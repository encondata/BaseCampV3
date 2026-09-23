import asyncio
from datetime import UTC, datetime, timedelta

import httpx
import pytest
import respx

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


def routes(api_ok=True, portal_ok=True, kiosk_ok=True):
    respx.get("http://api.test/system/status").respond(200 if api_ok else 503, json={})
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
    tracker = StateTracker([s.key for s in settings.services], 2)
    async with httpx.AsyncClient() as client:
        await Checker(settings, store, tracker, client, clock=Clock()).run_cycle()
    assert [r.ok for r in store.recent("api", 5)] == [True]
    assert [r.ok for r in store.recent("kiosk", 5)] == [False]
    assert tracker.snapshot("api").state == "up"
    assert tracker.snapshot("kiosk").state == "unknown"  # one strike only


@respx.mock
async def test_two_failed_cycles_flip_down(settings, store):
    routes(api_ok=False)
    tracker = StateTracker([s.key for s in settings.services], 2)
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
    tracker = StateTracker([s.key for s in settings.services], 2)
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
    tracker = StateTracker([s.key for s in settings.services], 2)
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


def test_seed_tracker_replays_recent_checks(settings, store):
    for n, ok in enumerate([True, False, False]):
        store.record("api", T0 + timedelta(minutes=n), ok, None, "")
    store.record("kiosk", T0, True, 12, "")
    tracker = StateTracker([s.key for s in settings.services], 2)
    seed_tracker(tracker, store, settings)
    assert tracker.snapshot("api").state == "down"
    assert tracker.snapshot("kiosk").state == "up"
    assert tracker.snapshot("kiosk").latency_ms == 12
    assert tracker.snapshot("portal").state == "unknown"
