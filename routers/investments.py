from __future__ import annotations

import csv
import io
from datetime import date, datetime
from typing import Optional

from fastapi import APIRouter, Depends, File, HTTPException, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import INVESTMENT_TYPES, Investment, User
from schemas import (
    CSVImportResult,
    InvestmentCreate,
    InvestmentOut,
    InvestmentUpdate,
    PropertyValuationRequest,
    PropertyValuationResponse,
)
from services.live_value import refresh_current_values
from services.property_valuation import estimate_value as estimate_property_value

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
        quantity=inv.quantity,
        monthly_rental_income=inv.monthly_rental_income,
        monthly_rental_charges=inv.monthly_rental_charges,
        loan_amount=inv.loan_amount,
        loan_interest_rate_pct=inv.loan_interest_rate_pct,
        monthly_mortgage_payment=inv.monthly_mortgage_payment,
        annual_yield_pct=inv.annual_yield_pct,
        account_type=inv.account_type,
        address=inv.address,
        postal_code=inv.postal_code,
        city=inv.city,
        country=inv.country,
        surface_sqm=inv.surface_sqm,
        property_subtype=inv.property_subtype,
        garden_sqm=inv.garden_sqm,
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
    # Live market refresh runs as a fire-and-forget task so the response
    # comes back in tens of ms (previously up to 12s while yfinance was
    # walked synchronously for every symbol). Fresh prices land in the
    # DB before the next call AND the SSE broadcast pushes them to the
    # browser in real time, so the user sees the new value either way.
    # Skip when live refresh is disabled (tests, hermetic runs).
    import os as _os
    if _os.getenv("INVESTAPP_DISABLE_LIVE_REFRESH") != "1":
        import asyncio
        from database import SessionLocal
        async def _bg_refresh():
            bg_db = SessionLocal()
            try:
                bg_rows = bg_db.query(Investment).filter(Investment.user_id == current.id).all()
                updates = await refresh_current_values(bg_rows)
                if updates:
                    changed = False
                    for r in bg_rows:
                        new_val = updates.get(r.id)
                        if new_val is not None and r.current_value != new_val:
                            r.current_value = new_val
                            changed = True
                    if changed:
                        bg_db.commit()
            finally:
                bg_db.close()
        asyncio.create_task(_bg_refresh())
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
        quantity=payload.quantity,
        monthly_rental_income=payload.monthly_rental_income,
        monthly_rental_charges=payload.monthly_rental_charges,
        loan_amount=payload.loan_amount,
        loan_interest_rate_pct=payload.loan_interest_rate_pct,
        monthly_mortgage_payment=payload.monthly_mortgage_payment,
        annual_yield_pct=payload.annual_yield_pct,
        account_type=payload.account_type,
        address=payload.address,
        postal_code=payload.postal_code,
        city=payload.city,
        country=payload.country,
        surface_sqm=payload.surface_sqm,
        property_subtype=payload.property_subtype,
        garden_sqm=payload.garden_sqm,
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


class WhatIfRequest(BaseModel):
    symbol: str
    asset_type: str = "stock"


