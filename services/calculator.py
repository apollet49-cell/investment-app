"""Pure financial calculations.

Each function returns a dict with `formula`, `inputs`, `steps`, `result` so the
frontend can show step-by-step explanations.
"""
from __future__ import annotations

import math
from typing import Any

import numpy_financial as nf


def _ensure_positive(name: str, v: float) -> None:
    if v is None or v <= 0:
        raise ValueError(f"{name} must be greater than 0")


def calc_roi(initial: float, final: float) -> dict[str, Any]:
    _ensure_positive("initial", initial)
    if final < 0:
        raise ValueError("final must be >= 0")
    roi = (final - initial) / initial * 100.0
    return {
        "formula": "ROI % = (final − initial) / initial × 100",
        "inputs": {"initial": initial, "final": final},
        "steps": [
            f"final − initial = {final} − {initial} = {final - initial}",
            f"(final − initial) / initial = {final - initial} / {initial} = {(final - initial) / initial:.6f}",
            f"× 100 = {roi:.4f}%",
        ],
        "result": round(roi, 4),
    }


def calc_compound(principal: float, annual_rate_pct: float, years: float, compounds_per_year: int = 12) -> dict[str, Any]:
    _ensure_positive("principal", principal)
    if compounds_per_year <= 0:
        raise ValueError("compounds_per_year must be > 0")
    if years <= 0:
        raise ValueError("years must be > 0")
    r = annual_rate_pct / 100.0
    n = compounds_per_year
    t = years
    amount = principal * (1 + r / n) ** (n * t)
    return {
        "formula": "A = P · (1 + r/n)^(n·t)",
        "inputs": {"P": principal, "r": r, "n": n, "t": t},
        "steps": [
            f"r/n = {r}/{n} = {r / n:.6f}",
            f"1 + r/n = {1 + r / n:.6f}",
            f"n·t = {n}·{t} = {n * t}",
            f"(1 + r/n)^(n·t) = {(1 + r / n) ** (n * t):.6f}",
            f"A = {principal} · {(1 + r / n) ** (n * t):.6f} = {amount:.4f}",
        ],
        "result": round(amount, 4),
    }


def calc_npv(rate_pct: float, cashflows: list[float]) -> dict[str, Any]:
    if not cashflows:
        raise ValueError("cashflows must not be empty")
    r = rate_pct / 100.0
    npv = float(nf.npv(r, cashflows))
    steps = [f"t={t}: {cf} / (1+{r})^{t} = {cf / (1 + r) ** t:.4f}" for t, cf in enumerate(cashflows)]
    steps.append(f"sum = {npv:.4f}")
    return {
        "formula": "NPV = Σ CF_t / (1 + r)^t",
        "inputs": {"rate_pct": rate_pct, "cashflows": cashflows},
        "steps": steps,
        "result": round(npv, 4),
    }


def calc_irr(cashflows: list[float]) -> dict[str, Any]:
    """IRR via numpy_financial (uses Newton-Raphson under the hood)."""
    if len(cashflows) < 2:
        raise ValueError("need at least 2 cashflows")
    if all(cf >= 0 for cf in cashflows) or all(cf <= 0 for cf in cashflows):
        raise ValueError("cashflows must contain at least one negative and one positive value")
    irr = nf.irr(cashflows)
    if irr is None or (isinstance(irr, float) and math.isnan(irr)):
        raise ValueError("IRR did not converge for these cashflows")
    irr_pct = float(irr) * 100.0
    return {
        "formula": "Find r such that Σ CF_t / (1 + r)^t = 0",
        "inputs": {"cashflows": cashflows},
        "steps": [
            f"Newton-Raphson on {len(cashflows)} cashflows",
            f"r ≈ {irr:.6f} → {irr_pct:.4f}%",
        ],
        "result": round(irr_pct, 4),
    }


