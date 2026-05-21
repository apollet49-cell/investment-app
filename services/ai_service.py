"""Anthropic Claude one-shot calls used by the monthly PDF report and the
dashboard's hero-insight endpoint. Streaming chat was removed with the
chatbot router; everything here is request/response."""
from __future__ import annotations

import logging
from typing import Optional

from anthropic import Anthropic
from sqlalchemy.orm import Session

from crypto import decrypt
from models import Investment, User
from settings import settings

log = logging.getLogger("ai_service")

MODEL = settings.ANTHROPIC_MODEL
SYSTEM_BASE = (
    "You are InvestAI, an expert financial advisor. You help users analyze investments, "
    "calculate returns, plan scenarios, and give actionable advice. Always be specific with "
    "numbers. Suggest concrete investment strategies. Format responses with clear sections. "
    "Never give generic advice."
)


class APIKeyMissingError(RuntimeError):
    pass


def _resolve_key(user: User) -> str:
    if user.encrypted_anthropic_key:
        try:
            return decrypt(user.encrypted_anthropic_key)
        except Exception as e:
            log.error("failed to decrypt user %d's anthropic key: %s", user.id, e)
    if settings.ANTHROPIC_API_KEY:
        return settings.ANTHROPIC_API_KEY
    raise APIKeyMissingError("no anthropic key configured for user or as global fallback")


def _portfolio_summary(db: Session, user: User) -> str:
    rows = db.query(Investment).filter(Investment.user_id == user.id).all()
    if not rows:
        return f"User {user.name} ({user.currency}) has no investments yet."
    total_invested = sum(r.amount_invested for r in rows)
    total_value = sum(r.current_value for r in rows)
    roi = ((total_value - total_invested) / total_invested * 100.0) if total_invested > 0 else 0.0
    by_type: dict[str, float] = {}
    for r in rows:
        by_type[r.type] = by_type.get(r.type, 0.0) + r.current_value
    alloc = ", ".join(f"{k}: {v / total_value * 100:.1f}%" for k, v in sorted(by_type.items())) if total_value else "n/a"
    top5 = sorted(rows, key=lambda r: r.current_value, reverse=True)[:5]
    top5_str = "; ".join(
        f"{r.name} ({r.type}, invested {r.amount_invested:.2f} {user.currency}, now {r.current_value:.2f})"
        for r in top5
    )
    return (
        f"USER PORTFOLIO ({user.currency}):\n"
        f"- Total invested: {total_invested:.2f}\n"
        f"- Current value: {total_value:.2f}\n"
        f"- Total ROI: {roi:+.2f}%\n"
        f"- Allocation: {alloc}\n"
        f"- Top 5 holdings: {top5_str}\n"
    )


def build_system_prompt(db: Session, user: User) -> str:
    return SYSTEM_BASE + "\n\n" + _portfolio_summary(db, user)


def one_shot(db: Session, user: User, message: str, system_override: Optional[str] = None, max_tokens: int = 1024) -> str:
    """Non-streaming convenience for PDF report generation."""
    api_key = _resolve_key(user)
    client = Anthropic(api_key=api_key)
    msg = client.messages.create(
        model=MODEL,
        system=system_override or build_system_prompt(db, user),
        messages=[{"role": "user", "content": message}],
        max_tokens=max_tokens,
    )
    parts = [b.text for b in msg.content if getattr(b, "type", "") == "text"]
    return "".join(parts)
