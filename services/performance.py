"""Performance metrics from the transaction log.

`simple_roi`: (current_value − total_invested) / total_invested. Ignores time —
misleading once you've been DCA'ing for years (a recent buy "drags down" the
ROI even though the early money has compounded).

`xirr`: solves for the rate r such that ∑ cf_i / (1+r)^(t_i/365) = 0 where
cf_i are dated cashflows. Buys are negative, sells/dividends positive, plus
the current portfolio value as a final positive cashflow at today's date.
This is the actual money-weighted annualised return.

`twr`: time-weighted return, computed from daily portfolio snapshots. It
neutralises the timing/size of cashflows — so you can fairly compare your
performance to an index. Requires snapshots; falls back to None if absent.
"""
from __future__ import annotations

from datetime import date, timedelta
from typing import Iterable, Optional

from services.clock import today_utc


def _xirr(cashflows: list[tuple[date, float]], guess: float = 0.1) -> Optional[float]:
    """Newton's method to find the rate that zeroes NPV of dated cashflows.
    Returns the annualised rate as a fraction (0.07 == 7%/yr), or None if it
    fails to converge or the cashflows are degenerate."""
    if len(cashflows) < 2:
        return None
    # Need at least one negative and one positive cashflow for a sign change.
    has_pos = any(cf > 0 for _, cf in cashflows)
    has_neg = any(cf < 0 for _, cf in cashflows)
    if not (has_pos and has_neg):
        return None

    t0 = min(d for d, _ in cashflows)

    def npv(r: float) -> float:
        total = 0.0
        for d, cf in cashflows:
            days = (d - t0).days
            # Guard against r ≤ -1 which would explode the denominator.
            base = 1.0 + r
            if base <= 0:
                return float("inf")
            total += cf / (base ** (days / 365.0))
        return total

    def dnpv(r: float) -> float:
        total = 0.0
        for d, cf in cashflows:
            days = (d - t0).days
            base = 1.0 + r
            if base <= 0:
                return float("inf")
            total += -days / 365.0 * cf / (base ** (days / 365.0 + 1))
        return total

    r = guess
    for _ in range(100):
        f = npv(r)
        df = dnpv(r)
        if df == 0 or not _finite(df):
            break
        new_r = r - f / df
        if not _finite(new_r):
            break
        if abs(new_r - r) < 1e-7:
            return new_r
        # Hard-clamp to avoid runaway iterations
        if new_r < -0.999:
            new_r = -0.5
        if new_r > 50:
            new_r = 5
        r = new_r
    # Last NPV check — if we ended on a near-zero value, accept it
    if abs(npv(r)) < 1e-3:
        return r
    return None


def _finite(x: float) -> bool:
    return x == x and x not in (float("inf"), float("-inf"))


def compute_xirr_from_transactions(
    transactions: Iterable,
    current_value: float,
    as_of: Optional[date] = None,
) -> Optional[float]:
    """Build the cashflow list from transactions + current value, then solve.
    Sign convention: buys/fees are money OUT (negative), sells/dividends are
    money IN (positive), and the current portfolio value is a final positive
    cashflow (as if you sold everything today)."""
    as_of = as_of or today_utc()
    cashflows: list[tuple[date, float]] = []
    for tx in transactions:
        amt = float(tx.amount or 0)
        if amt <= 0:
            continue
        tdate = tx.transaction_date
        if tx.type in ("buy", "fee"):
            cashflows.append((tdate, -amt))
        elif tx.type in ("sell", "dividend"):
            cashflows.append((tdate, amt))
        # splits don't affect cashflows
    if current_value > 0:
        cashflows.append((as_of, current_value))
    return _xirr(cashflows)


def compute_twr_from_snapshots(snapshots: list, contributions_by_date: dict[date, float]) -> Optional[float]:
    """Daily time-weighted return — links sub-period returns and removes the
    effect of cashflow timing. `snapshots` is sorted ascending by date.
    Returns the annualised rate, or None if there's not enough data.

    Convention: snapshots are taken at end-of-day, so `cur.total_value`
    already INCLUDES any contribution that happened that day. To get the
    market-only sub-return, we subtract the contribution from cur's end
    value (the part of cur that came from external money rather than
    market growth):

        sub_return = (cur.total_value - contribution) / prev.total_value

    The previous formulation `cur.total_value / (prev.total_value + contribution)`
    was wrong: it both added the contribution to the period start AND left
    it inside the period end, double-counting the cash inflow."""
    if len(snapshots) < 2:
        return None
    factor = 1.0
    days = 0
    for i in range(1, len(snapshots)):
        prev = snapshots[i - 1]
        cur = snapshots[i]
        contribution = contributions_by_date.get(cur.snapshot_date, 0.0)
        if prev.total_value <= 0:
            continue
        # Strip the external cashflow out of cur's end value so the ratio
        # is pure market performance.
        market_end = cur.total_value - contribution
        if market_end <= 0:
            continue
        sub_return = market_end / prev.total_value
        factor *= sub_return
        days += (cur.snapshot_date - prev.snapshot_date).days
    if days <= 0 or factor <= 0:
        return None
    return factor ** (365.0 / days) - 1.0


def compute_simple_roi(total_invested: float, current_value: float) -> Optional[float]:
    if total_invested <= 0:
        return None
    return (current_value - total_invested) / total_invested
