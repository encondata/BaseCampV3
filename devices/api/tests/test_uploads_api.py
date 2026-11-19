"""Uploads: presigned PUT, inspection with its review problems, commit."""

import datetime as dt
import uuid

import pytest
from sqlalchemy import select, update

from serversherpa_devices import catalog
from serversherpa_devices.config import get_settings
from serversherpa_devices.db.models import (
    App,
    AppleSettings,
    AppVersion,
    IosProfile,
    SignedBuild,
    Upload,
)

from .catalog_support import (
    APK_TYPE,
    HELLO_A,
    HELLO_A2,
    KEY_A_DIGEST,
    KEY_B_DIGEST,
    apple_settings_filled,
    audits,
    commit,
    hello_ipa,
    inspect,
    publish,
    start_upload,
)
from .fake_main_api import PERSON_ID


@pytest.fixture
def ios_owner_url(monkeypatch):
    """Set DEVICES_IOS_OWNER_URL for one test."""
    def set_url(url: str) -> None:
        monkeypatch.setenv("DEVICES_IOS_OWNER_URL", url)
        get_settings.cache_clear()

    yield set_url
    monkeypatch.setenv("DEVICES_IOS_OWNER_URL", "")   # what conftest set
    get_settings.cache_clear()


async def test_upload_requires_add(api, main_fake, bucket):
    main_fake.as_staff()
    r = await api.post("/api/uploads", json={"filename": "a.apk", "size": 10,
                                             "content_type": APK_TYPE})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "forbidden"
    some_id = uuid.uuid4()
    assert (await api.post(f"/api/uploads/{some_id}/inspect")).status_code == 403
    assert (await commit(api, str(some_id))).status_code == 403
    assert bucket.presigned == []
    # Staff can still look.
    assert (await api.get("/api/apps")).status_code == 200

    main_fake.as_kiosk()
    r = await api.post("/api/uploads", json={"filename": "a.apk", "size": 10,
                                             "content_type": APK_TYPE})
    assert r.status_code == 403
    assert r.json()["detail"]["code"] == "kiosk_session"


async def test_upload_key_size_limit_and_content_type(api, bucket, db):
    r = await api.post("/api/uploads", json={"filename": "../../Kiosk app (v2).apk",
                                             "size": 1234, "content_type": APK_TYPE})
    assert r.status_code == 201
    upload_id = r.json()["upload_id"]
    key, content_type, size = bucket.presigned[-1]
    assert key == f"uploads/{upload_id}/Kiosk_app_v2_.apk"
    assert (content_type, size) == (APK_TYPE, 1234)
    row = await db.get(Upload, uuid.UUID(upload_id))
    assert (row.file_key, row.size, row.created_by) == (key, 1234, PERSON_ID)

    # Browsers send no type for .ipa files.
    r = await api.post("/api/uploads", json={"filename": "Hello.ipa", "size": 5,
                                             "content_type": ""})
    assert r.json()["headers"] == {"Content-Type": "application/octet-stream"}

    r = await api.post("/api/uploads", json={"filename": "big.apk",
                                             "size": 500 * 1024 * 1024 + 1,
                                             "content_type": APK_TYPE})
    assert r.status_code == 413
    assert r.json()["detail"]["message"] == "Files over 500 MB aren't accepted"
    r = await api.post("/api/uploads", json={"filename": "exact.apk",
                                             "size": 500 * 1024 * 1024,
                                             "content_type": APK_TYPE})
    assert r.status_code == 201


async def test_inspect_before_the_put_finishes(api, bucket):
    upload_id = await start_upload(api, bucket, HELLO_A, put=False)
    r = await api.post(f"/api/uploads/{upload_id}/inspect")
    assert r.status_code == 409
    assert r.json()["detail"]["message"] == "The file didn't finish uploading"


async def test_inspect_garbage_is_a_plain_422(api, bucket, tmp_path):
    junk = tmp_path / "notes.apk"
    junk.write_bytes(b"not a zip at all" * 10)
    upload_id = await start_upload(api, bucket, junk)
    r = await api.post(f"/api/uploads/{upload_id}/inspect")
    assert r.status_code == 422
    assert r.json()["detail"]["message"] == "This isn't an APK or IPA"