@router.post("/{inv_id}/what-if")
async def what_if(
    inv_id: int,
    payload: WhatIfRequest,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Retroactive 'what if I'd invested the same amount in X at the same date?'
    Returns the alternative current value and a delta vs the original investment."""
    from services.market_data import market_service
    from services.market_universe import market_universe

    inv = db.get(Investment, inv_id)
    if not inv or inv.user_id != current.id:
        raise HTTPException(status_code=404, detail="investment not found")

    # Historical price of the alternative at the original purchase date
    hist = await market_universe.get_price_on_date(payload.symbol, inv.purchase_date, payload.asset_type)
    if not hist or not hist.get("price"):
        raise HTTPException(status_code=404, detail=f"no historical price for {payload.symbol} on {inv.purchase_date}")

    # Current price of the alternative
    if payload.asset_type == "crypto" and "-" not in payload.symbol:
        cur = await market_service.get_crypto_price(payload.symbol.lower())
        current_price = cur.get("price_usd") if cur else None
    else:
        cur = await market_service.get_stock_price(payload.symbol)
        current_price = cur.get("price") if cur else None

    if not current_price:
        raise HTTPException(status_code=404, detail=f"no current price for {payload.symbol}")

    alt_qty = inv.amount_invested / hist["price"]
    alt_current = alt_qty * current_price
    alt_gain = alt_current - inv.amount_invested
    alt_gain_pct = (alt_gain / inv.amount_invested * 100.0) if inv.amount_invested else 0.0

    orig_gain = inv.current_value - inv.amount_invested
    orig_gain_pct = (orig_gain / inv.amount_invested * 100.0) if inv.amount_invested else 0.0

    return {
        "original": {
            "name": inv.name,
            "symbol": inv.symbol,
            "amount_invested": inv.amount_invested,
            "current_value": inv.current_value,
            "gain": round(orig_gain, 2),
            "gain_pct": round(orig_gain_pct, 2),
        },
        "alternative": {
            "symbol": payload.symbol,
            "asset_type": payload.asset_type,
            "purchase_price": round(hist["price"], 4),
            "purchase_date_used": hist.get("date_actual"),
            "current_price": round(current_price, 4),
            "implied_quantity": round(alt_qty, 8),
            "current_value": round(alt_current, 2),
            "gain": round(alt_gain, 2),
            "gain_pct": round(alt_gain_pct, 2),
        },
        "delta": {
            "value": round(alt_current - inv.current_value, 2),
            "pct_points": round(alt_gain_pct - orig_gain_pct, 2),
        },
    }


@router.post("/{inv_id}/sync-dividends")
async def sync_dividends(
    inv_id: int,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Fetch dividend history from yfinance for this investment's symbol and
    create dividend Transactions for every payment since the purchase date.
    Idempotent: skips dates that already have a dividend transaction."""
    from services.dividends import fetch_dividends
    from models import Transaction

    inv = db.get(Investment, inv_id)
    if not inv or inv.user_id != current.id:
        raise HTTPException(status_code=404, detail="investment not found")
    if not inv.symbol:
        raise HTTPException(status_code=400, detail="investment has no symbol — cannot fetch dividends")
    if inv.type not in {"stock", "etf"}:
        raise HTTPException(status_code=400, detail="dividends only supported for stocks and ETFs")
    if not inv.quantity or inv.quantity <= 0:
        raise HTTPException(status_code=400, detail="set the quantity on this investment first")

    payments = await fetch_dividends(inv.symbol)
    if payments is None:
        raise HTTPException(status_code=502, detail="dividend data source unavailable")

    existing_dates = {
        t.transaction_date for t in db.query(Transaction)
        .filter(Transaction.investment_id == inv_id, Transaction.type == "dividend").all()
    }
    inserted = 0
    skipped = 0
    for p in payments:
        if p["date"] < inv.purchase_date:
            continue  # paid before we held the asset
        if p["date"] in existing_dates:
            skipped += 1
            continue
        amount = inv.quantity * p["dividend_per_share"]
        if amount <= 0:
            continue
        t = Transaction(
            investment_id=inv_id,
            user_id=current.id,
            type="dividend",
            transaction_date=p["date"],
            quantity=None,
            price_per_unit=p["dividend_per_share"],
            amount=round(amount, 2),
            fees=None,
            notes=f"Auto-imported via yfinance ({p['dividend_per_share']} per share)",
        )
        db.add(t)
        inserted += 1
    db.commit()
    return {
        "imported": inserted,
        "skipped_already_present": skipped,
        "total_payments_found": len(payments),
    }


@router.post("/estimate-value", response_model=PropertyValuationResponse)
async def estimate_value_endpoint(
    payload: PropertyValuationRequest,
    current: User = Depends(get_current_user),
) -> PropertyValuationResponse:
    """Look up comparable real-estate transactions and return an estimated value.
    Currently supports France (DVF). Other countries return `unsupported_country`."""
    result = await estimate_property_value(
        postal_code=payload.postal_code,
        country=payload.country,
        surface_sqm=payload.surface_sqm,
        property_subtype=payload.property_subtype,
    )
    return PropertyValuationResponse(**result)


REQUIRED_CSV_COLS = {"name", "type", "amount_invested", "current_value", "purchase_date"}
OPTIONAL_CSV_COLS = {
    "symbol", "notes", "quantity", "account_type",
    "monthly_rental_income", "monthly_rental_charges",
    "loan_amount", "loan_interest_rate_pct", "monthly_mortgage_payment",
    "annual_yield_pct", "address", "postal_code", "city", "country",
    "surface_sqm", "property_subtype", "garden_sqm",
    # Accepted but ignored on re-import — exported for human reference.
    "id", "roi_pct",
}


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
    # Pre-compute the user's existing investment ids so re-importing the
    # app's own CSV export doesn't double the portfolio. Rows whose `id`
    # matches an existing investment are skipped (we treat the CSV as a
    # NEW-rows feed, not an upsert).
    existing_ids = {
        i_id for (i_id,) in db.query(Investment.id).filter(Investment.user_id == current.id).all()
    }
    for i, row in enumerate(reader, start=2):  # row 1 is header
        try:
            inv_type = row["type"].strip().lower()
            if inv_type not in INVESTMENT_TYPES:
                raise ValueError(f"invalid type '{inv_type}'")
            row_id_raw = (row.get("id") or "").strip()
            if row_id_raw:
                try:
                    # int(float(...)) handles "12.0" that Excel emits when it
                    # round-trips a numeric column. Catches floats and ints.
                    row_id = int(float(row_id_raw))
                    if row_id in existing_ids:
                        skipped += 1
                        continue
                except (ValueError, TypeError):
                    pass  # ignore malformed id, treat as new row
            def _opt_float(key: str) -> Optional[float]:
                v = (row.get(key) or "").strip()
                return float(v) if v else None

            def _opt_str(key: str) -> Optional[str]:
                v = (row.get(key) or "").strip()
                return v or None

            amt = float(row["amount_invested"])
            cur = float(row["current_value"])
            if amt <= 0:
                raise ValueError(f"amount_invested must be > 0 (got {amt})")
            if cur < 0:
                raise ValueError(f"current_value cannot be negative (got {cur})")
            inv = Investment(
                user_id=current.id,
                name=row["name"].strip(),
                type=inv_type,
                symbol=_opt_str("symbol"),
                amount_invested=amt,
                current_value=cur,
                purchase_date=_parse_date(row["purchase_date"]),
                notes=_opt_str("notes"),
                quantity=_opt_float("quantity"),
                account_type=_opt_str("account_type"),
                monthly_rental_income=_opt_float("monthly_rental_income"),
                monthly_rental_charges=_opt_float("monthly_rental_charges"),
                loan_amount=_opt_float("loan_amount"),
                loan_interest_rate_pct=_opt_float("loan_interest_rate_pct"),
                monthly_mortgage_payment=_opt_float("monthly_mortgage_payment"),
                annual_yield_pct=_opt_float("annual_yield_pct"),
                address=_opt_str("address"),
                postal_code=_opt_str("postal_code"),
                city=_opt_str("city"),
                country=_opt_str("country"),
                surface_sqm=_opt_float("surface_sqm"),
                property_subtype=_opt_str("property_subtype"),
                garden_sqm=_opt_float("garden_sqm"),
            )
            db.add(inv)
            imported += 1
        except Exception as e:
            skipped += 1
            errors.append(f"row {i}: {e}")
    db.commit()
    return CSVImportResult(imported=imported, skipped=skipped, errors=errors[:50])


def _parse_date(s: str) -> date:
    """Accept ISO and unambiguous date formats. We avoid the dd/mm vs mm/dd
    ambiguity by NOT supporting either with separator '/' — users should
    re-format to ISO (YYYY-MM-DD) or use '.' / '-' which we treat as
    European (day-first). This is intentional: a CSV with '01/02/2024'
    silently parsed as 1-Feb in one locale and 2-Jan in another is a worse
    failure mode than rejecting the import."""
    s = s.strip()
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%d.%m.%Y", "%d-%m-%Y"):
        try:
            return datetime.strptime(s, fmt).date()
        except ValueError:
            continue
    raise ValueError(
        f"unrecognised date format: {s!r} (use YYYY-MM-DD, or DD.MM.YYYY / DD-MM-YYYY)"
    )


class SeedDemoRequest(BaseModel):
    # Explicit acknowledgement that the caller is OK with destructive wipe.
    # The frontend sends `{"confirm_wipe": true}` after a confirm() prompt;
    # a CSRF replay without this body returns 400 instead of nuking data.
    confirm_wipe: bool = False


@router.post("/seed-demo")
async def seed_demo(
    payload: SeedDemoRequest,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Populate the current user's account with a realistic demo portfolio
    (~21 investments across all types, 50+ transactions, DCA plans, alerts,
    watchlist, 18 months of daily snapshots).

    Wipes any existing data for this user, so the request body MUST include
    `confirm_wipe: true` — protects against CSRF / accidental call from a
    third-party page silently nuking a real user's portfolio."""
    if not payload.confirm_wipe:
        raise HTTPException(status_code=400, detail="confirm_wipe=true required to replace existing data")
    from services.demo_seed import seed_user
    result = seed_user(db, current)
    return {"ok": True, **result}
