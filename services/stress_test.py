"""Portfolio stress tests — simulate the impact of market shocks.

Applies a percentage shock per asset type (and optionally per sector) to the
current portfolio and returns the resulting value under each scenario, so the
user can see how their book would fare in different crisis conditions.
"""
from __future__ import annotations

from typing import Iterable

from data.asset_universe import SECTOR

# Per-asset-type shocks, expressed as a fractional change applied to
# current_value (e.g. -0.30 means -30%).
SCENARIOS: list[dict] = [
    {
        "key": "stocks_crash",
        "label": "Stock market crash",
        "description": "Equity markets fall 30%, ETFs follow",
        "shock_by_type": {"stock": -0.30, "etf": -0.30},
    },
    {
        "key": "crypto_winter",
        "label": "Crypto winter",
        "description": "Crypto loses half its value",
        "shock_by_type": {"crypto": -0.50},
    },
    {
        "key": "real_estate_correction",
        "label": "Real estate correction",
        "description": "Property prices fall 20%",
        "shock_by_type": {"real_estate": -0.20},
    },
    {
        "key": "rate_hike",
        "label": "Rate hike shock",
        "description": "Bonds -10%, equities -10%",
        "shock_by_type": {"bond": -0.10, "stock": -0.10, "etf": -0.10},
    },
    {
        "key": "tech_correction",
        "label": "Tech sector correction",
        "description": "Tech stocks lose 25% (sector-specific)",
        "shock_by_type": {},
        "shock_by_sector": {"Technology": -0.25, "Communication": -0.15},
    },
    {
        "key": "black_swan",
        "label": "Black swan (everything down)",
        "description": "Stocks -40%, crypto -50%, real estate -30%, bonds -15%",
        "shock_by_type": {"stock": -0.40, "etf": -0.40, "crypto": -0.50,
                          "real_estate": -0.30, "bond": -0.15, "startup": -0.60},
    },
    {
        "key": "mild_recession",
        "label": "Mild recession",
        "description": "Stocks -15%, real estate -5%",
        "shock_by_type": {"stock": -0.15, "etf": -0.15, "real_estate": -0.05},
    },
]


def _shock_for(position, scenario: dict) -> float:
    """Return the fractional change to apply to this position under the scenario."""
    by_type = scenario.get("shock_by_type", {})
    by_sector = scenario.get("shock_by_sector", {})
    shock = by_type.get(position.type, 0.0)
    if by_sector and position.type == "stock":
        sector = SECTOR.get(position.symbol or "", "Other")
        sector_shock = by_sector.get(sector, 0.0)
        # Sector shock overrides type shock when more severe (lower).
        if abs(sector_shock) > abs(shock):
            shock = sector_shock
    return shock


def run(rows: Iterable) -> dict:
    positions = [r for r in rows if r.current_value and r.current_value > 0]
    baseline = sum(p.current_value for p in positions)
    if baseline <= 0:
        return {"baseline": 0.0, "scenarios": []}

    results = []
    for s in SCENARIOS:
        shocked_total = 0.0
        for p in positions:
            shock = _shock_for(p, s)
            shocked_total += p.current_value * (1 + shock)
        loss = shocked_total - baseline
        results.append({
            "key": s["key"],
            "label": s["label"],
            "description": s["description"],
            "value": round(shocked_total, 2),
            "loss": round(loss, 2),
            "loss_pct": round((loss / baseline) * 100, 2),
        })

    # Sort by severity (worst first)
    results.sort(key=lambda r: r["loss_pct"])
    return {"baseline": round(baseline, 2), "scenarios": results}
