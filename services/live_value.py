"""Live current-value refresh for tradable investments.

Given a list of Investment rows, this fetches the current market price for
each (deduped by symbol) and returns `{investment_id: new_current_value}` for
rows where we can compute it (must have a symbol and a quantity).

All values are normalised to USD so the rest of the app can do consistent
math regardless of the symbol's home exchange. yfinance returns native
currency (USD for US stocks, GBp/pence for .L, EUR for .DE/.AS/.PA,
CHF for .SW, etc.) — we look up the FX rate against USD and multiply.

Used by `/investments/` and `/dashboard/summary` so the UI always sees the
latest market value without the user having to manually refresh each row.
"""
from __future__ import annotations

import asyncio
import logging
from typing import Iterable, Optional

from services.market_data import market_service

log = logging.getLogger("live_value")

TRADABLE_TYPES = {"stock", "etf", "crypto"}

# Currencies that yfinance may return for stock prices, with the conversion
# factor needed to reach the *major* currency unit (e.g. pence → pound = ÷100).
_PENCE_CURRENCIES = {"GBX", "GBP_PENCE", "PENCE", "GBP."}
# Currency aliases recognised as "this is already the major unit". We attempt
# FX conversion for ANY currency in this set. The list is intentionally wide
# (~25 ISO-4217 codes) because silently treating an Indian rupee or Brazilian
# real price as USD over-inflates positions by 80×+. Unknown currencies log
# a warning and fall back to raw value as a clear signal.
_KNOWN_MAJOR = {
    "USD", "EUR", "GBP", "CHF", "JPY", "CAD", "AUD", "NZD",
    "HKD", "SGD", "TWD", "KRW", "CNY", "CNH", "INR", "IDR", "THB", "MYR", "PHP", "VND",
    "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "RON", "BGN",
    "BRL", "MXN", "ARS", "CLP", "COP", "PEN",
    "ZAR", "EGP", "MAD", "NGN",
    "TRY", "ILS", "AED", "SAR", "QAR", "KWD",
}


async def _to_usd(amount: float, from_ccy: str) -> float:
    """Convert amount in `from_ccy` to USD using market_service's FX cache.
    Returns the original amount if FX lookup fails (warning logged).
    Unknown currencies log a warning so silent inflation can be caught."""
    cc = from_ccy.upper()
    if cc in ("", "USD"):
        return amount
    if cc not in _KNOWN_MAJOR:
        log.warning("unknown currency %s — value left as raw (may be over/under-stated)", cc)
        return amount
    try:
        data = await market_service.get_forex_rate(cc, "USD")
        rate = data.get("rate") if data else None
        if rate and rate > 0:
            return amount * float(rate)
        log.warning("FX %s→USD lookup returned no rate — value left as raw", cc)
    except Exception as e:
        log.warning("FX %s→USD lookup failed: %s", cc, e)
    return amount


async def _fetch_price_in_usd(symbol: str, asset_type: str) -> Optional[float]:
    """Return the live price PER UNIT converted to USD.

    For LSE stocks (GBp/pence) we first divide by 100 to get pounds, then
    convert pounds to USD. For Euronext (EUR), Xetra (EUR), SIX (CHF), TSE
    (JPY) etc., we just FX-convert the native price to USD. yfinance returns
    the source currency in the `currency` field; we trust it but fall back
    to a per-suffix heuristic when it's missing or wrong (LSE only).

    Each fetch is hard-bounded to 6s — leaves room for the 5s Alpha Vantage
    fallback inside get_stock_price after a yfinance miss. Python threads
    can't be cancelled, but the deadline still prevents the parent gather
    from accumulating runaway calls forever."""
    try:
        return await asyncio.wait_for(_fetch_price_inner(symbol, asset_type), timeout=6.0)
    except asyncio.TimeoutError:
        log.warning("live price fetch for %s timed out", symbol)
        return None


async def _fetch_price_inner(symbol: str, asset_type: str) -> Optional[float]:
    try:
        if asset_type == "crypto" and "-" not in symbol:
            data = await market_service.get_crypto_price(symbol.lower())
            return data.get("price_usd") if data else None
        data = await market_service.get_stock_price(symbol)
        if not data:
            return None
        price = data.get("price")
        if price is None:
            return None
        ccy = (data.get("currency") or "").upper()

        # Step 1: normalise pence → pounds so the value is in the major unit.
        if ccy in _PENCE_CURRENCIES:
            price = price / 100.0
            ccy = "GBP"
        elif ccy in ("GBP", "") and symbol.upper().endswith(".L") and price > 500:
            # Fallback heuristic: .L symbols with implausibly high price are
            # almost certainly pence even if yfinance mislabels them as GBP.
            price = price / 100.0
            ccy = "GBP"

        # Step 2: FX-convert to USD if needed.
        if ccy and ccy != "USD":
            price = await _to_usd(price, ccy)

        return float(price)
    except Exception as e:
        log.warning("live price fetch failed for %s (%s): %s", symbol, asset_type, e)
        return None


# Backwards-compatible alias — callers used to import _fetch_one directly.
_fetch_one = _fetch_price_in_usd


async def refresh_current_values(investments: Iterable) -> dict[int, float]:
    """Return {investment_id: new_current_value_usd} for tradable rows with
    a symbol + quantity. Caller decides whether to persist."""
    # Tests opt out so they don't hit real yfinance / CoinGecko.
    import os as _os
    if _os.getenv("INVESTAPP_DISABLE_LIVE_REFRESH") == "1":
        return {}
    work = [
        inv for inv in investments
        if inv.type in TRADABLE_TYPES
        and inv.symbol
        and inv.quantity
        and inv.quantity > 0
    ]
    if not work:
        return {}

    keys = list({(inv.symbol, inv.type) for inv in work})
    # Per-call deadline is 6s (in _fetch_price_in_usd). The batch deadline
    # is 12s so a slow yfinance + 5s Alpha Vantage fallback can still
    # finish within the parent window for a single ticker, while the
    # whole gather doesn't drag GET /investments/ past 12s in the worst
    # case. On timeout we return {} so the caller sees stored values.
    try:
        results = await asyncio.wait_for(
            asyncio.gather(
                *(_fetch_price_in_usd(sym, typ) for (sym, typ) in keys),
                return_exceptions=True,
            ),
            timeout=12.0,
        )
    except asyncio.TimeoutError:
        log.warning("live refresh batch timed out (>12s) — using stored values")
        return {}
    price_by_key: dict[tuple[str, str], float] = {}
    for key, r in zip(keys, results):
        if isinstance(r, (int, float)) and r > 0:
            price_by_key[key] = float(r)

    updates: dict[int, float] = {}
    for inv in work:
        price = price_by_key.get((inv.symbol, inv.type))
        if price is None:
            continue
        updates[inv.id] = round(inv.quantity * price, 2)
    return updates
