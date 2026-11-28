"""Call timings, counters and sampled series for one run.

With `open_log`, every record, count, sample and flag is also appended to the run
folder's metrics.jsonl as it happens, and replayed when the run is continued, so the
statistics cover the whole run however often it was interrupted.
"""

from __future__ import annotations

import copy
import json
import math
import os
import time
from pathlib import Path

from .logline import log

METRICS_NAME = "metrics.jsonl"
SYNC_INTERVAL = 1.0  # seconds between fsyncs, as the journal does
FEED_LOST = "feed_write_errors"  # counter: feed lines events.log did not get

# Calls that run in the background of a move; their failures are listed per call
# but do not count toward the verdict's failed-call total. A failed refresh is followed
# by a new sign-in, whose own failure (move-login, portal-login) is the one that counts.
DEFAULT_BACKGROUND = frozenset(
    {"heartbeat", "station-heartbeat", "waiting-scans", "asset-totals", "system-status",
     "db-health", "refresh", "portal-refresh"}
)


def percentile(sorted_values: list[float], p: float) -> float:
    """Linear interpolation between closest ranks."""
    if len(sorted_values) == 1:
        return sorted_values[0]
    rank = p * (len(sorted_values) - 1)
    lo = math.floor(rank)
    hi = min(lo + 1, len(sorted_values) - 1)
    return sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * (rank - lo)


class Metrics:
    def __init__(self, background: frozenset[str] = DEFAULT_BACKGROUND) -> None:
        self._background = background
        self._times: dict[str, list[float]] = {}
        self._counts: dict[str, int] = {}
        self._retries: dict[str, int] = {}
        self._failures: dict[str, int] = {}
        self._counters: dict[str, int] = {}
        self._series: dict[str, list[list]] = {}
        self._flags: dict[str, str] = {}
        self._log = None
        self._last_sync = 0.0
        self._log_failed = False

    # ── the log in the run folder ──────────────────────────────────────

    def open_log(self, path: Path) -> None:
        """Replays `path` when it exists, then appends every new entry to it. An unreadable
        line is skipped (a torn last line is also cut off, so new lines never join it).
        Raises OSError when the file cannot be read or opened."""
        path = Path(path)
        if path.exists():
            data = path.read_bytes()
            lines = data.split(b"\n")
            for raw in lines:
                entry = _parse(raw)
                if entry is not None:
                    self._replay(entry)
            if data and not data.endswith(b"\n"):
                cut = data.rfind(b"\n") + 1
                with open(path, "r+b") as fh:
                    if _parse(data[cut:]) is None:
                        fh.truncate(cut)
                    else:
                        fh.seek(0, os.SEEK_END)
                        fh.write(b"\n")
        self._log = open(path, "ab")
        self._last_sync = time.monotonic()

    def close_log(self) -> None:
        log_file, self._log = self._log, None
        if log_file is None:
            return
        try:
            log_file.flush()
            os.fsync(log_file.fileno())
        finally:
            log_file.close()

    def _write(self, entry: dict) -> None:
        """Never raises: statistics that cannot be saved are kept in memory and the
        problem is printed once."""
        if self._log is None:
            return
        try:
            self._log.write((json.dumps(entry, allow_nan=False, separators=(",", ":"))
                             + "\n").encode("utf-8"))
            self._log.flush()
            now = time.monotonic()
            if now - self._last_sync >= SYNC_INTERVAL:
                os.fsync(self._log.fileno())
                self._last_sync = now
        except (OSError, ValueError) as exc:
            if not self._log_failed:
                self._log_failed = True
                log("could not write metrics.jsonl; statistics are kept in memory", exc)

    def _replay(self, e: dict) -> None:
        try:
            kind, name = e["k"], e["c"]
            if kind == "r":
                self._record(name, e["ms"], bool(e["ok"]), int(e["n"]))
            elif kind == "c":
                self._count(name, int(e["n"]))
            elif kind == "s":
                self._series.setdefault(name, []).append([float(e["at"]), e["v"]])
            elif kind == "f":
                self._flags[name] = str(e["v"])
        except (KeyError, TypeError, ValueError):
            pass  # a line this version does not understand

    # ── recording ──────────────────────────────────────────────────────

    def record(self, call: str, ms: float | None, ok: bool, retries: int = 0) -> None:
        """One logical call: its last attempt's time, whether it ended well, retries used.

        `ms=None` is a call that never got an answer to time (its sign-in step failed
        first): it counts as a call, and its failure, but adds no latency sample."""
        self._record(call, ms, ok, retries)
        self._write({"k": "r", "c": call, "ms": None if ms is None else float(ms), "ok": ok,
                     "n": retries})

    def _record(self, call: str, ms: float | None, ok: bool, retries: int) -> None:
        self._counts[call] = self._counts.get(call, 0) + 1
        samples = self._times.setdefault(call, [])
        if ms is not None:
            samples.append(float(ms))
        self._retries[call] = self._retries.get(call, 0) + retries
        if not ok:
            self._failures[call] = self._failures.get(call, 0) + 1

    def count(self, name: str, n: int = 1) -> None:
        self._count(name, n)
        self._write({"k": "c", "c": name, "n": n})

    def _count(self, name: str, n: int) -> None:
        self._counters[name] = self._counters.get(name, 0) + n

    def sample(self, series: str, at: float, value: float | dict) -> None:
        kept = copy.deepcopy(value)
        self._series.setdefault(series, []).append([at, kept])
        self._write({"k": "s", "c": series, "at": at, "v": kept})

    def flag(self, name: str, value: str) -> None:
        """A named state that must survive a Continue (the sampler's database health)."""
        if self._flags.get(name) != value:
            self._flags[name] = value
            self._write({"k": "f", "c": name, "v": value})

    # ── reading ────────────────────────────────────────────────────────

    def flags(self) -> dict[str, str]:
        return dict(self._flags)

    def values(self, series: str) -> list:
        """The values of one series, without their times (not copied: read only)."""
        return [v for _, v in self._series.get(series, ())]

    def points(self, series: str) -> list[list]:
        """One series' [at, value] pairs (not copied: read only)."""
        return self._series.get(series, [])

    def calls(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for name in sorted(self._times):
            ordered = sorted(self._times[name])
            out[name] = {
                "count": self._counts[name],
                "retries": self._retries.get(name, 0),
                "failures": self._failures.get(name, 0),
                # null when no attempt of this call was ever timed
                "median_ms": round(percentile(ordered, 0.5), 1) if ordered else None,
                "p95_ms": round(percentile(ordered, 0.95), 1) if ordered else None,
                "max_ms": round(ordered[-1], 1) if ordered else None,
            }
        return out

    def counters(self) -> dict[str, int]:
        return {k: self._counters[k] for k in sorted(self._counters)}

    def series(self) -> dict[str, list[list]]:
        return {k: [list(p) for p in self._series[k]] for k in sorted(self._series)}

    def total_calls(self) -> int:
        """Every call recorded so far, of every kind."""
        return sum(self._counts.values())

    def failed_calls(self) -> int:
        return sum(n for name, n in self._failures.items() if name not in self._background)


def _parse(raw: bytes) -> dict | None:
    if not raw.strip():
        return None
    try:
        entry = json.loads(raw)
    except ValueError:  # includes UnicodeDecodeError
        return None
    return entry if isinstance(entry, dict) else None
