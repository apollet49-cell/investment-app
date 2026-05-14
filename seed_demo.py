"""Seed a realistic demo account with data across every page of the app.

Run: python seed_demo.py
Login: demo@investapp.io / demo2026

The script is idempotent — re-running it deletes the demo user's data and
re-creates it, leaving other users untouched.
"""
from __future__ import annotations

import json
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

# Make `investment_app/` importable when this is run from inside the directory.
sys.path.insert(0, str(Path(__file__).resolve().parent))

from auth import hash_password
from database import SessionLocal, init_db
from models import (
    Alert,
    ChatMessage,
    DCAPlan,
    Investment,
    PortfolioSnapshot,
    Scenario,
    Transaction,
    User,
    WatchlistItem,
)
from services.snapshots import take_snapshot

DEMO_EMAIL = "demo@investapp.io"
DEMO_PASSWORD = "demo2026"
DEMO_NAME = "Alex Demo"

TODAY = date.today()


def days_ago(n: int) -> date:
    return TODAY - timedelta(days=n)


def main() -> None:
    init_db()
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == DEMO_EMAIL).one_or_none()
        if user is None:
            user = User(
                email=DEMO_EMAIL,
                name=DEMO_NAME,
                hashed_password=hash_password(DEMO_PASSWORD),
                currency="EUR",
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            print(f"created user {user.email} (id={user.id})")
        else:
            user.name = DEMO_NAME
            user.hashed_password = hash_password(DEMO_PASSWORD)
            user.currency = "EUR"
            # Wipe demo data for a clean re-seed
            for model in (
                Transaction,
                DCAPlan,
                Alert,
                Scenario,
                WatchlistItem,
                ChatMessage,
                PortfolioSnapshot,
                Investment,
            ):
                db.query(model).filter(model.user_id == user.id).delete(synchronize_session=False)
            db.commit()
            print(f"reset user {user.email} (id={user.id})")

        # ---------- Target allocation (drives Rebalance page) ----------
        user.target_allocation_json = json.dumps({
            "stock": 25, "etf": 40, "crypto": 10,
            "bond": 10, "real_estate": 12, "startup": 3,
        })
        db.commit()

        # ---------- Investments (cover every type) ----------
        investments = [
            dict(name="Apple Inc.", type="stock", symbol="AAPL",
                 amount_invested=5000, current_value=6850, quantity=28,
                 purchase_date=days_ago(540), account_type="cto",
                 notes="Core US tech holding."),
            dict(name="Microsoft", type="stock", symbol="MSFT",
                 amount_invested=3000, current_value=3620, quantity=8,
                 purchase_date=days_ago(420), account_type="cto"),
            dict(name="LVMH", type="stock", symbol="MC.PA",
                 amount_invested=2500, current_value=2380, quantity=3,
                 purchase_date=days_ago(300), account_type="pea",
                 notes="Long-term luxury exposure (PEA)."),
            dict(name="Vanguard FTSE All-World", type="etf", symbol="VWCE.DE",
                 amount_invested=12000, current_value=14200, quantity=110,
                 purchase_date=days_ago(720), account_type="pea",
                 notes="Core diversified ETF."),
            dict(name="iShares Core MSCI World", type="etf", symbol="IWDA.AS",
                 amount_invested=4000, current_value=4750, quantity=46,
                 purchase_date=days_ago(450), account_type="pea"),
            dict(name="Lyxor PEA NASDAQ", type="etf", symbol="PUST.PA",
                 amount_invested=2500, current_value=3100, quantity=80,
                 purchase_date=days_ago(380), account_type="pea"),
            dict(name="Bitcoin", type="crypto", symbol="bitcoin",
                 amount_invested=4500, current_value=8200, quantity=0.12,
                 purchase_date=days_ago(660), account_type="cto",
                 notes="DCA'd in 2023."),
            dict(name="Ethereum", type="crypto", symbol="ethereum",
                 amount_invested=2000, current_value=2350, quantity=0.85,
                 purchase_date=days_ago(390), account_type="cto"),
            dict(name="Solana", type="crypto", symbol="solana",
                 amount_invested=800, current_value=1450, quantity=12,
                 purchase_date=days_ago(220), account_type="cto"),
            dict(name="iShares Euro Govt Bond", type="bond", symbol="IEAG.AS",
                 amount_invested=5000, current_value=5180, quantity=43,
                 purchase_date=days_ago(500), account_type="cto",
                 notes="Defensive sleeve."),
            dict(name="Vanguard Total Bond", type="bond", symbol="BND",
                 amount_invested=3000, current_value=2920, quantity=40,
                 purchase_date=days_ago(310), account_type="cto"),
            dict(name="Studio Paris 11e", type="real_estate", symbol=None,
                 amount_invested=180000, current_value=215000,
                 purchase_date=days_ago(900), account_type="other",
                 address="42 Rue Oberkampf", postal_code="75011",
                 city="Paris", country="FR", surface_sqm=28,
                 property_subtype="apartment",
                 monthly_rental_income=1100, monthly_rental_charges=180,
                 loan_amount=140000, loan_interest_rate_pct=2.1,
                 monthly_mortgage_payment=620,
                 notes="Rented out — Airbnb-friendly area."),
            dict(name="House Lyon 7e", type="real_estate", symbol=None,
                 amount_invested=240000, current_value=265000,
                 purchase_date=days_ago(1400), account_type="other",
                 address="15 Quai Claude Bernard", postal_code="69007",
                 city="Lyon", country="FR", surface_sqm=72,
                 property_subtype="apartment",
                 monthly_rental_income=1450, monthly_rental_charges=240,
                 loan_amount=180000, loan_interest_rate_pct=1.6,
                 monthly_mortgage_payment=810),
            dict(name="Aircall (pre-IPO)", type="startup", symbol=None,
                 amount_invested=8000, current_value=12500,
                 purchase_date=days_ago(800), account_type="cto",
                 annual_yield_pct=14.0,
                 notes="Friends-and-family allocation; very illiquid."),
            dict(name="Klarna (secondary)", type="startup", symbol=None,
                 amount_invested=3000, current_value=2700,
                 purchase_date=days_ago(450), account_type="cto",
                 annual_yield_pct=8.0,
                 notes="Secondary market — written down once."),
        ]
        inv_objs: list[Investment] = []
        for spec in investments:
            inv = Investment(user_id=user.id, **spec)
            db.add(inv)
            inv_objs.append(inv)
        db.commit()
        for inv in inv_objs:
            db.refresh(inv)
        print(f"added {len(inv_objs)} investments")

        # ---------- Transactions (one buy per investment + a few sells/divs/fees) ----------
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
        # Dividends across dividend-paying ETFs and stocks (quarterly-ish)
        for sym, divs in {
            "AAPL": [(120, 18), (210, 18), (300, 19), (390, 21)],
            "MSFT": [(95, 7), (185, 7), (275, 8), (365, 8)],
            "MC.PA": [(150, 22)],
            "VWCE.DE": [(180, 95), (360, 110), (545, 120)],
            "IEAG.AS": [(120, 35), (240, 35), (360, 36), (480, 38)],
            "BND": [(60, 9), (120, 9), (180, 9), (240, 9), (300, 9)],
        }.items():
            inv = next((i for i in inv_objs if i.symbol == sym), None)
            if inv is None:
                continue
            for d_ago, amount in divs:
                if d_ago > (TODAY - inv.purchase_date).days:
                    continue
                db.add(Transaction(
                    user_id=user.id, investment_id=inv.id, type="dividend",
                    transaction_date=days_ago(d_ago),
                    amount=amount, notes="Cash dividend",
                ))
                tx_count += 1
        # A partial sell on Solana (took some profit)
        sol = next((i for i in inv_objs if i.symbol == "solana"), None)
        if sol:
            db.add(Transaction(
                user_id=user.id, investment_id=sol.id, type="sell",
                transaction_date=days_ago(60),
                quantity=2, price_per_unit=140.0, amount=280.0,
                fees=1.5, notes="Trimmed after run-up",
            ))
            tx_count += 1
        # Annual broker fee
        db.add(Transaction(
            user_id=user.id, investment_id=inv_objs[0].id, type="fee",
            transaction_date=days_ago(30),
            amount=29.0, notes="Annual brokerage fee",
        ))
        tx_count += 1
        # Rental income (logged as 'dividend' so XIRR picks it up)
        studio = next((i for i in inv_objs if i.city == "Paris"), None)
        if studio:
            for m in range(1, 13):
                db.add(Transaction(
                    user_id=user.id, investment_id=studio.id, type="dividend",
                    transaction_date=days_ago(m * 30),
                    amount=920.0, notes=f"Net rent (month -{m})",
                ))
                tx_count += 1
        db.commit()
        print(f"added {tx_count} transactions")

        # ---------- DCA plans ----------
        dca_plans = [
            DCAPlan(user_id=user.id, name="VWCE monthly",
                    symbol="VWCE.DE", asset_type="etf",
                    amount=400, frequency="monthly",
                    start_date=days_ago(540), is_active=True),
            DCAPlan(user_id=user.id, name="Bitcoin weekly",
                    symbol="bitcoin", asset_type="crypto",
                    amount=50, frequency="weekly",
                    start_date=days_ago(280), is_active=True),
            DCAPlan(user_id=user.id, name="World ETF (IWDA) — paused",
                    symbol="IWDA.AS", asset_type="etf",
                    amount=250, frequency="biweekly",
                    start_date=days_ago(700), is_active=False),
        ]
        for p in dca_plans:
            db.add(p)
        db.commit()
        print(f"added {len(dca_plans)} DCA plans")

        # ---------- Scenarios ----------
        scenarios = [
            Scenario(user_id=user.id, name="Aggressive growth",
                     amount=50000, horizon_months=240,
                     annual_return=10.0, inflation_rate=2.5,
                     risk_level="high"),
            Scenario(user_id=user.id, name="Balanced 60/40",
                     amount=50000, horizon_months=240,
                     annual_return=6.5, inflation_rate=2.0,
                     risk_level="medium"),
            Scenario(user_id=user.id, name="Defensive bonds",
                     amount=50000, horizon_months=120,
                     annual_return=3.5, inflation_rate=2.0,
                     risk_level="low"),
        ]
        for s in scenarios:
            db.add(s)
        db.commit()
        print(f"added {len(scenarios)} scenarios")

        # ---------- Alerts ----------
        alerts = [
            Alert(user_id=user.id, type="roi_below", threshold=-10.0,
                  scope="portfolio", is_active=True),
            Alert(user_id=user.id, type="drawdown_above", threshold=20.0,
                  scope="portfolio", is_active=True),
        ]
        for a in alerts:
            db.add(a)
        db.commit()
        print(f"added {len(alerts)} alerts")

        # ---------- Watchlist ----------
        wl = [
            WatchlistItem(user_id=user.id, symbol="NVDA", asset_type="stock", name="NVIDIA"),
            WatchlistItem(user_id=user.id, symbol="TSLA", asset_type="stock", name="Tesla"),
            WatchlistItem(user_id=user.id, symbol="ASML", asset_type="stock", name="ASML Holding"),
            WatchlistItem(user_id=user.id, symbol="VUSA.AS", asset_type="etf", name="Vanguard S&P 500"),
            WatchlistItem(user_id=user.id, symbol="cardano", asset_type="crypto", name="Cardano"),
        ]
        for w in wl:
            db.add(w)
        db.commit()
        print(f"added {len(wl)} watchlist items")

        # ---------- Chat history (so the AI advisor page is populated) ----------
        chats = [
            ChatMessage(user_id=user.id, role="user",
                        content="Should I rebalance now or wait until end of year?",
                        created_at=datetime.now() - timedelta(days=4)),
            ChatMessage(user_id=user.id, role="assistant",
                        content=(
                            "Looking at your portfolio, equities are slightly over-target "
                            "(~75% vs the 65% you set). A modest trim into bonds would lower "
                            "drawdown risk, but if your CTO holdings have large unrealised "
                            "gains, deferring to January spreads the tax bill. The PEA "
                            "trades are tax-neutral — those are the best candidates to "
                            "rebalance now."
                        ),
                        created_at=datetime.now() - timedelta(days=4, hours=-1)),
            ChatMessage(user_id=user.id, role="user",
                        content="What's my biggest concentration risk?",
                        created_at=datetime.now() - timedelta(days=1)),
            ChatMessage(user_id=user.id, role="assistant",
                        content=(
                            "Real estate is your largest single bucket at roughly 60% of "
                            "net asset value (Paris + Lyon combined). It's illiquid and tied "
                            "to French residential prices — if rates rise further, both "
                            "valuation and your floating mortgage cost move against you."
                        ),
                        created_at=datetime.now() - timedelta(days=1, hours=-1)),
        ]
        for c in chats:
            db.add(c)
        db.commit()
        print(f"added {len(chats)} chat messages")

        # ---------- Portfolio snapshots (backfill 540 days = 18 months) ----------
        # The dashboard chart + TWR look meaningful only with enough history.
        # We synthesise a smooth-but-wobbly path from invested → current value.
        import math
        snapshot_total_today = sum(i.current_value for i in inv_objs)
        snapshot_invested = sum(i.amount_invested for i in inv_objs)
        n_days = 540
        for d in range(n_days, -1, -1):
            day = days_ago(d)
            progress = 1 - d / n_days
            base = snapshot_invested + (snapshot_total_today - snapshot_invested) * progress
            # Two overlapping sine waves give a more credible market-like wobble.
            wobble = (math.sin(d * 0.07) + math.sin(d * 0.18) * 0.5) * (snapshot_total_today * 0.018)
            value = round(base + wobble, 2)
            existing = (
                db.query(PortfolioSnapshot)
                .filter(PortfolioSnapshot.user_id == user.id,
                        PortfolioSnapshot.snapshot_date == day)
                .one_or_none()
            )
            if existing:
                existing.total_value = value
                existing.total_invested = round(snapshot_invested, 2)
            else:
                db.add(PortfolioSnapshot(
                    user_id=user.id, snapshot_date=day,
                    total_value=value, total_invested=round(snapshot_invested, 2),
                ))
        db.commit()
        print(f"added {n_days + 1} daily snapshots")

        print()
        print("=== Demo account ready ===")
        print(f"   email:    {DEMO_EMAIL}")
        print(f"   password: {DEMO_PASSWORD}")
        print(f"   currency: EUR")
        print(f"   net worth: €{snapshot_total_today:,.0f}")
    finally:
        db.close()


if __name__ == "__main__":
    main()
