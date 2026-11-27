"""The live feed: one line per thing the run did, kept in a ring, a log file and queues."""

from __future__ import annotations

import asyncio
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path

SUBSCRIBER_QUEUE = 1000


@dataclass(frozen=True)
class FeedLine:
    at: float           # epoch seconds
    device: str         # device name, or "Truck <name>"
    action: str         # stage label, or ready / departed / location / arrived
    subject: str        # SN <serial>, 10 tags, a container name, lat, lng
    ok: bool
    ms: float | None
    note: str = ""


def format_line(line: FeedLine) -> str:
    """`14:02:11  Load test – Label station 2    Label station    SN 7HK2M93    ok  41 ms`,
    in local 24-hour time; a failed line says `failed` and carries its note."""
    out = (f"{time.strftime('%H:%M:%S', time.localtime(line.at))}  {line.device}    "
           f"{line.action}    {line.subject}    {'ok' if line.ok else 'failed'}")
    if line.ms is not None:
        out += f"  {line.ms:.0f} ms"
    if line.note:
        out += f"  {line.note}"
    return out


class Events:
    def __init__(self, log_path: Path | None, keep: int = 500) -> None:
        self._ring: deque[FeedLine] = deque(maxlen=keep)
        self._subscribers: list[asyncio.Queue[FeedLine]] = []
        self._log = open(log_path, "a", encoding="utf-8") if log_path is not None else None

    def feed(self, line: FeedLine) -> None:
        self._ring.append(line)
        if self._log is not None and not self._log.closed:
            self._log.write(format_line(line) + "\n")
            self._log.flush()
        for q in self._subscribers:
            if q.full():
                q.get_nowait()          # a slow reader loses its oldest line, never blocks
            q.put_nowait(line)

    def recent(self) -> list[FeedLine]:
        return list(self._ring)

    def subscribe(self) -> asyncio.Queue[FeedLine]:
        q: asyncio.Queue[FeedLine] = asyncio.Queue(maxsize=SUBSCRIBER_QUEUE)
        self._subscribers.append(q)
        return q

    def unsubscribe(self, q: asyncio.Queue[FeedLine]) -> None:
        if q in self._subscribers:
            self._subscribers.remove(q)

    def close(self) -> None:
        if self._log is not None:
            self._log.close()
