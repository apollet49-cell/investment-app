"""Batch fetcher for the 750-asset universe.

- Stocks/ETFs: yfinance.download() in batches of 50 tickers, then per-ticker
  fast_info enrichment for market cap (sequential calls would be too slow at
  250 symbols, so we batch via threads).
- Cryptos: a single CoinGecko /coins/markets call returns up to 250 records.
- All results live in TTL caches (60s for prices, 5m for static metadata).
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime, timedelta, timezone
from typing import Any, Optional

import aiohttp
import pandas as pd
import yfinance as yf
from cachetools import TTLCache

from data.asset_universe import (
    ETF_CATEGORY,
    SECTOR,
    TOP_CRYPTOS,
    TOP_ETFS,
    TOP_STOCKS,
    country_of,
    etf_region,
)

log = logging.getLogger("market_universe")

BATCH_SIZE = 25
RETRY_CONCURRENCY = 6  # parallel per-symbol retries when a batch misses
COINGECKO_MARKETS_URL = "https://api.coingecko.com/api/v3/coins/markets"


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _yf_price_on_date_sync(symbol: str, target_date: date) -> Optional[dict]:
    """Get the close price for a symbol on a specific date (or nearest prior
    trading day for weekends / holidays). Returns None on failure.

    The returned `currency` is the native quote currency from yfinance
    (USD for US stocks, GBp/pence for LSE listings, EUR for Euronext,
    JPY for TSE, etc.) — NOT pre-normalised. The async wrapper
    `get_price_on_date` does the pence→pound→USD conversion, because that
    last step requires an async FX rate lookup."""
    try:
        t = yf.Ticker(symbol)
        # Fetch a small window around target so we catch the nearest trading day.
        start = target_date - timedelta(days=10)
        end = target_date + timedelta(days=1)
        h = t.history(start=start.isoformat(), end=end.isoformat())
        if h is None or h.empty:
            return None
        # Filter to rows on or before the target date.
        valid = h[h.index.date <= target_date]
        if valid.empty:
            # target_date might be older than the symbol's first trading day;
            # try the very first available row in the window as a fallback.
            valid = h
        last = valid.iloc[-1]
        actual_date = valid.index[-1].date().isoformat()

        # Native currency for the listing. yfinance's fast_info exposes it
        # without a slow .info call. Defaults to USD only if the lookup
        # itself fails — that's safer than blindly hardcoding USD, which
        # was the root cause of the "RR.L at $1.2M shows -97%" bug:
        # LSE stocks return prices in pence but the consumer assumed
        # dollars, producing quantities 100× too small.
        native_ccy = "USD"
        try:
            fi = getattr(t, "fast_info", None)
            if fi is not None:
                c = None
                if hasattr(fi, "get"):
                    c = fi.get("currency") or fi.get("quoteType")
                else:
                    c = getattr(fi, "currency", None)
                if c:
                    native_ccy = str(c).upper()
        except Exception:
            pass

        return {
            "symbol": symbol,
            "price": float(last["Close"]),
            "currency": native_ccy,
            "date_requested": target_date.isoformat(),
            "date_actual": actual_date,
            "source": "yfinance",
        }
    except Exception as e:
        log.warning("price_on %s/%s failed: %s", symbol, target_date, e)
        return None


def _yf_single_sync(symbol: str) -> Optional[dict]:
    """Fallback: per-symbol Ticker.history. Used when batch download misses a ticker."""
    try:
        t = yf.Ticker(symbol)
        h = t.history(period="5d")
        if h is None or h.empty:
            return None
        closes = h["Close"].dropna()
        if len(closes) < 1:
            return None
        last = float(closes.iloc[-1])
        prev = float(closes.iloc[-2]) if len(closes) >= 2 else last
        vol = float(h["Volume"].dropna().iloc[-1]) if "Volume" in h else None
        return {
            "price": last,
            "change": last - prev,
            "change_pct": ((last - prev) / prev * 100.0) if prev else 0.0,
            "volume": vol,
        }
    except Exception:
        return None


def _yf_batch_sync(symbols: list[str]) -> dict[str, dict]:
    """Download 2 days of daily candles for a batch of tickers and reduce to a
    quote dict per ticker. Returns {} on error so the caller can move on."""
    out: dict[str, dict] = {}
    if not symbols:
        return out
    try:
        df = yf.download(
            tickers=" ".join(symbols),
            period="5d",
            interval="1d",
            group_by="ticker",
            progress=False,
            threads=True,
            auto_adjust=False,
        )
    except Exception as e:
        log.warning("yfinance batch failed (%d symbols): %s", len(symbols), e)
        return out

    # When only one symbol is fetched, columns are flat (Open/High/Low/Close/...)
    # rather than the multi-index (symbol, field) shape.
    if len(symbols) == 1:
        sym = symbols[0]
        try:
            closes = df["Close"].dropna()
            if len(closes) >= 1:
                last = float(closes.iloc[-1])
                prev = float(closes.iloc[-2]) if len(closes) >= 2 else last
                vol = float(df["Volume"].dropna().iloc[-1]) if "Volume" in df else None
                out[sym] = {
                    "price": last,
                    "change": last - prev,
                    "change_pct": ((last - prev) / prev * 100.0) if prev else 0.0,
                    "volume": vol,
                }
        except Exception:
            pass
        return out

    for sym in symbols:
        try:
            sub = df[sym] if sym in df.columns.get_level_values(0) else None
            if sub is None or sub.empty:
                continue
            closes = sub["Close"].dropna()
            if len(closes) < 1:
                continue
            last = float(closes.iloc[-1])
            prev = float(closes.iloc[-2]) if len(closes) >= 2 else last
            vol = float(sub["Volume"].dropna().iloc[-1]) if "Volume" in sub else None
            out[sym] = {
                "price": last,
                "change": last - prev,
                "change_pct": ((last - prev) / prev * 100.0) if prev else 0.0,
                "volume": vol,
            }
        except Exception:
            continue
    return out


class MarketUniverseService:
    def __init__(self) -> None:
        self._stocks_cache: TTLCache = TTLCache(maxsize=4, ttl=60)
        self._etfs_cache: TTLCache = TTLCache(maxsize=4, ttl=60)
        self._crypto_cache: TTLCache = TTLCache(maxsize=4, ttl=60)
        self._meta_cache: TTLCache = TTLCache(maxsize=2048, ttl=24 * 3600)  # market cap, sector
        self._historical_cache: TTLCache = TTLCache(maxsize=512, ttl=300)
        self._lock = asyncio.Lock()

    # ---------- Stocks / ETFs ----------
    async def fetch_batch_quotes(self, symbols: list[str], asset_type: str) -> list[dict]:
        # Pass 1 — concurrent batch downloads.
        batches = [symbols[i:i + BATCH_SIZE] for i in range(0, len(symbols), BATCH_SIZE)]
        results = await asyncio.gather(*(asyncio.to_thread(_yf_batch_sync, b) for b in batches))
        merged: dict[str, dict] = {}
        for d in results:
            merged.update(d)

        # Pass 2 — for any symbol the batch missed, retry individually with
        # bounded concurrency. yfinance.batch is unreliable for non-US tickers
        # but per-symbol Ticker.history calls succeed far more often.
        missing = [s for s in symbols if s not in merged]
        if missing:
            log.info("retrying %d symbols individually (batch missed)", len(missing))
            sem = asyncio.Semaphore(RETRY_CONCURRENCY)

            async def _retry(sym: str) -> tuple[str, Optional[dict]]:
                async with sem:
                    return sym, await asyncio.to_thread(_yf_single_sync, sym)

            retries = await asyncio.gather(*(_retry(s) for s in missing))
            for sym, q in retries:
                if q is not None:
                    merged[sym] = q

        out = []
        for sym in symbols:
            q = merged.get(sym)
            if not q:
                continue
            out.append({
                "symbol": sym,
                "name": sym,  # filled with company name lazily on detail view
                "price": round(q["price"], 4),
                "change": round(q["change"], 4),
                "change_pct": round(q["change_pct"], 2),
                "volume": q["volume"],
                "market_cap": None,  # populated by enrich_metadata if requested
                "asset_type": asset_type,
                "sector": SECTOR.get(sym, "Other") if asset_type == "stock" else None,
                "category": ETF_CATEGORY.get(sym, "Other") if asset_type == "etf" else None,
                "country": country_of(sym) if asset_type == "stock" else None,
                "region": etf_region(sym) if asset_type == "etf" else None,
                "last_updated": _now(),
            })
        return out

    async def get_stocks(self) -> list[dict]:
        async with self._lock:
            if "all" in self._stocks_cache:
                return self._stocks_cache["all"]
        data = await self.fetch_batch_quotes(TOP_STOCKS, "stock")
        async with self._lock:
            self._stocks_cache["all"] = data
        return data

    async def get_etfs(self) -> list[dict]:
        async with self._lock:
            if "all" in self._etfs_cache:
                return self._etfs_cache["all"]
        data = await self.fetch_batch_quotes(TOP_ETFS, "etf")
        async with self._lock:
            self._etfs_cache["all"] = data
        return data

    # ---------- Crypto ----------
    async def get_crypto(self) -> list[dict]:
        async with self._lock:
            if "all" in self._crypto_cache:
                return self._crypto_cache["all"]
        data = await self._fetch_crypto_batch(TOP_CRYPTOS)
        async with self._lock:
            self._crypto_cache["all"] = data
        return data

    async def _fetch_crypto_batch(self, coin_ids: list[str]) -> list[dict]:
        # CoinGecko caps `ids` at ~250 in a single call; we paginate to be safe.
        out: list[dict] = []
        page_size = 250
        for i in range(0, len(coin_ids), page_size):
            chunk = coin_ids[i:i + page_size]
            params = {
                "vs_currency": "usd",
                "ids": ",".join(chunk),
                "order": "market_cap_desc",
                "per_page": str(page_size),
                "page": "1",
                "sparkline": "true",
                "price_change_percentage": "24h,7d",
            }
            try:
                async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=20)) as sess:
                    async with sess.get(COINGECKO_MARKETS_URL, params=params) as resp:
                        if resp.status != 200:
                            log.warning("coingecko markets returned %d", resp.status)
                            continue
                        rows = await resp.json()
            except Exception as e:
                log.warning("coingecko markets fetch failed: %s", e)
                continue
            for r in rows:
                out.append({
                    "id": r.get("id"),
                    "symbol": (r.get("symbol") or "").upper(),
                    "name": r.get("name"),
                    "price": r.get("current_price"),
                    "change_24h": r.get("price_change_percentage_24h"),
                    "change_7d": r.get("price_change_percentage_7d_in_currency"),
                    "market_cap": r.get("market_cap"),
                    "volume_24h": r.get("total_volume"),
                    "ath": r.get("ath"),
                    "atl": r.get("atl"),
                    "image_url": r.get("image"),
                    "sparkline_7d": (r.get("sparkline_in_7d") or {}).get("price") or [],
                    "asset_type": "crypto",
                    "last_updated": _now(),
                })
        return out

    # ---------- Top movers ----------
    async def get_top_movers(self, asset_type: str, n: int = 10) -> dict:
        if asset_type == "stock":
            data = await self.get_stocks()
        elif asset_type == "etf":
            data = await self.get_etfs()
        elif asset_type == "crypto":
            data = await self.get_crypto()
            for d in data:
                d["change_pct"] = d.get("change_24h") or 0.0
                d["volume"] = d.get("volume_24h") or 0.0
        else:
            return {"gainers": [], "losers": [], "most_active": []}

        # Filter rows that actually have a valid change_pct and volume.
        valid = [d for d in data if d.get("change_pct") is not None]
        gainers = sorted(valid, key=lambda d: d["change_pct"], reverse=True)[:n]
        losers = sorted(valid, key=lambda d: d["change_pct"])[:n]
        active = sorted(
            (d for d in data if d.get("volume") is not None),
            key=lambda d: d["volume"] or 0,
            reverse=True,
        )[:n]
        return {"gainers": gainers, "losers": losers, "most_active": active}

    # ---------- Search ----------
    async def search(self, query: str, limit: int = 10) -> list[dict]:
        q = query.lower().strip()
        if not q:
            return []
        out: list[dict] = []
        # Local universe match (instant, no API call).
        for sym in TOP_STOCKS:
            if q in sym.lower():
                out.append({"symbol": sym, "name": sym, "type": "stock"})
        for sym in TOP_ETFS:
            if q in sym.lower():
                out.append({"symbol": sym, "name": sym, "type": "etf"})
        # Crypto matches use cached metadata if present.
        crypto = self._crypto_cache.get("all", [])
        for c in crypto:
            if q in (c.get("name") or "").lower() or q in (c.get("symbol") or "").lower() or q in (c.get("id") or "").lower():
                out.append({"symbol": c["symbol"], "name": c["name"], "type": "crypto", "id": c["id"], "image_url": c.get("image_url")})

        # Yahoo search to catch tickers we don't list locally.
        try:
            url = f"https://query2.finance.yahoo.com/v1/finance/search?q={query}&quotesCount=10&newsCount=0"
            headers = {"User-Agent": "Mozilla/5.0 InvestApp/1.0"}
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5), headers=headers) as sess:
                async with sess.get(url) as resp:
                    if resp.status == 200:
                        data = await resp.json()
                        for item in (data.get("quotes") or []):
                            sym = item.get("symbol")
                            if not sym:
                                continue
                            if any(o.get("symbol") == sym for o in out):
                                continue
                            qt = item.get("quoteType", "").lower()
                            t = "etf" if qt == "etf" else ("crypto" if qt == "cryptocurrency" else "stock")
                            out.append({"symbol": sym, "name": item.get("shortname") or item.get("longname") or sym, "type": t})
        except Exception as e:
            log.warning("yahoo search failed: %s", e)

        # Deduplicate by (symbol, type) and cap.
        seen = set()
        deduped = []
        for o in out:
            key = (o["symbol"], o.get("type"))
            if key in seen:
                continue
            seen.add(key)
            deduped.append(o)
            if len(deduped) >= limit:
                break
        return deduped

    # ---------- Historical point-in-time price ----------
    async def get_price_on_date(self, symbol: str, target_date: date, asset_type: str = "stock") -> Optional[dict]:
        """Resolve the price of an asset on a specific date, normalised to USD.

        - Crypto (CoinGecko id like 'bitcoin'): /coins/{id}/history?date=DD-MM-YYYY
          → already in USD.
        - Anything else (yfinance ticker, includes BTC-USD style): fetch native
          price + currency, then normalise pence→pounds for LSE listings, then
          FX-convert to USD. Without this, a $1.2M position in RR.L gets a
          quantity computed from raw pence (treated as USD), and the row
          permanently looks like a -97% loss because live values are correctly
          in pounds while purchase math used pence.
        """
        if asset_type == "crypto" and "-" not in symbol:
            return await self._coingecko_price_on(symbol.lower(), target_date)

        raw = await asyncio.to_thread(_yf_price_on_date_sync, symbol, target_date)
        if not raw or raw.get("price") is None:
            return raw

        # Currency normalisation, same logic as services.live_value._fetch_price_inner.
        # Pence-currency tags vary by yfinance version (GBp / GBX / "PENCE"
        # / sometimes empty for .L listings with a high price).
        price = float(raw["price"])
        ccy = (raw.get("currency") or "").upper()
        _PENCE = {"GBP_PENCE", "GBX", "PENCE", "GBP."}
        # Some yfinance builds use lowercase "GBp" — already upper-cased above,
        # so this catches the legitimate pence variants. Note GBP is NOT in
        # this set: real pounds shouldn't be divided by 100.
        if ccy in _PENCE:
            price = price / 100.0
            ccy = "GBP"
        elif ccy in ("GBP", "") and symbol.upper().endswith(".L") and price > 500:
            # LSE fallback: prices above 500 in "GBP" are almost certainly pence
            # mislabelled by an older yfinance. £500/share would be exceptional
            # (only ~5 LSE constituents trade above that), so the false-positive
            # rate is negligible.
            price = price / 100.0
            ccy = "GBP"

        # FX-convert to USD. Reuse the live_value helper so we get the same
        # FX cache + fallback behaviour. Import here (not at module top) to
        # avoid a circular import (live_value → market_data → ...).
        if ccy and ccy != "USD":
            from services.live_value import _to_usd
            price = await _to_usd(price, ccy)

        return {
            **raw,
            "price": float(price),
            "currency": "USD",
            "native_currency": (raw.get("currency") or "USD").upper(),
        }

    async def _coingecko_price_on(self, coin_id: str, target_date: date) -> Optional[dict]:
        cg_date = target_date.strftime("%d-%m-%Y")
        url = f"https://api.coingecko.com/api/v3/coins/{coin_id}/history"
        params = {"date": cg_date, "localization": "false"}
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as sess:
                async with sess.get(url, params=params) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.json()
        except Exception as e:
            log.warning("coingecko price_on %s/%s failed: %s", coin_id, target_date, e)
            return None
        md = data.get("market_data") or {}
        price = (md.get("current_price") or {}).get("usd")
        if price is None:
            return None
        return {
            "symbol": (data.get("symbol") or coin_id).upper(),
            "id": coin_id,
            "price": float(price),
            "currency": "USD",
            "date_requested": target_date.isoformat(),
            "date_actual": target_date.isoformat(),
            "source": "coingecko",
        }

    # ---------- Asset detail (historical OHLC + technicals + meta) ----------
    async def get_asset_detail(self, symbol: str, asset_type: str, period: str = "1y") -> Optional[dict]:
        cache_key = f"{asset_type}:{symbol}:{period}"
        async with self._lock:
            if cache_key in self._historical_cache:
                return self._historical_cache[cache_key]

        if asset_type == "crypto":
            detail = await self._crypto_detail(symbol, period)
        else:
            detail = await self._stock_detail(symbol, period)

        if detail is not None:
            async with self._lock:
                self._historical_cache[cache_key] = detail
        return detail

    async def _stock_detail(self, symbol: str, period: str) -> Optional[dict]:
        valid_periods = {"1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "max"}
        if period not in valid_periods:
            period = "1y"
        interval = {"1d": "5m", "5d": "30m", "1mo": "1d", "3mo": "1d"}.get(period, "1d")

        def _sync() -> Optional[dict]:
            try:
                t = yf.Ticker(symbol)
                hist = t.history(period=period, interval=interval)
                if hist is None or hist.empty:
                    return None
                info = {}
                try:
                    info = t.info or {}
                except Exception:
                    pass

                close = hist["Close"]
                from services.technicals import compute_all
                tech = compute_all(close)
                candles = []
                for idx, row in hist.iterrows():
                    candles.append({
                        "time": int(idx.timestamp()),
                        "open": float(row["Open"]),
                        "high": float(row["High"]),
                        "low": float(row["Low"]),
                        "close": float(row["Close"]),
                        "volume": float(row.get("Volume", 0) or 0),
                    })
                week52_high = info.get("fiftyTwoWeekHigh") or float(hist["High"].max())
                week52_low = info.get("fiftyTwoWeekLow") or float(hist["Low"].min())
                return {
                    "symbol": symbol,
                    "name": info.get("longName") or info.get("shortName") or symbol,
                    "exchange": info.get("exchange") or "",
                    "asset_type": "etf" if (info.get("quoteType") or "").lower() == "etf" else "stock",
                    "currency": info.get("currency") or "USD",
                    "price": candles[-1]["close"],
                    "market_cap": info.get("marketCap"),
                    "week52_high": week52_high,
                    "week52_low": week52_low,
                    "expense_ratio": info.get("annualReportExpenseRatio") or info.get("expenseRatio"),
                    "pe_ratio": info.get("trailingPE"),
                    "dividend_yield": info.get("dividendYield"),
                    "beta": info.get("beta"),
                    "candles": candles,
                    "indicators": tech,
                    "summary": (info.get("longBusinessSummary") or "")[:600],
                    "website": info.get("website") or "",
                    "sector": info.get("sector") or SECTOR.get(symbol, ""),
                    "industry": info.get("industry") or "",
                    "period": period,
                }
            except Exception as e:
                log.warning("stock detail %s failed: %s", symbol, e)
                return None

        return await asyncio.to_thread(_sync)

    async def _crypto_detail(self, coin_id: str, period: str) -> Optional[dict]:
        days_map = {"1d": "1", "5d": "7", "1mo": "30", "3mo": "90", "6mo": "180", "1y": "365", "2y": "730", "5y": "1825", "max": "max"}
        days = days_map.get(period, "365")
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as sess:
                async with sess.get(f"https://api.coingecko.com/api/v3/coins/{coin_id}/ohlc",
                                    params={"vs_currency": "usd", "days": days}) as resp:
                    if resp.status != 200:
                        return None
                    raw = await resp.json()
                async with sess.get(f"https://api.coingecko.com/api/v3/coins/{coin_id}",
                                    params={"localization": "false", "tickers": "false",
                                            "community_data": "false", "developer_data": "false"}) as resp:
                    info = await resp.json() if resp.status == 200 else {}
        except Exception as e:
            log.warning("crypto detail %s failed: %s", coin_id, e)
            return None

        if not raw:
            return None
        candles = []
        closes = []
        for row in raw:
            t, o, h, l, c = row[0] / 1000, row[1], row[2], row[3], row[4]
            candles.append({"time": int(t), "open": o, "high": h, "low": l, "close": c, "volume": 0})
            closes.append(c)
        close_series = pd.Series(closes)
        from services.technicals import compute_all
        tech = compute_all(close_series)
        md = info.get("market_data") or {}
        return {
            "symbol": (info.get("symbol") or coin_id).upper(),
            "id": coin_id,
            "name": info.get("name") or coin_id,
            "asset_type": "crypto",
            "currency": "USD",
            "price": candles[-1]["close"] if candles else None,
            "market_cap": (md.get("market_cap") or {}).get("usd"),
            "week52_high": (md.get("ath") or {}).get("usd"),
            "week52_low": (md.get("atl") or {}).get("usd"),
            "candles": candles,
            "indicators": tech,
            "image_url": (info.get("image") or {}).get("large"),
            "summary": ((info.get("description") or {}).get("en") or "")[:600],
            "website": ((info.get("links") or {}).get("homepage") or [""])[0],
            "period": period,
        }


market_universe = MarketUniverseService()
