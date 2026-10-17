"""Kiosk sounds: POST /kiosk/sounds stores an uploaded audio file (2 MB max)
in Spaces under kiosk-sounds/<uuid> and records a kiosk_sounds row;
GET /kiosk/sounds/{id} streams it back. Either route takes a person session
with kiosk:view or an RFID Station's key (`serial` names the station)."""

import uuid

import pytest
from sqlalchemy import select

from serversherpa.db.models import AuditLog, Device, KioskSound
from tests.test_auth_kiosk_login import _client_viewer
from tests.test_kiosk_station_key import SERIAL
from tests.test_kiosk_station_scans import _auth, _station
from tests.test_sites_api import login

MAX = 2 * 1024 * 1024


@pytest.fixture
def store(monkeypatch):
    blobs: dict[str, tuple[bytes, str]] = {}

    async def put_object(key, data, content_type):
        blobs[key] = (data, content_type)

    async def get_object(key):
        if key not in blobs:
            from botocore.exceptions import ClientError
            raise ClientError({"Error": {"Code": "NoSuchKey", "Message": "gone"}},
                              "GetObject")
        return blobs[key][0]

    monkeypatch.setattr("serversherpa.api.routes.kiosk.put_object", put_object)
    monkeypatch.setattr("serversherpa.api.routes.kiosk.get_object", get_object)
    return blobs


def _file(data=b"ID3fake-mp3", name="ding.mp3", ctype="audio/mpeg"):
    return {"file": (name, data, ctype)}


async def test_upload_stores_in_spaces_and_records_row(client, db, seeded_user, store):
    hdrs = await login(client)
    r = await client.post("/kiosk/sounds", headers=hdrs, files=_file())
    assert r.status_code == 201, r.text
    body = r.json()
    assert set(body) == {"id", "name", "content_type", "size"}
    assert body["name"] == "ding.mp3" and body["content_type"] == "audio/mpeg"
    assert body["size"] == len(b"ID3fake-mp3")
    row = await db.get(KioskSound, uuid.UUID(body["id"]))
    assert row.storage_key.startswith("kiosk-sounds/")
    uuid.UUID(row.storage_key.removeprefix("kiosk-sounds/"))
    assert row.uploaded_by == seeded_user.id and row.uploaded_from_device is None
    assert store[row.storage_key] == (b"ID3fake-mp3", "audio/mpeg")
    (a,) = (await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "kiosk_sound", AuditLog.entity_id == body["id"]))).all()
    assert a.action == "create"


async def test_upload_with_serial_records_the_device(client, db, seeded_user, store):
    hdrs = await login(client)
    await client.post("/kiosk/heartbeat", headers=hdrs, json={
        "serial": "kiosk-snd", "name": "Dock", "mode": "web"})
    r = await client.post("/kiosk/sounds", headers=hdrs, files=_file(),
                          data={"serial": "kiosk-snd"})
    assert r.status_code == 201, r.text
    dev = await db.scalar(select(Device).where(Device.serial == "kiosk-snd"))
    row = await db.get(KioskSound, uuid.UUID(r.json()["id"]))
    assert row.uploaded_from_device == dev.id


async def test_upload_rejects_non_audio(client, db, seeded_user, store):
    hdrs = await login(client)
    r = await client.post("/kiosk/sounds", headers=hdrs,
                          files=_file(b"<svg/>", "x.svg", "image/svg+xml"))
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "not_audio"
    assert not store
    assert (await db.scalars(select(KioskSound))).all() == []


async def test_upload_rejects_over_2mb(client, db, seeded_user, store):
    hdrs = await login(client)
    r = await client.post("/kiosk/sounds", headers=hdrs, files=_file(b"x" * (MAX + 1)))
    assert r.status_code == 413
    assert r.json()["detail"]["code"] == "file_too_large"
    assert not store
    # exactly 2 MB is fine
    ok = await client.post("/kiosk/sounds", headers=hdrs, files=_file(b"x" * MAX))
    assert ok.status_code == 201, ok.text


async def test_upload_rejects_empty(client, db, seeded_user, store):
    hdrs = await login(client)
    r = await client.post("/kiosk/sounds", headers=hdrs, files=_file(b""))
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "empty_file"


async def test_stored_sound_downloads(client, db, seeded_user, store):
    hdrs = await login(client)
    sid = (await client.post("/kiosk/sounds", headers=hdrs, files=_file())).json()["id"]
    r = await client.get(f"/kiosk/sounds/{sid}", headers=hdrs)
    assert r.status_code == 200
    assert r.content == b"ID3fake-mp3"
    assert r.headers["content-type"] == "audio/mpeg"
    assert r.headers["x-content-type-options"] == "nosniff"


async def test_unknown_sound_is_404(client, db, seeded_user, store):
    hdrs = await login(client)
    r = await client.get(f"/kiosk/sounds/{uuid.uuid4()}", headers=hdrs)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "sound_not_found"


async def test_missing_blob_is_404(client, db, seeded_user, store):
    hdrs = await login(client)
    sid = (await client.post("/kiosk/sounds", headers=hdrs, files=_file())).json()["id"]
    store.clear()
    r = await client.get(f"/kiosk/sounds/{sid}", headers=hdrs)
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "sound_not_found"


async def test_permission(client, db, seeded_user, store):
    cv = await _client_viewer(db, client, "cv@test.example.com")
    assert (await client.post("/kiosk/sounds", headers=cv, files=_file())).status_code == 403
    assert (await client.post("/kiosk/sounds", files=_file())).status_code == 401
    assert (await client.get(f"/kiosk/sounds/{uuid.uuid4()}", headers=cv)).status_code == 403
    assert (await client.get(f"/kiosk/sounds/{uuid.uuid4()}")).status_code == 401


async def test_station_key_upload_and_download(client, db, seeded_user, store):
    device, _, key = await _station(db)
    r = await client.post("/kiosk/sounds", headers=_auth(key), files=_file(),
                          data={"serial": SERIAL})
    assert r.status_code == 201, r.text
    row = await db.get(KioskSound, uuid.UUID(r.json()["id"]))
    assert row.uploaded_by is None and row.uploaded_from_device == device.id
    got = await client.get(f"/kiosk/sounds/{row.id}", headers=_auth(key),
                           params={"serial": SERIAL})
    assert got.status_code == 200 and got.content == b"ID3fake-mp3"


async def test_station_key_needs_a_valid_key_and_serial(client, db, seeded_user, store):
    _, _, key = await _station(db)
    bad = await client.post("/kiosk/sounds", headers=_auth("nope"), files=_file(),
                            data={"serial": SERIAL})
    assert bad.status_code == 401
    assert bad.json()["detail"]["code"] == "station_key_invalid"
    no_serial = await client.post("/kiosk/sounds", headers=_auth(key), files=_file())
    assert no_serial.status_code == 401
    assert (await client.get(f"/kiosk/sounds/{uuid.uuid4()}",
                             headers=_auth(key))).status_code == 401
    assert not store
