"""The live feed: one line per thing the run did, kept in a ring, a log file and queues."""

from __future__ import annotations

import asyncio
import time
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

SUBSCRIBER_QUEUE = 1000
WRITE_RETRY_SECONDS = 5.0   # after a failed log write, wall time before the file is tried again


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
    """`2026-11-27 14:02:11  Load test – Label station 2    Label station    SN 7HK2M93    ok
    41 ms`, in local 24-hour time with the date (a run can last two days); a failed line
    says `failed` and carries its note. The page shows the time only."""
    out = (f"{time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(line.at))}  {line.device}    "
           f"{line.action}    {line.subject}    {'ok' if line.ok else 'failed'}")
    if line.ms is not None:
        out += f"  {line.ms:.0f} ms"
    if line.note:
        out += f"  {line.note}"
    return out


class Events:
    def __init__(self, log_path: Path | None, keep: int = 500,
                 on_lost: Callable[[], None] | None = None) -> None:
        """`on_lost` is called once for every line the log did not get (the run counts
        them in its Metrics, so the count survives a Continue)."""
        self._ring: deque[FeedLine] = deque(maxlen=keep)
        self._subscribers: list[asyncio.Queue[FeedLine]] = []
        self._log = open(log_path, "a", encoding="utf-8") if log_path is not None else None
        self.write_errors = 0           # lines not written to the log (disk full, file removed)
        self._on_lost = on_lost
        self._retry_at = 0.0

    def feed(self, line: FeedLine) -> None:
        """Never raises: a log file that cannot be written leaves the ring and the
        subscribers going."""
        self._ring.append(line)
        self._write(line)
        for q in self._subscribers:
            if q.full():
                q.get_nowait()          # a slow reader loses its oldest line, never blocks
            q.put_nowait(line)

    def _write(self, line: FeedLine) -> None:
        if self._log is None or self._log.closed:
            return
        if time.monotonic() < self._retry_at:   # after a failed write: not tried again yet
            self._lost()
            return
        try:
            self._log.write(format_line(line) + "\n")
            self._log.flush()
        except OSError:
            self._lost()
            self._retry_at = time.monotonic() + WRITE_RETRY_SECONDS

    def _lost(self) -> None:
        self.write_errors += 1
        if self._on_lost is not None:
            self._on_lost()

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
            try:
                self._log.close()
            except OSError:
                self.write_errors += 1
