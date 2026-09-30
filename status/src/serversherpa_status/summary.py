"""The public JSON. Built only from display names, states, and counts —
service URLs and probe details never leave the container."""

from datetime import UTC, datetime

from serversherpa_status.api_status import BACKGROUND_KEY, BACKGROUND_NAME, LatestApiStatus
from serversherpa_status.config import Settings, stale_after_seconds
from serversherpa_status.state import StateTracker
from serversherpa_status.store import WINDOW_DAYS, Store, uptime_percent


def _iso(at: datetime | None) -> str | None:
    if at is None:
        return None
    return at.astimezone(UTC).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _entry(key, name, snap, store, today, now, stale_after, latency_ms) -> dict:
    bars = store.daily(key, today, WINDOW_DAYS)
    state = snap.state
    if snap.last_checked_at is not None:
        age = (now.astimezone(UTC) - snap.last_checked_at.astimezone(UTC)).total_seconds()
        if age > stale_after:
            state = "unknown"
    return {
        "key": key,
        "name": name,
        "state": state,
        "last_checked_at": _iso(snap.last_checked_at),
        "latency_ms": latency_ms,
        "uptime_90d": uptime_percent(bars),
        "days": [{"day": b.day, "ok": b.ok, "total": b.total} for b in bars],
    }


def build_summary(
    settings: Settings,
    store: Store,
    tracker: StateTracker,
    now: datetime,
    latest: LatestApiStatus | None = None,
) -> dict:
    today = now.astimezone(UTC).date()
    stale_after = stale_after_seconds(settings)
    latest_status = latest.get(now, stale_after) if latest is not None else None
    services = []
    for s in settings.services:
        snap = tracker.snapshot(s.key)
        services.append(
            _entry(s.key, s.name, snap, store, today, now, stale_after, snap.latency_ms)
        )
    bg_snap = tracker.snapshot(BACKGROUND_KEY)
    if bg_snap.last_checked_at is not None:
        entry = _entry(
            BACKGROUND_KEY, BACKGROUND_NAME, bg_snap, store, today, now, stale_after, None
        )
        report = latest_status.background if latest_status is not None else None
        if entry["state"] == "up" and report is not None and report.state == "paused":
            entry["state"] = "paused"
        entry["workers"] = (
            {"running": report.running, "total": report.total} if report is not None else None
        )
        services.append(entry)
    states = {s["state"] for s in services}
    maintenance = latest_status is not None and latest_status.maintenance
    if "down" in states:
        overall = "degraded"
    elif maintenance:
        overall = "maintenance"
    elif states <= {"up", "paused"} and "up" in states:
        overall = "operational"
    else:
        overall = "unknown"
    return {
        "generated_at": _iso(now),
        "overall": overall,
        "interval_seconds": settings.interval_seconds,
        "failure_threshold": settings.failure_threshold,
        "services": services,
        "maintenance": (
            {"active": latest_status.maintenance, "message": latest_status.maintenance_message}
            if latest_status is not None
            else None
        ),
        "announcement": latest_status.announcement if latest_status is not None else None,
    }
