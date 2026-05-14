from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import TRANSACTION_TYPES, Investment, Transaction, User
from schemas import TransactionCreate, TransactionOut

router = APIRouter(tags=["transactions"])


def _to_out(t: Transaction) -> TransactionOut:
    return TransactionOut(
        id=t.id,
        investment_id=t.investment_id,
        type=t.type,
        transaction_date=t.transaction_date,
        quantity=t.quantity,
        price_per_unit=t.price_per_unit,
        amount=t.amount,
        fees=t.fees,
        notes=t.notes,
        created_at=t.created_at,
    )


@router.get("/transactions", response_model=list[dict])
async def list_all_transactions(
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    """All transactions for the user across every investment, plus a `name`
    field resolved from the parent Investment so the UI doesn't need a second
    fetch to display them."""
    rows = (
        db.query(Transaction)
        .filter(Transaction.user_id == current.id)
        .order_by(Transaction.transaction_date.desc(), Transaction.id.desc())
        .all()
    )
    inv_ids = {r.investment_id for r in rows if r.investment_id}
    name_by_id: dict[int, str] = {}
    if inv_ids:
        for inv in db.query(Investment).filter(Investment.id.in_(inv_ids)).all():
            name_by_id[inv.id] = inv.name
    return [{
        "id": t.id,
        "investment_id": t.investment_id,
        "investment_name": name_by_id.get(t.investment_id),
        "type": t.type,
        "transaction_date": t.transaction_date.isoformat() if t.transaction_date else None,
        "quantity": t.quantity,
        "price_per_unit": t.price_per_unit,
        "amount": t.amount,
        "fees": t.fees,
        "notes": t.notes,
    } for t in rows]


@router.get("/transactions/summary")
async def transactions_summary(
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Lifetime + YTD totals by transaction type."""
    rows = db.query(Transaction).filter(Transaction.user_id == current.id).all()
    this_year = date.today().year
    lifetime = {"buy": 0.0, "sell": 0.0, "dividend": 0.0, "fee": 0.0, "split": 0.0}
    ytd = {"buy": 0.0, "sell": 0.0, "dividend": 0.0, "fee": 0.0, "split": 0.0}
    for t in rows:
        if t.type in lifetime:
            lifetime[t.type] += t.amount
            if t.transaction_date and t.transaction_date.year == this_year:
                ytd[t.type] += t.amount
    return {
        "lifetime": {k: round(v, 2) for k, v in lifetime.items()},
        "ytd": {k: round(v, 2) for k, v in ytd.items()},
        "transaction_count": len(rows),
    }


@router.get("/investments/{inv_id}/transactions", response_model=list[TransactionOut])
async def list_transactions(
    inv_id: int,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> list[TransactionOut]:
    inv = db.get(Investment, inv_id)
    if not inv or inv.user_id != current.id:
        raise HTTPException(status_code=404, detail="investment not found")
    rows = (
        db.query(Transaction)
        .filter(Transaction.investment_id == inv_id)
        .order_by(Transaction.transaction_date.desc(), Transaction.id.desc())
        .all()
    )
    return [_to_out(t) for t in rows]


@router.post("/investments/{inv_id}/transactions", response_model=TransactionOut, status_code=201)
async def create_transaction(
    inv_id: int,
    payload: TransactionCreate,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TransactionOut:
    inv = db.get(Investment, inv_id)
    if not inv or inv.user_id != current.id:
        raise HTTPException(status_code=404, detail="investment not found")
    if payload.type not in TRANSACTION_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {TRANSACTION_TYPES}")
    t = Transaction(
        investment_id=inv_id,
        user_id=current.id,
        type=payload.type,
        transaction_date=payload.transaction_date,
        quantity=payload.quantity,
        price_per_unit=payload.price_per_unit,
        amount=payload.amount,
        fees=payload.fees,
        notes=payload.notes,
    )
    db.add(t)
    db.commit()
    db.refresh(t)
    return _to_out(t)


@router.delete("/transactions/{tx_id}")
async def delete_transaction(
    tx_id: int,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    t = db.get(Transaction, tx_id)
    if not t or t.user_id != current.id:
        raise HTTPException(status_code=404, detail="transaction not found")
    db.delete(t)
    db.commit()
    return Response(status_code=204)
