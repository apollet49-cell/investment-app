from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy.orm import Session

from auth import get_current_user
from database import get_db
from models import RISK_LEVELS, Scenario, User
from schemas import ScenarioCreate, ScenarioOut, ScenarioSimulation, ScenarioSubResult

router = APIRouter(prefix="/scenarios", tags=["scenarios"])


def _project(amount: float, annual_return_pct: float, horizon_months: int, inflation_pct: float) -> list[dict[str, float]]:
    monthly_rate = (1 + annual_return_pct / 100.0) ** (1 / 12.0) - 1
    monthly_inflation = (1 + inflation_pct / 100.0) ** (1 / 12.0) - 1
    points = []
    value = amount
    real_value = amount
    for m in range(horizon_months + 1):
        if m > 0:
            value *= 1 + monthly_rate
            real_value = value / ((1 + monthly_inflation) ** m)
        points.append({"month": m, "value": round(value, 2), "value_real": round(real_value, 2)})
    return points


def _build_sub(label: str, amount: float, annual_return_pct: float, horizon_months: int, inflation_pct: float) -> ScenarioSubResult:
    points = _project(amount, annual_return_pct, horizon_months, inflation_pct)
    return ScenarioSubResult(
        label=label,
        annual_return=annual_return_pct,
        final_value=points[-1]["value"],
        final_value_real=points[-1]["value_real"],
        points=points,
    )


def _to_out(s: Scenario) -> ScenarioOut:
    return ScenarioOut(
        id=s.id,
        user_id=s.user_id,
        name=s.name,
        amount=s.amount,
        horizon_months=s.horizon_months,
        annual_return=s.annual_return,
        inflation_rate=s.inflation_rate,
        risk_level=s.risk_level,
        created_at=s.created_at,
    )


def _recommendation(real_final: float, amount: float, risk: str) -> str:
    growth_pct = (real_final - amount) / amount * 100.0 if amount else 0.0
    if growth_pct < 0:
        return "Real returns are negative after inflation. Consider lower-fee assets or a longer horizon."
    if risk == "low" and growth_pct < 20:
        return "Steady but modest growth — appropriate for a conservative profile."
    if risk == "high" and growth_pct > 80:
        return "High projected upside, but verify with stress tests on the pessimistic scenario."
    if 20 <= growth_pct <= 80:
        return "Balanced risk/return profile — a strong candidate for inclusion in a diversified portfolio."
    return "Reasonable projection — diversify across asset types to reduce idiosyncratic risk."


@router.post("/", response_model=ScenarioOut, status_code=201)
async def create_scenario(payload: ScenarioCreate, current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> ScenarioOut:
    if payload.risk_level not in RISK_LEVELS:
        raise HTTPException(status_code=400, detail=f"risk_level must be one of {RISK_LEVELS}")
    s = Scenario(
        user_id=current.id,
        name=payload.name,
        amount=payload.amount,
        horizon_months=payload.horizon_months,
        annual_return=payload.annual_return,
        inflation_rate=payload.inflation_rate,
        risk_level=payload.risk_level,
    )
    db.add(s)
    db.commit()
    db.refresh(s)
    return _to_out(s)


@router.get("/", response_model=list[ScenarioOut])
async def list_scenarios(current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> list[ScenarioOut]:
    rows = db.query(Scenario).filter(Scenario.user_id == current.id).order_by(Scenario.created_at.desc()).all()
    return [_to_out(s) for s in rows]


@router.delete("/{sid}")
async def delete_scenario(sid: int, current: User = Depends(get_current_user), db: Session = Depends(get_db)):
    s = db.get(Scenario, sid)
    if not s or s.user_id != current.id:
        raise HTTPException(status_code=404, detail="scenario not found")
    db.delete(s)
    db.commit()
    return Response(status_code=204)


@router.get("/{sid}/simulate", response_model=ScenarioSimulation)
async def simulate(sid: int, current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> ScenarioSimulation:
    s = db.get(Scenario, sid)
    if not s or s.user_id != current.id:
        raise HTTPException(status_code=404, detail="scenario not found")
    pess = _build_sub("Pessimistic", s.amount, s.annual_return * 0.7, s.horizon_months, s.inflation_rate)
    real = _build_sub("Realistic", s.amount, s.annual_return, s.horizon_months, s.inflation_rate)
    opti = _build_sub("Optimistic", s.amount, s.annual_return * 1.3, s.horizon_months, s.inflation_rate)
    return ScenarioSimulation(
        scenario=_to_out(s),
        pessimistic=pess,
        realistic=real,
        optimistic=opti,
        recommendation=_recommendation(real.final_value_real, s.amount, s.risk_level),
    )
