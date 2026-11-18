"""Install links: POST /api/apps/{id}/install, the APK download, the iOS OTA
manifest, icons and IPA, and the per-iPhone install state on GET /api/apps."""

import datetime as dt
import io
import plistlib
import uuid

from PIL import Image
from sqlalchemy import update

from serversherpa_devices.db.models import App, AppVersion, IosDevice, Job, SignedBuild
from serversherpa_devices.services.links import make_install_token, read_install_token

from .catalog_support import HELLO_A
from .install_support import (
    PUBLIC_URL,
    add_icon,
    add_ios_version,
    add_profile,
    add_signed,
    anon_client,
    local,
    manifest_url,
    seed_android,
    sign_jobs,
)
from .worker_support import UDID_A, seed_apple, seed_device

APK_TYPE = "application/vnd.android.package-archive"


async def _ios_app(db, bucket):
    """Apple settings, an iOS app "Hello" with 1.4 (2) current."""
    await seed_apple(db)
    app = App(id=uuid.uuid4(), platform="ios", identifier="com.example.hello", name="Hello",
              asc_bundle_id="BUNDLE1")
    db.add(app)
    await db.commit()
    version = await add_ios_version(db, bucket, app, version_name="1.4", build="2", current=True)
    return app, version


def _ios_state(listed: list[dict], app) -> dict:
    return next(a for a in listed if a["id"] == str(app.id))["ios_state"]


async def test_android_install_link_streams_apk_with_headers(api, main_fake, devices_app,
                                                             bucket, db):
    app, (version,) = await seed_android(db, bucket)
    main_fake.as_staff()
    r = await api.post(f"/api/apps/{app.id}/install", json={})
    assert r.status_code == 200, r.text
    url = r.json()["url"]
    assert url.startswith(f"{PUBLIC_URL}/dl/")
    assert url.endswith("/Hello_Fixture-1.0.apk")
    token = url.split("/")[-2]
    assert read_install_token(token, kind="apk") == version.id

    calls = main_fake.authorize_route.call_count
    async with anon_client(devices_app) as anon:
        r = await anon.get(local(url))
    assert main_fake.authorize_route.call_count == calls     # no session asked for
    assert r.status_code == 200
    data = HELLO_A.read_bytes()
    assert r.content == data
    assert r.headers["content-type"] == APK_TYPE
    assert r.headers["content-disposition"] == 'attachment; filename="Hello_Fixture-1.0.apk"'
    assert r.headers["content-length"] == str(len(data))

    # An older version by id; a version of another app is not found.
    assert (await api.post(f"/api/apps/{app.id}/install",
                           json={"version_id": str(version.id)})).status_code == 200
    _, (other_version,) = await seed_android(db, bucket, identifier="com.example.other")
    r = await api.post(f"/api/apps/{app.id}/install", json={"version_id": str(other_version.id)})
    assert r.status_code == 404
    assert (await api.post(f"/api/apps/{uuid.uuid4()}/install", json={})).status_code == 404

    # Kiosk sessions only get links from /api/updates.
    main_fake.as_kiosk()
    assert (await api.post(f"/api/apps/{app.id}/install", json={})).status_code == 403


async def test_install_token_expired_410(devices_app, bucket, db):
    _, (version,) = await seed_android(db, bucket)
    expired = make_install_token(kind="apk", ref=version.id, ttl_seconds=-1)
    wrong_kind = make_install_token(kind="manifest", ref=version.id)
    async with anon_client(devices_app) as anon:
        for token in (expired, wrong_kind, "not-a-token"):
            r = await anon.get(f"/dl/{token}/Hello_Fixture-1.0.apk")
            assert r.status_code == 410, token
            assert "expired" in r.text
        old_manifest = make_install_token(kind="manifest", ref=uuid.uuid4(), ttl_seconds=-1)
        assert (await anon.get(f"/ota/{old_manifest}/manifest.plist")).status_code == 410
        assert (await anon.get(f"/ota/{old_manifest}/icon-57.png")).status_code == 410
        old_ipa = make_install_token(kind="ipa", ref=uuid.uuid4(), ttl_seconds=-1)
        assert (await anon.get(f"/ota/{old_ipa}/app.ipa")).status_code == 410
        # A manifest token doesn't open the IPA.
        manifest = make_install_token(kind="manifest", ref=uuid.uuid4())
        assert (await anon.get(f"/ota/{manifest}/app.ipa")).status_code == 410

        # A good token for a version deleted since, or one that never existed.
        good = make_install_token(kind="apk", ref=version.id)
        assert (await anon.get(f"/dl/{good}/x.apk")).status_code == 200
        await db.execute(update(AppVersion).where(AppVersion.id == version.id)
                         .values(deleted_at=dt.datetime.now(dt.UTC)))
        await db.commit()
        assert (await anon.get(f"/dl/{good}/x.apk")).status_code == 404
        unknown = make_install_token(kind="apk", ref=uuid.uuid4())
        assert (await anon.get(f"/dl/{unknown}/x.apk")).status_code == 404


