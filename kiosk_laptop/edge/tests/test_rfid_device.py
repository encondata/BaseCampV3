from datetime import UTC, datetime, timedelta

from edge.db import iso
from tests.conftest import make_session
from tests.test_reader_report import add_read, paired_station
from tests.test_rfid_pairing import SERIAL


async def test_device_unpaired_returns_null_reader(app, client):
    r = await client.get("/edge/rfid/device", headers=make_session(app))
    assert r.status_code == 200
    assert r.json() == {"reader": None}


async def test_device_returns_pairing_snapshot_and_last_read(app, client):
    await paired_station(app, client)
    now = datetime.now(UTC)
    app.state.reader_snapshot = {"serial": SERIAL, "firmware": "2.7.19.0", "tags_24h": 3,
                                 "reachable": True, "taken_at": iso(now)}
    add_read(app, SERIAL, now - timedelta(minutes=5))
    add_read(app, SERIAL, now - timedelta(minutes=2))
    add_read(app, "OTHER", now - timedelta(seconds=1))
    body = (await client.get("/edge/rfid/device", headers=make_session(app))).json()
    assert body["reader"]["serial"] == SERIAL
    assert set(body["reader"]) == {"serial", "model", "ip", "paired_at"}
    assert body["reader"]["model"] == "FX9600" and body["reader"]["paired_at"]
    assert body["snapshot"]["firmware"] == "2.7.19.0"
    assert body["last_read_at"] == iso(now - timedelta(minutes=2))


async def test_device_without_reads_or_snapshot_is_null(app, client):
    await paired_station(app, client)
    app.state.reader_snapshot = None
    body = (await client.get("/edge/rfid/device", headers=make_session(app))).json()
    assert body["snapshot"] is None and body["last_read_at"] is None


async def test_device_stale_snapshot_is_null(app, client):
    await paired_station(app, client)
    app.state.reader_snapshot = {"serial": SERIAL, "reachable": True,
                                 "taken_at": iso(datetime.now(UTC) - timedelta(minutes=10))}
    body = (await client.get("/edge/rfid/device", headers=make_session(app))).json()
    assert body["reader"]["serial"] == SERIAL and body["snapshot"] is None


async def test_device_needs_a_session(client):
    assert (await client.get("/edge/rfid/device")).status_code == 401