async def test_someone_elses_upload_is_not_found(api, main_fake, bucket):
    upload_id = await start_upload(api, bucket, HELLO_A)
    main_fake.as_admin(person_id=str(uuid.uuid4()))
    assert (await api.post(f"/api/uploads/{upload_id}/inspect")).status_code == 404
    assert (await commit(api, upload_id)).status_code == 404


async def test_inspect_then_commit_creates_app_and_current_version(api, main_fake, bucket, db):
    upload_id = await start_upload(api, bucket, HELLO_A, content_type=APK_TYPE)
    upload_key = bucket.presigned[-1][0]
    review = await inspect(api, upload_id)
    assert review == {
        "app": {"exists": False, "name": "Hello Fixture", "platform": "android",
                "identifier": "com.example.hello"},
        "version_name": "1.0", "build": "1", "signing_digest": KEY_A_DIGEST,
        "min_os": "26", "problems": [],
    }

    r = await commit(api, upload_id, "First release")
    assert r.status_code == 201, r.text
    saved = r.json()
    version = saved["version"]
    assert version["version_name"] == "1.0"
    assert version["build"] == "1"
    assert version["notes"] == "First release"
    assert version["size"] == HELLO_A.stat().st_size
    assert version["uploaded_by_name"] == "Pat Example"
    assert version["is_current"] is True

    app = (await db.scalars(select(App))).one()
    assert str(app.id) == saved["app_id"]
    assert (app.platform, app.identifier, app.name) == ("android", "com.example.hello",
                                                        "Hello Fixture")
    assert app.signing_digest == KEY_A_DIGEST
    row = await db.get(AppVersion, uuid.UUID(version["id"]))
    assert row.file_key == f"apps/{app.id}/{row.id}/hello-a.apk"
    assert row.is_current and row.uploaded_by == PERSON_ID
    assert row.min_os == "26" and row.build_sort == 1 and len(row.sha256) == 64
    assert bucket.read(row.file_key) == HELLO_A.read_bytes()
    assert app.icon_key == f"apps/{app.id}/icon.png"
    assert bucket.read(app.icon_key).startswith(b"\x89PNG")
    assert not any(k.startswith("uploads/") for k in bucket.object_keys()), bucket.object_keys()
    assert not bucket.exists(upload_key)
    assert (await db.get(Upload, uuid.UUID(upload_id))).committed_at is not None

    entries = audits(main_fake)
    assert [(e["entity_type"], e["action"]) for e in entries] == [
        ("appdist_app", "create"), ("appdist_version", "upload")]
    assert entries[1]["entity_id"] == version["id"]
    assert entries[1]["actor_person_id"] == str(PERSON_ID)
    assert entries[1]["changes"]["version_name"] == {"from": None, "to": "1.0"}

    listed = (await api.get("/api/apps")).json()
    assert listed == [{
        "id": str(app.id), "platform": "android", "identifier": "com.example.hello",
        "name": "Hello Fixture", "icon_url": f"/api/apps/{app.id}/icon",
        "current": version, "ios_state": None,
    }]
    icon = await api.get(f"/api/apps/{app.id}/icon")
    assert icon.status_code == 200
    assert icon.headers["content-type"] == "image/png"
    assert icon.headers["cache-control"] == "private, max-age=3600"
    assert icon.content == bucket.read(app.icon_key)

    # Committing the same upload twice is refused.
    r = await commit(api, upload_id)
    assert r.status_code == 409
    assert (await db.scalar(select(AppVersion.id).where(AppVersion.id != row.id))) is None


