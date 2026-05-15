from __future__ import annotations

import asyncio
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
from services.clock import today_utc
from services.live_value import refresh_current_values
from services.market_data import market_service
from services.risk import compute_risk_metrics
from services.performance import (
    compute_simple_roi,
    compute_twr_from_snapshots,
    compute_xirr_from_transactions,
)
from services.snapshots import take_snapshot

router = APIRouter(prefix="/dashboard", tags=["dashboard"])


def _to_out(inv: Investment) -> InvestmentOut:
    """Convert SQLAlchemy → Pydantic using model_validate so every column on
    Investment (quantity, account_type, real-estate fields, etc.) flows
    through automatically — avoids silently dropping fields when the model
    gains new ones."""
    roi = 0.0
    if inv.amount_invested > 0:
        roi = (inv.current_value - inv.amount_invested) / inv.amount_invested * 100.0
    out = InvestmentOut.model_validate(inv)
    out.roi_pct = round(roi, 2)
    return out


@router.get("/summary", response_model=DashboardSummary)
async def summary(current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> DashboardSummary:
    rows = db.query(Investment).filter(Investment.user_id == current.id).all()
    # Live market refresh runs as a fire-and-forget background task so the
    # dashboard renders instantly with stored values. Fresh prices land in
    # the DB before the next 60s auto-refresh — no user-visible wait on
    # slow yfinance/CoinGecko. Skip when live refresh is disabled (tests).
    import os as _os
    if _os.getenv("INVESTAPP_DISABLE_LIVE_REFRESH") != "1":
        async def _bg_refresh():
            from database import SessionLocal
            bg_db = SessionLocal()
            try:
                bg_rows = bg_db.query(Investment).filter(Investment.user_id == current.id).all()
                updates = await refresh_current_values(bg_rows)
                if updates:
                    changed = False
                    for r in bg_rows:
                        new_val = updates.get(r.id)
                        if new_val is not None and r.current_value != new_val:
                            r.current_value = new_val
                            changed = True
                    if changed:
                        bg_db.commit()
            finally:
                bg_db.close()
        asyncio.create_task(_bg_refresh())
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
    today = today_utc()
    # Real month boundaries (subtract 1 month at a time) rather than crude
    # `today - 30*i` which drifts on long horizons and breaks for February.
    def _months_ago(d: date, n: int) -> date:
        m = d.month - n
        y = d.year
        while m <= 0:
            m += 12
            y -= 1
        # Clamp day to the last day of the target month to avoid Feb 30 etc.
        from calendar import monthrange
        day = min(d.day, monthrange(y, m)[1])
        return date(y, m, day)

    months_back = 12
    portfolio_over_time: list[dict[str, float | str]] = []
    for i in range(months_back, -1, -1):
        month_date = _months_ago(today, i)
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

    # Skip months where prev value was 0 (e.g. before the user's first
    # purchase) — those would show as misleading flat "0.0%" bars.
    monthly_returns: list[dict[str, float | str]] = []
    for i in range(1, len(portfolio_over_time)):
        prev = portfolio_over_time[i - 1]["value"]
        curr = portfolio_over_time[i]["value"]
        if prev <= 0:
            continue
        ret = (curr - prev) / prev * 100.0
        monthly_returns.append({"month": portfolio_over_time[i]["date"], "return_pct": round(ret, 2)})

    triggered = evaluate_alerts(db, current, investments=rows)
    # diversification + carbon are pure-Python loops over `rows`; with a
    # large portfolio they can take ~10-30ms each. Offload to a worker
    # thread so we don't block the asyncio event loop while other users'
    # requests are waiting (matters under concurrent load on the free tier).
    diversification, carbon = await asyncio.gather(
        asyncio.to_thread(compute_diversification, rows),
        asyncio.to_thread(compute_carbon, rows),
    )

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
        # Only buys/sells are external cashflows for the TWR sub-period start
        # adjustment. Dividends and fees come from inside the portfolio (they
        # change the snapshot value organically, not via new money in/out).
        if tx.type == "buy":
            contribs_by_date[tx.transaction_date] += amt
        elif tx.type == "sell":
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
        "period_end": today_utc().isoformat(),
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
    cutoff = today_utc() - timedelta(days=days)

    # Snapshot for today happens in the background — fire-and-forget. The
    # chart endpoint shouldn't pay the 3-query write cost on the user's
    # request path. If today's snapshot isn't there yet, the chart will be
    # one day shorter; the missing point lands by the next request or the
    # 6h scheduler tick. Previously this ran via to_thread and added ~15ms
    # to every history call.
    from database import SessionLocal
    user_id = current.id
    async def _bg_snap():
        bg_db = SessionLocal()
        try:
            bg_user = bg_db.get(User, user_id)
            if bg_user:
                await asyncio.to_thread(take_snapshot, bg_db, bg_user)
        finally:
            bg_db.close()
    asyncio.create_task(_bg_snap())

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


@router.get("/risk")
async def risk(
    days: int = Query(180, ge=30, le=3650),
    benchmark: str = Query("^GSPC"),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Real portfolio risk metrics from daily snapshots:
    annualised volatility, max drawdown, beta vs benchmark, Sharpe ratio,
    and a composite score 0-100. Replaces the previous concentration-only
    "risk score" which was just cosmetic.

    Requires at least 30 daily snapshots; otherwise returns
    `{score: null, reason: "insufficient_history"}` so the UI can fall
    back to a "checking back in N days" message."""
    cutoff = today_utc() - timedelta(days=days)
    snaps = (
        db.query(PortfolioSnapshot)
        .filter(PortfolioSnapshot.user_id == current.id, PortfolioSnapshot.snapshot_date >= cutoff)
        .order_by(PortfolioSnapshot.snapshot_date.asc())
        .all()
    )
    portfolio_values = [s.total_value for s in snaps]

    # Pull a matching benchmark series for beta (best-effort).
    period = "6mo" if days <= 180 else "1y" if days <= 365 else "5y"
    bench_values: list[float] = []
    try:
        bench_raw = await market_service.get_historical(benchmark, period=period)
        if bench_raw and snaps:
            snap_start = snaps[0].snapshot_date.isoformat()
            bench_values = [float(p["close"]) for p in bench_raw if p["date"] >= snap_start]
    except Exception:
        pass

    metrics = compute_risk_metrics(portfolio_values, bench_values or None)
    metrics["benchmark_symbol"] = benchmark
    metrics["window_days"] = days
    return metrics
