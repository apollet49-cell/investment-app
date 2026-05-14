"""Planning endpoints: stress tests, FIRE calculator, rebalancing.

Grouped under /planning since they all answer "what if?" / "how do I get
there?" questions rather than reporting current state."""
from __future__ import annotations

from fastapi import APIRouter, Body, Depends, Query
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import Investment, User
from services.fire import compute as compute_fire
from services.rebalancing import compute as compute_rebalancing
from services.stress_test import run as run_stress_test

router = APIRouter(prefix="/planning", tags=["planning"])


@router.get("/stress-test")
async def stress_test(
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Apply built-in market-shock scenarios to the user's portfolio."""
    rows = db.query(Investment).filter(Investment.user_id == current.id).all()
    return run_stress_test(rows)


@router.get("/fire")
async def fire(
    monthly_expenses: float = Query(2000, ge=0, le=100000),
    monthly_savings: float = Query(1000, ge=0, le=100000),
    expected_return_pct: float = Query(7.0, ge=-50, le=50),
    target_multiplier: float = Query(25.0, ge=10, le=50),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Years-to-financial-independence given current portfolio + monthly
    savings + expected return + monthly expenses."""
    rows = db.query(Investment).filter(Investment.user_id == current.id).all()
    current_portfolio = sum(r.current_value or 0 for r in rows)
    return compute_fire(
        current_portfolio=current_portfolio,
        monthly_expenses=monthly_expenses,
        monthly_savings=monthly_savings,
        expected_return_pct=expected_return_pct,
        target_multiplier=target_multiplier,
    )


@router.post("/rebalance")
async def rebalance(
    payload: dict = Body(...),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Body: `{target_by_type: {type: pct}, new_contribution: number?}`.
    Returns drift per type + buy/sell actions to converge."""
    target = payload.get("target_by_type", {}) or {}
    # Coerce values to float, ignore zero/empty weights
    target_clean: dict[str, float] = {}
    for k, v in target.items():
        try:
            f = float(v)
        except (TypeError, ValueError):
            continue
        if f > 0:
            target_clean[k] = f
    new_contribution = float(payload.get("new_contribution") or 0)
    rows = db.query(Investment).filter(Investment.user_id == current.id).all()
    return compute_rebalancing(rows, target_by_type=target_clean, new_contribution=new_contribution)
