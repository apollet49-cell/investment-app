from __future__ import annotations

from datetime import date

from fastapi import APIRouter, Body, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import Investment, User
from services.wallet_sync import fetch_btc_balance, fetch_eth_balance

router = APIRouter(prefix="/wallet", tags=["wallet"])


@router.post("/preview")
async def preview(
    chain: str = Body(..., embed=True),
    address: str = Body(..., embed=True),
) -> dict:
    """Read-only check: return the balance for the given chain + address.
    Does NOT touch the user's portfolio — call /wallet/sync to actually save."""
    chain = (chain or "").lower()
    if chain == "btc":
        fn = fetch_btc_balance
    elif chain == "eth":
        fn = fetch_eth_balance
    else:
        raise HTTPException(status_code=400, detail="chain must be 'btc' or 'eth'")
    try:
        return await fn(address)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/sync")
async def sync(
    chain: str = Body(..., embed=True),
    address: str = Body(..., embed=True),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Fetch the balance and add it as an Investment for the current user.
    Idempotent on (user_id, symbol, notes-contains-address) — re-syncing the
    same address updates the existing row instead of creating duplicates."""
    chain = (chain or "").lower()
    if chain == "btc":
        fn = fetch_btc_balance
        symbol = "BTC"
        name = "Bitcoin wallet"
    elif chain == "eth":
        fn = fetch_eth_balance
        symbol = "ETH"
        name = "Ethereum wallet"
    else:
        raise HTTPException(status_code=400, detail="chain must be 'btc' or 'eth'")

    try:
        wallet = await fn(address)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    balance_usd = wallet["balance_usd"] or 0.0
    note = f"Synced from {symbol} address {wallet['address']}"

    # Idempotency: find an existing row with the same address in its notes
    existing = (
        db.query(Investment)
        .filter(Investment.user_id == current.id,
                Investment.symbol == symbol,
                Investment.notes.like(f"%{wallet['address']}%"))
        .first()
    )
    if existing:
        existing.quantity = wallet["balance"]
        existing.current_value = balance_usd
        # We don't overwrite amount_invested — that was set at the original sync
        db.commit()
        db.refresh(existing)
        action = "updated"
    else:
        inv = Investment(
            user_id=current.id,
            name=name,
            type="crypto",
            symbol=symbol,
            amount_invested=balance_usd if balance_usd > 0 else 0.01,  # gt=0 constraint in schema
            current_value=balance_usd,
            quantity=wallet["balance"],
            purchase_date=date.today(),
            notes=note,
        )
        db.add(inv)
        db.commit()
        db.refresh(inv)
        existing = inv
        action = "created"

    return {
        "action": action,
        "wallet": wallet,
        "investment_id": existing.id,
    }