async def test_ios_states_walk(api, bucket, db):
    app = App(id=uuid.uuid4(), platform="ios", identifier="com.example.hello", name="Hello",
              asc_bundle_id="BUNDLE1")
    db.add(app)
    await db.commit()
    version = await add_ios_version(db, bucket, app, version_name="1.4", build="2", current=True)
    android, _ = await seed_android(db, bucket)

    # Not the iOS stack.
    listed = (await api.get("/api/apps")).json()
    assert _ios_state(listed, app) == {"state": "not_set_up",
                                       "message": "Apple settings aren't set up yet."}
    assert _ios_state(listed, android) is None
    await seed_apple(db)

    unregistered = {"state": "register_first", "message": "This iPhone isn't registered."}
    for ref in (None, str(uuid.uuid4()), "junk"):
        params = {} if ref is None else {"device_ref": ref}
        r = await api.get("/api/apps", params=params)
        assert r.status_code == 200
        assert _ios_state(r.json(), app) == unregistered
        assert _ios_state(r.json(), android) is None

    device = await seed_device(db, UDID_A)
    ref = {"device_ref": str(device.id)}

    async def state() -> dict:
        r = await api.get("/api/apps", params=ref)
        assert r.status_code == 200
        return _ios_state(r.json(), app)

    async def set_device(**values) -> None:
        await db.execute(update(IosDevice).where(IosDevice.id == device.id).values(**values))
        await db.commit()

    assert await state() == {"state": "registering",
                             "message": "Registering this iPhone with Apple…"}
    await set_device(status="failed", error="Apple refused this iPhone: bad UDID")
    assert await state() == {"state": "failed",
                             "message": "Apple refused this iPhone: bad UDID"}
    await set_device(status="disabled", error=None)
    assert await state() == {"state": "disabled",
                             "message": "This iPhone was removed from Devices."}

    preparing = {"state": "preparing", "message": "Preparing the app for this iPhone…"}
    await set_device(status="registered", asc_device_id="ASCDEV1")
    # Registered, but the app has no profile yet: the rebuild will sign it.
    assert await state() == preparing
    assert await sign_jobs(db) == []
    # A profile made before this iPhone was registered doesn't hold it.
    profile = await add_profile(db, app, [uuid.uuid4()])
    assert await state() == preparing
    assert await sign_jobs(db) == []

    await db.execute(update(type(profile)).where(type(profile).id == profile.id)
                     .values(device_ids=[device.id]))
    await db.commit()
    assert await state() == preparing
    jobs = await sign_jobs(db)
    assert [(j.payload, j.status) for j in jobs] == [({"version_id": str(version.id)}, "queued")]
    assert await state() == preparing                 # queued already: not queued again
    assert len(await sign_jobs(db)) == 1

    # The worker failed it: the next look queues another try.
    await db.execute(update(Job).values(status="failed"))
    await db.commit()
    signed = await add_signed(db, bucket, version, status="failed")
    assert await state() == preparing
    assert [j.status for j in await sign_jobs(db)] == ["failed", "queued"]

    await db.execute(update(SignedBuild).where(SignedBuild.id == signed.id).values(
        status="ready", error=None,
        file_key=f"apps/{app.id}/{version.id}/signed/PROFILE-UUID-1.ipa"))
    await db.commit()
    ready = await state()
    assert (ready["state"], ready["message"]) == ("ready", "")
    url = manifest_url(ready["install_url"])
    assert url.startswith(f"{PUBLIC_URL}/ota/") and url.endswith("/manifest.plist")
    assert read_install_token(url.split("/")[-2], kind="manifest") == signed.id


