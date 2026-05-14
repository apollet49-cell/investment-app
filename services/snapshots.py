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

from sqlalchemy.orm import Session

from models import Investment, PortfolioSnapshot, User

log = logging.getLogger(__name__)


def take_snapshot(db: Session, user: User, when: date | None = None) -> PortfolioSnapshot:
    when = when or date.today()
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
    db.commit()
    db.refresh(snap)
    return snap


def take_all_snapshots(session_factory) -> int:
    """Scheduler entry point. Opens a fresh session, snapshots every user,
    closes the session. Returns the count of snapshots written. Errors per
    user are logged but don't abort the loop."""
    db: Session = session_factory()
    written = 0
    try:
        users = db.query(User).all()
        for u in users:
            try:
                take_snapshot(db, u)
                written += 1
            except Exception:
                log.exception("snapshot failed for user_id=%s", u.id)
    finally:
        db.close()
    return written
