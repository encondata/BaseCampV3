"""The Label Station's settings in the laptop's shared setup (Label Station
phase 1, Task 2): PUT/GET /edge/label-station, cleared by Clear Setup and
by changing station type, and mirrored as the config's `label_station`."""

import json
from datetime import UTC, datetime

import pytest
from tests.conftest import make_session
from tests.test_config_sync import DOC, _clock_known, _row, _seed

from edge import config_sync, laptop_setup
from edge.rfid import station_key

SETTINGS = {"label_kind": "top",
            "printer": {"type": "network", "ip": "10.0.0.40", "model": "ZT411", "serial": "S1"},
            "dpi": 300, "offset_x": -12, "offset_y": 4}
USB = {"label_kind": "front", "printer": {"type": "usb", "model": "ZD421", "serial": None},
       "dpi": 203, "offset_x": 0, "offset_y": 0}


def write_host(app, ips=("10.0.0.5",), prefix=24):
    (app.state.settings.data_dir / "host-network.json").write_text(json.dumps(
        {"updated_at": datetime.now(UTC).isoformat(),
         "interfaces": [{"name": "en0", "ipv4": i, "prefix": prefix} for i in ips]}))


def label_setup(app, station="label", initiative_id="m-1"):
    laptop_setup.save(app.state.store, {"initiative_id": initiative_id}, station)


async def put(app, client, body):
    return await client.put("/edge/label-station", headers=make_session(app), json=body)


async def test_settings_round_trip_into_the_shared_setup(app, client):
    write_host(app)
    label_setup(app)
    assert (await client.get("/edge/label-station", headers=make_session(app))).json() is None
    r = await put(app, client, SETTINGS)
    assert r.status_code == 200, r.text
    assert r.json() == SETTINGS
    got = (await client.get("/edge/label-station", headers=make_session(app))).json()
    assert got == SETTINGS
    assert laptop_setup.load(app.state.store)["label_station"] == SETTINGS
    r = await put(app, client, USB)
    assert r.json() == {**USB, "printer": {"type": "usb", "ip": None, "model": "ZD421",
                                            "serial": None}}


async def test_printer_object_is_normalized(app, client):
    label_setup(app)
    r = await put(app, client, {**USB, "printer": {"type": "usb", "model": "ZD421"}})
    assert r.json()["printer"] == {"type": "usb", "ip": None, "model": "ZD421", "serial": None}


async def test_needs_a_label_station_setup(app, client):
    r = await put(app, client, SETTINGS)
    assert r.status_code == 409 and r.json()["detail"]["code"] == "not_label_station"
    label_setup(app, station="rfid")
    r = await put(app, client, SETTINGS)
    assert r.status_code == 409


@pytest.mark.parametrize("change", [
    {"label_kind": "side"}, {"label_kind": None},
    {"printer": None}, {"printer": {"type": "bluetooth", "model": "x"}},
    {"printer": {"type": "network", "ip": "8.8.8.8", "model": "x"}},
    {"printer": {"type": "network", "ip": "10.0.0.5", "model": "x"}},
    {"printer": {"type": "network", "model": "x"}},
    {"printer": {"type": "usb", "ip": "10.0.0.40", "model": "x"}},
    {"printer": {"type": "usb", "model": "x" * 200}},
    {"printer": {"type": "usb", "model": 5}},
    {"dpi": "300"}, {"dpi": 0}, {"dpi": True}, {"dpi": 5000},
    {"offset_x": 1.5}, {"offset_y": "3"}, {"offset_x": 100000}, {"offset_y": None},
])
async def test_bad_settings_are_422(app, client, change):
    write_host(app)
    label_setup(app)
    r = await put(app, client, {**SETTINGS, **change})
    assert r.status_code == 422, r.text


async def test_a_bad_network_ip_is_bad_printer_ip(app, client):
    write_host(app)
    label_setup(app)
    r = await put(app, client, {**SETTINGS, "printer": {"type": "network", "ip": "127.0.0.1",
                                                        "model": "x"}})
    assert r.json()["detail"]["code"] == "bad_printer_ip"


async def test_clear_setup_clears_them(app, client):
    write_host(app)
    label_setup(app)
    await put(app, client, SETTINGS)
    station_key.apply_clear_setup(app.state.store)
    assert (await client.get("/edge/label-station", headers=make_session(app))).json() is None


