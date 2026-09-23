from datetime import UTC, datetime, timedelta

import pytest

from serversherpa_status.config import load_settings
from serversherpa_status.state import StateTracker
from serversherpa_status.store import Store
from serversherpa_status.summary import build_summary

NOW = datetime(2026, 9, 23, 12, 0, 5, tzinfo=UTC)


@pytest.fixture
def ctx(tmp_path):
    settings = load_settings({
        "STATUS_API_URL": "http://secret-api.internal:8000",
        "STATUS_PORTAL_URL": "http://portal.test",
        "STATUS_KIOSK_URL": "http://kiosk.test",
        "STATUS_DB_PATH": str(tmp_path / "s.db"),
    })
    store = Store(settings.db_path)
    tracker = StateTracker([s.key for s in settings.services], 2)
    yield settings, store, tracker
    store.close()


def test_unknown_before_any_checks(ctx):
    out = build_summary(*ctx, NOW)
    assert out["overall"] == "unknown"
    assert out["generated_at"] == "2026-09-23T12:00:05Z"
    assert [s["key"] for s in out["services"]] == ["api", "portal", "kiosk"]
    api = out["services"][0]
    assert api == {
        "key": "api", "name": "API", "state": "unknown",
        "last_checked_at": None, "latency_ms": None, "uptime_90d": None,
        "days": api["days"],
    }
    assert len(api["days"]) == 90
    assert api["days"][0] == {"day": "2026-06-26", "ok": None, "total": None}
    assert api["days"][-1]["day"] == "2026-09-23"


def test_operational_and_degraded(ctx):
    settings, store, tracker = ctx
    for s in settings.services:
        store.record(s.key, NOW, True, 30, "")
        tracker.record(s.key, True, 30, NOW)
    out = build_summary(settings, store, tracker, NOW)
    assert out["overall"] == "operational"
    assert out["services"][0]["uptime_90d"] == 100.0
    assert out["services"][0]["last_checked_at"] == "2026-09-23T12:00:05Z"
    assert out["services"][0]["days"][-1] == {"day": "2026-09-23", "ok": 1, "total": 1}

    for n in (1, 2):
        at = NOW + timedelta(minutes=n)
        store.record("kiosk", at, False, None, "HTTP 502 from http://kiosk.test")
        tracker.record("kiosk", False, None, at)
    out = build_summary(settings, store, tracker, NOW + timedelta(minutes=2))
    assert out["overall"] == "degraded"
    kiosk = out["services"][2]
    assert kiosk["state"] == "down"
    assert kiosk["uptime_90d"] == 33.3333


def test_mixed_up_and_unknown_is_unknown(ctx):
    settings, store, tracker = ctx
    tracker.record("api", True, 1, NOW)
    assert build_summary(settings, store, tracker, NOW)["overall"] == "unknown"


def test_never_leaks_urls_or_detail(ctx):
    settings, store, tracker = ctx
    store.record("api", NOW, False, None, "connection error to secret-api.internal")
    tracker.record("api", False, None, NOW)
    blob = repr(build_summary(settings, store, tracker, NOW))
    assert "secret-api" not in blob
    assert "internal" not in blob
    assert "http" not in blob
