import asyncio
import sqlite3
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import respx

from serversherpa_status.api_status import BACKGROUND_KEY, LatestApiStatus
from serversherpa_status.checker import Checker, seed_tracker
from serversherpa_status.config import load_settings
from serversherpa_status.state import StateTracker
from serversherpa_status.store import Store

T0 = datetime(2026, 9, 23, 12, 0, tzinfo=UTC)


@pytest.fixture
def settings(tmp_path):
    return load_settings({
        "STATUS_API_URL": "http://api.test",
        "STATUS_PORTAL_URL": "http://portal.test",
        "STATUS_KIOSK_URL": "http://kiosk.test",
        "STATUS_INTERVAL_SECONDS": "10",
        "STATUS_DB_PATH": str(tmp_path / "s.db"),
    })


@pytest.fixture
def store(settings):
    s = Store(settings.db_path)
    yield s
    s.close()


def routes(api_ok=True, portal_ok=True, kiosk_ok=True, api_json=None):
    respx.get("http://api.test/system/status").respond(
        200 if api_ok else 503, json={} if api_json is None else api_json
    )
    respx.get("http://portal.test/").respond(200 if portal_ok else 502, text='<div id="root">')
    respx.get("http://kiosk.test/config.js").respond(200 if kiosk_ok else 502, text="x")


class Clock:
    def __init__(self):
        self.now = T0

    def __call__(self):
        return self.now


@respx.mock
async def test_cycle_records_every_service(settings, store):
    routes(kiosk_ok=False)
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    async with httpx.AsyncClient() as client:
        await Checker(settings, store, tracker, client, clock=Clock()).run_cycle()
    assert [r.ok for r in store.recent("api", 5)] == [True]
    assert [r.ok for r in store.recent("kiosk", 5)] == [False]
    assert tracker.snapshot("api").state == "up"
    assert tracker.snapshot("kiosk").state == "unknown"  # one strike only


@respx.mock
async def test_two_failed_cycles_flip_down(settings, store):
    routes(api_ok=False)
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    clock = Clock()
    async with httpx.AsyncClient() as client:
        c = Checker(settings, store, tracker, client, clock=clock)
        await c.run_cycle()
        clock.now += timedelta(minutes=1)
        await c.run_cycle()
    assert tracker.snapshot("api").state == "down"
    assert tracker.snapshot("api").last_checked_at == clock.now


@respx.mock
async def test_prunes_on_first_cycle_then_hourly(settings, store, monkeypatch):
    routes()
    calls = []
    monkeypatch.setattr(store, "prune", lambda now: calls.append(now))
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    clock = Clock()
    async with httpx.AsyncClient() as client:
        c = Checker(settings, store, tracker, client, clock=clock)
        await c.run_cycle()
        clock.now += timedelta(minutes=30)
        await c.run_cycle()
        clock.now += timedelta(minutes=31)
        await c.run_cycle()
    assert calls == [T0, T0 + timedelta(minutes=61)]


async def test_run_forever_survives_a_crashing_cycle(settings, store, monkeypatch):
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    async with httpx.AsyncClient() as client:
        c = Checker(settings, store, tracker, client)
        calls = 0

        async def flaky():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise RuntimeError("boom")
            if calls >= 3:
                raise asyncio.CancelledError

        monkeypatch.setattr(c, "run_cycle", flaky)
        real_sleep = asyncio.sleep  # capture first: the patch below replaces asyncio.sleep globally
        monkeypatch.setattr(asyncio, "sleep", lambda s: real_sleep(0))
        with pytest.raises(asyncio.CancelledError):
            await c.run_forever()
    assert calls == 3


@respx.mock
async def test_tracker_updates_even_when_store_write_fails(settings, store, monkeypatch):
    routes()

    def boom(*a, **kw):
        raise sqlite3.OperationalError("disk full")

    monkeypatch.setattr(store, "record", boom)
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    async with httpx.AsyncClient() as client:
        c = Checker(settings, store, tracker, client, clock=Clock())
        await c.run_cycle()
    assert tracker.snapshot("api").state == "up"
    assert c.store_ok is False


@respx.mock
async def test_store_ok_true_after_a_clean_cycle(settings, store):
    routes()
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    async with httpx.AsyncClient() as client:
        c = Checker(settings, store, tracker, client, clock=Clock())
        await c.run_cycle()
    assert c.store_ok is True


@respx.mock
async def test_last_cycle_at_set_after_run_cycle(settings, store):
    routes()
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    clock = Clock()
    async with httpx.AsyncClient() as client:
        c = Checker(settings, store, tracker, client, clock=clock)
        assert c.last_cycle_at is None
        await c.run_cycle()
    assert c.last_cycle_at == clock.now


@respx.mock
async def test_prune_failure_does_not_stop_state_updates(settings, store, monkeypatch):
    routes()

    def boom(now):
        raise sqlite3.OperationalError("disk full")

    monkeypatch.setattr(store, "prune", boom)
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    async with httpx.AsyncClient() as client:
        c = Checker(settings, store, tracker, client, clock=Clock())
        await c.run_cycle()
    assert tracker.snapshot("api").state == "up"
    assert c.store_ok is False


