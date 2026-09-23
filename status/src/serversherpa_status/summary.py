"""The public JSON. Built only from display names, states, and counts —
service URLs and probe details never leave the container."""

from datetime import UTC, datetime

from serversherpa_status.config import Settings
from serversherpa_status.state import StateTracker
from serversherpa_status.store import WINDOW_DAYS, Store, uptime_percent


def _iso(at: datetime | None) -> str | None:
    if at is None:
        return None
    return at.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def build_summary(settings: Settings, store: Store, tracker: StateTracker, now: datetime) -> dict:
    today = now.astimezone(UTC).date()
    services = []
    for s in settings.services:
        snap = tracker.snapshot(s.key)
        bars = store.daily(s.key, today, WINDOW_DAYS)
        services.append({
            "key": s.key,
            "name": s.name,
            "state": snap.state,
            "last_checked_at": _iso(snap.last_checked_at),
            "latency_ms": snap.latency_ms,
            "uptime_90d": uptime_percent(bars),
            "days": [{"day": b.day, "ok": b.ok, "total": b.total} for b in bars],
        })
    states = {s["state"] for s in services}
    if "down" in states:
        overall = "degraded"
    elif states == {"up"}:
        overall = "operational"
    else:
        overall = "unknown"
    return {"generated_at": _iso(now), "overall": overall, "services": services}
