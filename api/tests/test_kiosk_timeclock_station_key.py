"""Time Clock station type (migration 0105): `devices.station_type` accepts
'timeclock', a Time Clock laptop's station key verifies, and the existing
station-key routes (sync, scans, heartbeat, sounds) refuse it with 403
`wrong_station_type` while keeping the key. RFID and Label keys are
unchanged."""

import uuid

import pytest
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import Device
from serversherpa.services import station_keys
from tests.test_kiosk_station_key import SERIAL
from tests.test_kiosk_station_scans import _auth, _scan, _station


async def _set(db, device, **fields):
    live = await db.get(Device, device.id)
    for k, v in fields.items():
        setattr(live, k, v)
    await db.commit()


async def _timeclock_station(db):
    """A registered Time Clock laptop with a key. -> (device, move, key)."""
    device, init, _ = await _station(db)
    live = await db.get(Device, device.id)
    live.station_type = "timeclock"
    key = await station_keys.issue(db, live, actor_id=None, via="password")
    await db.commit()
    return device, init, key


def test_station_type_constants():
    assert station_keys.STATION_TYPES == ("rfid", "label", "timeclock")
    assert station_keys.UPLOAD_STATION_TYPES == ("rfid", "label")
    assert station_keys.TIMECLOCK == "timeclock"


async def test_migration_allows_timeclock_station_type(db):
    d = Device(device_type="kiosk", name="TC", serial=f"tc-{uuid.uuid4().hex[:8]}",
               sub_type="laptop", station_type="timeclock")
    db.add(d)
    await db.flush()   # no IntegrityError
    d.station_type = "bogus"
    with pytest.raises(IntegrityError):
        await db.flush()
    await db.rollback()


async def test_verify_accepts_timeclock_laptop_key(client, db, seeded_user):
    device, _, key = await _timeclock_station(db)
    got = await station_keys.verify(db, SERIAL, key)
    assert got is not None and got.id == device.id


async def test_timeclock_key_refused_on_upload_routes(client, db, seeded_user):
    device, init, key = await _timeclock_station(db)
    params = {"serial": SERIAL, "initiative_id": str(init.id)}
    for path in ("/kiosk/station/sync/assets", "/kiosk/station/sync/containers",
                 "/kiosk/station/sync/label-templates", "/kiosk/station/sync/people",
                 "/kiosk/station/sync/client-assets"):
        r = await client.get(path, headers=_auth(key), params=params)
        assert r.status_code == 403, (path, r.text)
        assert r.json()["detail"] == {"code": "wrong_station_type"}, path
    r = await client.post("/kiosk/station/scans", headers=_auth(key),
                          json={"serial": SERIAL, "scans": [_scan("EPC-TC-1")]})
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == {"code": "wrong_station_type"}
    r = await client.post("/kiosk/station/heartbeat", headers=_auth(key),
                          json={"serial": SERIAL, "version": "2.0"})
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == {"code": "wrong_station_type"}
    r = await client.get(f"/kiosk/sounds/{uuid.uuid4()}", headers=_auth(key),
                         params={"serial": SERIAL})
    assert r.status_code == 403, r.text
    assert r.json()["detail"] == {"code": "wrong_station_type"}
    # the key is kept: the refusal is about the route, not the key
    db.expire_all()
    assert (await db.get(Device, device.id)).station_key_hash is not None
    got = await station_keys.verify(db, SERIAL, key)
    assert got is not None and got.id == device.id


async def test_rfid_and_label_keys_unchanged(client, db, seeded_user):
    device, init, key = await _station(db)
    params = {"serial": SERIAL, "initiative_id": str(init.id)}
    r = await client.get("/kiosk/station/sync/assets", headers=_auth(key), params=params)
    assert r.status_code == 200, r.text
    await _set(db, device, station_type="label")
    r = await client.get("/kiosk/station/sync/assets", headers=_auth(key), params=params)
    assert r.status_code == 200, r.text
