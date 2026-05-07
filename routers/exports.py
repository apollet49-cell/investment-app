from __future__ import annotations

import csv
import io
from datetime import date

from fastapi import APIRouter, Depends
from fastapi.responses import Response, StreamingResponse
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import Investment, Scenario, User
from services.pdf_report import generate_pdf

router = APIRouter(prefix="/exports", tags=["exports"])


@router.get("/csv")
async def export_portfolio_csv(current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> StreamingResponse:
    rows = db.query(Investment).filter(Investment.user_id == current.id).all()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "name", "type", "symbol", "amount_invested", "current_value", "purchase_date", "notes", "roi_pct"])
    for r in rows:
        roi = ((r.current_value - r.amount_invested) / r.amount_invested * 100.0) if r.amount_invested > 0 else 0.0
        writer.writerow([r.id, r.name, r.type, r.symbol or "", r.amount_invested, r.current_value, r.purchase_date.isoformat(), r.notes or "", round(roi, 2)])
    buf.seek(0)
    filename = f"portfolio-{date.today().isoformat()}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/scenarios.csv")
async def export_scenarios_csv(current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> StreamingResponse:
    rows = db.query(Scenario).filter(Scenario.user_id == current.id).all()
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["id", "name", "amount", "horizon_months", "annual_return_pct", "inflation_rate_pct", "risk_level"])
    for r in rows:
        writer.writerow([r.id, r.name, r.amount, r.horizon_months, r.annual_return, r.inflation_rate, r.risk_level])
    buf.seek(0)
    filename = f"scenarios-{date.today().isoformat()}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@router.get("/pdf")
async def export_pdf(current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> Response:
    pdf = generate_pdf(db, current)
    filename = f"investment-report-{date.today().isoformat()}.pdf"
    return Response(
        content=pdf,
        media_type="application/pdf",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
