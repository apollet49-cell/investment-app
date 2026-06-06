"""Postgres-backed slow-path cache for market data.

Sits behind the in-memory TTLCache in services/market_data.py. The fast
path is still RAM — this only kicks in on a cache miss to skip a fresh
yfinance round-trip if Postgres has a recent enough copy.

Typical flow:
    1. memory cache hit  → return (microseconds)
    2. memory miss → DB hit (still fresh) → return (≈5ms)
    3. memory miss → DB miss → fetch yfinance (≈300-3000ms)
    4. After fetch → write both memory + DB

The DB cache survives process restarts (Render free tier sleeps after
15min idle — every wake-up was paying a fresh yfinance hit until now).
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from sqlalchemy import delete
from sqlalchemy.orm import Session

from database import SessionLocal
from models import MarketDataCache

log = logging.getLogger("market_cache_db")

# Default TTLs by kind — same as the in-memory cache so the two layers
# are consistent. Overridable per call.
DEFAULT_TTL_SECONDS = {
    "stock": 60,
    "crypto": 60,
    "forex": 300,
    # "fx" is the same data as "forex" but routed through the new explicit
    # FX cache layer in market_data.py with a much longer TTL. The FX
    # rates used for portfolio display barely move within a day — 24h is
    # plenty for our use case and keeps OpenExchangeRates well under its
    # 1000 req/month free quota.
    "fx": 86400,
    "indices": 30,
    "macro": 3600,
    "historical": 1800,  # 30min — historical data doesn't change intra-day
    "dividend": 3600,
}


def get(kind: str, key: str) -> Optional[Any]:
    """Return the cached payload if present and fresh, else None.

    Never raises — a DB failure just degrades to "cache miss" so the
    caller falls through to the network. Errors are logged at WARNING."""
    try:
        db: Session = SessionLocal()
        try:
            row = (
                db.query(MarketDataCache)
                .filter(
                    MarketDataCache.kind == kind,
                    MarketDataCache.key == key,
                    MarketDataCache.expires_at > datetime.now(timezone.utc),
                )
                .first()
            )
            if not row:
                return None
            return json.loads(row.payload)
        finally:
            db.close()
    except Exception as e:
        log.warning("DB cache get failed for %s/%s: %s", kind, key, e)
        return None


def put(kind: str, key: str, value: Any, ttl_seconds: Optional[int] = None) -> None:
    """Write a payload to the cache. Idempotent — upserts on (kind, key).
    `ttl_seconds` defaults to the kind-specific TTL above. Errors are
    swallowed (logged) so a DB outage never breaks the price fetch."""
    if ttl_seconds is None:
        ttl_seconds = DEFAULT_TTL_SECONDS.get(kind, 300)
    try:
        db: Session = SessionLocal()
        try:
            payload = json.dumps(value, default=str)  # str for date / datetime
            expires = datetime.now(timezone.utc) + timedelta(seconds=ttl_seconds)
            # Upsert via merge-then-flush. SQLAlchemy doesn't have a portable
            # ON CONFLICT, so we delete-then-insert.
            db.query(MarketDataCache).filter(
                MarketDataCache.kind == kind, MarketDataCache.key == key
            ).delete(synchronize_session=False)
            db.add(MarketDataCache(
                kind=kind, key=key, payload=payload, expires_at=expires,
            ))
            db.commit()
        except Exception as e:
            db.rollback()
            log.warning("DB cache put failed for %s/%s: %s", kind, key, e)
        finally:
            db.close()
    except Exception as e:
        log.warning("DB cache put session error for %s/%s: %s", kind, key, e)


def purge_expired() -> int:
    """Scheduler entry point — drop expired rows. Bounds the table size
    so the cache doesn't grow forever. Returns the deletion count."""
    try:
        db: Session = SessionLocal()
        try:
            now = datetime.now(timezone.utc)
            n = db.query(MarketDataCache).filter(MarketDataCache.expires_at < now).count()
            db.execute(delete(MarketDataCache).where(MarketDataCache.expires_at < now))
            db.commit()
            return n
        finally:
            db.close()
    except Exception as e:
        log.warning("DB cache purge failed: %s", e)
        return 0
