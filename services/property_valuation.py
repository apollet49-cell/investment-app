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

# Fallback price-per-m² table (EUR, apartments, Q3 2024 averages from public
# sources: Notaires de France / MeilleursAgents quarterly stats). Used when the
# live DVF API is down (HTTP 502/timeout) so the user still gets a useful
# estimate instead of an error. Less precise than DVF but a reasonable proxy.
FALLBACK_PRICE_PER_SQM_EUR: dict[str, float] = {
    # Paris arrondissements
    "75001": 14000, "75002": 12500, "75003": 13500, "75004": 14000,
    "75005": 13500, "75006": 15500, "75007": 15000, "75008": 13500,
    "75009": 12500, "75010": 11000, "75011": 11000, "75012": 10500,
    "75013": 10000, "75014": 11500, "75015": 11500, "75016": 12000,
    "75017": 11500, "75018": 10500, "75019":  9500, "75020": 9500,
    # Major cities — per postal code where useful, else 2-digit department
    "69001": 5800, "69002": 6300, "69003": 5300, "69004": 5900,
    "69005": 5300, "69006": 6500, "69007": 5200, "69008": 4800, "69009": 4900,
    "13001": 3300, "13002": 3000, "13006": 3800, "13007": 4200, "13008": 4500,
    "31000": 3700, "31500": 3500,
    "06000": 5300, "06100": 5200, "06200": 5100, "06300": 5400,
    "44000": 4100, "67000": 3700, "33000": 4500, "59000": 3200,
    "35000": 4000, "51100": 2600, "34000": 4100, "37000": 2900,
    "45000": 2700, "21000": 3000, "76000": 2700, "76600": 2500,
    "38000": 3200, "42000": 1800, "63000": 2200, "57000": 2400,
    "54000": 2700, "68100": 2300, "29200": 2100, "29000": 2100,
    "49000": 3000, "72000": 2200, "86000": 2300, "87000": 1900,
    "63100": 2100, "73000": 3300, "74000": 4800, "74940": 6200,
    # 2-digit department fallback (used when no exact postal code match)
    "75": 11000, "92": 8500, "93": 4500, "94": 6500, "95": 4000,
    "78": 5500, "77": 3800, "91": 3800,
    "69": 5400, "13": 3300, "31": 3700, "06": 5300, "44": 4100,
    "67": 3700, "33": 4500, "59": 3200, "35": 4000, "51": 2600,
    "34": 4100, "37": 2900, "45": 2700, "21": 3000, "76": 2700,
    "38": 3200, "42": 1800, "63": 2200, "57": 2400, "54": 2700,
    "68": 2300, "29": 2100, "49": 3000, "72": 2200, "86": 2300,
    "87": 1900, "73": 3300, "74": 4800,
}

SUBTYPE_FACTOR = {"apartment": 1.0, "house": 0.85, "office": 1.1}
FRANCE_AVG_FALLBACK_EUR_PER_SQM = 3500.0


async def _eur_to_usd_rate() -> float:
    try:
        data = await market_service.get_forex_rate("EUR", "USD")
        if data and isinstance(data.get("rate"), (int, float)) and data["rate"] > 0:
            return float(data["rate"])
    except Exception as e:
        log.warning("EUR→USD fetch failed: %s", e)
    return 1.08  # sane fallback if FX is down


def _fallback_estimate(postal_code: str, surface_sqm: float, subtype: str, reason: str) -> dict:
    """Last-resort estimate from a hardcoded table of averages by postal code /
    department. Less precise than DVF but always returns something usable."""
    pc = postal_code.strip()
    price_per_sqm = (
        FALLBACK_PRICE_PER_SQM_EUR.get(pc)
        or FALLBACK_PRICE_PER_SQM_EUR.get(pc[:2])
        or FRANCE_AVG_FALLBACK_EUR_PER_SQM
    )
    factor = SUBTYPE_FACTOR.get(subtype, 1.0)
    adjusted_ppsqm = price_per_sqm * factor
    estimated_eur = adjusted_ppsqm * surface_sqm
    return {
        "status": "ok",
        "estimated_value_local": round(estimated_eur, 0),
        "local_currency": "EUR",
        "median_price_per_sqm_local": round(adjusted_ppsqm, 0),
        "comparable_count": 0,
        "source": f"Local averages (fallback — DVF live API unavailable: {reason})",
        "samples": [],
    }


async def _estimate_france(postal_code: str, surface_sqm: float, subtype: str) -> dict:
    """Query DVF for comparable transactions and return aggregated stats.
    Falls back to a static city-level table when DVF is unreachable."""
    dvf_type = DVF_TYPE_MAP.get(subtype)
    params = {"code_postal": postal_code.strip(), "limit": "500"}
    if dvf_type:
        params["type_local"] = dvf_type

    dvf_error: Optional[str] = None
    payload = None
    try:
        async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=10)) as sess:
            async with sess.get(DVF_API, params=params) as resp:
                if resp.status != 200:
                    dvf_error = f"HTTP {resp.status}"
                else:
                    payload = await resp.json()
    except aiohttp.ClientError as e:
        dvf_error = f"network error ({e.__class__.__name__})"
    except Exception as e:  # noqa: BLE001
        dvf_error = f"unexpected error ({e.__class__.__name__})"

    if dvf_error or payload is None:
        result = _fallback_estimate(postal_code, surface_sqm, subtype, dvf_error or "no response")
        eur_to_usd = await _eur_to_usd_rate()
        result["estimated_value_usd"] = round(result["estimated_value_local"] * eur_to_usd, 2)
        return result

    # Different DVF wrappers return slightly different shapes; handle both.
    rows = (
        payload.get("resultats")
        or payload.get("features")
        or (payload if isinstance(payload, list) else [])
    )
    if not rows:
        # Empty DVF response → try the fallback table instead of returning empty.
        result = _fallback_estimate(postal_code, surface_sqm, subtype, "no transactions returned")
        eur_to_usd = await _eur_to_usd_rate()
        result["estimated_value_usd"] = round(result["estimated_value_local"] * eur_to_usd, 2)
        return result

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
        # No surface-matched comparables — fall back to the static city averages.
        result = _fallback_estimate(postal_code, surface_sqm, subtype, "no surface match")
        eur_to_usd = await _eur_to_usd_rate()
        result["estimated_value_usd"] = round(result["estimated_value_local"] * eur_to_usd, 2)
        return result

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
