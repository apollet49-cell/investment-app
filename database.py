from __future__ import annotations

from collections.abc import Generator

from sqlalchemy import create_engine, event
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

# SQLite ignores `ondelete="CASCADE"` unless PRAGMA foreign_keys is ON per
# connection — without this, deleting an Investment leaves orphan
# Transactions on dev SQLite while Postgres enforces it. Force the PRAGMA
# on every new connection so dev parity matches prod.
if _db_url.startswith("sqlite"):
    @event.listens_for(engine, "connect")
    def _sqlite_fk_on(dbapi_conn, _conn_record):
        cursor = dbapi_conn.cursor()
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.close()


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
        # transactions.user_id was added after the table — older deployed DBs
        # need this backfill to avoid every transaction query 500ing.
        ("transactions", "user_id", "ALTER TABLE transactions ADD COLUMN user_id INTEGER"),
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

    # Add the unique constraint on portfolio_snapshots(user_id, snapshot_date)
    # for older DBs that pre-date the constraint. If duplicates already exist
    # (from the prior race), they must be deduped first, otherwise the
    # ALTER TABLE / CREATE UNIQUE INDEX fails and the constraint never lands.
    try:
        existing_indexes = {ix["name"] for ix in insp.get_indexes("portfolio_snapshots")}
        existing_uq = {uc["name"] for uc in insp.get_unique_constraints("portfolio_snapshots")}
        if "uq_snapshot_user_date" not in existing_indexes and "uq_snapshot_user_date" not in existing_uq:
            with engine.begin() as conn:
                # Step 1: dedupe — keep the row with the MAX id (most recent
                # write wins) per (user_id, snapshot_date) pair.
                conn.execute(text(
                    "DELETE FROM portfolio_snapshots WHERE id NOT IN ("
                    "  SELECT MAX(id) FROM portfolio_snapshots "
                    "  GROUP BY user_id, snapshot_date"
                    ")"
                ))
                # Step 2: add the constraint.
                if _db_url.startswith("postgresql"):
                    conn.execute(text(
                        "ALTER TABLE portfolio_snapshots ADD CONSTRAINT "
                        "uq_snapshot_user_date UNIQUE (user_id, snapshot_date)"
                    ))
                else:
                    conn.execute(text(
                        "CREATE UNIQUE INDEX IF NOT EXISTS uq_snapshot_user_date "
                        "ON portfolio_snapshots (user_id, snapshot_date)"
                    ))
    except Exception as e:
        # Constraint may already exist or table not present — log but don't abort boot.
        import logging
        logging.getLogger("database").warning("snapshot dedupe/constraint skipped: %s", e)

    # Composite index for /dashboard/performance (WHERE user_id ORDER BY date).
    try:
        with engine.begin() as conn:
            conn.execute(text(
                "CREATE INDEX IF NOT EXISTS ix_tx_user_date "
                "ON transactions (user_id, transaction_date)"
            ))
    except Exception:
        pass  # index may already exist
