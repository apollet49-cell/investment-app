"""Dividend data via yfinance.

Two complementary functions:
  - `fetch_dividends(symbol)` → list of historical payments per share (used by
    routers/investments.py to seed dividend transactions).
  - `fetch_dividend_metadata(symbol)` → aggregated dict for the dashboard:
    next ex-div date, trailing 12-month dividend, implied yield. Cached.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import date, datetime
from typing import Optional

import yfinance as yf
from cachetools import TTLCache

log = logging.getLogger("dividends")

_meta_cache: TTLCache = TTLCache(maxsize=512, ttl=3600)
_meta_lock = asyncio.Lock()


def _fetch_sync(symbol: str) -> Optional[list[dict]]:
    """Return list of {date, dividend_per_share} for the symbol, or None."""
    try:
        t = yf.Ticker(symbol)
        series = t.dividends
        if series is None or series.empty:
            return []
        out = []
        for idx, val in series.items():
            try:
                d = idx.date() if hasattr(idx, "date") else date.fromisoformat(str(idx)[:10])
                out.append({"date": d, "dividend_per_share": float(val)})
            except Exception:
                continue
        return out
    except Exception as e:
        log.warning("dividends fetch failed for %s: %s", symbol, e)
        return None


async def fetch_dividends(symbol: str) -> Optional[list[dict]]:
    """Historical dividend payments per share. Kept for backwards-compat
    callers (routers/investments.py uses this to back-fill dividend
    transactions)."""
    return await asyncio.to_thread(_fetch_sync, symbol)


def total_dividends_ytd(transactions) -> float:
    """Sum dividend transactions for the current calendar year."""
    today = date.today()
    return sum(
        t.amount for t in transactions
        if t.type == "dividend" and t.transaction_date.year == today.year
    )


def _format_date(value) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, str):
        return value[:10]
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    try:
        return str(value)[:10]
    except Exception:
        return None


def _fetch_metadata_sync(symbol: str) -> dict:
    """Heavier yfinance call that aggregates next ex-div, TTM dividend, yield."""
    try:
        t = yf.Ticker(symbol)
        divs = t.dividends
        history: list[dict] = []
        ttm = 0.0
        if divs is not None and not divs.empty:
            today = datetime.utcnow().date()
            for idx, val in divs.items():
                try:
                    d = idx.date() if hasattr(idx, "date") else date.fromisoformat(str(idx)[:10])
                    amount = float(val)
                    history.append({"date": d.isoformat(), "amount": amount})
                    if (today - d).days <= 365:
                        ttm += amount
                except Exception:
                    continue
            history.sort(key=lambda h: h["date"], reverse=True)
            history = history[:24]

        # Next ex-dividend date — yfinance shape varies by version.
        next_ex_div = None
        try:
            cal = t.calendar
            if isinstance(cal, dict):
                raw = cal.get("Ex-Dividend Date") or cal.get("ExDividendDate")
                if isinstance(raw, list) and raw:
                    raw = raw[0]
                next_ex_div = _format_date(raw)
            else:
                try:
                    raw = cal.loc["Ex-Dividend Date"]
                    if hasattr(raw, "iloc"):
                        raw = raw.iloc[0]
                    next_ex_div = _format_date(raw)
                except Exception:
                    pass
        except Exception:
            pass

        # Current price for implied yield
        current_price = None
        try:
            info = getattr(t, "fast_info", None)
            if info is not None:
                current_price = float(getattr(info, "last_price", 0) or 0)
        except Exception:
            pass

        annual_yield_pct = None
        if ttm > 0 and current_price and current_price > 0:
            annual_yield_pct = round((ttm / current_price) * 100, 2)

        return {
            "symbol": symbol,
            "history": history,
            "next_ex_div": next_ex_div,
            "ttm_dividend": round(ttm, 4) if ttm else None,
            "annual_yield_pct": annual_yield_pct,
            "current_price": current_price,
        }
    except Exception as e:
        log.warning("dividend metadata fetch failed for %s: %s", symbol, e)
        return {
            "symbol": symbol, "history": [], "next_ex_div": None,
            "ttm_dividend": None, "annual_yield_pct": None, "error": str(e),
        }


async def fetch_dividend_metadata(symbol: str) -> dict:
    if not symbol:
        return {"symbol": symbol, "history": [], "next_ex_div": None,
                "ttm_dividend": None, "annual_yield_pct": None}
    key = symbol.upper()
    async with _meta_lock:
        if key in _meta_cache:
            return _meta_cache[key]
    result = await asyncio.to_thread(_fetch_metadata_sync, key)
    async with _meta_lock:
        _meta_cache[key] = result
    return result


async def upcoming_calendar(investments: list, limit: int = 25) -> list[dict]:
    """For each tradable position with a symbol, fetch its dividend metadata
    and return ones with a future ex-div date OR a known yield, sorted by date."""
    tradable = [r for r in investments
                if r.symbol and r.type in ("stock", "etf") and r.current_value]
    tradable = tradable[:limit]

    async def _one(inv):
        data = await fetch_dividend_metadata(inv.symbol)
        next_ex = data.get("next_ex_div")
        ttm = data.get("ttm_dividend") or 0
        annual_yield = data.get("annual_yield_pct")
        qty = inv.quantity or 0
        next_payment = round(qty * ttm / 4, 2) if qty and ttm else None
        return {
            "investment_id": inv.id,
            "name": inv.name,
            "symbol": inv.symbol,
            "next_ex_div": next_ex,
            "annual_yield_pct": annual_yield,
            "ttm_dividend_per_unit": ttm or None,
            "estimated_next_payment_usd": next_payment,
        }

    results = await asyncio.gather(*(_one(r) for r in tradable))
    enriched = [r for r in results if r.get("next_ex_div") or r.get("annual_yield_pct")]
    enriched.sort(key=lambda r: r.get("next_ex_div") or "9999")
    return enriched
