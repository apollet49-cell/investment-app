"""Populate a single user account with realistic demo data.

Used by:
- The /investments/seed-demo endpoint (UI button: "Try with sample portfolio")
- The seed_demo.py CLI script (whole-DB seed, also targets demo@investapp.io)

Idempotent for the given user: wipes their existing investments/transactions/
plans/etc before re-populating, so re-running gives a clean slate.
"""
from __future__ import annotations

import math
from datetime import date, datetime, timedelta

from sqlalchemy.orm import Session

from models import (
    Alert,
    Investment,
    PortfolioSnapshot,
    Scenario,
    Transaction,
    User,
)


def _days_ago(n: int) -> date:
    return date.today() - timedelta(days=n)


def _wipe_user_data(db: Session, user_id: int) -> None:
    for model in (Transaction, Alert, Scenario, PortfolioSnapshot, Investment):
        db.query(model).filter(model.user_id == user_id).delete(synchronize_session=False)


INVESTMENT_SPECS = [
    # (name, type, symbol, invested, current, qty, days_ago, account_type, notes/yield)
    ("Apple Inc.", "stock", "AAPL", 5000, 6850, 28, 540, "cto", "Core US tech holding."),
    ("Microsoft", "stock", "MSFT", 3000, 3620, 8, 420, "cto", None),
    ("LVMH", "stock", "MC.PA", 2500, 2380, 3, 300, "pea", "Long-term luxury exposure (PEA)."),
    ("Alphabet Class A", "stock", "GOOGL", 4500, 5320, 22, 510, "cto", None),
    ("NVIDIA", "stock", "NVDA", 5200, 11800, 28, 320, "cto", "Bought before AI rally."),
    ("ASML Holding", "stock", "ASML.AS", 5500, 7200, 7, 360, "pea", "Semi-cap monopoly."),
    ("Novo Nordisk", "stock", "NVO", 4500, 5810, 42, 340, "cto", "GLP-1 boom."),
    ("Vanguard FTSE All-World", "etf", "VWCE.DE", 12000, 14200, 110, 720, "pea", "Core diversified ETF."),
    ("iShares Core MSCI World", "etf", "IWDA.AS", 4000, 4750, 46, 450, "pea", None),
    ("Vanguard S&P 500", "etf", "VUSA.AS", 6000, 7180, 75, 540, "pea", "S&P 500 in EUR."),
    ("VanEck Semiconductor", "etf", "SMH", 3500, 5400, 22, 460, "cto", "AI tailwind."),
    ("SPDR Gold", "etf", "GLD", 2500, 2980, 13, 200, "cto", "Hedge sleeve."),
    ("Bitcoin", "crypto", "bitcoin", 4500, 8200, 0.12, 660, "cto", "DCA'd in 2023."),
    ("Ethereum", "crypto", "ethereum", 2000, 2350, 0.85, 390, "cto", None),
    ("Solana", "crypto", "solana", 800, 1450, 12, 220, "cto", None),
    ("iShares Euro Govt Bond", "bond", "IEAG.AS", 5000, 5180, 43, 500, "cto", "Defensive sleeve."),
    ("Vanguard Total Bond", "bond", "BND", 3000, 2920, 40, 310, "cto", None),
    ("Studio Paris 11e", "real_estate", None, 180000, 215000, None, 900, "other", "Rented studio."),
    ("House Lyon 7e", "real_estate", None, 240000, 265000, None, 1400, "other", None),
    ("Aircall (pre-IPO)", "startup", None, 8000, 12500, None, 800, "cto", "Friends-and-family allocation."),
    ("Mistral AI (secondary)", "startup", None, 5000, 7200, None, 200, "cto", "AI bet."),
]


