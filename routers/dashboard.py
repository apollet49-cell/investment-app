from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import Investment, PortfolioSnapshot, Transaction, User
from schemas import DashboardSummary, InvestmentOut
from services.alerts_engine import evaluate_alerts
from services.carbon import compute as compute_carbon
from services.diversification import compute_score as compute_diversification
from services.live_value import refresh_current_values
from services.market_data import market_service
from services.performance import (
    compute_simple_roi,
    compute_twr_from_snapshots,
    compute_xirr_from_transactions,
)
from services.snapshots import take_snapshot

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _to_out(inv: Investment) -> InvestmentOut:
    roi = 0.0
    if inv.amount_invested > 0:
        roi = (inv.current_value - inv.amount_invested) / inv.amount_invested * 100.0
    return InvestmentOut(
        id=inv.id,
        user_id=inv.user_id,
        name=inv.name,
        type=inv.type,
        symbol=inv.symbol,
        amount_invested=inv.amount_invested,
        current_value=inv.current_value,
        purchase_date=inv.purchase_date,
        notes=inv.notes,
        created_at=inv.created_at,
        roi_pct=round(roi, 2),
    )


@router.get("/summary", response_model=DashboardSummary)
async def summary(current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> DashboardSummary:
    rows = db.query(Investment).filter(Investment.user_id == current.id).all()
    # Apply live market refresh before computing aggregates.
    updates = await refresh_current_values(rows)
    if updates:
        changed = False
        for r in rows:
            new_val = updates.get(r.id)
            if new_val is not None and r.current_value != new_val:
                r.current_value = new_val
                changed = True
        if changed:
            db.commit()
    total_invested = sum(r.amount_invested for r in rows)
    current_value = sum(r.current_value for r in rows)
    total_roi = ((current_value - total_invested) / total_invested * 100.0) if total_invested > 0 else 0.0

    best = None
    best_roi = float("-inf")
    for r in rows:
        if r.amount_invested > 0:
            roi = (r.current_value - r.amount_invested) / r.amount_invested * 100.0
            if roi > best_roi:
                best_roi = roi
                best = r

    by_type: dict[str, float] = defaultdict(float)
    for r in rows:
        by_type[r.type] += r.current_value

    # Naive value-over-time: linearly interpolate from purchase to today per investment, then sum monthly.
    today = date.today()
    months_back = 12
    portfolio_over_time: list[dict[str, float | str]] = []
    for i in range(months_back, -1, -1):
        month_date = today - timedelta(days=30 * i)
        total = 0.0
        for r in rows:
            if r.purchase_date > month_date:
                continue
            days_held = (month_date - r.purchase_date).days
            total_days = max((today - r.purchase_date).days, 1)
            progress = min(days_held / total_days, 1.0)
            value_at_month = r.amount_invested + (r.current_value - r.amount_invested) * progress
            total += value_at_month
        portfolio_over_time.append({"date": month_date.isoformat(), "value": round(total, 2)})

    monthly_returns: list[dict[str, float | str]] = []
    for i in range(1, len(portfolio_over_time)):
        prev = portfolio_over_time[i - 1]["value"]
        curr = portfolio_over_time[i]["value"]
        ret = ((curr - prev) / prev * 100.0) if prev > 0 else 0.0
        monthly_returns.append({"month": portfolio_over_time[i]["date"], "return_pct": round(ret, 2)})

    triggered = evaluate_alerts(db, current)
    diversification = compute_diversification(rows)
    carbon = compute_carbon(rows)

    return DashboardSummary(
        total_invested=round(total_invested, 2),
        current_value=round(current_value, 2),
        total_roi_pct=round(total_roi, 2),
        best_performer=_to_out(best) if best else None,
        by_type={k: round(v, 2) for k, v in by_type.items()},
        portfolio_over_time=portfolio_over_time,
        monthly_returns=monthly_returns,
        triggered_alerts=triggered,
        diversification=diversification,
        carbon=carbon,
    )


@router.get("/performance")
async def performance(
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Honest performance metrics from the transaction log:
    - simple_roi: (value − invested) / invested
    - xirr: money-weighted annualised return (Newton's method on dated cashflows)
    - twr: time-weighted return from daily snapshots (annualised)
    Each metric may be null if there's not enough data."""
    rows = db.query(Investment).filter(Investment.user_id == current.id).all()
    total_invested = sum(r.amount_invested for r in rows)
    current_value = sum(r.current_value for r in rows)

    txs = (
        db.query(Transaction)
        .filter(Transaction.user_id == current.id)
        .order_by(Transaction.transaction_date.asc())
        .all()
    )
    snaps = (
        db.query(PortfolioSnapshot)
        .filter(PortfolioSnapshot.user_id == current.id)
        .order_by(PortfolioSnapshot.snapshot_date.asc())
        .all()
    )

    # Net contributions per day, for the TWR sub-period start adjustment.
    contribs_by_date: dict[date, float] = defaultdict(float)
    for tx in txs:
        amt = float(tx.amount or 0)
        if tx.type in ("buy", "fee"):
            contribs_by_date[tx.transaction_date] += amt
        elif tx.type in ("sell", "dividend"):
            contribs_by_date[tx.transaction_date] -= amt

    xirr = compute_xirr_from_transactions(txs, current_value)
    twr = compute_twr_from_snapshots(snaps, dict(contribs_by_date))
    simple = compute_simple_roi(total_invested, current_value)

    period_start = None
    if txs:
        period_start = txs[0].transaction_date.isoformat()
    elif rows:
        period_start = min(r.purchase_date for r in rows).isoformat()

    return {
        "simple_roi_pct": round(simple * 100, 2) if simple is not None else None,
        "xirr_pct": round(xirr * 100, 2) if xirr is not None else None,
        "twr_pct": round(twr * 100, 2) if twr is not None else None,
        "period_start": period_start,
        "period_end": date.today().isoformat(),
        "transaction_count": len(txs),
        "snapshot_count": len(snaps),
    }


@router.get("/history")
async def history(
    days: int = Query(365, ge=7, le=3650),
    benchmark: str = Query("^GSPC", description="yfinance symbol for the benchmark line (^GSPC, URTH, ^STOXX50E, …)"),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Daily portfolio value (from snapshots) + a normalised benchmark line
    over the same window. Both are rebased to 100 at the earliest snapshot
    so they're directly comparable."""
    cutoff = date.today() - timedelta(days=days)

    # Ensure we have at least today's snapshot — useful for fresh users who
    # haven't waited for the nightly job to run yet.
    take_snapshot(db, current)

    snaps = (
        db.query(PortfolioSnapshot)
        .filter(PortfolioSnapshot.user_id == current.id, PortfolioSnapshot.snapshot_date >= cutoff)
        .order_by(PortfolioSnapshot.snapshot_date.asc())
        .all()
    )
    if not snaps:
        return {"portfolio": [], "benchmark": [], "benchmark_symbol": benchmark, "note": "no_snapshots"}

    base_value = snaps[0].total_value or 1.0
    portfolio_series = [
        {
            "date": s.snapshot_date.isoformat(),
            "value": round(s.total_value, 2),
            "normalized": round((s.total_value / base_value) * 100, 2) if base_value > 0 else 100,
        }
        for s in snaps
    ]

    # Map yfinance period from the requested day window.
    period = "1mo"
    if days > 30:
        period = "3mo"
    if days > 90:
        period = "6mo"
    if days > 180:
        period = "1y"
    if days > 365:
        period = "5y"
    if days > 1825:
        period = "10y"

    bench_series: list[dict] = []
    try:
        bench_raw = await market_service.get_historical(benchmark, period=period)
    except Exception:
        bench_raw = None
    if bench_raw:
        # Trim to our snapshot window and rebase to 100 at the first overlapping date.
        snap_start = snaps[0].snapshot_date.isoformat()
        relevant = [p for p in bench_raw if p["date"] >= snap_start]
        if relevant:
            bench_base = relevant[0]["close"] or 1.0
            bench_series = [
                {"date": p["date"], "normalized": round((p["close"] / bench_base) * 100, 2)}
                for p in relevant
                if bench_base > 0
            ]

    return {
        "portfolio": portfolio_series,
        "benchmark": bench_series,
        "benchmark_symbol": benchmark,
        "days": days,
    }