def test_seed_tracker_replays_recent_checks(settings, store):
    for n, ok in enumerate([True, False, False]):
        store.record("api", T0 + timedelta(minutes=n), ok, None, "")
    store.record("kiosk", T0, True, 12, "")
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    seed_tracker(tracker, store, settings)
    assert tracker.snapshot("api").state == "down"
    assert tracker.snapshot("kiosk").state == "up"
    assert tracker.snapshot("kiosk").latency_ms == 12
    assert tracker.snapshot("portal").state == "unknown"


def bg(state, running=2, total=3):
    return {"background": {"state": state, "running": running, "total": total}}


@respx.mock
async def test_background_running_is_recorded_up(settings, store):
    routes(api_json=bg("running"))
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    latest = LatestApiStatus()
    clock = Clock()
    async with httpx.AsyncClient() as client:
        await Checker(settings, store, tracker, client, clock=clock, latest=latest).run_cycle()
    assert tracker.snapshot("background").state == "up"
    assert [r.ok for r in store.recent("background", 5)] == [True]
    got = latest.get(clock.now, 60)
    assert got.background.running == 2 and got.background.total == 3


@respx.mock
async def test_background_down_for_two_cycles_reads_down(settings, store):
    routes(api_json=bg("down", 0))
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    clock = Clock()
    async with httpx.AsyncClient() as client:
        c = Checker(settings, store, tracker, client, clock=clock)
        await c.run_cycle()
        clock.now += timedelta(minutes=1)
        await c.run_cycle()
    assert tracker.snapshot("background").state == "down"
    assert [r.ok for r in store.recent("background", 5)] == [False, False]


@respx.mock
async def test_background_paused_is_recorded_ok(settings, store):
    routes(api_json=bg("paused"))
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    async with httpx.AsyncClient() as client:
        await Checker(settings, store, tracker, client, clock=Clock()).run_cycle()
    assert [r.ok for r in store.recent("background", 5)] == [True]


@respx.mock
async def test_api_without_background_records_nothing(settings, store):
    routes()
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    async with httpx.AsyncClient() as client:
        await Checker(settings, store, tracker, client, clock=Clock()).run_cycle()
    assert store.recent("background", 5) == []


@respx.mock
async def test_failed_api_probe_clears_latest_and_skips_background(settings, store):
    routes(api_ok=False, api_json=bg("running"))
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    latest = LatestApiStatus()
    clock = Clock()
    latest.set(parse_ok(), clock.now)
    async with httpx.AsyncClient() as client:
        await Checker(settings, store, tracker, client, clock=clock, latest=latest).run_cycle()
    assert latest.get(clock.now, 60) is None
    assert store.recent("background", 5) == []


def parse_ok():
    from serversherpa_status.api_status import ApiStatus

    return ApiStatus(False, None, None, None)


def test_seed_tracker_seeds_background(settings, store):
    store.record("background", T0, True, None, "")
    tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
    seed_tracker(tracker, store, settings)
    assert tracker.snapshot("background").state == "up"


def _ntfy_settings(tmp_path):
    return load_settings({
        "STATUS_API_URL": "http://api.test",
        "STATUS_PORTAL_URL": "http://portal.test",
        "STATUS_KIOSK_URL": "http://kiosk.test",
        "STATUS_INTERVAL_SECONDS": "10",
        "STATUS_DB_PATH": str(tmp_path / "n.db"),
        "STATUS_NTFY_TOPIC": "topic",
        "STATUS_NTFY_SERVER": "http://ntfy.test",
    })


async def _two_kiosk_failures(settings, watcher, status=200):
    from serversherpa_status.alerts import AlertWatcher  # noqa: F401

    routes(kiosk_ok=False)
    st = Store(settings.db_path)
    try:
        tracker = StateTracker([s.key for s in settings.services] + [BACKGROUND_KEY], 2)
        clock = Clock()
        async with httpx.AsyncClient() as client:
            c = Checker(settings, st, tracker, client, clock=clock, watcher=watcher)
            await c.run_cycle()
            clock.now += timedelta(minutes=1)
            await c.run_cycle()
        return tracker
    finally:
        st.close()


def _watcher(settings):
    from serversherpa_status.alerts import AlertWatcher

    return AlertWatcher({s.key: s.name for s in settings.services} | {BACKGROUND_KEY: "Background processing"})


@respx.mock
async def test_watcher_sends_one_down_alert(tmp_path):
    import json

    settings = _ntfy_settings(tmp_path)
    ntfy = respx.post("http://ntfy.test/").respond(200)
    await _two_kiosk_failures(settings, _watcher(settings))
    assert ntfy.call_count == 1
    assert json.loads(ntfy.calls[0].request.content)["title"] == "Kiosk is down"


@respx.mock
async def test_no_watcher_no_ntfy_request(tmp_path):
    settings = _ntfy_settings(tmp_path)
    ntfy = respx.post("http://ntfy.test/").respond(200)
    await _two_kiosk_failures(settings, None)
    assert ntfy.call_count == 0


@respx.mock
async def test_ntfy_failure_does_not_stop_the_cycle(tmp_path):
    settings = _ntfy_settings(tmp_path)
    respx.post("http://ntfy.test/").respond(500)
    tracker = await _two_kiosk_failures(settings, _watcher(settings))
    assert tracker.snapshot("kiosk").state == "down"