async def test_commit_rejects_duplicate_and_older_build(api, bucket, db, tmp_path):
    await apple_settings_filled(db)
    await publish(api, bucket, hello_ipa(tmp_path / "a", version="1.4", build="2"))

    same = await start_upload(api, bucket, hello_ipa(tmp_path / "b", version="1.4", build="2"))
    review = await inspect(api, same)
    assert review["app"]["exists"] is True
    assert review["problems"] == ["1.4 (2) is already uploaded."]
    r = await commit(api, same)
    assert r.status_code == 409
    assert r.json()["detail"]["problems"] == ["1.4 (2) is already uploaded."]

    older = await start_upload(api, bucket, hello_ipa(tmp_path / "c", version="1.3", build="1"))
    assert (await inspect(api, older))["problems"] == ["Build 1 isn't newer than 1.4 (2)."]
    assert (await commit(api, older)).status_code == 409

    # The check runs again at commit: a newer build committed meanwhile wins.
    newer = await start_upload(api, bucket, hello_ipa(tmp_path / "d", version="1.5", build="3"))
    newest = await start_upload(api, bucket, hello_ipa(tmp_path / "e", version="1.6", build="4"))
    assert (await inspect(api, newer))["problems"] == []
    assert (await inspect(api, newest))["problems"] == []
    assert (await commit(api, newest)).status_code == 201
    r = await commit(api, newer)
    assert r.status_code == 409
    assert r.json()["detail"]["problems"] == ["Build 3 isn't newer than 1.6 (4)."]
    versions = (await db.scalars(select(AppVersion.build))).all()
    assert sorted(versions) == ["2", "4"]


async def test_inspect_rejects_new_signing_key(api, bucket):
    await publish(api, bucket, HELLO_A)
    upload_id = await start_upload(api, bucket, HELLO_A2)
    review = await inspect(api, upload_id)
    assert review["signing_digest"] == KEY_B_DIGEST
    assert review["problems"] == [(
        f"This APK is signed with a different key ({KEY_B_DIGEST[:12]}…) than earlier "
        f"versions ({KEY_A_DIGEST[:12]}…). Phones would refuse it as an update.")]
    assert (await commit(api, upload_id)).status_code == 409


async def test_ios_upload_refused_when_not_owner(api, bucket, db, tmp_path, ios_owner_url):
    ipa = hello_ipa(tmp_path)
    upload_id = await start_upload(api, bucket, ipa)
    review = await inspect(api, upload_id)
    assert review["app"] == {"exists": False, "name": "Hello Display", "platform": "ios",
                             "identifier": "com.example.hello"}
    assert review["min_os"] == "16.0"
    assert review["problems"] == ["Apple settings aren't set up yet."]

    # A row without the certificate is still "not set up".
    db.add(AppleSettings(id=1, team_id="TEAM123456"))
    await db.commit()
    ios_owner_url("https://devices.example.test")
    review = await inspect(api, upload_id)
    assert review["problems"] == ["iPhone installs are set up on https://devices.example.test."]
    r = await commit(api, upload_id)
    assert r.status_code == 409
    assert r.json()["detail"]["problems"] == review["problems"]
    assert (await db.scalars(select(App))).all() == []


async def test_ios_commit_enqueues_bundle_then_sign(api, bucket, db, tmp_path, monkeypatch):
    await apple_settings_filled(db)
    queued = []
    monkeypatch.setattr(catalog, "enqueue",
                        lambda session, kind, payload: queued.append((kind, payload)))
    saved = await publish(api, bucket, hello_ipa(tmp_path))
    assert queued == [("ensure_bundle", {"app_id": saved["app_id"]}),
                      ("sign_build", {"version_id": saved["version"]["id"]})]
    app = await db.get(App, uuid.UUID(saved["app_id"]))
    assert app.signing_digest is None
    assert bucket.read(app.icon_key).startswith(b"\x89PNG")

    queued.clear()
    await publish(api, bucket, HELLO_A)
    assert queued == []   # Android needs no worker


