"""Portfolio diversification score (0-100).

Uses the Herfindahl-Hirschman Index (HHI) on two dimensions:
  - per-position weight (where most of the value sits)
  - per-asset-type weight (whether the user holds across categories)

A single concentrated position scores 0; an evenly spread portfolio scores 100.
"""
from __future__ import annotations

from typing import Iterable


def compute_score(rows: Iterable) -> dict:
    positions = [r for r in rows if r.current_value and r.current_value > 0]
    if not positions:
        return {
            "score": None,
            "positions": 0,
            "message": "Add at least one investment to see the score.",
        }

    total = sum(p.current_value for p in positions)
    if total <= 0:
        return {"score": None, "positions": 0, "message": "Portfolio total is zero."}

    weights = [(p, p.current_value / total) for p in positions]

    # Position-level HHI (sum of squared weights, scaled to 0..10000)
    hhi_position = sum(w * w for _, w in weights) * 10000
    position_score = max(0.0, min(100.0, round(100 - hhi_position / 100, 1)))

    # Type-level distribution
    type_dist: dict[str, float] = {}
    for p, w in weights:
        type_dist[p.type] = type_dist.get(p.type, 0.0) + w
    hhi_type = sum(v * v for v in type_dist.values()) * 10000
    type_score = max(0.0, min(100.0, round(100 - hhi_type / 100, 1)))

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

    # Overall score = weighted blend (positions matter more than types)
    overall = round(0.7 * position_score + 0.3 * type_score, 1)

    # Concise human-readable message
    top_name, top_w = sorted_by_weight[0][0].name, sorted_by_weight[0][1]
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
        "position_score": position_score,
        "type_score": type_score,
        "positions": len(positions),
        "top_positions": top_positions,
        "type_distribution": {k: round(v * 100, 1) for k, v in sorted(type_dist.items(), key=lambda x: -x[1])},
        "message": message,
    }
