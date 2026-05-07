"""In-memory SSE hub. State is per-process; single uvicorn worker required for v1.

Each connected client gets a bounded asyncio.Queue. The hub broadcasts events to
every queue; if a queue is full, the event is dropped for that client to avoid
back-pressure stalls (the heartbeat will reveal the missed update on next tick).
"""
from __future__ import annotations

import asyncio
import json
import logging
from typing import Any

log = logging.getLogger("sse")


class SSEHub:
    def __init__(self, queue_max: int = 100) -> None:
        self._clients: set[asyncio.Queue] = set()
        self._queue_max = queue_max
        self._lock = asyncio.Lock()

    async def connect(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=self._queue_max)
        async with self._lock:
            self._clients.add(q)
        log.info("SSE client connected (total=%d)", len(self._clients))
        return q

    async def disconnect(self, q: asyncio.Queue) -> None:
        async with self._lock:
            self._clients.discard(q)
        log.info("SSE client disconnected (total=%d)", len(self._clients))

    async def broadcast(self, event_type: str, data: dict[str, Any]) -> None:
        payload = json.dumps({"type": event_type, "data": data})
        async with self._lock:
            clients = list(self._clients)
        dropped = 0
        for q in clients:
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:
                dropped += 1
        if dropped:
            log.warning("dropped %d SSE events (clients with full queues)", dropped)

    @property
    def client_count(self) -> int:
        return len(self._clients)
