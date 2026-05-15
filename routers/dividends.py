from __future__ import annotations

import asyncio

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
    # Fan out the dividend metadata fetches in parallel. Previously this
    # endpoint did:
    #   upcoming = await upcoming_calendar(rows)   # gather() inside
    #   for r in rows: await fetch_dividend_metadata(r.symbol)
    # Two passes over the same symbols, the second one SEQUENTIAL. With a
    # 10-stock portfolio that's 10× one-at-a-time yfinance hits. Now we
    # fan out both calls together so the slowest tickers determine the
    # latency, not the sum.
    holders = [r for r in rows if r.symbol and r.type in ("stock", "etf") and r.quantity]
    metas, upcoming = await asyncio.gather(
        asyncio.gather(*(fetch_dividend_metadata(r.symbol) for r in holders)),
        upcoming_calendar(rows),
    )
    total_annual_estimate = 0.0
    for r, meta in zip(holders, metas):
        if meta.get("ttm_dividend"):
            total_annual_estimate += r.quantity * meta["ttm_dividend"]
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