async def test_ios_upload_after_a_missing_capability_gets_a_fresh_profile(
        api, bucket, db, tmp_path, monkeypatch):
    """Ruling R19: the fix for a capability the App ID lacked is turning it on
    and uploading again, and only a new profile carries it: the upload
    rebuilds the profiles (which re-sign the new version) instead of
    signing with the old one."""
    await apple_settings_filled(db)
    first = await publish(api, bucket, hello_ipa(tmp_path / "a", version="1.4", build="2"))
    app_id = uuid.UUID(first["app_id"])
    db.add(IosProfile(app_id=app_id, asc_profile_id="PROF1", uuid="PROFILE-UUID-1",
                      content=b"profile", expires_at=dt.datetime(2027, 1, 1, tzinfo=dt.UTC),
                      device_ids=[]))
    db.add(SignedBuild(version_id=uuid.UUID(first["version"]["id"]),
                       profile_uuid="PROFILE-UUID-1", status="failed", permanent=True,
                       error="This app needs aps-environment, …"))
    await db.commit()

    queued = []
    monkeypatch.setattr(catalog, "enqueue",
                        lambda session, kind, payload: queued.append((kind, payload)))
    await publish(api, bucket, hello_ipa(tmp_path / "b", version="1.5", build="3"))
    assert queued == [("ensure_bundle", {"app_id": str(app_id)}), ("rebuild_profiles", {})]

    # Once a new profile is in place, uploads sign as usual again.
    await db.execute(update(IosProfile).values(uuid="PROFILE-UUID-2"))
    await db.commit()
    queued.clear()
    third = await publish(api, bucket, hello_ipa(tmp_path / "c", version="1.6", build="4"))
    assert queued == [("ensure_bundle", {"app_id": str(app_id)}),
                      ("sign_build", {"version_id": third["version"]["id"]})]


async def test_read_only_blocks_commit(api, main_fake, bucket, db):
    upload_id = await start_upload(api, bucket, HELLO_A)
    assert (await inspect(api, upload_id))["problems"] == []
    main_fake.as_admin(read_only=True, read_only_message="Back at 18:00.")
    r = await commit(api, upload_id)
    assert r.status_code == 423
    assert r.json()["detail"] == {"code": "read_only_mode", "message": "Back at 18:00."}
    assert (await db.scalars(select(App))).all() == []
    assert (await api.get("/api/apps")).status_code == 200


async def test_stale_uploads_are_purged(api, bucket, db):
    stale = await start_upload(api, bucket, HELLO_A)
    await inspect(api, stale)   # also stores the icon under uploads/<id>/
    fresh = await start_upload(api, bucket, HELLO_A)
    done = await start_upload(api, bucket, HELLO_A2)
    await inspect(api, done)
    assert (await commit(api, done)).status_code == 201
    old = dt.datetime.now(dt.UTC) - dt.timedelta(hours=25)
    await db.execute(update(Upload).where(Upload.id.in_(
        [uuid.UUID(stale), uuid.UUID(done)])).values(created_at=old))
    await db.commit()
    assert any(k.startswith(f"uploads/{stale}/") for k in bucket.object_keys())

    await start_upload(api, bucket, HELLO_A2)

    db.expire_all()
    ids = {str(i) for i in (await db.scalars(select(Upload.id))).all()}
    assert stale not in ids
    assert {fresh, done} <= ids
    assert not any(k.startswith(f"uploads/{stale}/") for k in bucket.object_keys())
    assert any(k.startswith(f"uploads/{fresh}/") for k in bucket.object_keys())


async def test_commit_stores_the_inspected_bytes_even_if_reuploaded(api, bucket, db):
    """The presigned PUT stays valid after inspection: a second PUT must never
    become the version."""
    import hashlib

    upload_id = await start_upload(api, bucket, HELLO_A)
    presigned_key = bucket.presigned[-1][0]
    assert (await inspect(api, upload_id))["problems"] == []
    inspected_key = (await db.get(Upload, uuid.UUID(upload_id))).inspected["inspected_key"]
    assert inspected_key.startswith(f"uploads/{upload_id}/inspected/")
    assert inspected_key.endswith("/hello-a.apk")
    assert bucket.read(inspected_key) == HELLO_A.read_bytes()
    assert not bucket.exists(presigned_key)   # the client-writable copy is gone

    bucket.put(presigned_key, b"swapped after review" * 100)
    r = await commit(api, upload_id)
    assert r.status_code == 201, r.text
    row = await db.get(AppVersion, uuid.UUID(r.json()["version"]["id"]))
    assert row.sha256 == hashlib.sha256(HELLO_A.read_bytes()).hexdigest()
    assert row.size == HELLO_A.stat().st_size
    assert bucket.read(row.file_key) == HELLO_A.read_bytes()
    assert not any(k.startswith("uploads/") for k in bucket.object_keys())


async def _review(db, upload_id: str) -> dict:
    db.expire_all()
    return (await db.get(Upload, uuid.UUID(upload_id))).inspected


