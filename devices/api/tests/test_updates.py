"""GET /api/updates: the kiosk apps' update check."""

import uuid

import pytest
from httpx import ASGITransport, AsyncClient

from serversherpa_devices.config import get_settings
from serversherpa_devices.db.models import App
from serversherpa_devices.services.links import read_install_token

from .catalog_support import HELLO_A, KEY_A_DIGEST, KEY_B_DIGEST
from .install_support import (
    PUBLIC_URL,
    add_ios_version,
    add_profile,
    add_signed,
    anon_client,
    local,
    manifest_url,
    seed_android,
    sign_jobs,
)
from .worker_support import seed_apple


@pytest.fixture
def ios_owner_url(monkeypatch):
    """Set DEVICES_IOS_OWNER_URL for one test."""
    def set_url(url: str) -> None:
        monkeypatch.setenv("DEVICES_IOS_OWNER_URL", url)
        get_settings.cache_clear()

    yield set_url
    monkeypatch.setenv("DEVICES_IOS_OWNER_URL", "")   # what conftest set
    get_settings.cache_clear()


def android_query(version_code: int, digest: str = KEY_A_DIGEST,
                  package: str = "com.example.hello") -> dict:
    return {"platform": "android", "package": package, "version_code": version_code,
            "signing_digest": digest}


def ios_query(build: str, profile_kind: str = "adhoc") -> dict:
    return {"platform": "ios", "bundle_id": "com.example.hello", "build": build,
            "profile_kind": profile_kind}


async def _ios_app(db, bucket) -> tuple[App, object]:
    app = App(id=uuid.uuid4(), platform="ios", identifier="com.example.hello", name="Hello",
              asc_bundle_id="BUNDLE1")
    db.add(app)
    await db.commit()
    version = await add_ios_version(db, bucket, app, version_name="1.4", build="2", current=True)
    return app, version


async def test_updates_android_available(api, main_fake, devices_app, bucket, db):
    _, versions = await seed_android(db, bucket, versions=(("1.0", 1), ("1.2", 3)),
                                     notes="Faster scans")
    main_fake.as_kiosk()
    r = await api.get("/api/updates", params=android_query(1))
    assert r.status_code == 200, r.text
    body = r.json()
    url = body.pop("install_url")
    assert body == {"status": "available", "version_name": "1.2", "build": "3",
                    "notes": "Faster scans", "size": HELLO_A.stat().st_size}
    assert url.startswith(f"{PUBLIC_URL}/dl/") and url.endswith("/Hello_Fixture-1.2.apk")
    assert read_install_token(url.split("/")[-2], kind="apk") == versions[1].id

    async with anon_client(devices_app) as anon:
        download = await anon.get(local(url))
    assert download.status_code == 200
    assert download.content == HELLO_A.read_bytes()

    # The digest as Android prints it (upper case, colon pairs) matches too.
    colons = ":".join(KEY_A_DIGEST[i:i + 2] for i in range(0, 64, 2)).upper()
    r = await api.get("/api/updates", params=android_query(1, digest=colons))
    assert r.json()["status"] == "available"


async def test_updates_android_up_to_date_never_downgrades(api, main_fake, bucket, db):
    # 1.3 (3) was rolled back: 1.2 (2) is current.
    await seed_android(db, bucket, versions=(("1.2", 2), ("1.3", 3)), current=0)
    main_fake.as_kiosk()
    for installed in (2, 3, 40):
        r = await api.get("/api/updates", params=android_query(installed))
        assert r.status_code == 200
        assert r.json() == {"status": "up_to_date"}, installed
    r = await api.get("/api/updates", params=android_query(1))
    assert (r.json()["status"], r.json()["build"]) == ("available", "2")
    r = await api.get("/api/updates", params=android_query(1, package="com.example.unknown"))
    assert r.json() == {"status": "up_to_date"}
    # A digest mismatch on an up-to-date phone is still up to date.
    r = await api.get("/api/updates", params=android_query(2, digest=KEY_B_DIGEST))
    assert r.json() == {"status": "up_to_date"}


