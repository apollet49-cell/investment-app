from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import Investment, User
from schemas import DashboardSummary, InvestmentOut
from services.alerts_engine import evaluate_alerts
from services.diversification import compute_score as compute_diversification
from services.live_value import refresh_current_values

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
    )
