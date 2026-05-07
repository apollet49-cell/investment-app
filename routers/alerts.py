from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import ALERT_SCOPES, ALERT_TYPES, Alert, Investment, User
from schemas import AlertCreate, AlertOut

router = APIRouter(prefix="/alerts", tags=["alerts"])


def _to_out(a: Alert) -> AlertOut:
    return AlertOut(
        id=a.id,
        type=a.type,
        threshold=a.threshold,
        scope=a.scope,
        investment_id=a.investment_id,
        is_active=a.is_active,
        is_triggered=a.is_triggered,
        dismissed_at=a.dismissed_at,
        created_at=a.created_at,
    )


@router.post("/", response_model=AlertOut, status_code=201)
async def create_alert(payload: AlertCreate, current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> AlertOut:
    if payload.type not in ALERT_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {ALERT_TYPES}")
    if payload.scope not in ALERT_SCOPES:
        raise HTTPException(status_code=400, detail=f"scope must be one of {ALERT_SCOPES}")
    if payload.scope == "investment":
        if not payload.investment_id:
            raise HTTPException(status_code=400, detail="investment_id required for scope=investment")
        inv = db.get(Investment, payload.investment_id)
        if not inv or inv.user_id != current.id:
            raise HTTPException(status_code=404, detail="investment not found")
    a = Alert(
        user_id=current.id,
        type=payload.type,
        threshold=payload.threshold,
        scope=payload.scope,
        investment_id=payload.investment_id,
    )
    db.add(a)
    db.commit()
    db.refresh(a)
    return _to_out(a)


@router.get("/", response_model=list[AlertOut])
async def list_alerts(current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[AlertOut]:
    rows = db.query(Alert).filter(Alert.user_id == current.id).order_by(Alert.created_at.desc()).all()
    return [_to_out(a) for a in rows]


@router.post("/{aid}/dismiss", response_model=AlertOut)
async def dismiss_alert(aid: int, current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> AlertOut:
    a = db.get(Alert, aid)
    if not a or a.user_id != current.id:
        raise HTTPException(status_code=404, detail="alert not found")
    a.dismissed_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(a)
    return _to_out(a)


@router.delete("/{aid}")
async def delete_alert(aid: int, current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    a = db.get(Alert, aid)
    if not a or a.user_id != current.id:
        raise HTTPException(status_code=404, detail="alert not found")
    db.delete(a)
    db.commit()
    return Response(status_code=204)
