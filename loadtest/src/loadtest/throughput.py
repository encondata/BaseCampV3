"""Calls and scans per second, from the sampler's paired readings.

Each reading in the `throughput` series is {"calls", "scans", "waiting"} taken at one
moment: every call this run has made so far, every scan the server has taken so far
(sent less rejected) and the server's waiting-scan count. Rates are the difference
between two readings divided by the seconds between them. Scans processed in an
interval are the scans sent in it less the growth of the waiting count.
"""

from __future__ import annotations

SERIES = "throughput"
SCANS_SENT = "scans_sent"          # counter: scans in calls the server answered
SCANS_REJECTED = "scans_rejected"  # counter: scans the server answered as rejected
GAP_FACTOR = 3                     # an interval longer than this many windows is a pause


def scans_taken(counters: dict[str, int]) -> int:
    return max(0, counters.get(SCANS_SENT, 0) - counters.get(SCANS_REJECTED, 0))


def _valid(points: list[list]) -> list[list]:
    """The readings with a time and all three counts; anything else is left out."""
    out = []
    for p in points:
        try:
            float(p[0])
            if all(isinstance(p[1][k], (int, float)) for k in ("calls", "scans", "waiting")):
                out.append(p)
        except (KeyError, TypeError, ValueError, IndexError):
            continue
    return out


def _rates(a: list, b: list) -> dict | None:
    """Per-second rates from reading `a` to reading `b` ([at, value] pairs)."""
    try:
        dt = float(b[0]) - float(a[0])
        if dt <= 0:
            return None
        va, vb = a[1], b[1]
        calls = (vb["calls"] - va["calls"]) / dt
        sent = (vb["scans"] - va["scans"]) / dt
        processed = sent - (vb["waiting"] - va["waiting"]) / dt
    except (KeyError, TypeError, ValueError, IndexError):
        return None
    return {"calls": max(0.0, calls), "scans_sent": max(0.0, sent),
            "scans_processed": max(0.0, processed), "seconds": dt}


def current(points: list[list], window: float) -> dict | None:
    """The rates over the last `window` seconds or so: the newest reading against the
    newest one at least `window` seconds older. None until two such readings exist, or
    when they are more than GAP_FACTOR windows apart (the run was paused)."""
    points = _valid(points)
    if len(points) < 2:
        return None
    newest = points[-1]
    for older in reversed(points[:-1]):
        try:
            gap = float(newest[0]) - float(older[0])
        except (TypeError, ValueError, IndexError):
            return None
        if gap >= window:
            if gap > GAP_FACTOR * window:
                return None
            rates = _rates(older, newest)
            return None if rates is None else {k: round(v, 1) for k, v in rates.items()
                                               if k != "seconds"}
    return None


def intervals(points: list[list], window: float) -> list[dict]:
    """Back-to-back intervals of at least `window` seconds, pauses left out."""
    out: list[dict] = []
    points = _valid(points)
    if not points:
        return out
    anchor = points[0]
    for p in points[1:]:
        try:
            gap = float(p[0]) - float(anchor[0])
        except (TypeError, ValueError, IndexError):
            anchor = p
            continue
        if gap < window:
            continue
        if gap <= GAP_FACTOR * window:
            rates = _rates(anchor, p)
            if rates is not None:
                out.append(rates)
        anchor = p
    return out


KINDS = ("calls", "scans_sent", "scans_processed")


def summary(points: list[list], window: float) -> dict:
    """For each kind, the average per second over the run (pauses left out) and the
    busiest interval's. None for both when there is no interval."""
    spans = intervals(points, window)
    seconds = sum(s["seconds"] for s in spans)
    out: dict = {}
    for kind in KINDS:
        if not spans or seconds <= 0:
            out[kind] = {"average": None, "peak": None}
            continue
        total = sum(s[kind] * s["seconds"] for s in spans)
        out[kind] = {"average": round(total / seconds, 1),
                     "peak": round(max(s[kind] for s in spans), 1)}
    return out
