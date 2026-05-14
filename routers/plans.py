"""DCA (Dollar-Cost-Averaging) plans + projection.

Stores the recurring-investment configuration and simulates its trajectory
over a chosen horizon. Doesn't actually execute trades — pure planning tool.
"""
from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import DCAPlan, User
from schemas import DCAPlanCreate, DCAPlanOut

router = APIRouter(prefix="/plans", tags=["plans"])

VALID_TYPES = {"stock", "etf", "crypto"}
VALID_FREQUENCIES = {"weekly", "biweekly", "monthly", "quarterly"}

# How many contributions per year for each frequency.
FREQ_PER_YEAR = {"weekly": 52, "biweekly": 26, "monthly": 12, "quarterly": 4}


def _to_out(p: DCAPlan) -> DCAPlanOut:
    return DCAPlanOut(
        id=p.id, name=p.name, symbol=p.symbol, asset_type=p.asset_type,
        amount=p.amount, frequency=p.frequency, day_of_month=p.day_of_month,
        start_date=p.start_date, is_active=p.is_active,
        created_at=p.created_at,
    )


@router.get("/dca", response_model=list[DCAPlanOut])
async def list_dca(
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[DCAPlanOut]:
    rows = db.query(DCAPlan).filter(DCAPlan.user_id == current.id).order_by(DCAPlan.created_at.desc()).all()
    return [_to_out(p) for p in rows]


@router.post("/dca", response_model=DCAPlanOut, status_code=201)
async def create_dca(
    payload: DCAPlanCreate,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> DCAPlanOut:
    if payload.asset_type not in VALID_TYPES:
        raise HTTPException(status_code=400, detail=f"asset_type must be one of {sorted(VALID_TYPES)}")
    if payload.frequency not in VALID_FREQUENCIES:
        raise HTTPException(status_code=400, detail=f"frequency must be one of {sorted(VALID_FREQUENCIES)}")
    p = DCAPlan(
        user_id=current.id,
        name=payload.name,
        symbol=(payload.symbol or "").strip().upper() or None,
        asset_type=payload.asset_type,
        amount=payload.amount,
        frequency=payload.frequency,
        day_of_month=payload.day_of_month,
        start_date=payload.start_date,
        is_active=payload.is_active,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    return _to_out(p)


@router.delete("/dca/{pid}")
async def delete_dca(
    pid: int,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    p = db.get(DCAPlan, pid)
    if not p or p.user_id != current.id:
        raise HTTPException(status_code=404, detail="plan not found")
    db.delete(p)
    db.commit()
    return Response(status_code=204)


@router.get("/dca/{pid}/simulate")
async def simulate_dca(
    pid: int,
    years: float = Query(default=10, ge=0.5, le=50),
    expected_return_pct: float = Query(default=7.0, ge=-50, le=50),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Simulate the DCA plan's accumulated value over N years given an
    expected annual return. Compares DCA to a single lump-sum on the same total."""
    p = db.get(DCAPlan, pid)
    if not p or p.user_id != current.id:
        raise HTTPException(status_code=404, detail="plan not found")

    per_year = FREQ_PER_YEAR.get(p.frequency, 12)
    total_periods = int(years * per_year)
    if total_periods < 1:
        total_periods = 1
    r_period = (1 + expected_return_pct / 100.0) ** (1 / per_year) - 1

    contributed = 0.0
    portfolio_dca = 0.0
    trajectory_dca = []
    trajectory_lump = []
    total_to_invest = total_periods * p.amount
    portfolio_lump = total_to_invest

    for k in range(total_periods + 1):
        if k > 0:
            portfolio_dca = portfolio_dca * (1 + r_period) + p.amount
            contributed += p.amount
            portfolio_lump = portfolio_lump * (1 + r_period)
        trajectory_dca.append({"period": k, "value": round(portfolio_dca, 2), "contributed": round(contributed, 2)})
        trajectory_lump.append({"period": k, "value": round(portfolio_lump, 2)})

    return {
        "plan": _to_out(p).model_dump(),
        "years": years,
        "frequency": p.frequency,
        "periods_per_year": per_year,
        "expected_return_pct": expected_return_pct,
        "total_contributed": round(total_to_invest, 2),
        "final_value_dca": round(portfolio_dca, 2),
        "final_value_lump_sum": round(portfolio_lump, 2),
        "dca_minus_lump": round(portfolio_dca - portfolio_lump, 2),
        "trajectory_dca": trajectory_dca,
        "trajectory_lump_sum": trajectory_lump,
    }
