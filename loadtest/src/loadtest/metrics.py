"""Call timings, counters and sampled series for one run."""

from __future__ import annotations

import copy
import math

# Calls that run in the background of a move; their failures are listed per call
# but do not count toward the verdict's failed-call total. A failed refresh is followed
# by a new sign-in, whose own failure (move-login, portal-login) is the one that counts.
DEFAULT_BACKGROUND = frozenset(
    {"heartbeat", "station-heartbeat", "waiting-scans", "asset-totals", "system-status",
     "db-health", "refresh", "portal-refresh"}
)


def _percentile(sorted_values: list[float], p: float) -> float:
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

    def record(self, call: str, ms: float | None, ok: bool, retries: int = 0) -> None:
        """One logical call: its last attempt's time, whether it ended well, retries used.

        `ms=None` is a call that never got an answer to time (its sign-in step failed
        first): it counts as a call, and its failure, but adds no latency sample."""
        self._counts[call] = self._counts.get(call, 0) + 1
        samples = self._times.setdefault(call, [])
        if ms is not None:
            samples.append(float(ms))
        self._retries[call] = self._retries.get(call, 0) + retries
        if not ok:
            self._failures[call] = self._failures.get(call, 0) + 1

    def count(self, name: str, n: int = 1) -> None:
        self._counters[name] = self._counters.get(name, 0) + n

    def sample(self, series: str, at: float, value: float | dict) -> None:
        self._series.setdefault(series, []).append([at, copy.deepcopy(value)])

    def calls(self) -> dict[str, dict]:
        out: dict[str, dict] = {}
        for name in sorted(self._times):
            ordered = sorted(self._times[name])
            out[name] = {
                "count": self._counts[name],
                "retries": self._retries.get(name, 0),
                "failures": self._failures.get(name, 0),
                # null when no attempt of this call was ever timed
                "median_ms": round(_percentile(ordered, 0.5), 1) if ordered else None,
                "p95_ms": round(_percentile(ordered, 0.95), 1) if ordered else None,
                "max_ms": round(ordered[-1], 1) if ordered else None,
            }
        return out

    def counters(self) -> dict[str, int]:
        return {k: self._counters[k] for k in sorted(self._counters)}

    def series(self) -> dict[str, list[list]]:
        return {k: [list(p) for p in self._series[k]] for k in sorted(self._series)}

    def failed_calls(self) -> int:
        return sum(n for name, n in self._failures.items() if name not in self._background)
