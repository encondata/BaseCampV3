"""The Dock Station on the edge (dock station spec §3): a laptop kiosk station
type that keeps its paired reader, holds a station key, sends reader telemetry
and raises the off-move alarm, exactly as an RFID Station does. Pass grouping
and the Dock screen come later."""

import json
from datetime import UTC, datetime

import pytest

from edge import laptop_setup
from edge.db import Store, iso
from edge.rfid import processing, reader_report, station_key
from edge.sync import station_sync_paths
from tests.conftest import make_session
from tests.test_laptop_setup import OUT, paired, ready, setup
from tests.test_reader_report import SERIAL, paired_station
from tests.test_rfid_alarm import FRESH, NOW, as_station, client_asset, open_rows, station_seed
from tests.test_rfid_processing import read

RAW = "dock-station-key-0123456789-SECRET"
HEARTBEAT = "/kiosk/heartbeat"
STATION_HEARTBEAT = "/kiosk/station/heartbeat"


@pytest.fixture
def store(tmp_path):
    s = Store(tmp_path / "edge.db")
    yield s
    s.close()


def _scan_type_events(app):
    return [dict(r) for r in app.state.store.all(
        "SELECT title, detail FROM rfid_events WHERE kind = 'scan_type_selected'")]


async def test_setup_saves_dock_with_reader(app, client, cloud):
    await paired(app, client)
    setup_route = ready(app, cloud)
    key_route = cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    r = await setup(client, app, station_type="dock")
    assert r.status_code == 200, r.text
    sent = json.loads(setup_route.calls[0].request.content)
    assert sent["station_type"] == "dock" and sent["reader"]["serial"] == SERIAL
    saved = laptop_setup.load(app.state.store)
    assert saved["station_type"] == "dock"
    assert saved["reader"]["serial"] == SERIAL and saved["reader"]["model"] == "FX9600"
    [event] = _scan_type_events(app)
    assert event["detail"] == f"{OUT['scan_status_label']} · Dock Station"
    assert key_route.call_count == 1
    assert station_key.load_key(app.state.store, app.state.keys) == RAW
    assert RAW not in r.text


async def test_dock_setup_without_pairing_is_422(app, client, cloud):
    route = ready(app, cloud)
    r = await setup(client, app, station_type="dock")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "reader_required"
    assert not route.called


async def test_dock_setup_keeps_the_reader_pairing_and_pending_scans(app, client, cloud):
    from tests.test_rfid_uploader import add_scans, rows
    await paired(app, client)
    ready(app, cloud)
    cloud.post("/kiosk/station-key").respond(200, json={"key": RAW})
    [sid] = add_scans(app.state.store, 1)
    assert (await setup(client, app, station_type="dock")).status_code == 200
    assert app.state.store.one("SELECT * FROM rfid_pairing") is not None
    assert rows(app.state.store)[sid]["upload_state"] == "pending"


def test_dock_is_a_reader_station_and_a_dock_setup(app):
    store = app.state.store
    laptop_setup.save(store, {"initiative_id": "m-1"}, "dock")
    assert station_key.is_reader_setup(store) and station_key.is_dock_setup(store)
    assert station_key.is_station_setup(store) and not station_key.is_rfid_setup(store)
    laptop_setup.save(store, {"initiative_id": "m-1"}, "rfid")
    assert station_key.is_reader_setup(store) and not station_key.is_dock_setup(store)
    assert station_key.is_rfid_setup(store)
    laptop_setup.save(store, {"initiative_id": "m-1"}, "label")
    assert not station_key.is_reader_setup(store) and not station_key.is_dock_setup(store)


async def test_a_dock_without_a_key_needs_one(app):
    laptop_setup.save(app.state.store, {"initiative_id": "m-1"}, "dock")
    assert station_key.needs_key(app.state.store)


async def test_station_heartbeat_sent_for_dock(app, client, cloud):
    await paired_station(app, client, station="dock")
    station_key.store_key(app.state.store, app.state.keys, RAW)
    route = cloud.post(STATION_HEARTBEAT).respond(200, json={"registration": "ok",
                                                             "clear_setup": None})
    snap = await reader_report.build_snapshot(app.state)
    assert snap is not None and snap["serial"] == SERIAL
    app.state.reader_snapshot = snap
    fresh = reader_report.current_snapshot(app.state)
    assert fresh is not None and fresh["serial"] == SERIAL
    await reader_report.send_station_heartbeat(app.state, fresh)
    req = route.calls[-1].request
    assert req.headers["authorization"] == f"Station {RAW}"
    body = json.loads(req.content)
    assert body["serial"] == app.state.identity.serial
    assert body["reader"]["serial"] == SERIAL and body["reader"]["model"] == "FX9600"
    assert "config_applied_version" in body    # the config syncs on this beat


async def test_person_heartbeat_carries_no_config_on_keyed_dock(app, client, cloud):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    laptop_setup.save(app.state.store, {"initiative_id": "i-1"}, "dock")
    station_key.store_key(app.state.store, app.state.keys, RAW)
    route = cloud.post(HEARTBEAT).respond(200, json={"registration": "ok", "clear_setup": None})
    r = await client.post(HEARTBEAT, headers=make_session(app),
                          json={"serial": "browser", "name": "B", "mode": "web"})
    assert r.status_code == 200, r.text
    sent = json.loads(route.calls[-1].request.content)
    for key in ("config", "config_changed_at", "config_applied_version", "reader"):
        assert key not in sent


async def test_alarm_route_serves_dock(app, client):
    store = app.state.store
    station_seed(store, client_asset(1))
    as_station(store, "dock")
    read(store, "EE01", received_at=iso(datetime.now(UTC)))
    processing.process(store)
    h = make_session(app)
    body = (await client.get("/edge/rfid/alarm", headers=h)).json()
    [one] = body["alarms"]
    assert one["name"] == "Server 1" and one["id"] == body["latest_id"]
    as_station(store, "label")    # the same open row is not served to any other type
    body = (await client.get("/edge/rfid/alarm", headers=h)).json()
    assert body["alarms"] == [] and body["latest_id"] is None


def test_processing_raises_alarm_on_dock(store):
    station_seed(store, client_asset(1))
    as_station(store, "dock")
    read(store, "EE01", received_at=FRESH)
    assert processing.process(store, now=NOW).inserted == 1
    [row] = open_rows(store)
    assert row["asset_id"] == "x-1"


def test_station_sync_paths_for_dock_include_client_assets():
    paths = station_sync_paths("m-1", "serial-1", "dock")
    keys = [key for key, _route in paths]
    assert "/kiosk/sync/client-assets?initiative_id=m-1" in keys
    routes = dict(paths)
    assert routes["/kiosk/sync/client-assets?initiative_id=m-1"].startswith(
        "/kiosk/station/sync/client-assets?")
    assert paths == station_sync_paths("m-1", "serial-1", "rfid")
