"""Live current-value refresh for tradable investments.

Given a list of Investment rows, this fetches the current market price for
each (deduped by symbol) and returns `{investment_id: new_current_value}` for
rows where we can compute it (must have a symbol and a quantity).

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


async def _fetch_one(symbol: str, asset_type: str) -> Optional[float]:
    try:
        if asset_type == "crypto" and "-" not in symbol:
            # CoinGecko id (e.g. "bitcoin")
            data = await market_service.get_crypto_price(symbol.lower())
            return data.get("price_usd") if data else None
        # yfinance ticker (stocks, ETFs, and yahoo crypto like "BTC-USD")
        data = await market_service.get_stock_price(symbol)
        return data.get("price") if data else None
    except Exception as e:
        log.warning("live price fetch failed for %s (%s): %s", symbol, asset_type, e)
        return None


async def refresh_current_values(investments: Iterable) -> dict[int, float]:
    """Return {investment_id: new_current_value} for tradable rows with quantity.

    Doesn't touch the database. Caller decides whether to persist.
    """
    # Eligible rows: tradable type + has symbol + has quantity > 0.
    work = [
        inv for inv in investments
        if inv.type in TRADABLE_TYPES
        and inv.symbol
        and inv.quantity
        and inv.quantity > 0
    ]
    if not work:
        return {}

    # Dedupe (symbol, type) so we fetch each unique pair once.
    keys = list({(inv.symbol, inv.type) for inv in work})
    results = await asyncio.gather(
        *(_fetch_one(sym, typ) for (sym, typ) in keys),
        return_exceptions=True,
    )
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
