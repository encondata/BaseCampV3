import dataclasses

import httpx

from edge import outbox
from edge.app import create_app
from edge.background import Background


async def _done():
    return {}


async def test_tick_drains_and_syncs_when_online(app, cloud, monkeypatch):
    cloud.get("/system/status").respond(200, json={})
    up = app.state.upstream
    up.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    outbox.enqueue_scans(app.state.store, "p-1", "Jane", [{"client_scan_id": "s1"}])
    cloud.post("/kiosk/scans").respond(200, json={"accepted": ["s1"], "rejected": []})
    calls = []
    monkeypatch.setattr(app.state.syncer, "run", lambda: calls.append(1) or _done())
    bg = Background(app.state)
    await bg.tick(now=1000.0)
    assert outbox.counts(app.state.store)["sent"] == 1
    assert calls == [1]
    await bg.tick(now=1001.0)  # inside the sync interval: no second sync
    assert calls == [1]


async def test_tick_offline_does_nothing(app, cloud):
    cloud.get("/system/status").mock(side_effect=httpx.ConnectError("down"))
    bg = Background(app.state)
    await bg.tick(now=1000.0)
    assert app.state.upstream.online is False


async def test_lifespan_starts_and_stops_runner(settings, cloud):
    cloud.get("/system/status").respond(200, json={})
    bg_app = create_app(dataclasses.replace(settings, background=True))
    async with bg_app.router.lifespan_context(bg_app):
        task = bg_app.state.background._task
        assert task is not None and not task.done()
    assert task.cancelled()
