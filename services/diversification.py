"""Portfolio diversification score (0-100) + risk breakdown.

Uses the Herfindahl-Hirschman Index (HHI) on multiple dimensions:
  - per-position weight (where most of the value sits)
  - per-asset-type weight (whether the user holds across categories)
  - per-sector (for stocks/ETFs)
  - per-country/region (geographic risk)

A single concentrated position scores 0; an evenly spread portfolio scores 100.
The risk score is the inverse — high concentration on any one dimension
translates to elevated risk.
"""
from __future__ import annotations

from typing import Iterable

from data.asset_universe import SECTOR, country_of


def _hhi_score(distribution: dict) -> float:
    """Convert a weight distribution {key: 0..1} into a 0..100 diversification
    score. 100 = perfectly even, 0 = single key."""
    if not distribution:
        return 0.0
    hhi = sum(v * v for v in distribution.values()) * 10000  # 0..10000
    return max(0.0, min(100.0, round(100 - hhi / 100, 1)))


def _country_of_position(p) -> str:
    """Best-effort country code for an investment row."""
    if p.type == "real_estate" and getattr(p, "country", None):
        return p.country.upper()
    if p.type == "stock":
        return country_of(p.symbol or "")
    if p.type == "etf":
        return country_of(p.symbol or "")
    if p.type == "crypto":
        return "GLOBAL"
    if p.type == "bond":
        return "?"
    return "?"


def compute_score(rows: Iterable) -> dict:
    positions = [r for r in rows if r.current_value and r.current_value > 0]
    if not positions:
        return {
            "score": None,
            "risk_score": None,
            "positions": 0,
            "message": "Add at least one investment to see the score.",
        }

    total = sum(p.current_value for p in positions)
    if total <= 0:
        return {"score": None, "positions": 0, "message": "Portfolio total is zero."}

    weights = [(p, p.current_value / total) for p in positions]

    # Position-level
    position_dist = {f"{p.id}:{p.name}": w for p, w in weights}
    position_score = _hhi_score(position_dist)

    # Type-level
    type_dist: dict[str, float] = {}
    for p, w in weights:
        type_dist[p.type] = type_dist.get(p.type, 0.0) + w
    type_score = _hhi_score(type_dist)

    # Sector (stocks only — ETFs/crypto don't map cleanly)
    sector_dist: dict[str, float] = {}
    stock_total = 0.0
    for p, w in weights:
        if p.type == "stock":
            sector = SECTOR.get(p.symbol or "", "Other")
            sector_dist[sector] = sector_dist.get(sector, 0.0) + w
            stock_total += w
    # Normalise sector_dist to the stock sub-portfolio (so 100% means even split
    # within stocks, not within the whole portfolio).
    if stock_total > 0:
        sector_dist_norm = {k: v / stock_total for k, v in sector_dist.items()}
        sector_score = _hhi_score(sector_dist_norm)
    else:
        sector_score = None

    # Country / geographic
    country_dist: dict[str, float] = {}
    for p, w in weights:
        c = _country_of_position(p)
        country_dist[c] = country_dist.get(c, 0.0) + w
    country_score = _hhi_score(country_dist)

    # Top 5 positions for the dashboard breakdown
    sorted_by_weight = sorted(weights, key=lambda x: x[1], reverse=True)
    top_positions = [
        {
            "name": p.name,
            "type": p.type,
            "symbol": p.symbol,
            "weight_pct": round(w * 100, 1),
            "current_value": p.current_value,
        }
        for p, w in sorted_by_weight[:5]
    ]

    # Overall diversification = weighted blend across dimensions.
    components = [(position_score, 0.45), (type_score, 0.2), (country_score, 0.15)]
    if sector_score is not None:
        components.append((sector_score, 0.20))
    total_weight = sum(w for _, w in components)
    overall = round(sum(s * w for s, w in components) / total_weight, 1) if total_weight else 0.0

    # Risk score = inverse of diversification (0 = no risk / perfect spread,
    # 100 = max concentration risk). Plus penalties for type-specific risk
    # (crypto > 30% → bonus risk, single-stock > 20% → bonus risk).
    base_risk = 100 - overall
    crypto_weight = type_dist.get("crypto", 0.0)
    crypto_penalty = max(0, (crypto_weight - 0.3) * 50)
    single_position_penalty = max(0, (sorted_by_weight[0][1] - 0.2) * 60)
    risk_score = round(min(100.0, base_risk + crypto_penalty + single_position_penalty), 1)

    # Top risk factors (human-readable)
    risk_factors: list[str] = []
    top_name, top_w = sorted_by_weight[0][0].name, sorted_by_weight[0][1]
    if top_w >= 0.30:
        risk_factors.append(f"{top_name} concentrates {top_w * 100:.0f}% of the portfolio")
    if crypto_weight >= 0.30:
        risk_factors.append(f"Crypto exposure is high ({crypto_weight * 100:.0f}%)")
    if sector_score is not None and sector_score < 40 and stock_total >= 0.2:
        top_sec = max(sector_dist_norm.items(), key=lambda x: x[1])
        risk_factors.append(f"Stock holdings concentrated in {top_sec[0]} ({top_sec[1] * 100:.0f}%)")
    if country_score < 40:
        top_ctry = max(country_dist.items(), key=lambda x: x[1])
        risk_factors.append(f"Geographic concentration: {top_ctry[0]} = {top_ctry[1] * 100:.0f}%")
    if len(positions) < 5:
        risk_factors.append(f"Only {len(positions)} position(s) — increase the count for resilience")

    # Concise overall message
    if overall >= 75:
        message = f"Well diversified across {len(positions)} positions."
    elif overall >= 50:
        message = f"Moderately concentrated — {top_name} represents {top_w * 100:.0f}% of value."
    elif overall >= 25:
        message = f"Concentrated — {top_name} alone is {top_w * 100:.0f}% of the portfolio."
    else:
        message = f"Single-position risk — {top_name} dominates at {top_w * 100:.0f}%."

    return {
        "score": overall,
        "risk_score": risk_score,
        "position_score": position_score,
        "type_score": type_score,
        "sector_score": sector_score,
        "country_score": country_score,
        "positions": len(positions),
        "top_positions": top_positions,
        "type_distribution": {k: round(v * 100, 1) for k, v in sorted(type_dist.items(), key=lambda x: -x[1])},
        "sector_distribution": {k: round(v * 100, 1) for k, v in sorted(sector_dist.items(), key=lambda x: -x[1])} if stock_total > 0 else {},
        "country_distribution": {k: round(v * 100, 1) for k, v in sorted(country_dist.items(), key=lambda x: -x[1])},
        "risk_factors": risk_factors,
        "message": message,
    }
