"""Anthropic Claude integration for the InvestAI chatbot.

Streams responses token-by-token via SSE. Persists user + assistant messages
after the stream completes (or marks `truncated=True` if the client
disconnected mid-stream).
"""
from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Optional

from anthropic import Anthropic, APIError, AuthenticationError, RateLimitError
from sqlalchemy.orm import Session

from crypto import decrypt
from models import ChatMessage, Investment, User
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


def _history(db: Session, user: User, limit: int = 20) -> list[dict[str, str]]:
    rows = (
        db.query(ChatMessage)
        .filter(ChatMessage.user_id == user.id)
        .order_by(ChatMessage.created_at.desc())
        .limit(limit)
        .all()
    )
    rows.reverse()
    return [{"role": r.role, "content": r.content} for r in rows]


async def stream_chat(db: Session, user: User, message: str) -> AsyncIterator[str]:
    """Yield SSE-formatted frames. Persist messages after stream completes."""
    try:
        api_key = _resolve_key(user)
    except APIKeyMissingError:
        yield _sse({"error": "Set your Anthropic API key in Settings to use the chatbot."})
        return

    client = Anthropic(api_key=api_key)
    system = build_system_prompt(db, user)
    history = _history(db, user)
    messages = history + [{"role": "user", "content": message}]

    # Save the user's message immediately so it is reflected in /chat/history
    # even if the stream is interrupted before any tokens come back.
    db.add(ChatMessage(user_id=user.id, role="user", content=message))
    db.commit()

    accumulated = ""
    truncated = False
    try:
        with client.messages.stream(
            model=MODEL,
            system=system,
            messages=messages,
            max_tokens=2048,
        ) as stream:
            for chunk in stream.text_stream:
                accumulated += chunk
                yield _sse({"delta": chunk})
        yield _sse({"done": True})
    except AuthenticationError:
        truncated = True
        yield _sse({"error": "Anthropic API key was rejected. Update it in Settings."})
    except RateLimitError:
        truncated = True
        yield _sse({"error": "Anthropic rate limit reached. Try again in a moment."})
    except APIError as e:
        truncated = True
        log.exception("Anthropic API error: %s", e)
        yield _sse({"error": "AI service is temporarily unavailable. Please try again."})
    except Exception as e:  # noqa: BLE001
        truncated = True
        log.exception("Chat stream failed: %s", e)
        yield _sse({"error": "Unexpected error while generating response."})
    finally:
        if accumulated:
            db.add(ChatMessage(user_id=user.id, role="assistant", content=accumulated, truncated=truncated))
            db.commit()


def _sse(payload: dict) -> str:
    return f"data: {json.dumps(payload)}\n\n"


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
