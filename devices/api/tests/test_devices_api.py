"""The Devices page's API: GET /api/devices (the registered iPhones and the
team's per-class device counts) and POST /api/devices/{id}/disable."""

import datetime as dt
import uuid

from serversherpa_devices.db.models import AppleDeviceCount, IosDevice

from .catalog_support import apple_settings_filled, audits
from .fake_main_api import PERSON_ID
from .worker_support import UDID_A, UDID_B, fresh, jobs_of, seed_device


async def _counts(db, synced_at: dt.datetime, **counts: int) -> None:
    for device_class, count in counts.items():
        db.add(AppleDeviceCount(device_class=device_class, count=count, synced_at=synced_at))
    await db.commit()


async def test_list_devices_and_counts(api, db):
    now = dt.datetime.now(dt.UTC)
    await apple_settings_filled(db)
    await _counts(db, now, IPAD=2, IPHONE=7)
    older = await seed_device(db, UDID_A, name="Pat's iPhone", status="registered")
    failed = await seed_device(db, UDID_B, name="Crew iPhone", status="failed")
    failed.error = "Apple refused this device."
    failed.added_at = older.added_at + dt.timedelta(minutes=5)
    await db.commit()

    r = await api.get("/api/devices")
    assert r.status_code == 200, r.text
    body = r.json()
    # newest first; never the UDID (nor any part of it)
    assert [d["name"] for d in body["devices"]] == ["Crew iPhone", "Pat's iPhone"]
    crew = body["devices"][0]
    assert crew == {
        "id": str(failed.id), "name": "Crew iPhone", "product": "iPhone14,5",
        "os_version": "22B83", "added_by_name": "Pat Admin",
        "added_at": crew["added_at"], "status": "failed", "error": "Apple refused this device.",
    }
    assert UDID_A not in r.text and UDID_B not in r.text
    assert UDID_B[-4:] not in r.text
    # iPhone first, then the rest by class
    assert [(c["device_class"], c["count"]) for c in body["counts"]] == [("IPHONE", 7), ("IPAD", 2)]
    assert dt.datetime.fromisoformat(body["counts"][0]["synced_at"]) == now
    # counts checked within the minute: no sync queued
    assert await jobs_of("sync_devices") == []


async def test_list_devices_needs_view(api, main_fake):
    main_fake.as_staff(actions=[])
    r = await api.get("/api/devices")
    assert r.status_code == 403


async def test_sync_enqueued_when_stale(api, db):
    # Apple not set up: nothing to sync with
    r = await api.get("/api/devices")
    assert r.status_code == 200
    assert r.json() == {"devices": [], "counts": []}
    assert await jobs_of("sync_devices") == []

    # set up, never checked: one sync, and a second load doesn't queue another
    await apple_settings_filled(db)
    assert (await api.get("/api/devices")).status_code == 200
    assert (await api.get("/api/devices")).status_code == 200
    assert [j.status for j in await jobs_of("sync_devices")] == ["queued"]


async def test_sync_enqueued_when_counts_older_than_a_minute(api, db):
    await apple_settings_filled(db)
    await _counts(db, dt.datetime.now(dt.UTC) - dt.timedelta(seconds=61), IPHONE=3)
    r = await api.get("/api/devices")
    assert r.status_code == 200
    assert r.json()["counts"][0]["count"] == 3
    assert len(await jobs_of("sync_devices")) == 1


async def test_disable_requires_delete(api, main_fake, db):
    device = await seed_device(db, UDID_A, status="registered")
    main_fake.as_staff()   # view only
    assert (await api.get("/api/devices")).status_code == 200
    r = await api.post(f"/api/devices/{device.id}/disable")
    assert r.status_code == 403
    main_fake.as_admin(actions=["view", "add", "change"])
    r = await api.post(f"/api/devices/{device.id}/disable")
    assert r.status_code == 403
    assert (await fresh(IosDevice, device.id)).status == "registered"
    assert await jobs_of() == []
    assert audits(main_fake) == []


async def test_disable_enqueues_and_audits(api, main_fake, db):
    device = await seed_device(db, UDID_A, name="Pat's iPhone", status="registered")
    r = await api.post(f"/api/devices/{device.id}/disable")
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "disabled"
    assert UDID_A not in r.text
    # it stops installing at once; the worker disables it at Apple
    assert (await fresh(IosDevice, device.id)).status == "disabled"
    (job,) = await jobs_of()
    assert (job.kind, job.payload) == ("disable_device", {"device_id": str(device.id)})
    (audit,) = audits(main_fake)
    assert audit["actor_person_id"] == str(PERSON_ID)
    assert (audit["entity_type"], audit["entity_id"], audit["action"]) == (
        "appdist_device", str(device.id), "disable")
    assert audit["changes"] == {"status": {"from": "registered", "to": "disabled"}}
    assert UDID_A not in str(audit)

    # again: already disabled, nothing more to do
    r = await api.post(f"/api/devices/{device.id}/disable")
    assert r.status_code == 200
    assert len(await jobs_of()) == 1
    assert len(audits(main_fake)) == 1


async def test_disable_clears_an_old_registration_error(api, db):
    device = await seed_device(db, UDID_A, status="failed")
    device.error = "Apple refused this iPhone: no"
    await db.commit()
    r = await api.post(f"/api/devices/{device.id}/disable")
    assert (r.json()["status"], r.json()["error"]) == ("disabled", None)
    assert (await fresh(IosDevice, device.id)).error is None


async def test_disable_unknown_device(api):
    r = await api.post(f"/api/devices/{uuid.uuid4()}/disable")
    assert r.status_code == 404
    assert r.json()["detail"]["code"] == "not_found"


async def test_disable_blocked_in_read_only_mode(api, main_fake, db):
    device = await seed_device(db, UDID_A, status="registered")
    main_fake.as_admin(read_only=True, read_only_message="Maintenance until 14:00.")
    r = await api.post(f"/api/devices/{device.id}/disable")
    assert r.status_code == 423
    assert r.json()["detail"]["message"] == "Maintenance until 14:00."
    assert (await fresh(IosDevice, device.id)).status == "registered"


async def test_list_devices_never_returns_udid_in_error(api, db):
    # a row written before the worker scrubbed Apple's detail
    device = await seed_device(db, UDID_A, status="failed")
    device.error = (f"Apple refused this iPhone: A device with number '{UDID_A.lower()}' "
                    f"already exists ({UDID_A.replace('-', '')}).")
    await db.commit()

    r = await api.get("/api/devices")
    assert r.status_code == 200
    (out,) = r.json()["devices"]
    assert out["error"] == ("Apple refused this iPhone: A device with number 'this iPhone' "
                            "already exists (this iPhone).")
    bare = UDID_A.replace("-", "").lower()
    assert UDID_A.lower() not in r.text.lower() and bare not in r.text.lower()
