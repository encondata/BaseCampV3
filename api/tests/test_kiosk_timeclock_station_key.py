"""Time Clock station type (migration 0105): `devices.station_type` accepts
'timeclock', a Time Clock laptop's station key verifies, and the existing
station-key routes (sync except people, scans, heartbeat, sounds) refuse it with 403
`wrong_station_type` while keeping the key. RFID and Label keys are
unchanged."""

import uuid

import pytest
from sqlalchemy.exc import IntegrityError

from serversherpa.db.models import Device, Person, WorkerProfile
from serversherpa.services import station_keys
from tests.test_kiosk_station_key import SERIAL, _code, _device
from tests.test_kiosk_station_scans import _auth, _scan, _station
from tests.test_sites_api import login


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
    # (people sync takes a Time Clock key: test_kiosk_station_timeclock.py)
    for path in ("/kiosk/station/sync/assets", "/kiosk/station/sync/containers",
                 "/kiosk/station/sync/label-templates",
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


@pytest.mark.parametrize("sub_type", ["android", "zebra", "ios"])
async def test_android_timeclock_station_gets_and_uses_a_key(
        client, db, seeded_user, sub_type):
    """An Android, Zebra or iOS kiosk set up as a Time Clock Station signs in
    (session_person_id stamped by the heartbeat), takes a key and punches
    under it. Test name per the plan; parametrized over the three types."""
    uid = seeded_user.id
    hdrs = await login(client)
    device, _ = await _device(db, person_id=uid, sub_type=sub_type,
                              station_type="timeclock")
    person = Person(first_name="Nia", last_name="Native", rfid_tag=f"TC-{uuid.uuid4().hex[:6]}")
    db.add(person)
    await db.flush()
    db.add(WorkerProfile(person_id=person.id))
    await db.commit()
    pid = person.id
    db.expunge(person)

    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert r.status_code == 200, r.text
    key = r.json()["key"]
    assert key
    got = await station_keys.verify(db, SERIAL, key)
    assert got is not None and got.id == device.id

    r = await client.get(f"/kiosk/station/timeclock/{pid}", headers=_auth(key),
                         params={"serial": SERIAL})
    assert r.status_code == 200, r.text
    assert r.json()["clocked_in"] is False


@pytest.mark.parametrize("station_type", ["rfid", "label"])
async def test_android_rfid_station_still_refused(client, db, seeded_user, station_type):
    """RFID and Label Stations stay laptop-only."""
    uid = seeded_user.id
    hdrs = await login(client)
    await _device(db, person_id=uid, sub_type="android", station_type=station_type)
    r = await client.post("/kiosk/station-key", headers=hdrs, json={"serial": SERIAL})
    assert r.status_code == 409 and _code(r) == "not_rfid_station"


@pytest.mark.parametrize("station_type", ["rfid", "label"])
async def test_verify_refuses_non_laptop_rfid_and_label_keys(
        client, db, seeded_user, station_type):
    device, _, key = await _station(db)
    await _set(db, device, sub_type="ios", station_type=station_type)
    assert await station_keys.verify(db, SERIAL, key) is None