async def test_manifest_plist_fields(api, devices_app, bucket, db):
    app, version = await _ios_app(db, bucket)
    await add_icon(db, bucket, app)
    device = await seed_device(db, UDID_A, status="registered", asc_device_id="ASCDEV1")
    await add_profile(db, app, [device.id])
    signed = await add_signed(db, bucket, version)

    r = await api.post(f"/api/apps/{app.id}/install", json={"device_ref": str(device.id)})
    assert r.status_code == 200, r.text
    url = manifest_url(r.json()["url"])
    manifest_token = url.split("/")[-2]

    async with anon_client(devices_app) as anon:
        r = await anon.get(local(url))
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/xml")
        plist = plistlib.loads(r.content)
        (item,) = plist["items"]
        assets = {a["kind"]: a["url"] for a in item["assets"]}
        assert set(assets) == {"software-package", "display-image", "full-size-image"}
        ipa_url = assets["software-package"]
        assert ipa_url.startswith(f"{PUBLIC_URL}/ota/") and ipa_url.endswith("/app.ipa")
        assert read_install_token(ipa_url.split("/")[-2], kind="ipa") == signed.id
        assert assets["display-image"] == f"{PUBLIC_URL}/ota/{manifest_token}/icon-57.png"
        assert assets["full-size-image"] == f"{PUBLIC_URL}/ota/{manifest_token}/icon-512.png"
        assert item["metadata"] == {"bundle-identifier": "com.example.hello",
                                    "bundle-version": "1.4", "kind": "software",
                                    "title": "Hello"}

        for name, size in (("display-image", 57), ("full-size-image", 512)):
            icon = await anon.get(local(assets[name]))
            assert icon.status_code == 200
            assert icon.headers["content-type"] == "image/png"
            assert Image.open(io.BytesIO(icon.content)).size == (size, size)


async def test_ipa_stream_uses_signed_build(api, devices_app, bucket, db):
    app, version = await _ios_app(db, bucket)
    device = await seed_device(db, UDID_A, status="registered", asc_device_id="ASCDEV1")
    await add_profile(db, app, [device.id])
    signed = await add_signed(db, bucket, version, data=b"re-signed for this team")

    ipa = make_install_token(kind="ipa", ref=signed.id)
    async with anon_client(devices_app) as anon:
        r = await anon.get(f"/ota/{ipa}/app.ipa")
        assert r.status_code == 200
        assert r.content == b"re-signed for this team"     # never the uploaded original
        assert r.headers["content-type"] == "application/octet-stream"
        assert r.headers["content-length"] == str(len(b"re-signed for this team"))

        # A signed build that isn't ready (re-signing again) isn't served.
        await db.execute(update(SignedBuild).where(SignedBuild.id == signed.id)
                         .values(status="running"))
        await db.commit()
        assert (await anon.get(f"/ota/{ipa}/app.ipa")).status_code == 404
        manifest = make_install_token(kind="manifest", ref=signed.id)
        assert (await anon.get(f"/ota/{manifest}/manifest.plist")).status_code == 404


async def test_older_version_install_enqueues_sign(api, bucket, db):
    app, current = await _ios_app(db, bucket)
    older = await add_ios_version(db, bucket, app, version_name="1.3", build="1")
    device = await seed_device(db, UDID_A, status="registered", asc_device_id="ASCDEV1")
    await add_profile(db, app, [device.id])
    await add_signed(db, bucket, current)
    body = {"version_id": str(older.id), "device_ref": str(device.id)}

    r = await api.post(f"/api/apps/{app.id}/install", json=body)
    assert r.status_code == 202, r.text
    assert r.json() == {"state": "preparing", "message": "Preparing the app for this iPhone…"}
    assert [j.payload for j in await sign_jobs(db)] == [{"version_id": str(older.id)}]
    assert (await api.post(f"/api/apps/{app.id}/install", json=body)).status_code == 202
    assert len(await sign_jobs(db)) == 1

    signed = await add_signed(db, bucket, older, data=b"older, re-signed")
    r = await api.post(f"/api/apps/{app.id}/install", json=body)
    assert r.status_code == 200
    token = manifest_url(r.json()["url"]).split("/")[-2]
    assert read_install_token(token, kind="manifest") == signed.id

    # The current version is already signed; an unregistered iPhone can't install.
    assert (await api.post(f"/api/apps/{app.id}/install",
                           json={"device_ref": str(device.id)})).status_code == 200
    r = await api.post(f"/api/apps/{app.id}/install", json={"device_ref": str(uuid.uuid4())})
    assert r.status_code == 409
    assert r.json()["detail"] == {"code": "register_first",
                                  "message": "This iPhone isn't registered."}
