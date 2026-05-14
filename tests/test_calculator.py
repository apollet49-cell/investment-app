"""Tests for services/calculator.py — ROI, CAGR, NPV, IRR, compound, etc."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.calculator import (
    calc_annualized,
    calc_breakeven,
    calc_cagr,
    calc_compound,
    calc_irr,
    calc_npv,
    calc_payback,
    calc_roi,
    calc_sharpe,
)


def test_roi_basic():
    r = calc_roi(100, 120)
    assert r["result"] == 20.0
    assert "formula" in r
    assert "steps" in r


def test_roi_loss():
    assert calc_roi(100, 80)["result"] == -20.0


def test_roi_zero_initial_raises():
    with pytest.raises(ValueError):
        calc_roi(0, 100)


def test_cagr_doubles_over_10_years():
    """1000 → 2000 over 10 years ≈ 7.18% CAGR."""
    r = calc_cagr(1000, 2000, 10)
    assert abs(r["result"] - 7.18) < 0.01


def test_cagr_zero_years_raises():
    with pytest.raises(ValueError):
        calc_cagr(1000, 2000, 0)


def test_npv_textbook_example():
    """NPV of [-1000, 300, 400, 500] at 10%, all discounted from t=0:
    -1000 + 300/1.1 + 400/1.21 + 500/1.331 = -21.04. Negative → reject project."""
    r = calc_npv(10.0, [-1000, 300, 400, 500])
    assert abs(r["result"] - (-21.04)) < 1.0


def test_npv_zero_rate_equals_sum():
    """At 0% discount, NPV equals the simple sum."""
    r = calc_npv(0.0, [-100, 50, 50, 50])
    assert abs(r["result"] - 50.0) < 1e-6


def test_irr_break_even():
    """IRR is the rate that makes NPV = 0. Simple two-period case."""
    # -100 now, +110 next period → IRR = 10%
    r = calc_irr([-100, 110])
    assert abs(r["result"] - 10.0) < 0.01


def test_irr_no_sign_change_raises():
    with pytest.raises(ValueError):
        calc_irr([100, 200, 300])


def test_compound_one_year():
    """1000 @ 5% compounded monthly for 1 year ≈ 1051.16."""
    r = calc_compound(1000, 5, 1, 12)
    assert abs(r["result"] - 1051.16) < 0.5


def test_compound_zero_rate():
    """At 0% the principal is unchanged."""
    r = calc_compound(1000, 0, 5, 12)
    assert abs(r["result"] - 1000.0) < 1e-6


def test_breakeven_basic():
    """Fixed 1000, price 10, var 6 → break-even at 250 units."""
    r = calc_breakeven(1000, 10, 6)
    assert r["result"] == 250.0


def test_breakeven_no_margin_raises():
    with pytest.raises(ValueError):
        calc_breakeven(1000, 5, 5)


def test_payback_basic():
    """Invest 10000, get 2000/yr → payback = 5 years."""
    r = calc_payback(10000, 2000)
    assert r["result"] == 5.0


def test_payback_zero_cash_raises():
    with pytest.raises(ValueError):
        calc_payback(10000, 0)


def test_sharpe_positive():
    """Returns averaging 8% with risk_free 2% should give positive Sharpe."""
    returns = [0.10, 0.05, 0.12, 0.06, 0.08]
    r = calc_sharpe(returns, risk_free_rate=0.02)
    assert r["result"] > 0


def test_sharpe_empty_raises():
    with pytest.raises(ValueError):
        calc_sharpe([])


def test_annualized_one_year():
    """Returning 10% in 365 days → ~10% annualized."""
    r = calc_annualized(10.0, 365)
    assert abs(r["result"] - 10.0) < 0.05


def test_annualized_half_year():
    """Returning 10% in 182 days → ~21% annualized (compounded)."""
    r = calc_annualized(10.0, 182)
    assert 20.5 < r["result"] < 21.5