def seed_user(db: Session, user: User, *, set_currency: str | None = None) -> dict:
    """Populate `user` with demo data. Returns a summary dict (counts).
    `set_currency` optionally updates the user's currency too (e.g. "EUR")."""
    _wipe_user_data(db, user.id)
    db.commit()

    if set_currency and set_currency in ("USD", "EUR", "GBP", "CHF"):
        user.currency = set_currency

    # ---- Investments ----
    inv_objs: list[Investment] = []
    for spec in INVESTMENT_SPECS:
        name, typ, sym, invested, current, qty, d_ago, acct, note = spec
        payload = dict(
            user_id=user.id, name=name, type=typ, symbol=sym,
            amount_invested=invested, current_value=current,
            purchase_date=_days_ago(d_ago), account_type=acct,
            notes=note if isinstance(note, str) else None,
        )
        if qty is not None:
            payload["quantity"] = qty
        if typ == "real_estate":
            if "Paris" in name:
                payload.update(address="42 Rue Oberkampf", postal_code="75011",
                               city="Paris", country="FR", surface_sqm=28,
                               property_subtype="apartment",
                               monthly_rental_income=1100, monthly_rental_charges=180,
                               loan_amount=140000, loan_interest_rate_pct=2.1,
                               monthly_mortgage_payment=620)
            elif "Lyon" in name:
                payload.update(address="15 Quai Claude Bernard", postal_code="69007",
                               city="Lyon", country="FR", surface_sqm=72,
                               property_subtype="apartment",
                               monthly_rental_income=1450, monthly_rental_charges=240,
                               loan_amount=180000, loan_interest_rate_pct=1.6,
                               monthly_mortgage_payment=810)
        if typ == "startup":
            payload["annual_yield_pct"] = 14.0 if "Aircall" in name else 10.0
        inv = Investment(**payload)
        db.add(inv)
        inv_objs.append(inv)
    db.commit()
    for inv in inv_objs:
        db.refresh(inv)

    # ---- Transactions ----
    tx_count = 0
    for inv in inv_objs:
        qty = inv.quantity or (inv.amount_invested / 100.0)
        price = inv.amount_invested / qty if qty else inv.amount_invested
        db.add(Transaction(
            user_id=user.id, investment_id=inv.id, type="buy",
            transaction_date=inv.purchase_date,
            quantity=qty, price_per_unit=round(price, 2),
            amount=round(inv.amount_invested, 2),
            fees=round(inv.amount_invested * 0.001, 2),
            notes="Initial purchase",
        ))
        tx_count += 1

    # Dividends
    divs = {
        "AAPL": [(120, 18), (210, 18), (300, 19), (390, 21)],
        "MSFT": [(95, 7), (185, 7), (275, 8), (365, 8)],
        "MC.PA": [(150, 22)],
        "VWCE.DE": [(180, 95), (360, 110), (545, 120)],
        "IEAG.AS": [(120, 35), (240, 35), (360, 36), (480, 38)],
        "BND": [(60, 9), (120, 9), (180, 9), (240, 9), (300, 9)],
    }
    by_sym = {i.symbol: i for i in inv_objs if i.symbol}
    for sym, items in divs.items():
        inv = by_sym.get(sym)
        if not inv:
            continue
        days_held = (date.today() - inv.purchase_date).days
        for d, amt in items:
            if d > days_held:
                continue
            db.add(Transaction(
                user_id=user.id, investment_id=inv.id, type="dividend",
                transaction_date=_days_ago(d), amount=float(amt), notes="Cash dividend",
            ))
            tx_count += 1

    # Partial sell on Solana
    sol = by_sym.get("solana")
    if sol:
        db.add(Transaction(
            user_id=user.id, investment_id=sol.id, type="sell",
            transaction_date=_days_ago(60),
            quantity=2, price_per_unit=140.0, amount=280.0,
            fees=1.5, notes="Trimmed after run-up",
        ))
        tx_count += 1
    # Annual broker fee
    db.add(Transaction(
        user_id=user.id, investment_id=inv_objs[0].id, type="fee",
        transaction_date=_days_ago(30), amount=29.0,
        notes="Annual brokerage fee",
    ))
    tx_count += 1
    # Rental income on Paris studio (12 months)
    studio = next((i for i in inv_objs if i.city == "Paris"), None)
    if studio:
        for m in range(1, 13):
            db.add(Transaction(
                user_id=user.id, investment_id=studio.id, type="dividend",
                transaction_date=_days_ago(m * 30), amount=920.0,
                notes=f"Net rent (month -{m})",
            ))
            tx_count += 1
    db.commit()

    # ---- Scenarios ----
    for s in [
        Scenario(user_id=user.id, name="Aggressive growth", amount=50000,
                 horizon_months=240, annual_return=10.0, inflation_rate=2.5, risk_level="high"),
        Scenario(user_id=user.id, name="Balanced 60/40", amount=50000,
                 horizon_months=240, annual_return=6.5, inflation_rate=2.0, risk_level="medium"),
        Scenario(user_id=user.id, name="Defensive bonds", amount=50000,
                 horizon_months=120, annual_return=3.5, inflation_rate=2.0, risk_level="low"),
    ]:
        db.add(s)

    # ---- Alerts ----
    for a in [
        Alert(user_id=user.id, type="roi_below", threshold=-10.0, scope="portfolio", is_active=True),
        Alert(user_id=user.id, type="drawdown_above", threshold=20.0, scope="portfolio", is_active=True),
    ]:
        db.add(a)

    # ---- Snapshots (18 months of daily history) ----
    # Bulk-insert in one statement instead of 541 individual db.add()s.
    # On Postgres free tier this drops the demo-seed time from ~6s to
    # ~600ms; on SQLite from ~2s to ~80ms. Each demo signup runs this,
    # so the win lands directly on the "click → dashboard" latency.
    snap_total_today = sum(i.current_value for i in inv_objs)
    snap_invested = sum(i.amount_invested for i in inv_objs)
    n_days = 540
    snap_rows = []
    for d in range(n_days, -1, -1):
        day = _days_ago(d)
        progress = 1 - d / n_days
        base = snap_invested + (snap_total_today - snap_invested) * progress
        wobble = (math.sin(d * 0.07) + math.sin(d * 0.18) * 0.5) * (snap_total_today * 0.018)
        snap_rows.append({
            "user_id": user.id,
            "snapshot_date": day,
            "total_value": round(base + wobble, 2),
            "total_invested": round(snap_invested, 2),
        })
    db.bulk_insert_mappings(PortfolioSnapshot, snap_rows)
    db.commit()

    return {
        "investments": len(inv_objs),
        "transactions": tx_count,
        "scenarios": 3,
        "alerts": 2,
        "snapshots": n_days + 1,
        "currency": user.currency,
        "net_worth_usd": round(snap_total_today, 2),
    }
