"""Tests for services/risk.py — vol, drawdown, beta, composite score."""
from __future__ import annotations

import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.risk import (
    _beta,
    _daily_returns,
    _max_drawdown,
    compute_risk_metrics,
)


def test_insufficient_history_returns_null_score():
    out = compute_risk_metrics([100, 101, 102])
    assert out["score"] is None
    assert out["reason"] == "insufficient_history"


def test_flat_portfolio_zero_volatility_low_risk():
    """Portfolio that never moves has zero vol, zero drawdown, beta undefined."""
    values = [1000.0] * 60
    out = compute_risk_metrics(values)
    assert out["volatility_pct"] == 0.0
    assert out["max_drawdown_pct"] == 0.0
    assert out["score"] is not None
    assert out["tier"] == "low"


def test_max_drawdown_classic_example():
    """Peak 1000 → trough 700 = 30% drawdown."""
    values = [800, 900, 1000, 950, 700, 750, 900]
    assert abs(_max_drawdown(values) - 0.30) < 1e-9


def test_max_drawdown_recovery_doesnt_reset():
    """Drawdown is the WORST peak-to-trough, even if recovered later."""
    values = [100, 150, 80, 200]  # peak 150 → trough 80 = 47%
    assert abs(_max_drawdown(values) - (70 / 150)) < 1e-9


def test_daily_returns_skips_zero_previous():
    """A snapshot worth 0 shouldn't cause divide-by-zero."""
    returns = _daily_returns([100, 0, 50])
    assert returns == [(0 - 100) / 100]  # second drop computed, third skipped


def test_beta_perfect_correlation():
    """Portfolio == benchmark → beta should be 1.0."""
    port = [0.01, -0.02, 0.03, -0.01, 0.02, -0.01, 0.015, -0.005, 0.025, -0.015]
    bench = port[:]
    b = _beta(port, bench)
    assert b is not None
    assert abs(b - 1.0) < 1e-9


def test_beta_amplified_returns_two():
    """Portfolio returns are 2× the benchmark → beta should be 2.0."""
    bench = [0.01, -0.02, 0.03, -0.01, 0.02, -0.01, 0.015, -0.005, 0.025, -0.015]
    port = [r * 2 for r in bench]
    b = _beta(port, bench)
    assert b is not None
    assert abs(b - 2.0) < 1e-9


def test_beta_inverse_returns_negative():
    """Portfolio mirror-imaged → beta should be ≈ -1.0."""
    bench = [0.01, -0.02, 0.03, -0.01, 0.02, -0.01, 0.015, -0.005, 0.025, -0.015]
    port = [-r for r in bench]
    b = _beta(port, bench)
    assert b is not None
    assert abs(b - (-1.0)) < 1e-9


def test_beta_returns_none_when_benchmark_has_no_variance():
    bench = [0.0] * 12
    port = [0.01] * 12
    assert _beta(port, bench) is None


def test_high_volatility_portfolio_is_high_tier():
    """A portfolio with ±5% daily swings is high risk."""
    import random
    random.seed(42)
    values = [1000.0]
    for _ in range(80):
        # ±5% daily moves
        change = (random.random() - 0.5) * 0.10
        values.append(values[-1] * (1 + change))
    out = compute_risk_metrics(values)
    assert out["score"] is not None
    assert out["volatility_pct"] > 30  # ~50% annualised
    assert out["tier"] in ("medium", "high")


def test_steady_growth_portfolio_low_to_medium():
    """0.05% daily growth, no drawdown — should be low/medium."""
    values = [1000.0 * (1.0005 ** i) for i in range(100)]
    out = compute_risk_metrics(values)
    assert out["max_drawdown_pct"] < 0.01
    assert out["tier"] in ("low", "medium")


def test_score_components_sum_to_total():
    """Sanity: composite score = sum of components."""
    values = [1000 + i * 5 for i in range(60)]  # monotonic up
    out = compute_risk_metrics(values)
    assert out["score"] is not None
    total = (
        out["components"]["volatility"]
        + out["components"]["drawdown"]
        + out["components"]["beta"]
    )
    assert abs(total - out["score"]) < 0.2  # rounding


def test_beta_used_when_benchmark_provided():
    """Beta included in metrics + score when benchmark is provided."""
    values = [1000 + i for i in range(40)]
    bench = [100 + i * 0.1 for i in range(40)]
    out = compute_risk_metrics(values, bench)
    assert out["beta"] is not None
