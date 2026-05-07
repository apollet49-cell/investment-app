from __future__ import annotations

import csv
import io
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import INVESTMENT_TYPES, Investment, User
from schemas import CSVImportResult, InvestmentCreate, InvestmentOut, InvestmentUpdate

router = APIRouter(prefix="/investments", tags=["investments"])


def _to_out(inv: Investment) -> InvestmentOut:
    roi = 0.0
    if inv.amount_invested and inv.amount_invested > 0:
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


def _validate_type(t: str) -> None:
    if t not in INVESTMENT_TYPES:
        raise HTTPException(status_code=400, detail=f"type must be one of {INVESTMENT_TYPES}")


@router.get("/", response_model=list[InvestmentOut])
async def list_investments(current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[InvestmentOut]:
    rows = db.query(Investment).filter(Investment.user_id == current.id).order_by(Investment.created_at.desc()).all()
    return [_to_out(r) for r in rows]


@router.post("/", response_model=InvestmentOut, status_code=201)
async def create_investment(
    payload: InvestmentCreate,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> InvestmentOut:
    _validate_type(payload.type)
    inv = Investment(
        user_id=current.id,
        name=payload.name,
        type=payload.type,
        symbol=payload.symbol,
        amount_invested=payload.amount_invested,
        current_value=payload.current_value,
        purchase_date=payload.purchase_date,
        notes=payload.notes,
    )
    db.add(inv)
    db.commit()
    db.refresh(inv)
    return _to_out(inv)


@router.put("/{inv_id}", response_model=InvestmentOut)
async def update_investment(
    inv_id: int,
    payload: InvestmentUpdate,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> InvestmentOut:
    inv = db.get(Investment, inv_id)
    if not inv or inv.user_id != current.id:
        raise HTTPException(status_code=404, detail="investment not found")
    data = payload.model_dump(exclude_unset=True)
    if "type" in data:
        _validate_type(data["type"])
    for k, v in data.items():
        setattr(inv, k, v)
    db.commit()
    db.refresh(inv)
    return _to_out(inv)


@router.delete("/{inv_id}")
async def delete_investment(
    inv_id: int,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    inv = db.get(Investment, inv_id)
    if not inv or inv.user_id != current.id:
        raise HTTPException(status_code=404, detail="investment not found")
    db.delete(inv)
    db.commit()
    return Response(status_code=204)


REQUIRED_CSV_COLS = {"name", "type", "amount_invested", "current_value", "purchase_date"}
OPTIONAL_CSV_COLS = {"symbol", "notes"}


@router.post("/import", response_model=CSVImportResult)
async def import_csv(
    file: UploadFile = File(...),
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> CSVImportResult:
    raw = await file.read()
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="file must be UTF-8 encoded CSV")
    reader = csv.DictReader(io.StringIO(text))
    if not reader.fieldnames:
        raise HTTPException(status_code=400, detail="empty CSV")
    cols = {c.strip() for c in reader.fieldnames}
    missing = REQUIRED_CSV_COLS - cols
    if missing:
        raise HTTPException(status_code=400, detail=f"missing required columns: {sorted(missing)}")
    unknown = cols - REQUIRED_CSV_COLS - OPTIONAL_CSV_COLS
    if unknown:
        raise HTTPException(status_code=400, detail=f"unknown columns: {sorted(unknown)}")

    imported = 0
    skipped = 0
    errors: list[str] = []
    for i, row in enumerate(reader, start=2):  # row 1 is header
        try:
            inv_type = row["type"].strip().lower()
            if inv_type not in INVESTMENT_TYPES:
                raise ValueError(f"invalid type '{inv_type}'")
            inv = Investment(
                user_id=current.id,
                name=row["name"].strip(),
                type=inv_type,
                symbol=(row.get("symbol") or "").strip() or None,
                amount_invested=float(row["amount_invested"]),
                current_value=float(row["current_value"]),
                purchase_date=_parse_date(row["purchase_date"]),
                notes=(row.get("notes") or "").strip() or None,
            )
            db.add(inv)
            imported += 1
        except Exception as e:
            skipped += 1
            errors.append(f"row {i}: {e}")
    db.commit()
    return CSVImportResult(imported=imported, skipped=skipped, errors=errors[:50])


def _parse_date(s: str) -> date:
    s = s.strip()
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(f"unrecognised date format: {s}")
