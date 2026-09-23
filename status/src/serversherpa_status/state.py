"""Displayed state per service. One failed check is noise; a service reads
'down' only after `threshold` consecutive failures, and 'up' again on the
first success. Every check still counts toward uptime (see store.py)."""

from collections.abc import Iterable
from dataclasses import dataclass
from datetime import datetime


@dataclass(frozen=True)
class Snapshot:
    state: str  # "up" | "down" | "unknown"
    last_checked_at: datetime | None
    latency_ms: int | None


class StateTracker:
    def __init__(self, keys: Iterable[str], threshold: int) -> None:
        self._threshold = threshold
        self._fails = {k: 0 for k in keys}
        self._snap = {k: Snapshot("unknown", None, None) for k in self._fails}

    def record(self, key: str, ok: bool, latency_ms: int | None, at: datetime) -> None:
        prev = self._snap[key].state
        if ok:
            self._fails[key] = 0
            state = "up"
        else:
            self._fails[key] += 1
            state = "down" if self._fails[key] >= self._threshold else prev
        self._snap[key] = Snapshot(state, at, latency_ms)

    def snapshot(self, key: str) -> Snapshot:
        return self._snap[key]
