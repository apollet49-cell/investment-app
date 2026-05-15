"""Daily portfolio snapshots.

A scheduled job runs `take_all_snapshots(SessionLocal)` once a day and writes
one row per active user into `portfolio_snapshots`. The dashboard chart then
uses these real values instead of a linear interpolation between purchase
date and today.

Idempotent: re-running on the same day updates the existing row rather than
creating a duplicate. That means we can also run it on demand (e.g. right
after the user adds a transaction) without polluting the series.
"""
from __future__ import annotations

import logging
from datetime import date

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from models import Investment, PortfolioSnapshot, User
from services.clock import today_utc

log = logging.getLogger(__name__)


def take_snapshot(db: Session, user: User, when: date | None = None) -> PortfolioSnapshot:
    when = when or today_utc()
    rows = db.query(Investment).filter(Investment.user_id == user.id).all()
    total_value = round(sum((r.current_value or 0) for r in rows), 2)
    total_invested = round(sum((r.amount_invested or 0) for r in rows), 2)
    existing = (
        db.query(PortfolioSnapshot)
        .filter(PortfolioSnapshot.user_id == user.id, PortfolioSnapshot.snapshot_date == when)
        .one_or_none()
    )
    if existing:
        existing.total_value = total_value
        existing.total_invested = total_invested
        db.commit()
        return existing
    snap = PortfolioSnapshot(
        user_id=user.id,
        snapshot_date=when,
        total_value=total_value,
        total_invested=total_invested,
    )
    db.add(snap)
    try:
        db.commit()
        db.refresh(snap)
        return snap
    except IntegrityError:
        # Lost the race against a concurrent take_snapshot for the same
        # (user, date). The unique constraint prevented the duplicate;
        # re-fetch and update the row that won the race.
        db.rollback()
        winner = (
            db.query(PortfolioSnapshot)
            .filter(PortfolioSnapshot.user_id == user.id,
                    PortfolioSnapshot.snapshot_date == when)
            .one()
        )
        winner.total_value = total_value
        winner.total_invested = total_invested
        db.commit()
        return winner


def take_all_snapshots(session_factory) -> int:
    """Scheduler entry point. One SQL statement covers every user instead
    of iterating N users × 3 queries each (the previous implementation
    didn't scale past ~100 users on Postgres free tier — the scheduler
    blocked for 30+ seconds writing snapshots, holding a DB connection
    the whole time).

    The single UPSERT aggregates each user's portfolio total via
    SUM(...) GROUP BY user_id, then inserts/updates one row per user
    for today's date. Idempotent: re-running the job (or running it
    several times a day) just overwrites the same date row.

    Falls back to the per-user loop when the SQL dialect doesn't support
    the upsert syntax we use (everything except very old SQLite)."""
    from sqlalchemy import text
    db: Session = session_factory()
    today = today_utc()
    try:
        dialect = db.bind.dialect.name
        if dialect in ("postgresql", "sqlite"):
            # SQLite 3.24+ and Postgres share the ON CONFLICT DO UPDATE
            # form thanks to the uq_snapshot_user_date constraint.
            stmt = text("""
                INSERT INTO portfolio_snapshots
                  (user_id, snapshot_date, total_value, total_invested, created_at)
                SELECT
                  i.user_id,
                  :today AS snapshot_date,
                  ROUND(CAST(SUM(COALESCE(i.current_value, 0)) AS NUMERIC), 2) AS total_value,
                  ROUND(CAST(SUM(COALESCE(i.amount_invested, 0)) AS NUMERIC), 2) AS total_invested,
                  CURRENT_TIMESTAMP
                FROM investments i
                GROUP BY i.user_id
                ON CONFLICT (user_id, snapshot_date) DO UPDATE
                SET total_value = EXCLUDED.total_value,
                    total_invested = EXCLUDED.total_invested
            """)
            result = db.execute(stmt, {"today": today.isoformat()})
            db.commit()
            return result.rowcount or 0

        # Fallback: per-user loop for dialects that don't support our upsert.
        written = 0
        users = db.query(User).all()
        for u in users:
            try:
                take_snapshot(db, u)
                written += 1
            except Exception:
                log.exception("snapshot failed for user_id=%s", u.id)
        return written
    finally:
        db.close()
