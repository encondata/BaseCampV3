from datetime import UTC, datetime, timedelta

import httpx
import respx

from serversherpa_status.alerts import Alert, AlertWatcher, format_duration, publish
from serversherpa_status.config import NtfyConfig

T0 = datetime(2026, 9, 30, 12, 0, tzinfo=UTC)
NAMES = {"kiosk": "Kiosk", "background": "Background processing"}


def test_format_duration():
    assert format_duration(30) == "under a minute"
    assert format_duration(14 * 60 + 20) == "14 min"
    assert format_duration(2 * 3600 + 5 * 60) == "2 h 5 min"
    assert format_duration(3 * 3600) == "3 h"


def test_down_then_recovery():
    w = AlertWatcher(NAMES)
    w.prime({"kiosk": "up"})
    down = w.evaluate({"kiosk": "down"}, None, None, T0)
    assert len(down) == 1
    assert down[0].title == "Kiosk is down"
    assert (down[0].priority, down[0].tags) == (4, ("rotating_light",))
    assert w.evaluate({"kiosk": "down"}, None, None, T0 + timedelta(minutes=1)) == []
    up = w.evaluate({"kiosk": "up"}, None, None, T0 + timedelta(minutes=14))
    assert up == [Alert("Kiosk is back up", "Down for 14 min", 3, ("white_check_mark",))]


def test_recovery_after_primed_down_has_no_duration():
    w = AlertWatcher(NAMES)
    w.prime({"kiosk": "down"})
    (alert,) = w.evaluate({"kiosk": "up"}, None, None, T0)
    assert alert.title == "Kiosk is back up"
    assert "Down for" not in alert.message


def test_unknown_transitions():
    w = AlertWatcher(NAMES)
    assert len(w.evaluate({"kiosk": "down"}, None, None, T0)) == 1
    w = AlertWatcher(NAMES)
    assert w.evaluate({"kiosk": "up"}, None, None, T0) == []
    assert w.evaluate({"kiosk": "unknown"}, None, None, T0) == []


def test_maintenance_transitions():
    w = AlertWatcher(NAMES)
    assert w.evaluate({}, True, "x", T0) == []
    (ended,) = w.evaluate({}, False, None, T0)
    assert ended.title == "Maintenance ended"
    assert (ended.priority, ended.tags) == (2, ("white_check_mark",))
    assert w.evaluate({}, None, None, T0) == []
    (started,) = w.evaluate({}, True, "Cutover", T0)
    assert started == Alert("Maintenance started", "Cutover", 2, ("construction",))


def test_names_used_and_no_urls():
    w = AlertWatcher(NAMES)
    w.prime({"background": "up"})
    alerts = w.evaluate({"background": "down"}, None, None, T0)
    alerts += w.evaluate({"background": "up"}, None, None, T0)
    assert alerts[0].title == "Background processing is down"
    assert all("http" not in repr(a) for a in alerts)


ALERT = Alert("Kiosk is down", "msg", 4, ("rotating_light",))


@respx.mock
async def test_publish_body_and_headers():
    route = respx.post("https://ntfy.test/").respond(200)
    cfg = NtfyConfig("https://ntfy.test", "topic", "tok", "https://status.test")
    async with httpx.AsyncClient() as client:
        assert await publish(client, cfg, ALERT) is True
    req = route.calls[0].request
    import json
    assert json.loads(req.content) == {
        "topic": "topic", "title": "Kiosk is down", "message": "msg",
        "priority": 4, "tags": ["rotating_light"], "click": "https://status.test",
    }
    assert req.headers["Authorization"] == "Bearer tok"


@respx.mock
async def test_publish_omits_optional_fields():
    route = respx.post("https://ntfy.test/").respond(200)
    cfg = NtfyConfig("https://ntfy.test", "topic", None, None)
    async with httpx.AsyncClient() as client:
        await publish(client, cfg, ALERT)
    req = route.calls[0].request
    assert b"click" not in req.content
    assert "Authorization" not in req.headers


@respx.mock
async def test_publish_failures_return_false():
    cfg = NtfyConfig("https://ntfy.test", "topic", None, None)
    async with httpx.AsyncClient() as client:
        respx.post("https://ntfy.test/").respond(500)
        assert await publish(client, cfg, ALERT) is False
        respx.post("https://ntfy.test/").mock(side_effect=httpx.ConnectError("x"))
        assert await publish(client, cfg, ALERT) is False


@respx.mock
async def test_publish_swallows_unexpected_exceptions():
    cfg = NtfyConfig("https://ntfy.test", "topic", None, None)
    respx.post("https://ntfy.test/").mock(side_effect=RuntimeError("boom"))
    async with httpx.AsyncClient() as client:
        assert await publish(client, cfg, ALERT) is False


def test_primed_watcher_from_seeded_down_tracker_sends_no_alert(tmp_path):
    from serversherpa_status.alerts import build_watcher
    from serversherpa_status.api_status import BACKGROUND_KEY
    from serversherpa_status.checker import seed_tracker
    from serversherpa_status.config import load_settings
    from serversherpa_status.state import StateTracker
    from serversherpa_status.store import Store

    settings = load_settings({
        "STATUS_API_URL": "http://api.test",
        "STATUS_PORTAL_URL": "http://portal.test",
        "STATUS_KIOSK_URL": "http://kiosk.test",
        "STATUS_DB_PATH": str(tmp_path / "s.db"),
        "STATUS_NTFY_TOPIC": "topic",
    })
    store = Store(settings.db_path)
    try:
        at = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)
        for n in (0, 1):
            store.record("kiosk", at + timedelta(minutes=n), False, None, "")
        tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
        seed_tracker(tracker, store, settings)
        states = {k: tracker.snapshot(k).state for k in [s.key for s in settings.services] + [BACKGROUND_KEY]}
        assert states["kiosk"] == "down"
        watcher = build_watcher(settings, tracker)
        assert watcher is not None
        assert watcher.evaluate(states, None, None, at + timedelta(minutes=2)) == []
        assert build_watcher(settings.__class__(**{**settings.__dict__, "ntfy": None}), tracker) is None
    finally:
        store.close()
