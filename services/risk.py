"""Real portfolio risk metrics from daily snapshots.

Replaces the previous concentration-only "Risk score" (which was just
"top position weight" + "number of holdings" — cosmetic) with proper
finance metrics:

- **Annualised volatility**: stddev of daily returns × √252.
- **Maximum drawdown**: worst peak-to-trough loss over the window.
- **Beta**: covariance(portfolio, benchmark) / variance(benchmark).
  Measures sensitivity to S&P 500 moves. 1.0 = moves with market,
  >1 = amplified, <0 = inverse.
- **Sharpe ratio**: annualised excess return / annualised vol.

Composite risk score 0-100 (higher = riskier) combines them:
  vol_score  (0-50)  : annualised vol × 200, capped at 50
  dd_score   (0-30)  : max drawdown × 150, capped at 30
  beta_score (0-20)  : |beta - 1| × 20, capped at 20

Needs at least 30 daily snapshots to be meaningful; falls back to None.
"""
from __future__ import annotations

import math
import statistics
from typing import Optional


def _daily_returns(values: list[float]) -> list[float]:
    """v_n / v_{n-1} − 1 — skips days where prev is 0."""
    returns = []
    for i in range(1, len(values)):
        prev = values[i - 1]
        if prev > 0:
            returns.append((values[i] - prev) / prev)
    return returns


def _max_drawdown(values: list[float]) -> float:
    peak = values[0] if values else 0.0
    max_dd = 0.0
    for v in values:
        if v > peak:
            peak = v
        if peak > 0:
            dd = (peak - v) / peak
            if dd > max_dd:
                max_dd = dd
    return max_dd


def _beta(port_returns: list[float], bench_returns: list[float]) -> Optional[float]:
    """β = cov(port, bench) / var(bench). Aligns the shorter list."""
    n = min(len(port_returns), len(bench_returns))
    if n < 10:
        return None
    p = port_returns[-n:]
    b = bench_returns[-n:]
    mp = sum(p) / n
    mb = sum(b) / n
    cov = sum((p[i] - mp) * (b[i] - mb) for i in range(n)) / (n - 1)
    varb = sum((b[i] - mb) ** 2 for i in range(n)) / (n - 1)
    if varb <= 0:
        return None
    return cov / varb


def compute_risk_metrics(
    portfolio_values: list[float],
    benchmark_values: Optional[list[float]] = None,
    risk_free_annual: float = 0.02,
) -> dict:
    """`portfolio_values` is a daily-spaced list of portfolio totals (oldest
    first). `benchmark_values` is the same length series for the benchmark
    (e.g. S&P 500 close), optional — beta returned None without it.

    Returns dict with score / tier / individual metrics, or
    `{"score": None, "reason": "insufficient_history"}` when there's less
    than 30 days of data."""
    if len(portfolio_values) < 30:
        return {
            "score": None,
            "tier": None,
            "reason": "insufficient_history",
            "n_days": len(portfolio_values),
        }

    returns = _daily_returns(portfolio_values)
    if not returns:
        return {"score": None, "tier": None, "reason": "no_returns"}

    # Annualised volatility — 252 trading days/year.
    mean_r = sum(returns) / len(returns)
    if len(returns) > 1:
        std_daily = statistics.stdev(returns)
    else:
        std_daily = 0.0
    annual_vol = std_daily * math.sqrt(252)

    # Max drawdown (peak-to-trough)
    max_dd = _max_drawdown(portfolio_values)

    # Beta vs benchmark
    beta = None
    if benchmark_values and len(benchmark_values) >= 10:
        bench_returns = _daily_returns(benchmark_values)
        if bench_returns:
            beta = _beta(returns, bench_returns)

    # Sharpe ratio (annualised)
    rf_daily = risk_free_annual / 252.0
    sharpe = None
    if std_daily > 0:
        sharpe = ((mean_r - rf_daily) / std_daily) * math.sqrt(252)

    # Composite score — higher = riskier. Anchored on these calibration points:
    #   "low" (≤30) : diversified ETF portfolio (vol ~12%, dd ~10%, β ~0.9)
    #   "med" (~50) : typical retail equity portfolio (vol ~20%, dd ~25%, β 1.1)
    #   "high" (>70): concentrated or crypto-heavy (vol >30%, dd >40%, β 1.5+)
    vol_score = min(annual_vol * 200.0, 50.0)              # 25% vol → 50 pts
    dd_score = min(max_dd * 150.0, 30.0)                   # 20% dd → 30 pts
    beta_score = min(abs((beta if beta is not None else 1.0) - 1.0) * 20.0, 20.0)
    composite = vol_score + dd_score + beta_score

    tier = "low" if composite < 30 else "medium" if composite < 65 else "high"

    return {
        "score": round(composite, 1),
        "tier": tier,
        "volatility_pct": round(annual_vol * 100, 2),
        "max_drawdown_pct": round(max_dd * 100, 2),
        "beta": round(beta, 2) if beta is not None else None,
        "sharpe": round(sharpe, 2) if sharpe is not None else None,
        "n_days": len(returns),
        "components": {
            "volatility": round(vol_score, 1),
            "drawdown": round(dd_score, 1),
            "beta": round(beta_score, 1),
        },
    }
