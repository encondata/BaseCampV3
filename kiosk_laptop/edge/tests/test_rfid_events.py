"""The edge RFID event log (feeds the dashboard's System Events panel)."""

import json

from edge.rfid import events
from tests.conftest import make_session
from tests.test_laptop_setup import ready, setup
from tests.test_rfid_checks import beat, sign_in
from tests.test_rfid_pairing import READER_IP, SERIAL, pair, stored, use_reader, write_host


async def paired(app, client):
    write_host(app)
    reader = use_reader(app)
    assert (await pair(client, app)).status_code == 200
    return reader


def rows(app):
    return events.recent(app.state.store, 200)


def titles(app):
    return [e["title"] for e in rows(app)]


def test_record_and_recent_order_and_clamp(app):
    st = app.state.store
    for i in range(5):
        events.record(st, "k", f"t{i}", f"d{i}")
    got = events.recent(st)
    assert [e["title"] for e in got] == ["t4", "t3", "t2", "t1", "t0"]
    assert set(got[0]) == {"id", "at", "kind", "title", "detail"} and got[0]["at"]
    assert len(events.recent(st, 2)) == 2
    assert len(events.recent(st, 0)) == 1 and len(events.recent(st, -5)) == 1
    assert len(events.recent(st, 10_000)) == 5


def test_cap_at_200(app):
    st = app.state.store
    for i in range(230):
        events.record(st, "k", f"t{i}")
    got = events.recent(st, 200)
    assert len(got) == 200 and got[0]["title"] == "t229" and got[-1]["title"] == "t30"
    assert st.one("SELECT COUNT(*) AS n FROM rfid_events")["n"] == 200


def test_record_never_raises(app, monkeypatch):
    st = app.state.store

    def boom(*a, **k):
        raise RuntimeError("broken")
    monkeypatch.setattr(st, "run", boom)
    events.record(st, "k", "t")  # no exception
    st.conn.close()
    monkeypatch.undo()
    events.record(st, "k", "t")


async def test_events_need_a_session(client):
    assert (await client.get("/edge/rfid/events")).status_code == 401


async def test_events_route(app, client):
    events.record(app.state.store, "k", "One", "d")
    events.record(app.state.store, "k", "Two")
    h = make_session(app)
    body = (await client.get("/edge/rfid/events", headers=h)).json()
    assert [e["title"] for e in body["events"]] == ["Two", "One"]
    body = (await client.get("/edge/rfid/events?limit=1", headers=h)).json()
    assert len(body["events"]) == 1


async def test_connect_pair_events_and_no_token(app, client):
    write_host(app)
    use_reader(app)
    h = make_session(app)
    r = await client.post("/edge/rfid/connect", headers=h, json={"ip": READER_IP})
    assert r.status_code == 200
    assert (await pair(client, app)).status_code == 200
    by_kind = {e["kind"]: e for e in rows(app)}
    assert by_kind["reader_connected"]["title"] == "Reader connected"
    assert by_kind["reader_connected"]["detail"] == f"FX9600 · {READER_IP}"
    assert by_kind["reader_paired"]["title"] == "Reader paired"
    assert by_kind["reader_paired"]["detail"] == "FX9600 · sends to 10.0.0.5"
    token = stored(app)["token"]
    assert token and all(token not in json.dumps(e) for e in rows(app))


async def test_start_stop_events_name_the_person(app, client):
    await paired(app, client)
    h = make_session(app, name="Ann Lee")
    assert (await client.post("/edge/rfid/start", headers=h)).status_code == 200
    assert (await client.post("/edge/rfid/stop", headers=h)).status_code == 200
    by_kind = {e["kind"]: e for e in rows(app)}
    assert by_kind["reader_started"]["title"] == "Reader started"
    assert by_kind["reader_started"]["detail"] == "FX9600 · Started by Ann Lee"
    assert by_kind["reader_stopped"]["title"] == "Reader stopped"
    assert by_kind["reader_stopped"]["detail"] == "Stopped by Ann Lee"


async def test_failed_start_records_nothing(app, client):
    reader = await paired(app, client)
    reader.mode = "unreachable"
    r = await client.post("/edge/rfid/start", headers=make_session(app))
    assert r.status_code != 200
    assert "Reader started" not in titles(app)


async def test_status_antennas(app, client):
    h = make_session(app)
    assert (await client.get("/edge/rfid/status", headers=h)).json() == {"reader": None}
    reader = await paired(app, client)
    body = (await client.get("/edge/rfid/status", headers=h)).json()
    assert body["antennas"] == ["1", "2"]
    reader.mode = "unreachable"
    body = (await client.get("/edge/rfid/status", headers=h)).json()
    assert body["antennas"] == []


async def test_setup_events(app, client, cloud):
    await paired(app, client)
    ready(app, cloud)
    r = await setup(client, app, station_type="rfid")
    assert r.status_code == 200
    by_kind = {e["kind"]: e for e in rows(app)}
    assert by_kind["move_loaded"]["title"] == "Move loaded"
    assert by_kind["move_loaded"]["detail"] == "Move One"
    assert by_kind["scan_type_selected"]["title"] == "Scan type selected"
    assert by_kind["scan_type_selected"]["detail"] == "Picked up · RFID Station"


async def test_label_setup_event_and_failed_setup(app, client, cloud):
    ready(app, cloud)
    await setup(client, app, station_type="label")
    assert {e["kind"]: e for e in rows(app)}["scan_type_selected"]["detail"] == \
        "Picked up · Label Station"
    app.state.store.run("DELETE FROM rfid_events")
    cloud.post("/kiosk/setup").respond(409, json={"detail": {"code": "move_locked"}})
    await setup(client, app, station_type="label")
    assert rows(app) == []


async def test_portal_check_in_events(app, client, cloud):
    h = await sign_in(app)
    cloud.post("/kiosk/heartbeat").respond(200, json=beat())
    await client.get("/edge/rfid/checks/registration", headers=h)
    e = rows(app)[0]
    assert (e["kind"], e["title"], e["detail"]) == (
        "portal_check_in", "Portal check-in successful", "Connected to ServerSherpa")
    cloud.post("/kiosk/heartbeat").respond(200, json=beat("expired"))
    await client.get("/edge/rfid/checks/registration", headers=h)
    e = rows(app)[0]
    assert e["title"] == "Portal check-in failed" and "expired" in e["detail"]
    # other checks record nothing
    n = len(rows(app))
    await client.get("/edge/rfid/checks/reader", headers=h)
    assert len(rows(app)) == n


async def test_wipe_clears_events(app, client):
    events.record(app.state.store, "k", "t")
    r = await client.post("/edge/wipe", json={}, headers=make_session(app, max_rank=60))
    assert r.status_code == 200 and rows(app) == []
