"""SQLite history: raw checks (7 days) + a per-UTC-day rollup (90 days).
One connection, used only from the event-loop thread; each write is a
tiny transaction, so it is called inline rather than via a thread pool."""

import sqlite3
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

RAW_RETENTION = timedelta(days=7)
WINDOW_DAYS = 90

SCHEMA = """
CREATE TABLE IF NOT EXISTS checks (
    id INTEGER PRIMARY KEY,
    service TEXT NOT NULL,
    at TEXT NOT NULL,
    ok INTEGER NOT NULL,
    latency_ms INTEGER,
    detail TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS checks_service_at ON checks (service, at);
CREATE TABLE IF NOT EXISTS daily (
    service TEXT NOT NULL,
    day TEXT NOT NULL,
    ok_count INTEGER NOT NULL,
    total_count INTEGER NOT NULL,
    PRIMARY KEY (service, day)
);
"""


@dataclass(frozen=True)
class CheckRow:
    at: datetime
    ok: bool
    latency_ms: int | None


@dataclass(frozen=True)
class DayBar:
    day: str
    ok: int | None
    total: int | None


def _utc(at: datetime) -> datetime:
    if at.tzinfo is None:
        raise ValueError("naive datetime; pass a timezone-aware value")
    return at.astimezone(UTC)


class Store:
    def __init__(self, path: str) -> None:
        self.path = path
        Path(path).parent.mkdir(parents=True, exist_ok=True)
        self._conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
        self._conn.execute("PRAGMA journal_mode=WAL")
        self._conn.executescript(SCHEMA)

    def close(self) -> None:
        self._conn.close()

    def record(
        self, service: str, at: datetime, ok: bool, latency_ms: int | None, detail: str
    ) -> None:
        at = _utc(at)
        with self._conn:
            self._conn.execute("BEGIN")
            self._conn.execute(
                "INSERT INTO checks (service, at, ok, latency_ms, detail) VALUES (?, ?, ?, ?, ?)",
                (service, at.isoformat(), int(ok), latency_ms, detail),
            )
            self._conn.execute(
                "INSERT INTO daily (service, day, ok_count, total_count) VALUES (?, ?, ?, 1) "
                "ON CONFLICT (service, day) DO UPDATE SET "
                "ok_count = ok_count + excluded.ok_count, total_count = total_count + 1",
                (service, at.date().isoformat(), int(ok)),
            )

    def recent(self, service: str, limit: int) -> list[CheckRow]:
        rows = self._conn.execute(
            "SELECT at, ok, latency_ms FROM checks WHERE service = ? ORDER BY at DESC, id DESC LIMIT ?",
            (service, limit),
        ).fetchall()
        return [CheckRow(datetime.fromisoformat(a), bool(o), lat) for a, o, lat in reversed(rows)]

    def prune(self, now: datetime) -> None:
        now = _utc(now)
        oldest_day = now.date() - timedelta(days=WINDOW_DAYS - 1)
        with self._conn:
            self._conn.execute("BEGIN")
            self._conn.execute(
                "DELETE FROM checks WHERE at < ?", ((now - RAW_RETENTION).isoformat(),)
            )
            self._conn.execute("DELETE FROM daily WHERE day < ?", (oldest_day.isoformat(),))

    def daily(self, service: str, today: date, days: int = WINDOW_DAYS) -> list[DayBar]:
        first = today - timedelta(days=days - 1)
        found = dict(
            ((d, (o, t)) for d, o, t in self._conn.execute(
                "SELECT day, ok_count, total_count FROM daily "
                "WHERE service = ? AND day >= ? AND day <= ?",
                (service, first.isoformat(), today.isoformat()),
            ))
        )
        bars = []
        for n in range(days):
            day = (first + timedelta(days=n)).isoformat()
            ok, total = found.get(day, (None, None))
            bars.append(DayBar(day, ok, total))
        return bars


def uptime_percent(bars: Iterable[DayBar]) -> float | None:
    ok = total = 0
    for b in bars:
        if b.total:
            ok += b.ok or 0
            total += b.total
    return round(ok / total * 100, 4) if total else None
