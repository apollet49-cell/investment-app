"""Tests for services/performance.py — XIRR, TWR, simple ROI.

Run from investment_app/:
    pytest tests/ -v
"""
from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path
from types import SimpleNamespace

# Make the package importable when running pytest from the repo root
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.performance import (
    _xirr,
    compute_simple_roi,
    compute_twr_from_snapshots,
    compute_xirr_from_transactions,
)


# ---------- _xirr (Newton's method) ----------

def test_xirr_one_year_10pct():
    """Invest 100, get back 110 a year later → ~10%/yr."""
    r = _xirr([(date(2024, 1, 1), -100.0), (date(2025, 1, 1), 110.0)])
    assert r is not None
    assert abs(r - 0.10) < 0.005


def test_xirr_two_year_zero_return():
    """Invest 100, get back 100 two years later → ~0%."""
    r = _xirr([(date(2024, 1, 1), -100.0), (date(2026, 1, 1), 100.0)])
    assert r is not None
    assert abs(r) < 0.005


def test_xirr_negative_return():
    """Invest 100, get back 80 a year later → ~-20%."""
    r = _xirr([(date(2024, 1, 1), -100.0), (date(2025, 1, 1), 80.0)])
    assert r is not None
    assert -0.21 < r < -0.19


def test_xirr_no_sign_change_returns_none():
    """Only negative cashflows → cannot solve."""
    assert _xirr([(date(2024, 1, 1), -100.0), (date(2025, 1, 1), -110.0)]) is None


def test_xirr_only_positive_returns_none():
    """Only positive cashflows → cannot solve."""
    assert _xirr([(date(2024, 1, 1), 100.0), (date(2025, 1, 1), 110.0)]) is None


def test_xirr_empty():
    assert _xirr([]) is None


def test_xirr_single_cashflow():
    assert _xirr([(date(2024, 1, 1), -100.0)]) is None


def test_xirr_dca_then_value():
    """100 in y0, 100 in y1, 230 back y2 — annualised somewhere between 0 and 15%."""
    cf = [
        (date(2023, 1, 1), -100.0),
        (date(2024, 1, 1), -100.0),
        (date(2025, 1, 1), 230.0),
    ]
    r = _xirr(cf)
    assert r is not None
    assert 0.05 < r < 0.20  # Plausible band — exact value depends on cashflow timing


# ---------- compute_xirr_from_transactions ----------

def _tx(type_, days_ago, amount):
    return SimpleNamespace(
        type=type_,
        transaction_date=date.today() - timedelta(days=days_ago),
        amount=amount,
    )


def test_xirr_from_transactions_simple_buy_then_value():
    txs = [_tx("buy", 365, 1000.0)]
    r = compute_xirr_from_transactions(txs, current_value=1100.0)
    assert r is not None
    assert abs(r - 0.10) < 0.01


def test_xirr_from_transactions_ignores_splits():
    """split transactions have no cashflow impact."""
    txs = [
        _tx("buy", 365, 1000.0),
        _tx("split", 180, 0.0),  # zero-amount, ignored
    ]
    r = compute_xirr_from_transactions(txs, current_value=1100.0)
    assert r is not None
    assert abs(r - 0.10) < 0.01


def test_xirr_from_transactions_with_dividend():
    """Got a dividend halfway through, raising the effective return."""
    txs = [
        _tx("buy", 365, 1000.0),
        _tx("dividend", 180, 50.0),
    ]
    r = compute_xirr_from_transactions(txs, current_value=1100.0)
    assert r is not None
    # 1000 in, 50 out at mid-year, 1100 at year end ≈ 17%
    assert 0.12 < r < 0.20


def test_xirr_from_transactions_no_transactions_no_value():
    assert compute_xirr_from_transactions([], current_value=0) is None


# ---------- compute_twr_from_snapshots ----------

def _snap(d, value):
    return SimpleNamespace(snapshot_date=d, total_value=value)


def test_twr_flat_no_growth():
    """Portfolio stays at 1000 for a year → TWR ~ 0%."""
    snaps = [_snap(date(2024, 1, 1), 1000.0), _snap(date(2025, 1, 1), 1000.0)]
    r = compute_twr_from_snapshots(snaps, {})
    assert r is not None
    assert abs(r) < 0.001


def test_twr_steady_growth_one_year():
    """1000 → 1100 over a year, no contributions → ~10%."""
    snaps = [_snap(date(2024, 1, 1), 1000.0), _snap(date(2025, 1, 1), 1100.0)]
    r = compute_twr_from_snapshots(snaps, {})
    assert r is not None
    assert abs(r - 0.10) < 0.001


def test_twr_removes_contribution_effect():
    """1000 → 2000 over a year but 900 was a contribution mid-year. TWR should
    show actual market return (~10%), not the deceptive 100% total growth."""
    mid = date(2024, 7, 1)
    snaps = [
        _snap(date(2024, 1, 1), 1000.0),
        _snap(mid, 1950.0),               # 1050 from growth + 900 contribution
        _snap(date(2025, 1, 1), 2000.0),  # +2.6% in 2nd half
    ]
    contribs = {mid: 900.0}
    r = compute_twr_from_snapshots(snaps, contribs)
    assert r is not None
    # TWR ≈ (1050/1000) × (2000/1950) ^ (365/365) − 1 ≈ ~7%
    assert 0.05 < r < 0.10


def test_twr_too_few_snapshots():
    assert compute_twr_from_snapshots([], {}) is None
    assert compute_twr_from_snapshots([_snap(date.today(), 1000)], {}) is None


# ---------- compute_simple_roi ----------

def test_simple_roi():
    assert abs(compute_simple_roi(1000, 1200) - 0.20) < 1e-9


def test_simple_roi_loss():
    assert abs(compute_simple_roi(1000, 800) - (-0.20)) < 1e-9


def test_simple_roi_zero_invested():
    assert compute_simple_roi(0, 100) is None