async def test_changing_station_type_clears_them_and_setting_up_again_keeps_them(app, client):
    write_host(app)
    label_setup(app)
    await put(app, client, SETTINGS)
    label_setup(app, initiative_id="m-1")  # set up again as a Label Station
    assert laptop_setup.load(app.state.store)["label_station"] == SETTINGS
    label_setup(app, station="rfid")
    assert laptop_setup.load(app.state.store)["label_station"] is None
    label_setup(app)
    assert laptop_setup.load(app.state.store)["label_station"] is None


async def test_a_fresh_setup_has_no_label_station(app):
    label_setup(app)
    assert laptop_setup.load(app.state.store)["label_station"] is None


# ── the config section ──────────────────────────────────────────────

async def test_config_mirrors_them_and_marks_dirty(app, client):
    write_host(app)
    out = await _seed(app, client)
    assert out["doc"]["label_station"] is None
    _clock_known(app)
    label_setup(app)
    await put(app, client, SETTINGS)
    got = (await client.get("/edge/config", headers=make_session(app))).json()
    assert got["doc"]["label_station"] == SETTINGS
    assert got["version"] == out["version"] + 1 and got["changed_at"] is not None
    assert _row(app)["dirty"] == 1


async def test_an_unchanged_put_does_not_mark_the_config(app, client):
    write_host(app)
    await _seed(app, client)
    label_setup(app)
    await put(app, client, SETTINGS)
    version = _row(app)["version"]
    await put(app, client, SETTINGS)
    assert _row(app)["version"] == version


async def test_clear_setup_nulls_the_section_and_marks_dirty(app, client):
    write_host(app)
    await _seed(app, client)
    label_setup(app)
    await put(app, client, SETTINGS)
    app.state.store.run("UPDATE device_config SET dirty = 0")
    station_key.apply_clear_setup(app.state.store)
    got = (await client.get("/edge/config", headers=make_session(app))).json()
    assert got["doc"]["label_station"] is None
    assert _row(app)["dirty"] == 1


async def test_station_type_change_nulls_the_section_and_marks_dirty(app, client):
    write_host(app)
    await _seed(app, client)
    label_setup(app)
    await put(app, client, SETTINGS)
    app.state.store.run("UPDATE device_config SET dirty = 0")
    label_setup(app, station="rfid")
    got = (await client.get("/edge/config", headers=make_session(app))).json()
    assert got["doc"]["label_station"] is None and _row(app)["dirty"] == 1


async def test_browsers_and_the_portal_cannot_overwrite_the_section(app, client):
    write_host(app)
    await _seed(app, client)
    label_setup(app)
    await put(app, client, SETTINGS)
    version = _row(app)["version"]
    r = await client.put("/edge/config", headers=make_session(app),
                         json={"doc": {**DOC, "label_station": {"dpi": 1}},
                               "base_version": version})
    assert r.json()["doc"]["label_station"] == SETTINGS
    beat = config_sync.prepare_beat(app.state.store)
    config_sync.handle_reply(app.state.store, beat, {
        "server_time": datetime.now(UTC).isoformat(), "config_version": 99,
        "config": {**DOC, "label_station": {"dpi": 1}}})
    assert config_sync.get(app.state.store)["doc"]["label_station"] == SETTINGS


async def test_the_report_carries_the_section(app, client):
    write_host(app)
    await _seed(app, client)
    _clock_known(app)
    label_setup(app)
    await put(app, client, SETTINGS)
    beat = config_sync.prepare_beat(app.state.store)
    assert beat.fields["config"]["label_station"] == SETTINGS


async def test_wipe_nulls_the_section_and_marks_dirty(app, client):
    write_host(app)
    await _seed(app, client)
    label_setup(app)
    await put(app, client, SETTINGS)
    app.state.store.run("UPDATE device_config SET dirty = 0")
    r = await client.post("/edge/wipe", json={}, headers=make_session(app, max_rank=60))
    assert r.status_code == 200
    got = (await client.get("/edge/config", headers=make_session(app))).json()
    assert got["doc"]["label_station"] is None and _row(app)["dirty"] == 1
