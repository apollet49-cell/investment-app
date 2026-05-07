"""Multi-source price verification.

Fans out to all available sources for a symbol/asset class via asyncio.gather,
discards outliers, and computes a confidence score.
"""
from __future__ import annotations

import asyncio
import logging
import statistics
from datetime import datetime, timezone
from typing import Optional

from services.market_data import market_service

log = logging.getLogger("data_verifier")


def _outlier_filter(prices_by_source: dict[str, float]) -> dict[str, float]:
    """Drop any source whose price is > 3σ from the median."""
    if len(prices_by_source) < 3:
        return prices_by_source
    values = list(prices_by_source.values())
    med = statistics.median(values)
    sd = statistics.pstdev(values) or 0.0
    if sd == 0:
        return prices_by_source
    return {k: v for k, v in prices_by_source.items() if abs(v - med) <= 3 * sd}


def _confidence(std: float, median: float, used: int, attempted: int) -> float:
    if median <= 0 or attempted == 0:
        return 0.0
    normalized_std = min(std / median, 1.0)
    coverage = used / attempted
    return round(max(0.0, min(100.0, 100.0 * (1.0 - normalized_std) * coverage)), 2)


def _status(prices: dict[str, float], asset_class: str) -> str:
    n = len(prices)
    if n == 0:
        return "UNVERIFIED"
    if n == 1:
        return "UNVERIFIED"
    values = list(prices.values())
    median = statistics.median(values)
    if median <= 0:
        return "UNVERIFIED"
    max_dev_pct = max(abs(v - median) / median * 100 for v in values)
    tolerance = 1.0 if asset_class == "stock" else 2.0
    if n >= 3:
        return "VERIFIED" if max_dev_pct <= tolerance else "SUSPICIOUS"
    # n == 2
    return "SUSPICIOUS" if max_dev_pct > 0.5 else "VERIFIED"


async def verify_price(symbol: str, asset_class: str = "stock") -> dict:
    """Verify the price of a symbol across multiple sources.

    asset_class: "stock" | "crypto" — controls tolerance and source list.
    """
    if asset_class == "crypto":
        sources = {
            "coingecko": market_service._crypto_coingecko(symbol.lower()),
            "yfinance": market_service._crypto_yfinance(symbol.lower()),
        }
    else:
        sources = {
            "yfinance": market_service._stock_yfinance(symbol.upper()),
            "alpha_vantage": market_service._stock_alpha_vantage(symbol.upper()),
        }
    attempted = list(sources.keys())
    coros = list(sources.values())
    results = await asyncio.gather(*coros, return_exceptions=True)

    prices_by_source: dict[str, float] = {}
    failed: list[str] = []
    for name, res in zip(attempted, results):
        if isinstance(res, dict):
            price = res.get("price") if asset_class != "crypto" else res.get("price_usd")
            if price is not None and price > 0:
                prices_by_source[name] = float(price)
                continue
        failed.append(name)

    used_filtered = _outlier_filter(prices_by_source)
    used_names = list(used_filtered.keys())
    failed += [n for n in prices_by_source if n not in used_filtered]

    if not used_filtered:
        return {
            "symbol": symbol,
            "verified_price": None,
            "confidence_score": 0.0,
            "sources_used": [],
            "sources_failed": failed,
            "deviation_pct": 0.0,
            "status": "UNVERIFIED",
            "all_prices_by_source": prices_by_source,
            "median_price": None,
            "mean_price": None,
            "min_price": None,
            "max_price": None,
            "std_deviation": None,
        }

    values = list(used_filtered.values())
    median = statistics.median(values)
    mean = statistics.fmean(values)
    std = statistics.pstdev(values) if len(values) > 1 else 0.0
    deviation_pct = (max(abs(v - median) for v in values) / median * 100) if median > 0 else 0.0
    status = _status(used_filtered, asset_class)
    confidence = _confidence(std, median, len(used_filtered), len(attempted))

    return {
        "symbol": symbol,
        "verified_price": round(median, 6),
        "confidence_score": confidence,
        "sources_used": used_names,
        "sources_failed": failed,
        "deviation_pct": round(deviation_pct, 4),
        "status": status,
        "all_prices_by_source": {k: round(v, 6) for k, v in prices_by_source.items()},
        "median_price": round(median, 6),
        "mean_price": round(mean, 6),
        "min_price": round(min(values), 6),
        "max_price": round(max(values), 6),
        "std_deviation": round(std, 6),
    }
