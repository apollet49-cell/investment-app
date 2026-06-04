"""Market data fetchers (stocks/ETFs, crypto, forex, indices, macro) with TTL caches.

Each fetcher is async and never raises — failures return None so the
data_verifier can fan-out via asyncio.gather(..., return_exceptions=True)
without one source killing the others.
"""
from __future__ import annotations

import asyncio
import logging
import time
from datetime import datetime, timezone
from typing import Any, Optional

import aiohttp
import yfinance as yf
from cachetools import TTLCache

from settings import settings

log = logging.getLogger("market_data")

_INDEX_MAP = {
    "SP500": ("S&P 500", "^GSPC"),
    "NASDAQ": ("NASDAQ Composite", "^IXIC"),
    "DOW": ("Dow Jones", "^DJI"),
    "CAC40": ("CAC 40", "^FCHI"),
    "DAX": ("DAX", "^GDAXI"),
    "FTSE100": ("FTSE 100", "^FTSE"),
    "NIKKEI": ("Nikkei 225", "^N225"),
    "HANGSENG": ("Hang Seng", "^HSI"),
    "ASX200": ("ASX 200", "^AXJO"),
    "BSE_SENSEX": ("BSE SENSEX", "^BSESN"),
}

# Macro indicators per data source. FRED series codes for US; World Bank indicators for others.
_FRED_SERIES = {
    "gdp_growth": ("A191RL1Q225SBEA", "%"),
    "inflation_rate": ("CPIAUCSL", "index"),
    "unemployment": ("UNRATE", "%"),
    "interest_rate": ("FEDFUNDS", "%"),
    "debt_to_gdp": ("GFDEGDQ188S", "%"),
}
_WB_INDICATOR = {
    "gdp_growth": "NY.GDP.MKTP.KD.ZG",
    "inflation_rate": "FP.CPI.TOTL.ZG",
    "unemployment": "SL.UEM.TOTL.ZS",
    "interest_rate": "FR.INR.RINR",
    "debt_to_gdp": "GC.DOD.TOTL.GD.ZS",
}


def _now() -> datetime:
    return datetime.now(timezone.utc)


