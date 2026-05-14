"""FIRE (Financial Independence Retire Early) calculator.

Given current portfolio + monthly savings + expected return + monthly
expenses, computes when the user reaches their FIRE number — defined as
`target_multiplier × annual_expenses` (the classic 4% safe withdrawal rule
gives a multiplier of 25).
"""
from __future__ import annotations

import math


def compute(
    current_portfolio: float,
    monthly_expenses: float,
    monthly_savings: float,
    expected_return_pct: float = 7.0,
    target_multiplier: float = 25.0,
) -> dict:
    if monthly_expenses < 0 or monthly_savings < 0 or current_portfolio < 0:
        return {"error": "negative inputs are not allowed"}

    annual_expenses = monthly_expenses * 12
    annual_savings = monthly_savings * 12
    target_portfolio = target_multiplier * annual_expenses
    r = expected_return_pct / 100.0
    progress_pct = round((current_portfolio / target_portfolio) * 100, 1) if target_portfolio > 0 else 0

    if target_portfolio <= 0:
        return {
            "error": "monthly_expenses must be > 0 to define a FIRE target",
            "current_portfolio": current_portfolio,
        }

    if current_portfolio >= target_portfolio:
        return {
            "already_fire": True,
            "current_portfolio": current_portfolio,
            "monthly_expenses": monthly_expenses,
            "annual_expenses": annual_expenses,
            "monthly_savings": monthly_savings,
            "expected_return_pct": expected_return_pct,
            "target_multiplier": target_multiplier,
            "target_portfolio": round(target_portfolio, 2),
            "years_to_fire": 0,
            "fire_age_offset": 0,
            "progress_pct": progress_pct,
            "savings_rate_pct": _savings_rate(monthly_savings, monthly_expenses),
        }

    # Solve V(t) = current·(1+r)^t + S_annual·((1+r)^t − 1)/r = target
    # → (1+r)^t = (target + S/r) / (current + S/r)
    # If r == 0, fallback to linear accumulation.
    if r > 0:
        numerator = target_portfolio + annual_savings / r
        denominator = current_portfolio + annual_savings / r
        if denominator <= 0 or numerator <= 0 or numerator <= denominator:
            years = 0.0
        else:
            years = math.log(numerator / denominator) / math.log(1 + r)
    else:
        gap = target_portfolio - current_portfolio
        years = (gap / annual_savings) if annual_savings > 0 else None

    if years is None or years < 0:
        years_value = None
    else:
        years_value = round(years, 1)

    # Year-by-year trajectory for the chart (capped at 60 yrs)
    trajectory = []
    if years_value is not None:
        max_years = min(int(years + 5), 60)
        v = current_portfolio
        for year in range(0, max_years + 1):
            trajectory.append({"year": year, "value": round(v, 2)})
            v = v * (1 + r) + annual_savings

    # Savings rate %, useful metric on its own
    savings_rate = _savings_rate(monthly_savings, monthly_expenses)

    return {
        "current_portfolio": current_portfolio,
        "monthly_expenses": monthly_expenses,
        "annual_expenses": annual_expenses,
        "monthly_savings": monthly_savings,
        "expected_return_pct": expected_return_pct,
        "target_multiplier": target_multiplier,
        "target_portfolio": round(target_portfolio, 2),
        "years_to_fire": years_value,
        "progress_pct": progress_pct,
        "savings_rate_pct": savings_rate,
        "trajectory": trajectory,
    }


def _savings_rate(monthly_savings: float, monthly_expenses: float) -> float:
    """Savings rate = savings / (savings + expenses). Capped 0..100."""
    total = monthly_savings + monthly_expenses
    if total <= 0:
        return 0.0
    return round(min(100.0, max(0.0, (monthly_savings / total) * 100)), 1)
