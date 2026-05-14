"""Tests for services/rebalancing.py — drift + buy/sell/contribution-only actions."""
from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.rebalancing import compute


def _pos(type_, value):
    return SimpleNamespace(type=type_, current_value=value)


def test_empty_portfolio_no_contribution_returns_error():
    r = compute([], {"stock": 50, "bond": 50}, 0)
    assert "error" in r


def test_already_balanced_no_actions():
    """50/50 stock/bond, target 50/50 → drift within tolerance."""
    rows = [_pos("stock", 5000), _pos("bond", 5000)]
    r = compute(rows, {"stock": 50, "bond": 50}, 0)
    assert r["mode"] == "full_rebalance"
    assert r["actions"] == []  # within 1% tolerance


def test_full_rebalance_actions_match_drift():
    """80/20 stock/bond, target 50/50 → sell 3000 stock, buy 3000 bond."""
    rows = [_pos("stock", 8000), _pos("bond", 2000)]
    r = compute(rows, {"stock": 50, "bond": 50}, 0)
    assert r["mode"] == "full_rebalance"
    assert len(r["actions"]) == 2
    sell = next(a for a in r["actions"] if a["action"] == "sell")
    buy = next(a for a in r["actions"] if a["action"] == "buy")
    assert sell["type"] == "stock"
    assert buy["type"] == "bond"
    assert abs(sell["amount_usd"] - 3000) < 1
    assert abs(buy["amount_usd"] - 3000) < 1


def test_target_weights_normalised():
    """Targets summing to 200 should normalise — same result as 100/100."""
    rows = [_pos("stock", 8000), _pos("bond", 2000)]
    r1 = compute(rows, {"stock": 50, "bond": 50}, 0)
    r2 = compute(rows, {"stock": 100, "bond": 100}, 0)
    assert r1["actions"] == r2["actions"]


def test_contribution_only_no_sells():
    """80/20 portfolio, target 60/40, with 5000 to invest — only buys, no sells."""
    rows = [_pos("stock", 8000), _pos("bond", 2000)]
    r = compute(rows, {"stock": 60, "bond": 40}, new_contribution=5000)
    assert r["mode"] == "contribution_only"
    for a in r["actions"]:
        assert a["action"] == "buy"
    # All contributions sum to the new money (capped)
    total = sum(a["amount_usd"] for a in r["actions"])
    assert total <= 5001  # rounded


def test_contribution_only_caps_to_available():
    """Contribution should never exceed the new money input even if drift is large."""
    rows = [_pos("stock", 1000), _pos("bond", 0)]
    r = compute(rows, {"stock": 50, "bond": 50}, new_contribution=200)
    total = sum(a["amount_usd"] for a in r["actions"])
    assert total <= 201


def test_drift_calculation():
    """Stock = 70%, target = 50% → drift +20."""
    rows = [_pos("stock", 7000), _pos("bond", 3000)]
    r = compute(rows, {"stock": 50, "bond": 50}, 0)
    stock_row = next(c for c in r["comparison"] if c["type"] == "stock")
    assert abs(stock_row["current_pct"] - 70.0) < 0.5
    assert abs(stock_row["drift_pct"] - 20.0) < 0.5


def test_comparison_sorted_by_abs_drift():
    """The comparison list should be sorted by largest drift first."""
    rows = [_pos("stock", 4000), _pos("bond", 1000), _pos("crypto", 5000)]
    r = compute(rows, {"stock": 50, "bond": 40, "crypto": 10}, 0)
    drifts = [abs(c["drift_pct"]) for c in r["comparison"]]
    # Sorted descending
    assert drifts == sorted(drifts, reverse=True)


def test_missing_type_in_target_treated_as_zero():
    """Holding 'crypto' but target only specifies stock/bond → crypto is over-target."""
    rows = [_pos("stock", 5000), _pos("crypto", 5000)]
    r = compute(rows, {"stock": 100}, 0)
    actions = {a["type"]: a for a in r["actions"]}
    assert "crypto" in actions
    assert actions["crypto"]["action"] == "sell"


def test_zero_target_weights_returns_error():
    """All zeros isn't a valid allocation."""
    rows = [_pos("stock", 1000)]
    r = compute(rows, {"stock": 0, "bond": 0}, 0)
    assert "error" in r
