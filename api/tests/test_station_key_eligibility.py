"""A station key works only for a registered RFID laptop kiosk: a kiosk that
is no longer an RFID laptop gets the plain 401, and a lapsed registration is a
403 `kiosk_not_registered` that keeps the key, so renewing restores uploads."""

import uuid
from datetime import UTC, datetime, timedelta

from serversherpa.db.models import Device
from tests.test_kiosk_station_key import SERIAL
from tests.test_kiosk_station_scans import _auth, _post, _scan, _station


async def _set(db, device, **fields):
    live = await db.get(Device, device.id)
    for k, v in fields.items():
        setattr(live, k, v)
    await db.commit()


async def test_key_refused_when_station_is_no_longer_rfid_laptop(client, db, seeded_user):
    device, _, key = await _station(db)
    await _set(db, device, station_type="label")
    r = await _post(client, key, [_scan("EPC-ELIG-LABEL")])
    assert r.status_code == 401
    assert r.json()["detail"] == {"code": "station_key_invalid"}


async def test_key_refused_when_kiosk_is_not_a_laptop(client, db, seeded_user):
    device, _, key = await _station(db)
    await _set(db, device, sub_type="android")
    r = await _post(client, key, [_scan("EPC-ELIG-ANDROID")])
    assert r.status_code == 401
    assert r.json()["detail"] == {"code": "station_key_invalid"}


async def test_lapsed_registration_is_403_and_keeps_key(client, db, seeded_user):
    device, _, key = await _station(db)
    await _set(db, device, token_expires_at=datetime.now(UTC) - timedelta(days=1))
    r = await _post(client, key, [_scan("EPC-ELIG-LAPSED")])
    assert r.status_code == 403
    assert r.json()["detail"] == {"code": "kiosk_not_registered"}
    db.expire_all()
    assert (await db.get(Device, device.id)).station_key_hash is not None


async def test_unregistered_kiosk_is_403(client, db, seeded_user):
    device, _, key = await _station(db)
    await _set(db, device, token_expires_at=None)
    r = await _post(client, key, [_scan("EPC-ELIG-NONE")])
    assert r.status_code == 403
    assert r.json()["detail"] == {"code": "kiosk_not_registered"}


async def test_soon_expiring_registration_still_passes(client, db, seeded_user):
    device, _, key = await _station(db)
    await _set(db, device, token_expires_at=datetime.now(UTC) + timedelta(days=2))
    r = await _post(client, key, [_scan("EPC-ELIG-SOON")])
    assert r.status_code == 200, r.text


async def test_renewed_registration_restores_the_key(client, db, seeded_user):
    device, _, key = await _station(db)
    await _set(db, device, token_expires_at=datetime.now(UTC) - timedelta(days=1))
    assert (await _post(client, key, [_scan("EPC-ELIG-R1")])).status_code == 403
    await _set(db, device, token_expires_at=datetime.now(UTC) + timedelta(days=30))
    r = await _post(client, key, [_scan("EPC-ELIG-R2")])
    assert r.status_code == 200, r.text
    assert len(r.json()["accepted"]) == 1


async def test_wrong_key_on_lapsed_kiosk_is_plain_401(client, db, seeded_user):
    device, _, _ = await _station(db)
    await _set(db, device, token_expires_at=datetime.now(UTC) - timedelta(days=1))
    r = await _post(client, "wrong-key", [_scan("EPC-ELIG-WRONG")])
    assert r.status_code == 401
    assert r.json()["detail"] == {"code": "station_key_invalid"}


async def test_station_sync_also_403s_when_lapsed(client, db, seeded_user):
    device, init, key = await _station(db)
    await _set(db, device, token_expires_at=datetime.now(UTC) - timedelta(days=1))
    r = await client.get("/kiosk/station/sync/assets", headers=_auth(key),
                         params={"serial": SERIAL, "initiative_id": str(init.id)})
    assert r.status_code == 403
    assert r.json()["detail"] == {"code": "kiosk_not_registered"}
    # a wrong move on a lapsed kiosk is still the registration refusal
    r = await client.get("/kiosk/station/sync/assets", headers=_auth(key),
                         params={"serial": SERIAL, "initiative_id": str(uuid.uuid4())})
    assert r.status_code == 403
    assert r.json()["detail"] == {"code": "kiosk_not_registered"}


def test_registration_state_importable_from_service():
    from serversherpa.services.kiosk_registration import REGISTRATION_SOON, registration_state
    now = datetime(2026, 10, 16, tzinfo=UTC)
    assert registration_state(None, now) == "none"
    assert registration_state(now, now) == "expired"
    assert registration_state(now + REGISTRATION_SOON, now) == "soon"
    assert registration_state(now + REGISTRATION_SOON + timedelta(seconds=1), now) == "ok"
