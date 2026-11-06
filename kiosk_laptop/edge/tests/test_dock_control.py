"""POST /edge/dock/control: the Dock screen's Start, Pause and Stop (dock
station spec, "Start, Pause, Stop"). Start starts the reader, Pause stops it
and leaves the open burst to its own rule, Stop stops it and decides the
open burst at once, even when the reader doesn't answer. The button pressed
is remembered as the overview's `control`."""

from datetime import UTC, datetime

from tests.conftest import make_session
from tests.test_dock_grouper import T0, batch, decided, dock, group, passes, read
from tests.test_rfid_pairing import code, use_reader
from tests.test_rfid_reader_control import paired

ACTIONS = ("start", "pause", "stop")


async def control(client, headers, action):
    return await client.post("/edge/dock/control", json={"action": action}, headers=headers)


async def overview_control(client, headers):
    return (await client.get("/edge/dock", headers=headers)).json()["control"]


def open_burst(store) -> float:
    """AA01, then CC01 a second later, grouped into a burst that is still
    open. Timed from now, so the idle rule can't decide it during the test:
    only Stop does. Answers the burst's first second (after T0)."""
    base = (datetime.now(UTC) - T0).total_seconds()
    batch(store, [("AA01", base), ("CC01", base + 1)])
    group(store, base + 1)
    assert passes(store)[-1]["closed_at"] is None
    return base


async def test_control_needs_a_session(app, client):
    reader = await paired(app, client)
    transport = app.state.reader_transport
    seen, stops = len(transport.requests), reader.stops
    for action in ACTIONS:
        r = await client.post("/edge/dock/control", json={"action": action})
        assert r.status_code == 401, action
    assert len(transport.requests) == seen
    assert reader.starts == [] and reader.stops == stops
    assert app.state.dock_control is None


async def test_bad_action_is_422(app, client):
    await paired(app, client)
    transport = app.state.reader_transport
    seen = len(transport.requests)
    h = make_session(app)
    for body in ({"action": "jump"}, {}, [1]):
        r = await client.post("/edge/dock/control", json=body, headers=h)
        assert r.status_code == 422 and code(r) == "bad_request", body
    assert len(transport.requests) == seen
    assert await overview_control(client, h) is None


async def test_start_and_pause_drive_the_reader_and_are_remembered(app, client):
    reader = await paired(app, client)
    store = app.state.store
    dock(store)
    h = make_session(app, name="Ann Lee")
    assert await overview_control(client, h) is None
    r = await control(client, h, "start")
    assert r.status_code == 200
    assert r.json() == {"reading": True, "control": "start", "decided": 0}
    assert reader.starts == [{"doNotPersistState": False}]
    latest = (await client.get("/edge/rfid/events", headers=h)).json()["events"]
    started = [e for e in latest if e["kind"] == "reader_started"]
    assert started and started[0]["detail"] == "FX9600 · Started by Ann Lee"
    open_burst(store)
    before = reader.stops
    r = await control(client, h, "pause")
    assert r.status_code == 200
    assert r.json() == {"reading": False, "control": "pause", "decided": 0}
    assert reader.stops == before + 1
    assert [p["closed_at"] for p in passes(store)] == [None]   # left to its own rule
    assert await overview_control(client, h) == "pause"


async def test_start_needs_an_online_session(app, client):
    reader = await paired(app, client)
    offline = make_session(app, offline=True)
    r = await control(client, offline, "start")
    assert r.status_code == 503 and code(r) == "edge_offline"
    assert reader.starts == []
    assert await overview_control(client, offline) == "start"   # remembered all the same
    for action in ("pause", "stop"):
        r = await control(client, offline, action)
        assert r.status_code == 200, action
        assert r.json() == {"reading": False, "control": action, "decided": 0}, action


async def test_stop_decides_the_open_burst_at_once(app, client):
    await paired(app, client)
    store = app.state.store
    dock(store)
    base = open_burst(store)                      # AA01 0, CC01 1: open
    read(store, "AA02", base + 1.5)               # stored, not grouped yet
    assert not app.state.dock_send_wake.is_set()
    h = make_session(app)
    r = await control(client, h, "stop")
    assert r.status_code == 200
    assert r.json() == {"reading": False, "control": "stop", "decided": 1}
    assert decided(store) == [("pack", "c-1", ["a-1", "a-2"])]
    assert [p["send_state"] for p in passes(store)] == ["pending"]
    assert app.state.dock_send_wake.is_set()
    assert await overview_control(client, h) == "stop"


async def test_stop_decides_even_when_the_reader_does_not_answer(app, client):
    store = app.state.store
    use_reader(app)                               # no pairing at all
    dock(store)
    h = make_session(app)
    open_burst(store)
    r = await control(client, h, "stop")
    assert r.status_code == 409 and code(r) == "reader_required"
    assert decided(store) == [("pack", "c-1", ["a-1"])]
    assert app.state.dock_send_wake.is_set()

    reader = await paired(app, client)
    reader.mode = "unreachable"
    open_burst(store)
    r = await control(client, h, "stop")
    assert r.status_code == 502 and code(r) == "reader_unreachable"
    assert decided(store) == [("pack", "c-1", ["a-1"]), ("pack", "c-1", ["a-1"])]
    assert await overview_control(client, h) == "stop"
