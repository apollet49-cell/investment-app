"""News fetcher via Yahoo Finance RSS (no API key required). Returns at most
`limit` items per call. Results are cached for 5 minutes to keep the page fast
and to avoid hammering Yahoo.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

import feedparser
from cachetools import TTLCache

log = logging.getLogger("news")
_cache: TTLCache = TTLCache(maxsize=512, ttl=300)
_lock = asyncio.Lock()


async def get_news(symbol: str, limit: int = 8) -> list[dict]:
    symbol = symbol.upper()
    async with _lock:
        if symbol in _cache:
            return _cache[symbol][:limit]

    def _sync() -> list[dict]:
        url = f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={symbol}&region=US&lang=en-US"
        try:
            parsed = feedparser.parse(url)
            items = []
            for entry in (parsed.entries or [])[:limit]:
                published_str: Optional[str] = None
                if getattr(entry, "published_parsed", None):
                    try:
                        published_str = datetime(*entry.published_parsed[:6], tzinfo=timezone.utc).isoformat()
                    except Exception:
                        pass
                items.append({
                    "title": entry.get("title", "(no title)"),
                    "link": entry.get("link", ""),
                    "summary": (entry.get("summary") or "")[:300],
                    "published": published_str,
                    "source": "Yahoo Finance",
                })
            return items
        except Exception as e:
            log.warning("news fetch failed for %s: %s", symbol, e)
            return []

    items = await asyncio.to_thread(_sync)
    async with _lock:
        _cache[symbol] = items
    return items[:limit]
