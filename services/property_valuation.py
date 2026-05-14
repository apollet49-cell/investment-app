"""Real estate market valuation via free public APIs.

Currently supports France via the DVF (Demandes de Valeurs Foncières) dataset
— the French government's record of every real estate transaction since 2014,
released as open data and queryable for free without an API key.

For non-French addresses we return `unsupported_country` so the UI can show a
friendly message instead of crashing.
"""
from __future__ import annotations

import logging
import statistics
from typing import Optional

import aiohttp

from services.market_data import market_service

log = logging.getLogger("property_valuation")

# Community-maintained wrapper over the official DVF dataset.
DVF_API = "https://api.cquest.org/dvf"

DVF_TYPE_MAP = {
    "apartment": "Appartement",
    "house": "Maison",
    "office": None,  # DVF lumps commercial under "Local industriel. commercial..."; skip filter
}


async def _eur_to_usd_rate() -> float:
    try:
        data = await market_service.get_forex_rate("EUR", "USD")
        if data and isinstance(data.get("rate"), (int, float)) and data["rate"] > 0:
            return float(data["rate"])
    except Exception as e:
        log.warning("EUR→USD fetch failed: %s", e)
    return 1.08  # sane fallback if FX is down


async def _estimate_france(postal_code: str, surface_sqm: float, subtype: str) -> dict:
    """Query DVF for comparable transactions and return aggregated stats."""
    dvf_type = DVF_TYPE_MAP.get(subtype)
    params = {"code_postal": postal_code.strip(), "limit": "500"}
    if dvf_type:
        params["type_local"] = dvf_type

    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=15)) as sess:
            async with sess.get(DVF_API, params=params) as resp:
                if resp.status != 200:
                    return {"status": "error", "message": f"DVF returned HTTP {resp.status}"}
                payload = await resp.json()
    except aiohttp.ClientError as e:
        return {"status": "error", "message": f"network error: {e}"}

    # Different DVF wrappers return slightly different shapes; handle both.
    rows = (
        payload.get("resultats")
        or payload.get("features")
        or (payload if isinstance(payload, list) else [])
    )
    if not rows:
        return {"status": "no_data", "comparable_count": 0,
                "source": "DVF (France)", "message": "No transactions found for this postal code"}

    # Filter rows by similar surface (±25% with a minimum band of ±15 m²).
    band = max(surface_sqm * 0.25, 15.0)
    min_surf = max(surface_sqm - band, 1.0)
    max_surf = surface_sqm + band

    prices_per_sqm: list[float] = []
    samples: list[dict] = []
    for row in rows:
        props = row.get("properties") if "properties" in row else row
        valeur = props.get("valeur_fonciere") or props.get("valeur")
        surf = props.get("surface_reelle_bati") or props.get("surface")
        if not valeur or not surf:
            continue
        try:
            valeur = float(valeur)
            surf = float(surf)
        except (TypeError, ValueError):
            continue
        if surf <= 0 or valeur < 1000:
            continue
        if not (min_surf <= surf <= max_surf):
            continue
        ppsqm = valeur / surf
        # sanity filter: realistic price/m² in France is roughly 500..30000 €/m²
        if ppsqm < 200 or ppsqm > 50000:
            continue
        prices_per_sqm.append(ppsqm)
        if len(samples) < 8:
            samples.append({
                "date": props.get("date_mutation"),
                "price_eur": round(valeur, 0),
                "surface_sqm": surf,
                "price_per_sqm_eur": round(ppsqm, 0),
                "address": " ".join(filter(None, [
                    str(props.get("adresse_numero") or ""),
                    str(props.get("adresse_nom_voie") or ""),
                ])).strip() or None,
                "commune": props.get("commune"),
            })

    if not prices_per_sqm:
        return {"status": "no_match", "comparable_count": 0,
                "source": "DVF (France)",
                "message": f"No comparable transactions found within ±{int(band)} m² of {surface_sqm} m²"}

    # Trim extreme outliers — keep the middle 90% of price/m² distribution.
    prices_per_sqm.sort()
    n = len(prices_per_sqm)
    if n >= 20:
        lo = int(n * 0.05)
        hi = int(n * 0.95)
        prices_per_sqm = prices_per_sqm[lo:hi]

    median_ppsqm = statistics.median(prices_per_sqm)
    estimated_eur = median_ppsqm * surface_sqm
    eur_to_usd = await _eur_to_usd_rate()

    return {
        "status": "ok",
        "estimated_value_local": round(estimated_eur, 0),
        "local_currency": "EUR",
        "estimated_value_usd": round(estimated_eur * eur_to_usd, 2),
        "median_price_per_sqm_local": round(median_ppsqm, 0),
        "comparable_count": len(prices_per_sqm),
        "source": f"DVF (France) — {n} transactions in {postal_code}",
        "samples": samples,
    }


async def estimate_value(postal_code: str, country: str, surface_sqm: float, property_subtype: str = "apartment") -> dict:
    """Public entrypoint. Dispatches by country code."""
    country = (country or "FR").upper()
    if country == "FR":
        return await _estimate_france(postal_code, surface_sqm, property_subtype)
    return {
        "status": "unsupported_country",
        "source": None,
        "message": f"Auto-valuation isn't available for country '{country}' yet. Enter the current value manually.",
        "comparable_count": 0,
    }
