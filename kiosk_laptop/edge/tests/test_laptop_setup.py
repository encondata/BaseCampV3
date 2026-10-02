"""The laptop's finished Kiosk Setup, shared with every browser (D2), and
the edge/cloud consistency rules around /kiosk/setup (review I5)."""

import json

from tests.conftest import make_session
from tests.fake_reader import FakeReader

READER_IP = "10.0.0.20"
SERIAL = "84248dee5721"
SETUP = {"serial": "browser", "initiative_id": "m-1", "site_id": "s-1", "scan_status": "x"}
OUT = {"device_id": "d-1", "initiative_id": "m-1", "initiative_name": "Move One",
       "site_id": "s-1", "site_name": "Dock", "site_role": "source", "scan_status": "x",
       "scan_status_label": "Picked up"}


async def no_sync():
    return {}


def ready(app, cloud, status=200, body=OUT):
    app.state.upstream.save_session("p-1", refresh_token="r1", access_token="a1", expires_in=900)
    app.state.syncer.run = no_sync
    return cloud.post("/kiosk/setup").respond(status, json=body)


async def paired(app, client):
    reader = FakeReader()
    app.state.reader_transport = reader.transport()
    r = await client.post("/edge/rfid/pair", headers=make_session(app),
                          json={"ip": READER_IP, "laptop_ip": "10.0.0.5"})
    assert r.status_code == 200, r.text
    return reader


async def setup(client, app, **body):
    return await client.post("/kiosk/setup", headers=make_session(app), json={**SETUP, **body})


async def test_edge_setup_is_null_until_set_up_and_needs_a_session(app, client):
    assert (await client.get("/edge/setup")).status_code == 401
    r = await client.get("/edge/setup", headers=make_session(app))
    assert r.status_code == 200 and r.json() is None


async def test_a_label_setup_is_shared(app, client, cloud):
    ready(app, cloud)
    assert (await setup(client, app, station_type="label")).status_code == 200
    body = (await client.get("/edge/setup", headers=make_session(app, person_id="p-2"))).json()
    assert {k: body[k] for k in OUT if k != "device_id"} == {k: v for k, v in OUT.items()
                                                             if k != "device_id"}
    assert body["station_type"] == "label" and body["reader"] is None
    assert body["updated_at"]


async def test_an_rfid_setup_is_shared_with_the_reader_summary(app, client, cloud):
    await paired(app, client)
    ready(app, cloud)
    assert (await setup(client, app, station_type="rfid")).status_code == 200
    body = (await client.get("/edge/setup", headers=make_session(app))).json()
    assert body["station_type"] == "rfid"
    assert body["reader"] == {"ip": READER_IP, "serial": SERIAL, "model": "FX9600",
                              "versions": {"readerApplication": "2.7.19.0",
                                           "radioFirmware": "2.1.14.0",
                                           "cloudAgentApplication": "1.0.0"}}
    assert "token" not in json.dumps(body) and "…" not in json.dumps(body)


async def test_a_failed_setup_keeps_the_shared_one(app, client, cloud):
    ready(app, cloud)
    await setup(client, app, station_type="label")
    cloud.post("/kiosk/setup").respond(409, json={"detail": {"code": "move_locked"}})
    assert (await setup(client, app, station_type="label",
                        initiative_id="m-2")).status_code == 409
    assert (await client.get("/edge/setup", headers=make_session(app))).json()[
        "initiative_id"] == "m-1"


async def test_wipe_clears_the_shared_setup(app, client, cloud):
    ready(app, cloud)
    await setup(client, app, station_type="label")
    r = await client.post("/edge/wipe", json={}, headers=make_session(app, max_rank=60))
    assert r.status_code == 200
    assert (await client.get("/edge/setup", headers=make_session(app))).json() is None


async def test_a_label_setup_drops_the_pairing_but_keeps_the_reader(app, client, cloud):
    await paired(app, client)
    row = app.state.store.one("SELECT * FROM rfid_readers WHERE serial = ?", (SERIAL,))
    ready(app, cloud)
    assert (await setup(client, app, station_type="label")).status_code == 200
    assert app.state.store.one("SELECT * FROM rfid_pairing") is None
    kept = app.state.store.one("SELECT * FROM rfid_readers WHERE serial = ?", (SERIAL,))
    assert (kept["token"], kept["password_index"]) == (row["token"], row["password_index"])
    assert (await client.get("/edge/rfid/reader", headers=make_session(app))).json() is None


async def test_a_refused_label_setup_keeps_the_pairing(app, client, cloud):
    await paired(app, client)
    ready(app, cloud, status=409, body={"detail": {"code": "move_locked"}})
    assert (await setup(client, app, station_type="label")).status_code == 409
    assert app.state.store.one("SELECT * FROM rfid_pairing") is not None


async def test_reader_required_is_422_like_the_cloud(app, client, cloud):
    route = ready(app, cloud)
    r = await setup(client, app, station_type="rfid")
    assert r.status_code == 422 and r.json()["detail"]["code"] == "reader_required"
    assert not route.called