async def test_updates_android_digest_mismatch(api, main_fake, bucket, db):
    await seed_android(db, bucket, versions=(("1.0", 1), ("1.2", 3)))
    main_fake.as_kiosk()
    for digest in (KEY_B_DIGEST, ""):
        r = await api.get("/api/updates", params=android_query(1, digest=digest))
        assert r.status_code == 200
        assert r.json() == {
            "status": "reinstall_required",
            "message": "This copy came from Google Play. Uninstall it and install from "
                       "https://devices.test once to get updates."}


async def test_updates_ios_development_profile_register_first(api, main_fake, bucket, db):
    await seed_apple(db)
    app, version = await _ios_app(db, bucket)
    main_fake.as_kiosk()
    for kind in ("development", "none"):
        r = await api.get("/api/updates", params=ios_query("1", profile_kind=kind))
        assert r.status_code == 200
        assert r.json() == {"status": "register_first",
                            "message": "Add this device on https://devices.test first."}
    # Up to date wins over registration.
    r = await api.get("/api/updates", params=ios_query("2", profile_kind="development"))
    assert r.json() == {"status": "up_to_date"}

    # Ad Hoc: preparing until the current version is signed with the profile.
    r = await api.get("/api/updates", params=ios_query("1"))
    assert r.json()["status"] == "preparing"
    await add_profile(db, app, [uuid.uuid4()])
    r = await api.get("/api/updates", params=ios_query("1"))
    assert r.json()["status"] == "preparing"
    assert [j.payload for j in await sign_jobs(db)] == [{"version_id": str(version.id)}]
    signed = await add_signed(db, bucket, version)
    r = await api.get("/api/updates", params=ios_query("1"))
    body = r.json()
    url = body.pop("install_url")
    assert body == {"status": "available", "version_name": "1.4", "build": "2", "notes": "",
                    "size": version.size}
    token = manifest_url(url).split("/")[-2]
    assert read_install_token(token, kind="manifest") == signed.id
    assert (await api.get("/api/updates", params=ios_query("1.0.5"))).json()["status"] \
        == "available"
    assert (await api.get("/api/updates", params=ios_query("2.0.1"))).json() \
        == {"status": "up_to_date"}
    assert (await api.get("/api/updates", params=ios_query("not a build"))).status_code == 422


async def test_updates_ios_not_owner(api, main_fake, bucket, db, ios_owner_url):
    await _ios_app(db, bucket)
    main_fake.as_kiosk()
    r = await api.get("/api/updates", params=ios_query("1"))
    assert r.status_code == 200
    assert r.json() == {"status": "not_set_up", "message": "Apple settings aren't set up yet."}
    ios_owner_url("https://devices.example.test")
    r = await api.get("/api/updates", params=ios_query("1"))
    assert r.json() == {"status": "not_set_up",
                        "message": "iOS installs are set up on https://devices.example.test."}


async def test_updates_requires_session(api, main_fake, devices_app, bucket, db):
    await seed_android(db, bucket)
    async with AsyncClient(transport=ASGITransport(app=devices_app),
                           base_url="http://testserver") as anon:
        r = await anon.get("/api/updates", params=android_query(0))
    assert r.status_code == 401
    main_fake.revoked()
    assert (await api.get("/api/updates", params=android_query(0))).status_code == 401
    main_fake.as_staff(actions=[])                  # a portal session without view
    r = await api.get("/api/updates", params=android_query(0))
    assert r.status_code == 403
    main_fake.as_kiosk()
    bad = {"platform": "android", "package": "com.example.hello"}   # no version_code
    assert (await api.get("/api/updates", params=bad)).status_code == 422
    assert (await api.get("/api/updates", params={"platform": "windows"})).status_code == 422


async def test_portal_staff_can_call_updates(api, main_fake, bucket, db):
    await seed_android(db, bucket, versions=(("1.0", 1), ("1.2", 3)))
    main_fake.as_staff()
    r = await api.get("/api/updates", params=android_query(1))
    assert r.status_code == 200
    assert r.json()["status"] == "available"
