from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from schemas import CalcResult
from services import calculator as calc

router = APIRouter(prefix="/calculator", tags=["calculator"])


def _wrap(mode: str, fn, **kwargs):
    try:
        out = fn(**kwargs)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return CalcResult(mode=mode, **out)


@router.get("/roi", response_model=CalcResult)
async def roi(initial: float = Query(...), final: float = Query(...)) -> CalcResult:
    return _wrap("roi", calc.calc_roi, initial=initial, final=final)


@router.get("/compound", response_model=CalcResult)
async def compound(
    principal: float = Query(...),
    annual_rate_pct: float = Query(...),
    years: float = Query(...),
    compounds_per_year: int = Query(12),
) -> CalcResult:
    return _wrap(
        "compound",
        calc.calc_compound,
        principal=principal,
        annual_rate_pct=annual_rate_pct,
        years=years,
        compounds_per_year=compounds_per_year,
    )


class CashflowsBody(BaseModel):
    cashflows: list[float]
    rate_pct: Optional[float] = None
    risk_free_rate: Optional[float] = None


@router.post("/npv", response_model=CalcResult)
async def npv(body: CashflowsBody) -> CalcResult:
    if body.rate_pct is None:
        raise HTTPException(status_code=400, detail="rate_pct is required for NPV")
    return _wrap("npv", calc.calc_npv, rate_pct=body.rate_pct, cashflows=body.cashflows)


@router.post("/irr", response_model=CalcResult)
async def irr(body: CashflowsBody) -> CalcResult:
    return _wrap("irr", calc.calc_irr, cashflows=body.cashflows)


@router.get("/breakeven", response_model=CalcResult)
async def breakeven(
    fixed_costs: float = Query(...),
    price_per_unit: float = Query(...),
    variable_cost_per_unit: float = Query(...),
) -> CalcResult:
    return _wrap(
        "breakeven",
        calc.calc_breakeven,
        fixed_costs=fixed_costs,
        price_per_unit=price_per_unit,
        variable_cost_per_unit=variable_cost_per_unit,
    )


@router.get("/payback", response_model=CalcResult)
async def payback(initial_investment: float = Query(...), annual_cash_flow: float = Query(...)) -> CalcResult:
    return _wrap("payback", calc.calc_payback, initial_investment=initial_investment, annual_cash_flow=annual_cash_flow)


@router.get("/cagr", response_model=CalcResult)
async def cagr(beginning: float = Query(...), ending: float = Query(...), years: float = Query(...)) -> CalcResult:
    return _wrap("cagr", calc.calc_cagr, beginning=beginning, ending=ending, years=years)


@router.post("/sharpe", response_model=CalcResult)
async def sharpe(body: CashflowsBody) -> CalcResult:
    rf = body.risk_free_rate if body.risk_free_rate is not None else 0.02
    return _wrap("sharpe", calc.calc_sharpe, returns=body.cashflows, risk_free_rate=rf)


@router.get("/annualized", response_model=CalcResult)
async def annualized(total_return_pct: float = Query(...), days: int = Query(...)) -> CalcResult:
    return _wrap("annualized", calc.calc_annualized, total_return_pct=total_return_pct, days=days)
