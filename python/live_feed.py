"""A tiny in-process fan-out for Server-Sent Events. The owner console and
the developer panel subscribe to it, so a billing event that lands on the
webhook route is on screen in the same breath it is written to the database.
One process, one broadcaster; a real deployment would put a message bus here.

The frames are the same ones the TypeScript twin publishes
(``app/src/events.ts``), because the browser app parsing them is the same
browser app.
"""

import asyncio
import json
from typing import Any, AsyncIterator, Dict, Set

from store import now_iso

# Enough room for a burst of deliveries while a slow reader catches up; past
# that the subscriber is dropped rather than allowed to grow the queue without
# bound. It reconnects and re-reads, because the archive is the source of
# truth and the stream is only the nudge.
QUEUE_DEPTH = 256

# Proxies drop idle streams; a comment every 25s keeps them open.
HEARTBEAT_SECONDS = 25

SSE_HEADERS = {
    "Cache-Control": "no-cache, no-transform",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


class LiveFeed:
    def __init__(self) -> None:
        self._subscribers: Set[asyncio.Queue] = set()

    async def subscribe(self) -> AsyncIterator[str]:
        queue: asyncio.Queue = asyncio.Queue(maxsize=QUEUE_DEPTH)
        self._subscribers.add(queue)
        try:
            yield ": connected\n\n"
            while True:
                try:
                    yield await asyncio.wait_for(queue.get(), HEARTBEAT_SECONDS)
                except asyncio.TimeoutError:
                    yield ": ping\n\n"
        finally:
            self._subscribers.discard(queue)

    def publish(self, event: Dict[str, Any]) -> None:
        """Push one frame to every subscriber. Call it from the event loop:
        the routes that publish are async for exactly that reason."""
        frame = f"data: {json.dumps({**event, 'published_at': now_iso()})}\n\n"
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(frame)
            except asyncio.QueueFull:
                self._subscribers.discard(queue)

    @property
    def subscriber_count(self) -> int:
        return len(self._subscribers)
