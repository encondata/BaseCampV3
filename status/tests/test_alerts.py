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