async def test_reinspect_deletes_superseded_inspected_object(api, bucket, db):
    upload_id = await start_upload(api, bucket, HELLO_A)
    presigned_key = bucket.presigned[-1][0]
    await inspect(api, upload_id)
    first = await _review(db, upload_id)
    assert bucket.read(first["inspected_key"]) == HELLO_A.read_bytes()
    assert bucket.exists(first["icon_key"])

    # A new PUT is what gets checked again.
    bucket.put(presigned_key, HELLO_A2.read_bytes())
    review = await inspect(api, upload_id)
    assert review["version_name"] == "1.1"
    second = await _review(db, upload_id)
    assert second["inspected_key"] != first["inspected_key"]
    assert second["icon_key"] != first["icon_key"]
    assert bucket.read(second["inspected_key"]) == HELLO_A2.read_bytes()
    assert not bucket.exists(first["inspected_key"])
    assert not bucket.exists(first["icon_key"])
    assert {k for k in bucket.object_keys() if k.startswith("uploads/")} == {
        second["inspected_key"], second["icon_key"]}

    # With no new PUT, checking again reads the kept copy.
    review = await inspect(api, upload_id)
    assert review["version_name"] == "1.1"
    third = await _review(db, upload_id)
    assert bucket.read(third["inspected_key"]) == HELLO_A2.read_bytes()
    assert not bucket.exists(second["inspected_key"])


async def test_inspect_and_commit_interleaved_store_the_reviewed_bytes(api, bucket, db,
                                                                       monkeypatch):
    """A second inspection that runs while commit is copying must not change
    what commit stores, nor the committed upload's review."""
    import asyncio
    import hashlib

    from serversherpa_devices.services import storage

    upload_id = await start_upload(api, bucket, HELLO_A)
    presigned_key = bucket.presigned[-1][0]
    await inspect(api, upload_id)
    reviewed = await _review(db, upload_id)
    bucket.put(presigned_key, HELLO_A2.read_bytes())   # the PUT URL is still valid

    second_copy_written = asyncio.Event()
    second: dict = {}
    real_copy, real_upload = bucket.copy_object, bucket.upload_from

    async def upload_spy(path, key, content_type):
        await real_upload(path, key, content_type)
        if "/inspected/" in key and key != reviewed["inspected_key"]:
            second_copy_written.set()

    async def copy_spy(source_key, key):
        if "task" not in second:   # commit's first copy: let inspect #2 run first
            second["task"] = asyncio.create_task(
                api.post(f"/api/uploads/{upload_id}/inspect"))
            await asyncio.wait_for(second_copy_written.wait(), 30)
        await real_copy(source_key, key)

    monkeypatch.setattr(storage, "upload_from", upload_spy)
    monkeypatch.setattr(storage, "copy_object", copy_spy)
    r = await commit(api, upload_id)
    assert r.status_code == 201, r.text
    late = await second["task"]
    assert late.status_code == 409
    assert late.json()["detail"]["message"] == "This file was already saved."

    row = await db.get(AppVersion, uuid.UUID(r.json()["version"]["id"]))
    stored = bucket.read(row.file_key)
    assert hashlib.sha256(stored).hexdigest() == row.sha256 == reviewed["sha256"]
    assert stored == HELLO_A.read_bytes()
    assert (row.version_name, row.build) == ("1.0", "1")
    assert (await _review(db, upload_id))["sha256"] == reviewed["sha256"]
    # The late inspection's objects don't linger.
    assert not any(k.startswith("uploads/") for k in bucket.object_keys()), \
        bucket.object_keys()


async def test_commit_refuses_a_missing_or_changed_inspected_copy(api, bucket, db):
    upload_id = await start_upload(api, bucket, HELLO_A)
    await inspect(api, upload_id)
    key = (await _review(db, upload_id))["inspected_key"]

    bucket.put(key, b"shorter")
    r = await commit(api, upload_id)
    assert r.status_code == 409
    assert r.json()["detail"]["message"] == "Check the file again before saving it."
    assert not any(k.startswith("apps/") for k in bucket.object_keys())

    await bucket.delete_object(key)
    r = await commit(api, upload_id)
    assert r.status_code == 409
    assert r.json()["detail"]["message"] == "Check the file again before saving it."
    assert (await db.scalars(select(App))).all() == []
