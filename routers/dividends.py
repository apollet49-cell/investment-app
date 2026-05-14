from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import Investment, User
from services.dividends import fetch_dividend_metadata, upcoming_calendar

router = APIRouter(prefix="/dividends", tags=["dividends"])


@router.get("/calendar")
async def calendar(
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Upcoming ex-dividend dates + estimated payouts across the user's portfolio."""
    rows = db.query(Investment).filter(Investment.user_id == current.id).all()
    upcoming = await upcoming_calendar(rows)
    # Aggregate annual income estimate from TTM dividends × quantity held.
    total_annual_estimate = 0.0
    for r in rows:
        if r.symbol and r.type in ("stock", "etf") and r.quantity:
            d = await fetch_dividend_metadata(r.symbol)
            if d.get("ttm_dividend"):
                total_annual_estimate += r.quantity * d["ttm_dividend"]
    return {
        "upcoming": upcoming,
        "annual_income_estimate_usd": round(total_annual_estimate, 2),
    }


@router.get("/{inv_id}")
async def per_investment(
    inv_id: int,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    inv = db.get(Investment, inv_id)
    if not inv or inv.user_id != current.id:
        raise HTTPException(status_code=404, detail="investment not found")
    if not inv.symbol:
        raise HTTPException(status_code=400, detail="investment has no symbol")
    return await fetch_dividend_metadata(inv.symbol)
