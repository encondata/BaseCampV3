"""The worker's jobs against a fake App Store Connect and a fake bucket:
registering and disabling iPhones, App IDs, Ad Hoc profile rebuilds, IPA
re-signing (resign.sign_app and resign.binary_entitlements are swapped out;
test_resign_integration.py runs the real rcodesign) and the device count
sync."""

import io
import plistlib
import uuid
import zipfile

import pytest
from sqlalchemy import select, update

from serversherpa_devices.db.engine import get_sessionmaker
from serversherpa_devices.db.models import (
    App,
    AppleDeviceCount,
    AppVersion,
    IosDevice,
    IosProfile,
    Job,
    SignedBuild,
)
from serversherpa_devices.signing import resign
from serversherpa_devices.worker.run import run_once

from .fake_asc import TEAM_ID, error
from .package_fixtures import make_provision
from .worker_support import (
    EXPIRES,
    P12,
    P12_PASSWORD,
    UDID_A,
    UDID_B,
    UDID_C,
    fresh,
    install_fake,
    jobs_of,
    queue,
    run_all,
    seed_apple,
    seed_device,
    seed_ios_app,
    signed_builds,
)

PROFILE_NAME = "ServerSherpa Devices · com.example.hello"
PROFILE_UUID = "6a1f0c3e-1111-4222-8333-944455556666"


@pytest.fixture
def fake(monkeypatch):
    return install_fake(monkeypatch)


@pytest.fixture
async def apple(db, fake):
    await seed_apple(db, cert_id=fake.cert_id)
    return fake