def calc_breakeven(fixed_costs: float, price_per_unit: float, variable_cost_per_unit: float) -> dict[str, Any]:
    _ensure_positive("fixed_costs", fixed_costs)
    margin = price_per_unit - variable_cost_per_unit
    if margin <= 0:
        raise ValueError("price must be greater than variable cost")
    units = fixed_costs / margin
    return {
        "formula": "Break-even units = FC / (P − VC)",
        "inputs": {"fixed_costs": fixed_costs, "price": price_per_unit, "variable_cost": variable_cost_per_unit},
        "steps": [
            f"contribution margin = P − VC = {price_per_unit} − {variable_cost_per_unit} = {margin}",
            f"FC / margin = {fixed_costs} / {margin} = {units:.4f} units",
        ],
        "result": round(units, 4),
    }


def calc_payback(initial_investment: float, annual_cash_flow: float) -> dict[str, Any]:
    _ensure_positive("initial_investment", initial_investment)
    if annual_cash_flow <= 0:
        raise ValueError("annual_cash_flow must be > 0")
    years = initial_investment / annual_cash_flow
    return {
        "formula": "Payback (years) = initial_investment / annual_cash_flow",
        "inputs": {"initial_investment": initial_investment, "annual_cash_flow": annual_cash_flow},
        "steps": [f"{initial_investment} / {annual_cash_flow} = {years:.4f} years"],
        "result": round(years, 4),
    }


def calc_cagr(beginning: float, ending: float, years: float) -> dict[str, Any]:
    _ensure_positive("beginning", beginning)
    if years <= 0:
        raise ValueError("years must be > 0")
    if ending <= 0:
        raise ValueError("ending must be > 0")
    ratio = ending / beginning
    cagr = ratio ** (1.0 / years) - 1.0
    cagr_pct = cagr * 100.0
    return {
        "formula": "CAGR = (ending / beginning)^(1/years) − 1",
        "inputs": {"beginning": beginning, "ending": ending, "years": years},
        "steps": [
            f"ending / beginning = {ending} / {beginning} = {ratio:.6f}",
            f"^(1/{years}) = {ratio ** (1 / years):.6f}",
            f"− 1 = {cagr:.6f} → {cagr_pct:.4f}%",
        ],
        "result": round(cagr_pct, 4),
    }


def calc_sharpe(returns: list[float], risk_free_rate: float = 0.02) -> dict[str, Any]:
    """Sharpe ratio. `returns` are decimal periodic returns (e.g. 0.05 = 5%).
    `risk_free_rate` is annual decimal."""
    if len(returns) < 2:
        raise ValueError("need at least 2 returns")
    n = len(returns)
    mean = sum(returns) / n
    variance = sum((r - mean) ** 2 for r in returns) / (n - 1)
    std = math.sqrt(variance)
    if std == 0:
        raise ValueError("std deviation is zero, Sharpe undefined")
    sharpe = (mean - risk_free_rate) / std
    return {
        "formula": "Sharpe = (mean(returns) − risk_free_rate) / std(returns)",
        "inputs": {"returns": returns, "risk_free_rate": risk_free_rate},
        "steps": [
            f"mean = {mean:.6f}",
            f"std = {std:.6f}",
            f"(mean − rf) / std = ({mean:.6f} − {risk_free_rate}) / {std:.6f} = {sharpe:.4f}",
        ],
        "result": round(sharpe, 4),
    }


def calc_annualized(total_return_pct: float, days: int) -> dict[str, Any]:
    if days <= 0:
        raise ValueError("days must be > 0")
    total = total_return_pct / 100.0
    if total <= -1:
        raise ValueError("total return must be > -100%")
    annualized = (1 + total) ** (365.0 / days) - 1
    annualized_pct = annualized * 100.0
    return {
        "formula": "Annualized = (1 + total_return)^(365/days) − 1",
        "inputs": {"total_return_pct": total_return_pct, "days": days},
        "steps": [
            f"1 + total = {1 + total:.6f}",
            f"365 / {days} = {365 / days:.6f}",
            f"^ → {(1 + total) ** (365 / days):.6f}",
            f"− 1 = {annualized:.6f} → {annualized_pct:.4f}%",
        ],
        "result": round(annualized_pct, 4),
    }