class MarketDataService:
    def __init__(self) -> None:
        # TTL caches per spec
        self._stock_cache: TTLCache = TTLCache(maxsize=512, ttl=60)
        self._crypto_cache: TTLCache = TTLCache(maxsize=512, ttl=60)
        self._forex_cache: TTLCache = TTLCache(maxsize=128, ttl=300)
        self._indices_cache: TTLCache = TTLCache(maxsize=32, ttl=30)
        self._macro_cache: TTLCache = TTLCache(maxsize=128, ttl=3600)

        # Locks per cache (cachetools is not async-safe)
        self._lk_stock = asyncio.Lock()
        self._lk_crypto = asyncio.Lock()
        self._lk_forex = asyncio.Lock()
        self._lk_indices = asyncio.Lock()
        self._lk_macro = asyncio.Lock()

        self._cache_hits = 0
        self._cache_misses = 0

        # Cap watched symbols so a long-running process doesn't accumulate
        # them forever. 2000 is well above any plausible single-user portfolio
        # + watchlist size; when full we drop the oldest entry FIFO-style.
        self._watched_symbols: dict[str, None] = {}
        self._watched_max = 2000

    def watch(self, symbols: list[str]) -> None:
        for s in symbols:
            key = s.upper()
            # Touch (re-insert) to make this the newest entry
            self._watched_symbols.pop(key, None)
            self._watched_symbols[key] = None
            while len(self._watched_symbols) > self._watched_max:
                # Drop oldest insertion (Python 3.7+ dicts preserve order)
                oldest = next(iter(self._watched_symbols))
                self._watched_symbols.pop(oldest, None)

    # ---------- Stocks ----------
    async def get_stock_price(self, symbol: str) -> Optional[dict[str, Any]]:
        symbol = symbol.upper()
        async with self._lk_stock:
            if symbol in self._stock_cache:
                self._cache_hits += 1
                log.debug("cache hit: stock %s", symbol)
                return self._stock_cache[symbol]
            self._cache_misses += 1

        # Postgres slow-path cache — survives Render free-tier sleeps so
        # the first user after a wake-up doesn't pay a fresh yfinance hit.
        # Wrapped to_thread because the DB session is sync.
        import asyncio as _asyncio
        from services import market_cache_db
        db_hit = await _asyncio.to_thread(market_cache_db.get, "stock", symbol)
        if db_hit is not None:
            async with self._lk_stock:
                self._stock_cache[symbol] = db_hit
            return db_hit

        result = await self._stock_yfinance(symbol)
        if result is None:
            result = await self._stock_alpha_vantage(symbol)

        if result is not None:
            async with self._lk_stock:
                self._stock_cache[symbol] = result
            # Fire-and-forget DB write — caller doesn't wait.
            _asyncio.create_task(_asyncio.to_thread(market_cache_db.put, "stock", symbol, result))
        return result

    async def _stock_yfinance(self, symbol: str) -> Optional[dict[str, Any]]:
        def _sync() -> Optional[dict[str, Any]]:
            try:
                t = yf.Ticker(symbol)
                fast = getattr(t, "fast_info", None)
                price = None
                currency = "USD"
                volume = None
                market_cap = None
                if fast is not None:
                    price = getattr(fast, "last_price", None) or getattr(fast, "lastPrice", None)
                    currency = getattr(fast, "currency", None) or "USD"
                    volume = getattr(fast, "last_volume", None)
                    market_cap = getattr(fast, "market_cap", None)
                if price is None:
                    info = t.info or {}
                    price = info.get("regularMarketPrice") or info.get("currentPrice")
                    currency = info.get("currency") or currency
                    volume = info.get("regularMarketVolume") or volume
                    market_cap = info.get("marketCap") or market_cap
                if price is None:
                    return None
                # change from previous close
                prev = None
                try:
                    prev = float(getattr(fast, "previous_close", 0) or 0)
                except Exception:
                    pass
                if not prev:
                    info = t.info or {}
                    prev = info.get("regularMarketPreviousClose") or 0
                change = price - prev if prev else None
                change_pct = (change / prev * 100.0) if prev else None
                return {
                    "symbol": symbol,
                    "price": float(price),
                    "change": float(change) if change is not None else None,
                    "change_pct": float(change_pct) if change_pct is not None else None,
                    "volume": float(volume) if volume else None,
                    "market_cap": float(market_cap) if market_cap else None,
                    "currency": currency,
                    "source": "yfinance",
                    "last_updated": _now().isoformat(),
                }
            except Exception as e:
                log.warning("yfinance %s failed: %s", symbol, e)
                return None

        return await asyncio.to_thread(_sync)

    async def _stock_alpha_vantage(self, symbol: str) -> Optional[dict[str, Any]]:
        url = f"https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol={symbol}&apikey={settings.ALPHA_VANTAGE_KEY}"
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as sess:
                async with sess.get(url) as resp:
                    data = await resp.json()
            q = data.get("Global Quote") or {}
            if not q or not q.get("05. price"):
                return None
            price = float(q["05. price"])
            change = float(q.get("09. change") or 0)
            change_pct = float((q.get("10. change percent") or "0%").rstrip("%"))
            volume = float(q.get("06. volume") or 0)
            return {
                "symbol": symbol,
                "price": price,
                "change": change,
                "change_pct": change_pct,
                "volume": volume,
                "market_cap": None,
                "currency": "USD",
                "source": "alpha_vantage",
                "last_updated": _now().isoformat(),
            }
        except Exception as e:
            log.warning("alpha_vantage %s failed: %s", symbol, e)
            return None

    # ---------- Crypto ----------
    async def get_crypto_price(self, coin_id: str) -> Optional[dict[str, Any]]:
        coin_id = coin_id.lower()
        async with self._lk_crypto:
            if coin_id in self._crypto_cache:
                self._cache_hits += 1
                return self._crypto_cache[coin_id]
            self._cache_misses += 1
        result = await self._crypto_coingecko(coin_id)
        if result is None:
            result = await self._crypto_yfinance(coin_id)
        if result is not None:
            async with self._lk_crypto:
                self._crypto_cache[coin_id] = result
        return result

    async def _crypto_coingecko(self, coin_id: str) -> Optional[dict[str, Any]]:
        url = f"https://api.coingecko.com/api/v3/coins/{coin_id}?localization=false&tickers=false&community_data=false&developer_data=false"
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as sess:
                async with sess.get(url) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.json()
            md = data.get("market_data") or {}
            price = md.get("current_price", {}).get("usd")
            if price is None:
                return None
            return {
                "name": data.get("name", coin_id),
                "symbol": data.get("symbol", "").upper(),
                "price_usd": float(price),
                "price_btc": float(md.get("current_price", {}).get("btc") or 0) or None,
                "change_24h": float(md.get("price_change_percentage_24h") or 0),
                "market_cap": float(md.get("market_cap", {}).get("usd") or 0) or None,
                "volume_24h": float(md.get("total_volume", {}).get("usd") or 0) or None,
                "source": "coingecko",
                "last_updated": _now().isoformat(),
            }
        except Exception as e:
            log.warning("coingecko %s failed: %s", coin_id, e)
            return None

    async def _crypto_yfinance(self, coin_id: str) -> Optional[dict[str, Any]]:
        # Map common coingecko ids to yfinance ticker.
        symbol_map = {
            "bitcoin": "BTC-USD",
            "ethereum": "ETH-USD",
            "solana": "SOL-USD",
            "ripple": "XRP-USD",
            "cardano": "ADA-USD",
            "dogecoin": "DOGE-USD",
        }
        ticker = symbol_map.get(coin_id, f"{coin_id.upper()}-USD")
        stock = await self._stock_yfinance(ticker)
        if not stock:
            return None
        return {
            "name": coin_id,
            "symbol": ticker.split("-")[0],
            "price_usd": stock["price"],
            "price_btc": None,
            "change_24h": stock.get("change_pct"),
            "market_cap": stock.get("market_cap"),
            "volume_24h": stock.get("volume"),
            "source": "yfinance",
            "last_updated": _now().isoformat(),
        }

    # ---------- Forex ----------
    async def get_forex_rate(self, from_currency: str, to_currency: str) -> Optional[dict[str, Any]]:
        from_c = from_currency.upper()
        to_c = to_currency.upper()
        key = f"{from_c}_{to_c}"
        async with self._lk_forex:
            if key in self._forex_cache:
                self._cache_hits += 1
                return self._forex_cache[key]
            self._cache_misses += 1

        result = await self._forex_oxr(from_c, to_c)
        if result is None and "EUR" in (from_c, to_c):
            result = await self._forex_ecb(from_c, to_c)
        if result is None:
            result = await self._forex_yfinance(from_c, to_c)

        if result is not None:
            async with self._lk_forex:
                self._forex_cache[key] = result
        return result

    async def _forex_oxr(self, from_c: str, to_c: str) -> Optional[dict[str, Any]]:
        # Free tier of openexchangerates is USD-base only; convert via USD pivot.
        url = f"https://openexchangerates.org/api/latest.json?app_id={settings.OPEN_EXCHANGE_RATES_KEY}"
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as sess:
                async with sess.get(url) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.json()
            rates = data.get("rates") or {}
            if from_c == "USD":
                rate = rates.get(to_c)
            elif to_c == "USD":
                base = rates.get(from_c)
                rate = (1 / base) if base else None
            else:
                a = rates.get(from_c)
                b = rates.get(to_c)
                rate = (b / a) if a and b else None
            if rate is None:
                return None
            return {
                "pair": f"{from_c}{to_c}",
                "rate": float(rate),
                "change_24h": None,
                "source": "open_exchange_rates",
                "timestamp": _now().isoformat(),
            }
        except Exception as e:
            log.warning("oxr %s/%s failed: %s", from_c, to_c, e)
            return None

    async def _forex_ecb(self, from_c: str, to_c: str) -> Optional[dict[str, Any]]:
        # ECB publishes EUR-base daily reference rates as XML.
        url = "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml"
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as sess:
                async with sess.get(url) as resp:
                    if resp.status != 200:
                        return None
                    text = await resp.text()
            rates: dict[str, float] = {"EUR": 1.0}
            for line in text.splitlines():
                line = line.strip()
                if "currency=" in line and "rate=" in line:
                    cur = line.split('currency="', 1)[1].split('"', 1)[0]
                    rate = line.split('rate="', 1)[1].split('"', 1)[0]
                    try:
                        rates[cur] = float(rate)
                    except ValueError:
                        pass
            if from_c == "EUR" and to_c in rates:
                rate = rates[to_c]
            elif to_c == "EUR" and from_c in rates:
                rate = 1 / rates[from_c]
            elif from_c in rates and to_c in rates:
                rate = rates[to_c] / rates[from_c]
            else:
                return None
            return {
                "pair": f"{from_c}{to_c}",
                "rate": float(rate),
                "change_24h": None,
                "source": "ecb",
                "timestamp": _now().isoformat(),
            }
        except Exception as e:
            log.warning("ecb %s/%s failed: %s", from_c, to_c, e)
            return None

    async def _forex_yfinance(self, from_c: str, to_c: str) -> Optional[dict[str, Any]]:
        symbol = f"{from_c}{to_c}=X"
        stock = await self._stock_yfinance(symbol)
        if not stock:
            return None
        return {
            "pair": f"{from_c}{to_c}",
            "rate": stock["price"],
            "change_24h": stock.get("change_pct"),
            "source": "yfinance",
            "timestamp": _now().isoformat(),
        }

    # ---------- Indices ----------
    async def get_index_data(self, index: str) -> Optional[dict[str, Any]]:
        index = index.upper()
        if index not in _INDEX_MAP:
            return None
        async with self._lk_indices:
            if index in self._indices_cache:
                self._cache_hits += 1
                return self._indices_cache[index]
            self._cache_misses += 1

        name, ticker = _INDEX_MAP[index]

        def _sync() -> Optional[dict[str, Any]]:
            try:
                t = yf.Ticker(ticker)
                hist = t.history(period="1y")
                if hist is None or hist.empty:
                    return None
                last_close = float(hist["Close"].iloc[-1])
                first_close = float(hist["Close"].iloc[0])
                ytd_return = (last_close - first_close) / first_close * 100.0
                week52_high = float(hist["High"].max())
                week52_low = float(hist["Low"].min())
                fast = getattr(t, "fast_info", None)
                prev = float(getattr(fast, "previous_close", 0) or 0) if fast else 0
                change = last_close - prev if prev else None
                change_pct = (change / prev * 100.0) if prev else None
                return {
                    "name": name,
                    "symbol": ticker,
                    "value": last_close,
                    "change": change,
                    "change_pct": change_pct,
                    "ytd_return": ytd_return,
                    "week52_high": week52_high,
                    "week52_low": week52_low,
                }
            except Exception as e:
                log.warning("index %s failed: %s", index, e)
                return None

        result = await asyncio.to_thread(_sync)
        if result is not None:
            async with self._lk_indices:
                self._indices_cache[index] = result
        return result

    async def get_all_indices(self) -> list[dict[str, Any]]:
        results = await asyncio.gather(*(self.get_index_data(k) for k in _INDEX_MAP), return_exceptions=True)
        return [r for r in results if isinstance(r, dict)]

    # ---------- Macro ----------
    async def get_macro_indicator(self, indicator: str, country: str = "US") -> Optional[dict[str, Any]]:
        indicator = indicator.lower()
        country = country.upper()
        cache_key = f"{country}_{indicator}"
        async with self._lk_macro:
            if cache_key in self._macro_cache:
                self._cache_hits += 1
                return self._macro_cache[cache_key]
            self._cache_misses += 1

        if country == "US" and indicator in _FRED_SERIES:
            result = await self._macro_fred(indicator)
        else:
            result = await self._macro_worldbank(indicator, country)

        if result is not None:
            async with self._lk_macro:
                self._macro_cache[cache_key] = result
        return result

    async def _macro_fred(self, indicator: str) -> Optional[dict[str, Any]]:
        series, unit = _FRED_SERIES[indicator]
        url = f"https://api.stlouisfed.org/fred/series/observations?series_id={series}&api_key={settings.FRED_KEY}&file_type=json&sort_order=desc&limit=1"
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as sess:
                async with sess.get(url) as resp:
                    if resp.status != 200:
                        return None
                    data = await resp.json()
            obs = (data.get("observations") or [None])[0]
            if not obs or obs.get("value") in (None, "."):
                return None
            return {
                "country": "US",
                "indicator": indicator,
                "value": float(obs["value"]),
                "unit": unit,
                "period": obs.get("date", ""),
                "source": "fred",
            }
        except Exception as e:
            log.warning("fred %s failed: %s", indicator, e)
            return None

    async def _macro_worldbank(self, indicator: str, country: str) -> Optional[dict[str, Any]]:
        wb_key = _WB_INDICATOR.get(indicator)
        if not wb_key:
            return None
        url = f"https://api.worldbank.org/v2/country/{country}/indicator/{wb_key}?format=json&per_page=1&date=2010:2024"
        try:
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5)) as sess:
                async with sess.get(url) as resp:
                    if resp.status != 200:
                        return None
                    payload = await resp.json()
            if not isinstance(payload, list) or len(payload) < 2:
                return None
            for entry in payload[1] or []:
                if entry.get("value") is not None:
                    return {
                        "country": country,
                        "indicator": indicator,
                        "value": float(entry["value"]),
                        "unit": "%",
                        "period": entry.get("date", ""),
                        "source": "world_bank",
                    }
        except Exception as e:
            log.warning("world_bank %s/%s failed: %s", indicator, country, e)
        return None

    # ---------- Historical / Search ----------
    async def get_historical(self, symbol: str, period: str = "1y") -> Optional[list[dict[str, Any]]]:
        """Daily OHLCV candles, normalised to USD.

        yfinance returns prices in each listing's native currency: pence for
        London (.L), EUR for Euronext / Xetra, JPY for TSE, etc. Without
        normalisation, the investment-detail chart shows an axis like 0–1400
        for a London stock (raw pence) while the surrounding cards show USD
        amounts — visibly inconsistent, and identical in shape to the
        cost-basis bug that produced -97% phantom losses.

        We fetch the native currency once via fast_info, then if needed:
          1. Divide pence by 100 to get pounds.
          2. FX-convert the major-unit price to USD using the cached rate.
        Same pipeline as services.live_value._fetch_price_inner for the
        live spot price."""
        valid_periods = {"1d", "5d", "1mo", "3mo", "6mo", "1y", "2y", "5y", "10y", "ytd", "max"}
        if period not in valid_periods:
            period = "1y"

        def _sync() -> Optional[dict[str, Any]]:
            try:
                t = yf.Ticker(symbol.upper())
                hist = t.history(period=period)
                if hist is None or hist.empty:
                    return None
                # Read the native currency once. fast_info is the cheap path;
                # falls back to USD only on lookup failure (warning logged
                # elsewhere — silently OK here so existing tests still pass).
                native = "USD"
                try:
                    fi = getattr(t, "fast_info", None)
                    if fi is not None:
                        c = fi.get("currency") if hasattr(fi, "get") else getattr(fi, "currency", None)
                        if c:
                            native = str(c).upper()
                except Exception:
                    pass
                candles = []
                for idx, row in hist.iterrows():
                    candles.append({
                        "date": idx.strftime("%Y-%m-%d"),
                        "open": float(row["Open"]),
                        "high": float(row["High"]),
                        "low": float(row["Low"]),
                        "close": float(row["Close"]),
                        "volume": float(row["Volume"]) if "Volume" in row else 0,
                    })
                return {"candles": candles, "native_currency": native}
            except Exception as e:
                log.warning("historical %s failed: %s", symbol, e)
                return None

        raw = await asyncio.to_thread(_sync)
        if not raw:
            return None
        candles = raw["candles"]
        ccy = raw["native_currency"]

        # ── Pence normalisation (same logic as live_value / market_universe) ──
        _PENCE = {"GBP_PENCE", "GBX", "PENCE", "GBP."}
        scale = 1.0
        if ccy in _PENCE:
            scale = 1 / 100.0
            ccy = "GBP"
        elif ccy in ("GBP", "") and symbol.upper().endswith(".L"):
            # LSE heuristic: if the median close is > 500, it's almost
            # certainly pence mislabelled as GBP. Median (not max) so a
            # single bad row doesn't flip the assessment.
            try:
                closes_sorted = sorted(c["close"] for c in candles)
                median = closes_sorted[len(closes_sorted) // 2]
                if median > 500:
                    scale = 1 / 100.0
                    ccy = "GBP"
            except Exception:
                pass

        # ── FX to USD ──
        if ccy and ccy != "USD":
            from services.live_value import _to_usd
            # Convert 1.0 of the native currency to USD, then multiply each
            # candle by the resulting factor. One forex call total, not one
            # per candle.
            fx = await _to_usd(1.0, ccy)
            scale = scale * fx

        if scale != 1.0:
            for c in candles:
                c["open"] = c["open"] * scale
                c["high"] = c["high"] * scale
                c["low"] = c["low"] * scale
                c["close"] = c["close"] * scale

        # Returns a plain list — back-compatible with the dashboard history
        # / risk paths and the existing /market/historical route. All prices
        # are USD; callers don't need to ask. The native currency info is
        # only useful for an axis label, which the frontend can guess from
        # the magnitude or we expose later via a separate endpoint.
        return candles

    async def search_symbols(self, query: str) -> list[dict[str, Any]]:
        url = f"https://query2.finance.yahoo.com/v1/finance/search?q={query}&quotesCount=10&newsCount=0"
        try:
            headers = {"User-Agent": "Mozilla/5.0 InvestmentApp/1.0"}
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=5), headers=headers) as sess:
                async with sess.get(url) as resp:
                    if resp.status != 200:
                        return []
                    data = await resp.json()
            quotes = data.get("quotes") or []
            return [
                {
                    "symbol": q.get("symbol"),
                    "name": q.get("shortname") or q.get("longname") or "",
                    "type": q.get("typeDisp") or q.get("quoteType") or "",
                    "exchange": q.get("exchange") or "",
                }
                for q in quotes
                if q.get("symbol")
            ]
        except Exception as e:
            log.warning("search %s failed: %s", query, e)
            return []

    # ---------- Scheduler hooks ----------
    async def refresh_watched_symbols(self, sse) -> None:
        if not self._watched_symbols:
            return
        results = await asyncio.gather(*(self.get_stock_price(s) for s in self._watched_symbols), return_exceptions=True)
        clean = [r for r in results if isinstance(r, dict)]
        if clean:
            await sse.broadcast("prices", {"prices": clean})

    async def refresh_forex(self, sse) -> None:
        pairs = [("EUR", "USD"), ("GBP", "USD"), ("USD", "JPY"), ("USD", "CHF")]
        results = await asyncio.gather(*(self.get_forex_rate(a, b) for a, b in pairs), return_exceptions=True)
        clean = [r for r in results if isinstance(r, dict)]
        if clean:
            await sse.broadcast("forex", {"rates": clean})

    async def refresh_indices(self, sse) -> None:
        data = await self.get_all_indices()
        if data:
            await sse.broadcast("indices", {"indices": data})

    async def refresh_macro(self, sse) -> None:
        results = await asyncio.gather(*(self.get_macro_indicator(k) for k in _FRED_SERIES), return_exceptions=True)
        clean = [r for r in results if isinstance(r, dict)]
        if clean:
            await sse.broadcast("macro", {"indicators": clean})

    def cache_stats(self) -> dict[str, int]:
        return {"hits": self._cache_hits, "misses": self._cache_misses, "watched_symbols": len(self._watched_symbols)}


market_service = MarketDataService()
