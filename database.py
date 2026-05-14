from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from settings import settings

# Render (and some Heroku-style PaaS) hand out URLs starting with `postgres://`
# but SQLAlchemy 2.x only recognises the longer `postgresql://` scheme.
_db_url = settings.DATABASE_URL
if _db_url.startswith("postgres://"):
    _db_url = _db_url.replace("postgres://", "postgresql://", 1)

# SQLite needs check_same_thread=False for FastAPI's threaded request handling.
engine = create_engine(
    _db_url,
    connect_args={"check_same_thread": False} if _db_url.startswith("sqlite") else {},
    echo=False,
    pool_pre_ping=True,  # detects dropped Postgres connections (e.g. after sleep)
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


class Base(DeclarativeBase):
    pass


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


def init_db() -> None:
    # Import models so SQLAlchemy registers them on Base before create_all.
    import models  # noqa: F401
    from sqlalchemy import inspect, text

    Base.metadata.create_all(bind=engine)

    # Idempotent column additions for already-deployed tables. SQLAlchemy's
    # create_all() creates missing tables but NOT missing columns, so we
    # patch in new optional columns by hand. Safe to run on every boot.
    _migrations = [
        # (table, column, ddl)
        ("investments", "quantity", "ALTER TABLE investments ADD COLUMN quantity FLOAT"),
        ("investments", "monthly_rental_income", "ALTER TABLE investments ADD COLUMN monthly_rental_income FLOAT"),
        ("investments", "monthly_rental_charges", "ALTER TABLE investments ADD COLUMN monthly_rental_charges FLOAT"),
        ("investments", "loan_amount", "ALTER TABLE investments ADD COLUMN loan_amount FLOAT"),
        ("investments", "loan_interest_rate_pct", "ALTER TABLE investments ADD COLUMN loan_interest_rate_pct FLOAT"),
        ("investments", "monthly_mortgage_payment", "ALTER TABLE investments ADD COLUMN monthly_mortgage_payment FLOAT"),
        ("investments", "annual_yield_pct", "ALTER TABLE investments ADD COLUMN annual_yield_pct FLOAT"),
        ("investments", "address", "ALTER TABLE investments ADD COLUMN address TEXT"),
        ("investments", "postal_code", "ALTER TABLE investments ADD COLUMN postal_code VARCHAR(16)"),
        ("investments", "city", "ALTER TABLE investments ADD COLUMN city VARCHAR(128)"),
        ("investments", "country", "ALTER TABLE investments ADD COLUMN country VARCHAR(8)"),
        ("investments", "surface_sqm", "ALTER TABLE investments ADD COLUMN surface_sqm FLOAT"),
        ("investments", "property_subtype", "ALTER TABLE investments ADD COLUMN property_subtype VARCHAR(32)"),
        ("investments", "garden_sqm", "ALTER TABLE investments ADD COLUMN garden_sqm FLOAT"),
        ("investments", "account_type", "ALTER TABLE investments ADD COLUMN account_type VARCHAR(16)"),
        ("users", "target_allocation_json", "ALTER TABLE users ADD COLUMN target_allocation_json TEXT"),
    ]
    insp = inspect(engine)
    with engine.begin() as conn:
        for table, column, ddl in _migrations:
            try:
                existing_cols = {c["name"] for c in insp.get_columns(table)}
            except Exception:
                continue
            if column in existing_cols:
                continue
            try:
                conn.execute(text(ddl))
            except Exception:
                pass  # column probably added by a concurrent worker
