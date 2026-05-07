from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user, hash_password
from crypto import encrypt
from database import get_db
from models import SUPPORTED_CURRENCIES, User
from schemas import SettingsUpdate, UserOut

router = APIRouter(prefix="/settings", tags=["settings"])


def _to_out(u: User) -> UserOut:
    return UserOut(
        id=u.id,
        email=u.email,
        name=u.name,
        currency=u.currency,
        has_anthropic_key=u.encrypted_anthropic_key is not None,
        created_at=u.created_at,
    )


@router.put("/", response_model=UserOut)
async def update_settings(
    payload: SettingsUpdate,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> UserOut:
    if payload.email and payload.email != current.email:
        if db.query(User).filter(User.email == payload.email).first():
            raise HTTPException(status_code=409, detail="email already in use")
        current.email = payload.email
    if payload.name is not None:
        current.name = payload.name
    if payload.password:
        current.hashed_password = hash_password(payload.password)
    if payload.currency:
        if payload.currency not in SUPPORTED_CURRENCIES:
            raise HTTPException(status_code=400, detail=f"currency must be one of {SUPPORTED_CURRENCIES}")
        current.currency = payload.currency
    if payload.anthropic_api_key is not None:
        if payload.anthropic_api_key.strip() == "":
            current.encrypted_anthropic_key = None
        else:
            current.encrypted_anthropic_key = encrypt(payload.anthropic_api_key.strip())
    db.commit()
    db.refresh(current)
    return _to_out(current)
