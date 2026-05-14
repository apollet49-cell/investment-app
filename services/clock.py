"""Single source of truth for 'today'.

Render's runtime is UTC. Naive `date.today()` returns the server's local
'today', which on Render IS UTC but on a developer's Mac (or a future
non-UTC deploy) drifts. Snapshots, transaction YTD buckets, and the
dashboard chart all need to agree on what 'today' means.

Use `today_utc()` everywhere instead of `date.today()`."""
from __future__ import annotations

from datetime import date, datetime, timezone


def today_utc() -> date:
    """UTC date — same value across timezones, deterministic for tests."""
    return datetime.now(timezone.utc).date()


def now_utc() -> datetime:
    """UTC datetime."""
    return datetime.now(timezone.utc)
