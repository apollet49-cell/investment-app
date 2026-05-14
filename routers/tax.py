from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import Investment, User
from services.tax import compute as compute_tax

router = APIRouter(prefix="/tax", tags=["tax"])


@router.get("/summary")
async def summary(
    tmi: float = Query(30.0, ge=0, le=45),
    pea_years: float = Query(5.0, ge=0, le=40),
    av_years: float = Query(8.0, ge=0, le=40),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Per-wrapper tax simulation. All amounts are in the canonical USD
    storage; the frontend converts via the user FX rate at display time."""
    rows = db.query(Investment).filter(Investment.user_id == current.id).all()
    return compute_tax(rows, tmi_pct=tmi, pea_years_held=pea_years, av_years_held=av_years)
