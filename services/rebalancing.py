"""Rebalancing suggestions: compare current allocation to a target allocation
and propose buy/sell actions to converge.

Supports two modes:
  - **Rebalance via sales** (default): buy underweighted types, sell overweighted ones.
  - **Rebalance via new contribution**: only buy (good for tax-efficient
    rebalancing without realising gains). Caller provides `new_contribution`.
"""
from __future__ import annotations

from typing import Iterable, Optional


def compute(
    rows: Iterable,
    target_by_type: dict[str, float],
    new_contribution: float = 0.0,
) -> dict:
    """`target_by_type` maps {type: weight_pct} (must sum to ~100 ±2).
    Returns the current vs target allocation, the drift per type, and a
    list of buy/sell actions."""
    positions = [r for r in rows if r.current_value and r.current_value > 0]
    current_total = sum(p.current_value for p in positions)

    if current_total <= 0 and new_contribution <= 0:
        return {"error": "Portfolio is empty and no new contribution provided"}

    # Normalise target weights to sum to 1.0
    target_sum = sum(target_by_type.values())
    if target_sum <= 0:
        return {"error": "Target weights must sum to a positive value"}
    target_norm = {k: v / target_sum for k, v in target_by_type.items()}

    # Current weights
    by_type: dict[str, float] = {}
    for p in positions:
        by_type[p.type] = by_type.get(p.type, 0.0) + p.current_value

    # Apply new contribution (mode: contribution-only)
    if new_contribution > 0:
        # Future total after the contribution lands
        future_total = current_total + new_contribution
        # Compute "ideal" allocation of the new money so that, after the buy,
        # the per-type weights are as close as possible to target.
        actions = []
        all_types = set(target_norm.keys()) | set(by_type.keys())
        for t in sorted(all_types):
            target_value = target_norm.get(t, 0.0) * future_total
            current_value = by_type.get(t, 0.0)
            delta = target_value - current_value
            # In contribution-only mode we can only buy (positive delta).
            buy_amount = max(0.0, delta)
            if buy_amount > 0.01:
                actions.append({"type": t, "action": "buy", "amount_usd": round(buy_amount, 2)})

        # Cap total buys to the available contribution and scale proportionally
        total_buys = sum(a["amount_usd"] for a in actions)
        if total_buys > new_contribution and total_buys > 0:
            factor = new_contribution / total_buys
            for a in actions:
                a["amount_usd"] = round(a["amount_usd"] * factor, 2)
        mode = "contribution_only"
    else:
        # Full rebalance mode: sell over, buy under
        actions = []
        all_types = set(target_norm.keys()) | set(by_type.keys())
        for t in sorted(all_types):
            target_value = target_norm.get(t, 0.0) * current_total
            current_value = by_type.get(t, 0.0)
            delta = target_value - current_value
            if abs(delta) < 0.01 * current_total:  # within 1% — leave it
                continue
            actions.append({
                "type": t,
                "action": "buy" if delta > 0 else "sell",
                "amount_usd": round(abs(delta), 2),
            })
        mode = "full_rebalance"

    # Side-by-side comparison
    comparison = []
    all_types = set(target_norm.keys()) | set(by_type.keys())
    for t in sorted(all_types):
        cur_w = (by_type.get(t, 0.0) / current_total * 100) if current_total > 0 else 0.0
        tgt_w = target_norm.get(t, 0.0) * 100
        comparison.append({
            "type": t,
            "current_value": round(by_type.get(t, 0.0), 2),
            "current_pct": round(cur_w, 1),
            "target_pct": round(tgt_w, 1),
            "drift_pct": round(cur_w - tgt_w, 1),
        })
    comparison.sort(key=lambda c: abs(c["drift_pct"]), reverse=True)

    return {
        "mode": mode,
        "current_total": round(current_total, 2),
        "new_contribution": round(new_contribution, 2) if new_contribution else 0,
        "future_total": round(current_total + new_contribution, 2),
        "comparison": comparison,
        "actions": actions,
    }
