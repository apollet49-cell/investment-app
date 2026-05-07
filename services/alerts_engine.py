from __future__ import annotations

from sqlalchemy.orm import Session

from models import Alert, Investment, User
from schemas import AlertOut


def _to_out(a: Alert) -> AlertOut:
    return AlertOut(
        id=a.id,
        type=a.type,
        threshold=a.threshold,
        scope=a.scope,
        investment_id=a.investment_id,
        is_active=a.is_active,
        is_triggered=a.is_triggered,
        dismissed_at=a.dismissed_at,
        created_at=a.created_at,
    )


def evaluate_alerts(db: Session, user: User) -> list[AlertOut]:
    """Evaluate every active alert for the user; persist is_triggered changes; return triggered+undismissed."""
    alerts = db.query(Alert).filter(Alert.user_id == user.id, Alert.is_active.is_(True)).all()
    investments = db.query(Investment).filter(Investment.user_id == user.id).all()

    portfolio_invested = sum(i.amount_invested for i in investments)
    portfolio_value = sum(i.current_value for i in investments)
    portfolio_roi = ((portfolio_value - portfolio_invested) / portfolio_invested * 100.0) if portfolio_invested > 0 else 0.0

    triggered: list[AlertOut] = []
    changed = False
    for a in alerts:
        was_triggered = a.is_triggered
        if a.scope == "portfolio":
            roi = portfolio_roi
        else:
            inv = next((i for i in investments if i.id == a.investment_id), None)
            if not inv or inv.amount_invested <= 0:
                a.is_triggered = False
                if a.is_triggered != was_triggered:
                    changed = True
                continue
            roi = (inv.current_value - inv.amount_invested) / inv.amount_invested * 100.0

        if a.type == "roi_below":
            now_triggered = roi < a.threshold
        elif a.type == "drawdown_above":
            now_triggered = (-roi) > a.threshold
        else:
            now_triggered = False

        a.is_triggered = now_triggered
        if not was_triggered and now_triggered:
            # Reset dismissal so banner re-appears on a fresh trigger event.
            a.dismissed_at = None
        if a.is_triggered != was_triggered:
            changed = True

        if a.is_triggered and a.dismissed_at is None:
            triggered.append(_to_out(a))

    if changed:
        db.commit()
    return triggered


def refresh_all_alerts(db: Session) -> None:
    """Background-job entrypoint: re-evaluate every user's alerts."""
    users = db.query(User).all()
    for u in users:
        evaluate_alerts(db, u)