class Signer:
    """Stands in for rcodesign: records each call, and writes a signature
    file into the bundle so the uploaded IPA shows it was signed."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.fail: Exception | None = None
        self.binary: dict = {"get-task-allow": True, "aps-environment": "development",
                             "com.apple.security.application-groups": ["group.example"],
                             "keychain-access-groups": [f"{TEAM_ID}.com.example.hello"]}

    def sign_app(self, app_dir, *, p12, password, entitlements, extension_entitlements=None):
        profile = (app_dir / "embedded.mobileprovision").read_bytes()
        self.calls.append({"app_dir": app_dir, "p12": p12, "password": password,
                           "entitlements": entitlements,
                           "extensions": extension_entitlements, "profile": profile})
        if self.fail is not None:
            raise self.fail
        (app_dir / "_CodeSignature").mkdir(exist_ok=True)
        (app_dir / "_CodeSignature" / "CodeResources").write_bytes(b"signed")

    def binary_entitlements(self, macho):
        return dict(self.binary)


@pytest.fixture
def signer(monkeypatch):
    found = Signer()
    monkeypatch.setattr(resign, "sign_app", found.sign_app)
    monkeypatch.setattr(resign, "binary_entitlements", found.binary_entitlements)
    return found


def _posts(fake, kind: str) -> list:
    return [c for c in fake.calls if c.method == "POST" and c.url.path == f"/v1/{kind}"]


# Registering iPhones.

async def test_register_new_device_then_rebuild_enqueued(db, apple):
    device = await seed_device(db, UDID_A, name="Pat's iPhone")
    await queue("register_device", {"device_id": str(device.id)})

    assert await run_once(get_sessionmaker())
    saved = await fresh(IosDevice, device.id)
    (asc_id,) = apple.devices
    assert apple.devices[asc_id]["udid"] == UDID_A
    assert apple.devices[asc_id]["name"] == "Pat's iPhone"
    assert (saved.status, saved.asc_device_id, saved.device_class, saved.error) == (
        "registered", asc_id, "IPHONE", None)
    register, rebuild = await jobs_of()
    assert (register.status, register.result) == ("done", {"asc_device_id": asc_id})
    assert (rebuild.kind, rebuild.status, rebuild.payload) == ("rebuild_profiles", "queued", {})


async def test_register_existing_apple_device_skips_post(db, apple):
    asc_id = apple.add_device(UDID_A, status="DISABLED", device_class="IPHONE")
    device = await seed_device(db, UDID_A)
    await queue("register_device", {"device_id": str(device.id)})

    assert await run_once(get_sessionmaker())
    assert _posts(apple, "devices") == []
    assert apple.devices[asc_id]["status"] == "ENABLED"   # re-enabled, not added again
    saved = await fresh(IosDevice, device.id)
    assert (saved.status, saved.asc_device_id) == ("registered", asc_id)
    assert [j.kind for j in await jobs_of()] == ["register_device", "rebuild_profiles"]

    # Already enabled: no change at Apple at all.
    await queue("register_device", {"device_id": str(device.id)})
    calls = len(apple.calls)
    await run_all()   # the rebuild (no apps: no calls), then the register
    assert [(c.method, c.url.path) for c in apple.calls[calls:]] == [("GET", "/v1/devices")]


async def test_register_conflict_marks_failed_with_reason(db, apple):
    detail = "An invalid value '0000' was provided for the parameter 'udid'."
    apple._post_devices = lambda request, item, body: error(
        409, "ENTITY_ERROR.ATTRIBUTE.INVALID", detail)
    device = await seed_device(db, UDID_A)
    await queue("register_device", {"device_id": str(device.id)})

    assert await run_once(get_sessionmaker())
    saved = await fresh(IosDevice, device.id)
    assert saved.status == "failed"
    assert saved.error == f"Apple refused this iPhone: {detail}"
    (job,) = await jobs_of()
    assert (job.status, job.attempts) == ("failed", 1)   # a 409 is never retried
    assert not await run_once(get_sessionmaker())


async def test_register_other_apple_error_is_retried(db, apple):
    apple.refuse("This key can't use this API.")
    device = await seed_device(db, UDID_A)
    await queue("register_device", {"device_id": str(device.id)})

    assert await run_once(get_sessionmaker())
    saved = await fresh(IosDevice, device.id)
    assert saved.error == "Apple refused this iPhone: This key can't use this API."
    (job,) = await jobs_of()
    assert (job.status, job.attempts) == ("queued", 1)


async def test_register_skips_a_device_disabled_since(db, apple):
    device = await seed_device(db, UDID_A, status="disabled")
    await queue("register_device", {"device_id": str(device.id)})
    assert await run_once(get_sessionmaker())
    assert apple.calls == []
    (job,) = await jobs_of()
    assert (job.status, job.result) == ("done", {"skipped": "disabled"})


async def test_register_without_apple_settings_fails_the_device(db, fake):
    device = await seed_device(db, UDID_A)
    await queue("register_device", {"device_id": str(device.id)})
    assert await run_once(get_sessionmaker())
    saved = await fresh(IosDevice, device.id)
    assert (saved.status, saved.error) == ("failed", "Apple settings aren't set up yet.")
    (job,) = await jobs_of()
    assert job.status == "failed"
    assert fake.calls == []


async def test_disable_device(db, apple):
    asc_id = apple.add_device(UDID_A)
    device = await seed_device(db, UDID_A, status="registered", asc_device_id=asc_id)
    await queue("disable_device", {"device_id": str(device.id)})

    assert await run_once(get_sessionmaker())
    assert apple.devices[asc_id]["status"] == "DISABLED"
    assert (await fresh(IosDevice, device.id)).status == "disabled"
    assert [j.kind for j in await jobs_of()] == ["disable_device", "rebuild_profiles"]


# App IDs.

async def test_ensure_bundle_creates_or_finds_the_app_id(db, apple, bucket, tmp_path):
    app, _ = await seed_ios_app(db, bucket, tmp_path, name="Hello: Crew")
    await queue("ensure_bundle", {"app_id": str(app.id)})
    assert await run_once(get_sessionmaker())
    (bundle_id,) = apple.bundle_ids
    assert apple.bundle_ids[bundle_id]["identifier"] == "com.example.hello"
    assert apple.bundle_ids[bundle_id]["name"] == "Hello Crew"
    assert (await fresh(App, app.id)).asc_bundle_id == bundle_id
    # The new app has no profile yet, so one is built.
    assert [j.kind for j in await jobs_of()] == ["ensure_bundle", "rebuild_profiles"]

    # An App ID Apple already has is found, not created again.
    other, _ = await seed_ios_app(db, bucket, tmp_path, identifier="com.example.other")
    existing = apple.add_bundle_id("com.example.other")
    await queue("ensure_bundle", {"app_id": str(other.id)})
    await run_once(get_sessionmaker())   # the queued rebuild ran first
    await run_once(get_sessionmaker())
    assert len(_posts(apple, "bundleIds")) == 1
    assert (await fresh(App, other.id)).asc_bundle_id == existing


# Ad Hoc profiles.

async def _hello_with_bundle(db, apple, bucket, tmp_path, **kwargs):
    bundle = apple.add_bundle_id("com.example.hello")
    return (*await seed_ios_app(db, bucket, tmp_path, asc_bundle_id=bundle, **kwargs), bundle)


async def test_rebuild_only_deletes_named_profiles(db, apple, bucket, tmp_path):
    app, version, bundle = await _hello_with_bundle(db, apple, bucket, tmp_path)
    xcode = apple.add_profile("Xcode Managed")
    longer = apple.add_profile(PROFILE_NAME + ".widget")    # Apple's filter would match it
    old = apple.add_profile(PROFILE_NAME)
    asc_id = apple.add_device(UDID_A)
    await seed_device(db, UDID_A, status="registered", asc_device_id=asc_id)
    await queue("rebuild_profiles", {})

    assert await run_once(get_sessionmaker())
    assert xcode in apple.profiles and longer in apple.profiles
    assert old not in apple.profiles
    (new_id,) = [p for p, attrs in apple.profiles.items()
                 if attrs["name"] == PROFILE_NAME]
    created = apple.profiles[new_id]
    assert created["relationships"] == {"bundleId": bundle, "certificates": [apple.cert_id],
                                        "devices": [asc_id]}

    async with get_sessionmaker()() as session:
        profile = await session.scalar(select(IosProfile).where(IosProfile.app_id == app.id))
    assert (profile.asc_profile_id, profile.uuid) == (new_id, created["uuid"])
    assert profile.expires_at == EXPIRES
    assert profile.content.startswith(b"0")   # DER
    rebuild, sign = await jobs_of()
    assert rebuild.result == {"apps": {str(app.id): "rebuilt"}}
    assert (sign.kind, sign.payload) == ("sign_build", {"version_id": str(version.id)})


async def test_rebuild_includes_all_registered_devices(db, apple, bucket, tmp_path):
    app, _, _ = await _hello_with_bundle(db, apple, bucket, tmp_path)
    ids = [apple.add_device(udid) for udid in (UDID_A, UDID_B, UDID_C)]
    a = await seed_device(db, UDID_A, status="registered", asc_device_id=ids[0])
    b = await seed_device(db, UDID_B, status="registered", asc_device_id=ids[1])
    await seed_device(db, UDID_C, status="disabled", asc_device_id=ids[2])
    await seed_device(db, "00008101-0000000000000000", status="pending")
    # Apps without an App ID or a current version are left alone.
    await seed_ios_app(db, bucket, tmp_path, identifier="com.example.noid")
    await seed_ios_app(db, bucket, tmp_path, identifier="com.example.old",
                       asc_bundle_id=apple.add_bundle_id("com.example.old"), current=False)
    await queue("rebuild_profiles", {})

    assert await run_once(get_sessionmaker())
    (created,) = apple.profiles.values()
    assert sorted(created["relationships"]["devices"]) == sorted(ids[:2])
    async with get_sessionmaker()() as session:
        (profile,) = (await session.scalars(select(IosProfile))).all()
    assert profile.app_id == app.id
    assert sorted(profile.device_ids) == sorted([a.id, b.id])

    # A device added later gets a fresh profile with everyone on it.
    first_uuid = profile.uuid
    async with get_sessionmaker()() as session:
        await session.execute(update(IosDevice).where(IosDevice.udid == UDID_C)
                              .values(status="registered"))
        await session.commit()
    await queue("rebuild_profiles", {})
    await run_all()
    (created,) = [p for p in apple.profiles.values() if p["name"] == PROFILE_NAME]
    assert sorted(created["relationships"]["devices"]) == sorted(ids)
    async with get_sessionmaker()() as session:
        (profile,) = (await session.scalars(select(IosProfile))).all()
    assert profile.uuid != first_uuid
    assert len(profile.device_ids) == 3


async def test_rebuild_with_no_registered_devices_makes_no_profile(db, apple, bucket, tmp_path):
    app, _, _ = await _hello_with_bundle(db, apple, bucket, tmp_path)
    old = apple.add_profile(PROFILE_NAME)
    db.add(IosProfile(app_id=app.id, asc_profile_id=old, uuid="old-uuid", content=b"x",
                      expires_at=EXPIRES, device_ids=[]))
    await db.commit()
    await seed_device(db, UDID_A, status="pending")
    await queue("rebuild_profiles", {})

    assert await run_once(get_sessionmaker())
    assert _posts(apple, "profiles") == []
    assert apple.profiles == {}
    async with get_sessionmaker()() as session:
        assert (await session.scalars(select(IosProfile))).all() == []
    (job,) = await jobs_of()
    assert (job.status, job.result) == ("done", {"apps": {str(app.id): "no_devices"}})


# Re-signing.

async def _ready_to_sign(db, apple, bucket, tmp_path):
    app, version, _ = await _hello_with_bundle(db, apple, bucket, tmp_path)
    content = make_provision(
        devices=[UDID_A], uuid=PROFILE_UUID, name=PROFILE_NAME,
        extra_entitlements={"aps-environment": "production"})
    db.add(IosProfile(app_id=app.id, asc_profile_id="PROF9999", uuid=PROFILE_UUID,
                      content=content, expires_at=EXPIRES, device_ids=[]))
    await db.commit()
    return app, version, content


async def test_sign_build_marks_ready_and_uploads(db, apple, bucket, tmp_path, signer):
    app, version, content = await _ready_to_sign(db, apple, bucket, tmp_path)
    await queue("sign_build", {"version_id": str(version.id)})

    assert await run_once(get_sessionmaker())
    (call,) = signer.calls
    assert call["app_dir"].name == "Hello.app"
    assert (call["p12"], call["password"]) == (P12, P12_PASSWORD)
    assert call["profile"] == content
    assert call["entitlements"] == {
        "get-task-allow": False,
        "application-identifier": f"{TEAM_ID}.com.example.hello",
        "com.apple.developer.team-identifier": TEAM_ID,
        "aps-environment": "production",
        "keychain-access-groups": [f"{TEAM_ID}.com.example.hello"],
    }
    assert call["extensions"] == {}

    (row,) = await signed_builds()
    key = f"apps/{app.id}/{version.id}/signed/{PROFILE_UUID}.ipa"
    assert (row.version_id, row.profile_uuid, row.status, row.file_key, row.error) == (
        version.id, PROFILE_UUID, "ready", key, None)
    with zipfile.ZipFile(io.BytesIO(bucket.read(key))) as zf:
        names = set(zf.namelist())
        assert zf.read("Payload/Hello.app/embedded.mobileprovision") == content
        assert zf.read("Payload/Hello.app/_CodeSignature/CodeResources") == b"signed"
        info = plistlib.loads(zf.read("Payload/Hello.app/Info.plist"))
    assert info["CFBundleIdentifier"] == "com.example.hello"
    assert all(n.startswith("Payload/") for n in names)
    (job,) = await jobs_of()
    assert (job.status, job.result) == ("done", {"file_key": key})


async def test_sign_build_signs_extensions_with_their_own_entitlements(
        db, apple, bucket, tmp_path, signer):
    _app, version, _ = await _ready_to_sign(db, apple, bucket, tmp_path)
    ipa = tmp_path / "with-widget.ipa"
    with zipfile.ZipFile(io.BytesIO(bucket.read(version.file_key))) as src, \
            zipfile.ZipFile(ipa, "w") as out:
        for item in src.infolist():
            out.writestr(item, src.read(item))
        out.writestr("Payload/Hello.app/PlugIns/Widget.appex/Info.plist", plistlib.dumps(
            {"CFBundleIdentifier": "com.example.hello.widget",
             "CFBundleExecutable": "Widget"}))
        out.writestr("Payload/Hello.app/PlugIns/Widget.appex/Widget", b"macho")
    bucket.put(version.file_key, ipa.read_bytes())
    await queue("sign_build", {"version_id": str(version.id)})

    assert await run_once(get_sessionmaker())
    (call,) = signer.calls
    # The profile only allows the app's own App ID, so the widget's is dropped.
    assert call["extensions"] == {"PlugIns/Widget.appex": {
        "get-task-allow": False,
        "com.apple.developer.team-identifier": TEAM_ID,
        "aps-environment": "production",
        "keychain-access-groups": [f"{TEAM_ID}.com.example.hello"],
    }}


async def test_sign_build_failure_records_error(db, apple, bucket, tmp_path, signer):
    _app, version, _ = await _ready_to_sign(db, apple, bucket, tmp_path)
    signer.fail = resign.SignError("error: the certificate password is wrong")
    await queue("sign_build", {"version_id": str(version.id)})

    assert await run_once(get_sessionmaker())
    (row,) = await signed_builds()
    assert (row.status, row.error, row.file_key) == (
        "failed", "error: the certificate password is wrong", None)
    assert row.failed_at is not None
    assert not any("/signed/" in key for key in bucket.object_keys())
    (job,) = await jobs_of()
    assert (job.status, job.attempts) == ("failed", 1)   # signing again won't help

    # Asked again later, the same row goes back to running and then ready.
    signer.fail = None
    await queue("sign_build", {"version_id": str(version.id)})
    assert await run_once(get_sessionmaker())
    (row,) = await signed_builds()
    assert (row.status, row.error) == ("ready", None)


async def test_sign_build_storage_failure_is_retried(db, apple, bucket, tmp_path, signer,
                                                     monkeypatch):
    from serversherpa_devices.services import storage

    _app, version, _ = await _ready_to_sign(db, apple, bucket, tmp_path)

    async def down(path, key, content_type):
        raise OSError("bucket unreachable")

    monkeypatch.setattr(storage, "upload_from", down)
    await queue("sign_build", {"version_id": str(version.id)})
    assert await run_once(get_sessionmaker())
    (row,) = await signed_builds()
    assert (row.status, row.error) == ("failed", "Signing didn't finish (OSError).")
    assert row.failed_at is not None
    (job,) = await jobs_of()
    assert (job.status, job.attempts) == ("queued", 1)


async def test_sign_build_skips_deleted_version_and_missing_profile(
        db, apple, bucket, tmp_path, signer):
    _app, version, _ = await _hello_with_bundle(db, apple, bucket, tmp_path)
    await queue("sign_build", {"version_id": str(version.id)})
    assert await run_once(get_sessionmaker())
    assert (await jobs_of())[0].result == {"skipped": "no_profile"}

    async with get_sessionmaker()() as session:
        await session.execute(update(AppVersion).where(AppVersion.id == version.id)
                              .values(deleted_at=EXPIRES, is_current=False))
        await session.commit()
    await queue("sign_build", {"version_id": str(version.id)})
    assert await run_once(get_sessionmaker())
    assert (await jobs_of())[1].result == {"skipped": "version_deleted"}
    assert signer.calls == []
    assert await signed_builds() == []


async def test_new_ios_app_end_to_end(db, apple, bucket, tmp_path, signer):
    """What an upload commit queues, through to a signed IPA."""
    app, version = await seed_ios_app(db, bucket, tmp_path)
    asc_id = apple.add_device(UDID_A)
    await seed_device(db, UDID_A, status="registered", asc_device_id=asc_id)
    await queue("ensure_bundle", {"app_id": str(app.id)})
    await queue("sign_build", {"version_id": str(version.id)})

    await run_all()
    assert {j.status for j in await jobs_of()} == {"done"}
    (row,) = await signed_builds()
    assert row.status == "ready"
    async with get_sessionmaker()() as session:
        profile = await session.scalar(select(IosProfile))
    assert row.profile_uuid == profile.uuid


# The device count.

async def test_sync_devices_counts_by_class(db, apple):
    apple.add_device(UDID_A, device_class="IPHONE")
    apple.add_device(UDID_B, device_class="IPHONE", status="DISABLED")
    apple.add_device(UDID_C, device_class="IPAD")
    db.add(AppleDeviceCount(device_class="APPLE_WATCH", count=4))
    await db.commit()
    await queue("sync_devices", {})

    assert await run_once(get_sessionmaker())
    async with get_sessionmaker()() as session:
        counts = {c.device_class: c.count for c in
                  (await session.scalars(select(AppleDeviceCount))).all()}
    assert counts == {"IPHONE": 2, "IPAD": 1, "APPLE_WATCH": 0}


async def test_missing_device_skips_and_bad_payload_fails_without_retry(db, apple):
    await queue("register_device", {"device_id": str(uuid.uuid4())})
    assert await run_once(get_sessionmaker())
    (job,) = await jobs_of()
    assert (job.status, job.result) == ("done", {"skipped": "device_gone"})
    async with get_sessionmaker()() as session:
        await session.execute(update(Job).values(status="done"))
        await session.commit()
    await queue("register_device", {})
    assert await run_once(get_sessionmaker())
    job = (await jobs_of())[-1]
    assert job.status == "failed"


async def test_sign_build_gave_up_marks_running_build_failed(db, apple, bucket, tmp_path):
    from serversherpa_devices.worker import jobs

    _app, version, _ = await _ready_to_sign(db, apple, bucket, tmp_path)
    db.add(SignedBuild(version_id=version.id, profile_uuid=PROFILE_UUID, status="running"))
    job = Job(kind="sign_build", payload={"version_id": str(version.id)}, status="failed")
    db.add(job)
    await db.commit()
    await jobs.gave_up(db, job)
    await db.commit()
    (row,) = await signed_builds()
    assert (row.status, row.error) == ("failed", jobs.SIGN_GAVE_UP)
    assert row.failed_at is not None
