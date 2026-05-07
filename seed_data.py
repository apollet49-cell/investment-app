"""Seed the database with a demo user, sample investments, and scenarios.

Usage:  python seed_data.py
Idempotent: re-running will skip rows that already exist for the demo user.
"""
from __future__ import annotations

from datetime import date, timedelta

from auth import hash_password
from database import SessionLocal, init_db
from models import Alert, Investment, Scenario, User

DEMO_EMAIL = "demo@invest.app"
DEMO_PASSWORD = "demopass"


def _today_minus(months: int) -> date:
    return date.today() - timedelta(days=30 * months)


SAMPLE_INVESTMENTS = [
    {"name": "Apple Inc.",            "type": "stock",       "symbol": "AAPL", "amount_invested": 5000,  "current_value": 6850, "purchase_date": _today_minus(18), "notes": "Long-term hold, earnings beat trend."},
    {"name": "Vanguard S&P 500 ETF",  "type": "etf",         "symbol": "VOO",  "amount_invested": 8000,  "current_value": 9120, "purchase_date": _today_minus(24), "notes": "Core index exposure."},
    {"name": "Microsoft",             "type": "stock",       "symbol": "MSFT", "amount_invested": 4000,  "current_value": 5600, "purchase_date": _today_minus(15), "notes": "Cloud/AI exposure."},
    {"name": "Bitcoin",               "type": "crypto",      "symbol": "BTC",  "amount_invested": 2000,  "current_value": 3450, "purchase_date": _today_minus(10), "notes": "Speculative allocation."},
    {"name": "Ethereum",              "type": "crypto",      "symbol": "ETH",  "amount_invested": 1500,  "current_value": 1320, "purchase_date": _today_minus(8),  "notes": "Underwater, holding."},
    {"name": "10y US Treasury Bond",  "type": "bond",        "symbol": "US10Y","amount_invested": 6000,  "current_value": 6240, "purchase_date": _today_minus(20), "notes": "Defensive ballast."},
    {"name": "Brooklyn Triplex",      "type": "real_estate", "symbol": None,   "amount_invested": 50000, "current_value": 58500, "purchase_date": _today_minus(36), "notes": "Rental income property."},
    {"name": "AI startup seed",       "type": "startup",     "symbol": None,   "amount_invested": 5000,  "current_value": 4500, "purchase_date": _today_minus(6),  "notes": "Pre-seed, illiquid."},
]

SAMPLE_SCENARIOS = [
    {"name": "Bull Market 2026",     "amount": 25000, "horizon_months": 60,  "annual_return": 12.0, "inflation_rate": 2.5, "risk_level": "high"},
    {"name": "Defensive Allocation", "amount": 25000, "horizon_months": 120, "annual_return": 5.0,  "inflation_rate": 2.5, "risk_level": "low"},
    {"name": "Recession Plan",       "amount": 25000, "horizon_months": 36,  "annual_return": 1.5,  "inflation_rate": 4.0, "risk_level": "low"},
]


def seed() -> None:
    init_db()
    db = SessionLocal()
    try:
        user = db.query(User).filter(User.email == DEMO_EMAIL).first()
        if not user:
            user = User(
                email=DEMO_EMAIL,
                name="Demo User",
                hashed_password=hash_password(DEMO_PASSWORD),
                currency="USD",
            )
            db.add(user)
            db.commit()
            db.refresh(user)
            print(f"Created demo user: {DEMO_EMAIL} / {DEMO_PASSWORD}")
        else:
            print(f"Demo user already exists: {DEMO_EMAIL}")

        existing_inv = {i.name for i in db.query(Investment).filter(Investment.user_id == user.id).all()}
        for spec in SAMPLE_INVESTMENTS:
            if spec["name"] in existing_inv:
                continue
            db.add(Investment(user_id=user.id, **spec))
        existing_sc = {s.name for s in db.query(Scenario).filter(Scenario.user_id == user.id).all()}
        for spec in SAMPLE_SCENARIOS:
            if spec["name"] in existing_sc:
                continue
            db.add(Scenario(user_id=user.id, **spec))

        # Default ROI alert
        if not db.query(Alert).filter(Alert.user_id == user.id, Alert.type == "roi_below").first():
            db.add(Alert(user_id=user.id, type="roi_below", threshold=5.0, scope="portfolio"))

        db.commit()
        n_inv = db.query(Investment).filter(Investment.user_id == user.id).count()
        n_sc = db.query(Scenario).filter(Scenario.user_id == user.id).count()
        print(f"Seed complete: {n_inv} investments, {n_sc} scenarios.")
    finally:
        db.close()


if __name__ == "__main__":
    seed()
