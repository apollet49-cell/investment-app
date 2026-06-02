"""News fetcher via Google News RSS — no API key, works for any query.

Replaces the previous Yahoo Finance RSS implementation, which only
covered tickers Yahoo knew about (so it 404'd on every crypto position
and most non-US tickers). Google News indexes basically everything and
returns recent results for any free-form query, which fits the detail
modal's "news for this asset" use case much better — you can search
"Microsoft", "MSFT", "bitcoin", "Volkswagen scandal" interchangeably.

In-memory TTLCache (10 min) keyed by (query, limit, lang) so a user
re-opening the same detail modal doesn't refetch.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import quote_plus

import feedparser
from cachetools import TTLCache

log = logging.getLogger("news")
_cache: TTLCache = TTLCache(maxsize=512, ttl=600)  # 10 minutes
_lock = asyncio.Lock()


async def get_news(query: str, limit: int = 15, lang: str = "fr") -> list[dict]:
    """Fetch recent Google News results matching `query`.

    `lang` controls the hl / gl / ceid trio: "fr" biases toward French
    sources, "en" toward English/US. Default French because the app
    targets a French audience; the route lets callers override.
    """
    query = (query or "").strip()
    if not query:
        return []
    key = (query.lower(), limit, lang)
    async with _lock:
        if key in _cache:
            return _cache[key]

    def _sync() -> list[dict]:
        if lang == "fr":
            url = (
                f"https://news.google.com/rss/search?q={quote_plus(query)}"
                "&hl=fr&gl=FR&ceid=FR:fr"
            )
        else:
            url = (
                f"https://news.google.com/rss/search?q={quote_plus(query)}"
                "&hl=en-US&gl=US&ceid=US:en"
            )
        try:
            parsed = feedparser.parse(url)
            items: list[dict] = []
            for entry in (parsed.entries or [])[:limit]:
                published_iso: Optional[str] = None
                if getattr(entry, "published_parsed", None):
                    try:
                        published_iso = datetime(
                            *entry.published_parsed[:6], tzinfo=timezone.utc
                        ).isoformat()
                    except Exception:
                        pass
                # entry.source is a FeedParserDict; .get('title') yields
                # the publisher name (BBC, Bloomberg, etc.). Defensive
                # cast for older feedparser versions that may return a
                # plain string.
                source = entry.get("source")
                if source and hasattr(source, "get"):
                    publisher = source.get("title") or source.get("value") or ""
                elif source:
                    publisher = str(source)
                else:
                    publisher = ""
                items.append({
                    "title": (entry.get("title") or "").strip(),
                    "url": entry.get("link") or "",
                    "publisher": publisher,
                    "published_at": published_iso,
                })
            return items
        except Exception as e:
            log.warning("news fetch failed for %s: %s", query, e)
            return []

    items = await asyncio.to_thread(_sync)
    async with _lock:
        _cache[key] = items
    return items
