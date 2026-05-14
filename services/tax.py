"""French tax simulation for investment portfolios.

Computes "what would I owe if I sold everything today?" under several tax
wrappers and rates. Highly simplified — real taxation depends on transaction
history, holding periods, loss carry-forwards, account opening dates, etc.

Wrapper rules (2024 reference):
  - **CTO** (compte-titres ordinaire): flat tax 30% (PFU) on gains
      = 12.8% income tax + 17.2% social charges. Or opt for marginal rate +
        17.2% PS (good for low TMI).
  - **PEA**: tax-deferred while inside the wrapper. On withdrawal:
      - < 5 years from opening: 30% PFU (like CTO)
      - ≥ 5 years: only 17.2% social charges
  - **Assurance vie**: depends on age of contract and amounts.
      - < 8 years: 30% PFU
      - ≥ 8 years (< 150k€ premiums): 7.5% PFL + 17.2% PS = 24.7%
      - ≥ 8 years (≥ 150k€): 12.8% + 17.2% = 30%
  - **PER**: not taxed in/out the same way — gains in withdrawal phase taxed
      at TMI + 17.2% PS for the capital portion. Simplified here as 30%.

PEA contribution cap: 150 000 € (lifetime).
"""
from __future__ import annotations

from typing import Iterable, Optional


# Default marginal rates (Tranche Marginale d'Imposition) — user can override.
TMI_OPTIONS = [0, 11, 30, 41, 45]
SOCIAL_CHARGES_RATE = 0.172  # CSG-CRDS, applies almost always
PFU_RATE = 0.30              # Flat tax 30%
PEA_CAP_EUR = 150_000.0


def _gain(inv) -> float:
    return (inv.current_value or 0) - (inv.amount_invested or 0)


def _classify(inv) -> str:
    """Normalise account_type to one of the canonical keys we know."""
    raw = (inv.account_type or "").lower().strip()
    if raw in {"pea", "cto", "av", "per"}:
        return raw
    return "other"


def compute(
    rows: Iterable,
    tmi_pct: float = 30.0,
    pea_years_held: float = 5.0,
    av_years_held: float = 8.0,
) -> dict:
    """Build a per-wrapper summary + a side-by-side scenario simulation.

    `tmi_pct` is the user's marginal tax rate (used for the optional
    'marginal' scenario on CTO instead of PFU 30%).
    `pea_years_held` and `av_years_held` let the user simulate before/after
    the favourable threshold."""
    by_wrapper: dict[str, dict] = {
        "cto": {"label": "CTO (compte-titres)", "invested": 0.0, "current": 0.0, "gain": 0.0, "positions": 0},
        "pea": {"label": "PEA", "invested": 0.0, "current": 0.0, "gain": 0.0, "positions": 0},
        "av":  {"label": "Assurance vie", "invested": 0.0, "current": 0.0, "gain": 0.0, "positions": 0},
        "per": {"label": "PER", "invested": 0.0, "current": 0.0, "gain": 0.0, "positions": 0},
        "other": {"label": "Other / unassigned", "invested": 0.0, "current": 0.0, "gain": 0.0, "positions": 0},
    }
    for inv in rows:
        if not inv.amount_invested:
            continue
        k = _classify(inv)
        w = by_wrapper[k]
        w["invested"] += inv.amount_invested
        w["current"] += inv.current_value or 0
        w["gain"] += _gain(inv)
        w["positions"] += 1

    # Per-wrapper tax simulation
    tmi = max(0.0, min(45.0, tmi_pct)) / 100.0
    marginal_total_rate = tmi + SOCIAL_CHARGES_RATE     # marginal option on CTO
    av_long_rate = 0.075 + SOCIAL_CHARGES_RATE          # 7.5% PFL + 17.2% PS

    def _scenarios_for(wrapper: str, gain: float) -> dict[str, dict]:
        gain = max(0.0, gain)  # losses → 0 tax (simplification; in reality offset)
        scenarios: dict[str, dict] = {}
        if wrapper == "cto":
            scenarios["pfu"] = {"label": "Flat tax (PFU 30%)", "rate_pct": 30.0, "tax": gain * PFU_RATE}
            scenarios["marginal"] = {"label": f"Marginal (TMI {tmi_pct:.0f}% + 17.2% PS)",
                                     "rate_pct": round(marginal_total_rate * 100, 2),
                                     "tax": gain * marginal_total_rate}
        elif wrapper == "pea":
            if pea_years_held < 5:
                scenarios["before5"] = {"label": "Withdraw < 5 yr (PFU 30%)", "rate_pct": 30.0, "tax": gain * PFU_RATE}
            scenarios["after5"] = {"label": "Withdraw ≥ 5 yr (PS 17.2% only)",
                                    "rate_pct": round(SOCIAL_CHARGES_RATE * 100, 2),
                                    "tax": gain * SOCIAL_CHARGES_RATE}
        elif wrapper == "av":
            if av_years_held < 8:
                scenarios["before8"] = {"label": "Withdraw < 8 yr (PFU 30%)", "rate_pct": 30.0, "tax": gain * PFU_RATE}
            scenarios["after8"] = {"label": "Withdraw ≥ 8 yr (7.5% + 17.2%)",
                                    "rate_pct": round(av_long_rate * 100, 2),
                                    "tax": gain * av_long_rate}
        elif wrapper == "per":
            scenarios["exit"] = {"label": "Capital exit (PFU 30%)", "rate_pct": 30.0, "tax": gain * PFU_RATE}
        else:  # other
            scenarios["pfu"] = {"label": "Default PFU 30%", "rate_pct": 30.0, "tax": gain * PFU_RATE}
        for s in scenarios.values():
            s["tax"] = round(s["tax"], 2)
        return scenarios

    wrapper_breakdown = []
    total_tax_optimal = 0.0
    total_tax_worst = 0.0
    for key, w in by_wrapper.items():
        if w["positions"] == 0:
            continue
        scen = _scenarios_for(key, w["gain"])
        # Pick the best (lowest tax) scenario as "optimal" for the wrapper
        best = min(scen.values(), key=lambda s: s["tax"]) if scen else None
        worst = max(scen.values(), key=lambda s: s["tax"]) if scen else None
        wrapper_breakdown.append({
            "wrapper": key,
            "label": w["label"],
            "positions": w["positions"],
            "invested": round(w["invested"], 2),
            "current": round(w["current"], 2),
            "gain": round(w["gain"], 2),
            "scenarios": scen,
            "best_tax": best["tax"] if best else 0,
            "best_label": best["label"] if best else None,
        })
        if best:
            total_tax_optimal += best["tax"]
        if worst:
            total_tax_worst += worst["tax"]

    # PEA cap tracker (using amount_invested as a proxy for contributions)
    pea = by_wrapper["pea"]
    pea_cap = {
        "limit_eur": PEA_CAP_EUR,
        "used_usd": round(pea["invested"], 2),
        "remaining_usd": round(max(0.0, PEA_CAP_EUR - pea["invested"]), 2),
        "used_pct": round((pea["invested"] / PEA_CAP_EUR) * 100, 1) if PEA_CAP_EUR else 0.0,
    }

    return {
        "wrappers": wrapper_breakdown,
        "total_tax_optimal": round(total_tax_optimal, 2),
        "total_tax_worst": round(total_tax_worst, 2),
        "tax_savings_via_optimal": round(total_tax_worst - total_tax_optimal, 2),
        "pea_cap": pea_cap,
        "tmi_used": tmi_pct,
        "pea_years_held": pea_years_held,
        "av_years_held": av_years_held,
    }
