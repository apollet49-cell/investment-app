"""Regression tests for the pence/GBP normalisation bug.

The bug: `_yf_price_on_date_sync` hardcoded `currency: "USD"`, so when a
user created a position in a London-listed stock (.L suffix, quoted in
pence by yfinance), the purchase price was stored as if pence were
dollars. Live refresh later correctly converted pence→pound→USD, so the
current_value ended up ~100× too small and every London position looked
like a catastrophic -97% loss (the exact ratio that triggered this bug).

We don't hit real yfinance here — we monkeypatch the sync helper to
return a known native-currency response, then verify the async wrapper
applies the pence→pound→USD chain correctly.

No pytest-asyncio in deps, so we drive each async function via
asyncio.run() directly. Each test wires its own monkeypatches.
"""
from __future__ import annotations

import asyncio
from datetime import date

import pytest

from services import market_universe as mu
from services.market_data import market_service


def _stub_fx(monkeypatch, rate=1.25, base="GBP"):
    """Stub the forex layer with a fixed rate. Returns a list that records
    every (base, quote) pair called for assertions."""
    calls = []

    async def fake_forex(b, q):
        calls.append((b, q))
        return {"rate": rate, "base": b, "quote": q}

    monkeypatch.setattr(market_service, "get_forex_rate", fake_forex)
    return calls


def _stub_yf(monkeypatch, price, currency):
    """Stub the sync yfinance helper to return a known native quote."""
    def fake_sync(symbol, target_date):
        return {
            "symbol": symbol,
            "price": float(price),
            "currency": currency,
            "date_requested": target_date.isoformat(),
            "date_actual": target_date.isoformat(),
            "source": "yfinance",
        }
    monkeypatch.setattr(mu, "_yf_price_on_date_sync", fake_sync)


def test_lse_pence_normalised_to_pounds_then_usd(monkeypatch):
    """RR.L at 600p should become £6, then $7.50 USD at FX 1.25."""
    _stub_yf(monkeypatch, price=600.0, currency="GBp")
    fx_calls = _stub_fx(monkeypatch, rate=1.25)

    result = asyncio.run(mu.market_universe.get_price_on_date(
        "RR.L", date(2024, 12, 11), asset_type="stock"
    ))
    assert result is not None
    # 600 pence → £6 → $7.50
    assert result["price"] == pytest.approx(7.5, rel=1e-6)
    assert result["currency"] == "USD"
    assert fx_calls == [("GBP", "USD")]


def test_lse_gbp_high_price_heuristic_kicks_in(monkeypatch):
    """yfinance sometimes mislabels .L prices as GBP when they're really pence.
    A price > 500 in 'GBP' on a .L symbol should be treated as pence."""
    _stub_yf(monkeypatch, price=1300.0, currency="GBP")
    _stub_fx(monkeypatch, rate=1.25)

    result = asyncio.run(mu.market_universe.get_price_on_date(
        "RR.L", date(2025, 6, 1), asset_type="stock"
    ))
    # 1300 (pence) → £13 → $16.25
    assert result["price"] == pytest.approx(16.25, rel=1e-6)
    assert result["currency"] == "USD"


def test_real_gbp_under_500_left_alone(monkeypatch):
    """A £200/share price (legit pounds) on a .L symbol must NOT be divided by
    100. Only the >500 heuristic kicks in for ambiguous cases."""
    _stub_yf(monkeypatch, price=200.0, currency="GBP")
    _stub_fx(monkeypatch, rate=1.25)

    result = asyncio.run(mu.market_universe.get_price_on_date(
        "AZN.L", date(2025, 6, 1), asset_type="stock"
    ))
    # £200 (not divided) → $250
    assert result["price"] == pytest.approx(250.0, rel=1e-6)


def test_usd_passthrough(monkeypatch):
    """US tickers must pass through with no FX call."""
    _stub_yf(monkeypatch, price=145.32, currency="USD")
    fx_calls = _stub_fx(monkeypatch)

    result = asyncio.run(mu.market_universe.get_price_on_date(
        "AAPL", date(2025, 6, 1), asset_type="stock"
    ))
    assert result["price"] == pytest.approx(145.32)
    assert result["currency"] == "USD"
    assert fx_calls == []  # USD → no FX call


def test_eur_listing_converts_to_usd(monkeypatch):
    """An Xetra (.DE) stock priced in EUR should FX-convert to USD."""
    _stub_yf(monkeypatch, price=100.0, currency="EUR")
    _stub_fx(monkeypatch, rate=1.08)

    result = asyncio.run(mu.market_universe.get_price_on_date(
        "SAP.DE", date(2025, 6, 1), asset_type="stock"
    ))
    assert result["price"] == pytest.approx(108.0)
    assert result["currency"] == "USD"
