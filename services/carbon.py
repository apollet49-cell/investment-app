"""Portfolio carbon footprint estimation (tCO2e per year).

Approximation based on sector-level Scope 1+2 emissions intensity per dollar
invested. The numbers are rough industry averages from public sources (CDP,
Trucost-style methodologies). Useful for a *signal*, not for compliance
reporting — actual portfolio emissions require company-specific disclosures.

For crypto we use per-coin annual energy consumption:
  - PoW (BTC, LTC, DOGE…): high
  - PoS (ETH post-merge, SOL, ADA…): negligible

Real estate and bonds are excluded (no good public data without specifics).
"""
from __future__ import annotations

from typing import Iterable

from data.asset_universe import SECTOR

# tCO2e per $1k invested per year, by sector (rough Scope 1+2+3 intensity).
SECTOR_INTENSITY: dict[str, float] = {
    "Energy": 5.0,
    "Utilities": 2.0,
    "Materials": 1.5,
    "Industrials": 0.5,
    "Consumer Discretionary": 0.4,
    "Consumer Staples": 0.3,
    "Healthcare": 0.10,
    "Financials": 0.10,
    "Technology": 0.05,
    "Communication": 0.10,
    "Real Estate": 0.20,
    "Other": 0.30,
}

# tCO2e per coin per year. PoW chains are very high; PoS are ~negligible.
CRYPTO_INTENSITY_PER_COIN: dict[str, float] = {
    "bitcoin": 0.50,        # Cambridge CCAF estimate, declining as renewables grow
    "BTC-USD": 0.50,
    "litecoin": 0.10,
    "LTC-USD": 0.10,
    "dogecoin": 0.05,
    "DOGE-USD": 0.05,
    "bitcoin-cash": 0.10,
    "BCH-USD": 0.10,
    "monero": 0.05,
    "XMR-USD": 0.05,
}

# tCO2e per $1k invested for crypto without a per-coin mapping (PoS default).
CRYPTO_DEFAULT_INTENSITY_PER_USD_K = 0.005

# Default for unknown ETFs (treated like a diversified equity basket).
ETF_DEFAULT_INTENSITY = 0.25


def _intensity_for(p) -> tuple[float, str, float]:
    """Return (emissions_tCO2e_per_year, basis_label, intensity_value).

    The intensity is per $1k invested, except for crypto where it's per coin
    when we have a per-coin number. `basis_label` describes which assumption
    was used so the UI can be transparent."""
    if p.type == "stock":
        sector = SECTOR.get(p.symbol or "", "Other")
        intensity = SECTOR_INTENSITY.get(sector, SECTOR_INTENSITY["Other"])
        emissions = (p.current_value / 1000.0) * intensity
        return emissions, f"{sector} sector avg", intensity
    if p.type == "etf":
        emissions = (p.current_value / 1000.0) * ETF_DEFAULT_INTENSITY
        return emissions, "Diversified ETF avg", ETF_DEFAULT_INTENSITY
    if p.type == "crypto":
        per_coin = CRYPTO_INTENSITY_PER_COIN.get(p.symbol or "")
        if per_coin is not None and p.quantity and p.quantity > 0:
            return per_coin * p.quantity, f"{p.symbol} per-coin", per_coin
        # Fallback to per-USD intensity (negligible for most PoS coins)
        emissions = (p.current_value / 1000.0) * CRYPTO_DEFAULT_INTENSITY_PER_USD_K
        return emissions, "Proof-of-stake avg", CRYPTO_DEFAULT_INTENSITY_PER_USD_K
    # Real estate, bonds, startup: no good public data → 0 (excluded)
    return 0.0, "Not tracked", 0.0


def compute(rows: Iterable) -> dict:
    positions = [r for r in rows if r.current_value and r.current_value > 0]
    if not positions:
        return {
            "total_tco2e_year": 0.0,
            "tracked_positions": 0,
            "skipped_positions": 0,
            "breakdown": [],
            "equivalents": {},
            "message": "Add investments to estimate the portfolio's carbon footprint.",
        }

    breakdown: list[dict] = []
    total = 0.0
    skipped = 0
    for p in positions:
        emissions, basis, _ = _intensity_for(p)
        if emissions <= 0:
            skipped += 1
            continue
        breakdown.append({
            "name": p.name,
            "symbol": p.symbol,
            "type": p.type,
            "current_value": p.current_value,
            "emissions_tco2e_year": round(emissions, 3),
            "basis": basis,
        })
        total += emissions
    breakdown.sort(key=lambda b: b["emissions_tco2e_year"], reverse=True)

    # Useful equivalents to make the number tangible.
    equivalents = {
        "car_km": round(total * 5000),               # ~190 gCO2/km typical car
        "transatlantic_flights": round(total / 1.6, 2),  # ~1.6 tCO2e per pax round trip
        "french_avg_pct": round((total / 9.0) * 100, 1),  # avg French = 9 tCO2e/yr
    }

    if total < 0.5:
        message = "Very low footprint — mostly cash, bonds, or PoS crypto."
    elif total < 2:
        message = "Low footprint — well below the average French citizen (9 tCO2e/yr)."
    elif total < 5:
        message = "Moderate footprint — comparable to a few months of average emissions."
    else:
        message = "High footprint — heavy exposure to carbon-intensive sectors."

    return {
        "total_tco2e_year": round(total, 2),
        "tracked_positions": len(breakdown),
        "skipped_positions": skipped,
        "breakdown": breakdown[:10],
        "equivalents": equivalents,
        "message": message,
    }
