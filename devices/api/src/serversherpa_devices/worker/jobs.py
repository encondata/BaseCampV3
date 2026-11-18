"""What each job does. A handler gets the claimed job, does its work and
returns the job's result; the runner (worker/run.py) marks it done in the
same transaction as the handler's last writes. JobFailed fails it without
another try; any other exception is retried (worker/queue.py).

No transaction stays open across an Apple call or the signing run: a
handler reads what it needs, commits, does the slow part, then fetches its
rows again before writing.

- register_device {device_id}: add the iPhone to the Apple team (or
  re-enable it there), then rebuild the profiles.
- disable_device {device_id}: disable it at Apple, then rebuild.
- ensure_bundle {app_id}: find or create the app's App ID.
- rebuild_profiles {}: a fresh Ad Hoc profile per iOS app, holding every
  registered iPhone, then re-sign each app's current version with it.
- sign_build {version_id}: re-sign a version with its app's profile.
- sync_devices {}: how many devices of each class the team holds."""

import asyncio
import collections
import datetime as dt
import logging
import plistlib
import re
import tempfile
import uuid
from pathlib import Path

from sqlalchemy import and_, delete, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices import catalog
from serversherpa_devices.apple.asc import AscClient, AscError, AscRateLimited
from serversherpa_devices.apple.settings import AppleCredentials, load_credentials
from serversherpa_devices.db.models import (
    App,
    AppleDeviceCount,
    AppVersion,
    IosDevice,
    IosProfile,
    Job,
    SignedBuild,
)
from serversherpa_devices.packages import PackageError, provision
from serversherpa_devices.redact import without_udid
from serversherpa_devices.services import storage
from serversherpa_devices.signing import SignError, entitlements, resign
from serversherpa_devices.worker.queue import ERROR_MAX, JobFailed, enqueue

log = logging.getLogger(__name__)

IPA_TYPE = "application/octet-stream"
_INFO_PLIST_LIMIT = 4 * 1024 * 1024
REGISTER_GAVE_UP = "Registering with Apple didn't finish. Add this iPhone again to retry."
DISABLE_GAVE_UP = ("Apple didn't confirm disabling this iPhone, so Apple still lists it as "
                   "enabled. It's out of every profile here; disable it in Apple's developer "
                   "site too.")
SIGN_GAVE_UP = "Signing didn't finish."


def profile_name(bundle_id: str) -> str:
    """The only profile name the worker makes, and the only one it deletes."""
    return f"ServerSherpa Devices · {bundle_id}"


def signed_key(app_id: uuid.UUID, version_id: uuid.UUID, profile_uuid: str) -> str:
    return f"apps/{app_id}/{version_id}/signed/{profile_uuid}.ipa"


def make_client(creds: AppleCredentials) -> AscClient:
    """The App Store Connect client a job uses (tests swap in a fake)."""
    return creds.client()


async def _credentials(db: AsyncSession) -> AppleCredentials:
    creds = await load_credentials(db)
    if creds is None:
        raise JobFailed(catalog.ios_not_set_up_message())
    return creds


def _id_from(job: Job, key: str) -> uuid.UUID:
    try:
        return uuid.UUID(str((job.payload or {})[key]))
    except (KeyError, ValueError):
        raise JobFailed(f"The job has no valid {key}.") from None


async def _locked(db: AsyncSession, model, ident):
    return await db.scalar(select(model).where(model.id == ident).with_for_update()
                           .execution_options(populate_existing=True))


# iPhones.

async def _device_failed(db: AsyncSession, device_id: uuid.UUID, error: str) -> None:
    device = await _locked(db, IosDevice, device_id)
    if device is not None and device.status != "disabled":   # disabled meanwhile: it stays so
        device.status = "failed"
        device.error = error
    await db.commit()


async def register_device(db: AsyncSession, job: Job) -> dict:
    device_id = _id_from(job, "device_id")
    device = await db.get(IosDevice, device_id)
    if device is None:
        return {"skipped": "device_gone"}
    if device.status == "disabled":   # disabled since it was queued
        return {"skipped": "disabled"}
    udid, name = device.udid, device.name
    creds = await load_credentials(db)
    await db.commit()
    if creds is None:
        await _device_failed(db, device_id, catalog.ios_not_set_up_message())
        raise JobFailed(catalog.ios_not_set_up_message())

    try:
        async with make_client(creds) as client:
            found = await client.find_device(udid)
            if found is None:
                found = await client.register_device(name, udid)
            elif found.status == "DISABLED":
                found = await client.set_device_status(found.id, "ENABLED")
    except AscRateLimited:
        raise
    except AscError as exc:
        # Apple's detail can quote the UDID back; it never reaches the row or the job.
        detail = without_udid(exc.detail, udid)
        if exc.status == 0 or exc.status >= 500:
            # Unreachable, or Apple's own failure: nothing was refused. The
            # iPhone stays registering through the retries (gave_up marks it
            # failed after the last one).
            raise AscError(exc.status, exc.code, detail) from None
        reason = f"Apple refused this iPhone: {detail}"
        await _device_failed(db, device_id, reason)
        if exc.status == 409:          # the request itself is wrong: never retried
            raise JobFailed(reason) from None
        raise AscError(exc.status, exc.code, detail) from None

    device = await _locked(db, IosDevice, device_id)
    if device is None:
        return {"skipped": "device_gone"}
    if device.status == "disabled":
        return {"skipped": "disabled"}
    device.asc_device_id = found.id
    device.device_class = found.device_class
    device.status = "registered"
    device.error = None
    await enqueue(db, "rebuild_profiles", {})
    return {"asc_device_id": found.id}


async def disable_device(db: AsyncSession, job: Job) -> dict:
    device_id = _id_from(job, "device_id")
    device = await db.get(IosDevice, device_id)
    if device is None:
        return {"skipped": "device_gone"}
    asc_id, udid = device.asc_device_id, device.udid
    creds = await load_credentials(db)
    await db.commit()

    if creds is not None:
        async with make_client(creds) as client:
            if asc_id is None:
                found = await client.find_device(udid)
                asc_id = found.id if found is not None else None
            if asc_id is not None:
                await client.set_device_status(asc_id, "DISABLED")

    device = await _locked(db, IosDevice, device_id)
    if device is None:
        return {"skipped": "device_gone"}
    device.status = "disabled"
    if creds is not None:
        await enqueue(db, "rebuild_profiles", {})
    return {"asc_device_id": asc_id}


# App IDs.

def _bundle_name(name: str) -> str:
    """An App ID's name: Apple refuses most punctuation in it."""
    cleaned = " ".join(re.sub(r"[^A-Za-z0-9 ]+", " ", name).split())
    return cleaned or "ServerSherpa app"


async def ensure_bundle(db: AsyncSession, job: Job) -> dict:
    app_id = _id_from(job, "app_id")
    app = await db.get(App, app_id)
    if app is None or app.platform != "ios":
        return {"skipped": "app_gone"}
    if app.asc_bundle_id:
        return {"asc_bundle_id": app.asc_bundle_id}
    identifier, name = app.identifier, app.name
    creds = await _credentials(db)
    await db.commit()

    async with make_client(creds) as client:
        bundle_id = (await client.find_bundle_id(identifier)
                     or await client.create_bundle_id(identifier, _bundle_name(name)))

    app = await _locked(db, App, app_id)
    if app is None:
        return {"skipped": "app_gone"}
    app.asc_bundle_id = bundle_id
    # A new app gets its first profile now; later ones come with each rebuild.
    if await db.scalar(select(IosProfile.id).where(IosProfile.app_id == app_id)) is None:
        await enqueue(db, "rebuild_profiles", {})
    return {"asc_bundle_id": bundle_id}


# Ad Hoc profiles.

async def rebuild_profiles(db: AsyncSession, job: Job) -> dict:
    creds = await _credentials(db)
    apps = (await db.execute(
        select(App.id, App.identifier, App.asc_bundle_id, AppVersion.id)
        .join(AppVersion, and_(AppVersion.app_id == App.id, AppVersion.is_current,
                               AppVersion.deleted_at.is_(None)))
        .where(App.platform == "ios", App.asc_bundle_id.is_not(None))
        .order_by(App.identifier))).all()
    devices = (await db.execute(
        select(IosDevice.id, IosDevice.asc_device_id)
        .where(IosDevice.status == "registered", IosDevice.asc_device_id.is_not(None))
        .order_by(IosDevice.added_at, IosDevice.id))).all()
    await db.commit()

    states: dict[str, str] = {}
    async with make_client(creds) as client:
        for app_id, identifier, bundle_res, version_id in apps:
            name = profile_name(identifier)
            for old in await client.list_profiles(name):   # exact name only
                await client.delete_profile(old.id)
            if not devices:                                # Apple refuses an empty profile
                await db.execute(delete(IosProfile).where(IosProfile.app_id == app_id))
                await db.commit()
                states[str(app_id)] = "no_devices"
                continue
            made = await client.create_adhoc_profile(
                name, bundle_res, creds.asc_certificate_id, [d.asc_device_id for d in devices])
            expires = made.expires_at or provision.parse(made.content).expires_at
            if expires is None:
                raise PackageError("The new profile has no expiry date.")
            values = {"asc_profile_id": made.id, "uuid": made.uuid, "content": made.content,
                      "expires_at": expires, "device_ids": [d.id for d in devices]}
            await db.execute(insert(IosProfile).values(app_id=app_id, **values)
                             .on_conflict_do_update(index_elements=["app_id"], set_=values))
            await enqueue(db, "sign_build", {"version_id": str(version_id)})
            await db.commit()          # each app's profile is kept even if a later one fails
            states[str(app_id)] = "rebuilt"
    return {"apps": states}


# Re-signing.

async def _set_signed_build(db: AsyncSession, version_id: uuid.UUID, profile_uuid: str,
                            **values) -> int:
    result = await db.execute(
        update(SignedBuild)
        .where(SignedBuild.version_id == version_id, SignedBuild.profile_uuid == profile_uuid)
        .values(**values))
    return result.rowcount


def _bundle_info(bundle: Path) -> dict:
    path = bundle / "Info.plist"
    try:
        if path.stat().st_size > _INFO_PLIST_LIMIT:
            raise SignError(f"{bundle.name}'s Info.plist is too large.")
        info = plistlib.loads(path.read_bytes())
    except (OSError, plistlib.InvalidFileException, ValueError):
        raise SignError(f"{bundle.name}'s Info.plist can't be read.") from None
    executable = info.get("CFBundleExecutable") if isinstance(info, dict) else None
    if not isinstance(executable, str) or not executable or "/" in executable \
            or executable in (".", ".."):
        raise SignError(f"{bundle.name} has no executable.")
    return info


def _resign(work: Path, *, bundle_id: str, profile_content: bytes, p12: bytes,
            password: str) -> Path:
    """Unpack, embed the profile, sign, pack. Blocking: runs in a thread."""
    unpacked = work / "unpacked"
    app_dir = resign.unpack_ipa(work / "original.ipa", unpacked)
    embedded = app_dir / "embedded.mobileprovision"
    embedded.unlink(missing_ok=True)       # never written through a link
    embedded.write_bytes(profile_content)
    profile = provision.parse(profile_content)

    info = _bundle_info(app_dir)
    main = entitlements.for_profile(
        resign.binary_entitlements(app_dir / info["CFBundleExecutable"]), profile,
        bundle_id=bundle_id)
    extensions: dict[str, dict] = {}
    plugins = app_dir / "PlugIns"
    if plugins.is_dir() and not plugins.is_symlink():
        for appex in sorted(plugins.glob("*.appex")):
            if not appex.is_dir() or appex.is_symlink():
                continue
            ext_info = _bundle_info(appex)
            ext_id = ext_info.get("CFBundleIdentifier")
            if not isinstance(ext_id, str) or not ext_id:
                raise SignError(f"{appex.name} has no bundle identifier.")
            extensions[f"PlugIns/{appex.name}"] = entitlements.for_profile(
                resign.binary_entitlements(appex / ext_info["CFBundleExecutable"]), profile,
                bundle_id=ext_id)

    resign.sign_app(app_dir, p12=p12, password=password, entitlements=main,
                    extension_entitlements=extensions)
    signed = work / "signed.ipa"
    resign.pack_ipa(unpacked, signed)
    return signed


async def sign_build(db: AsyncSession, job: Job) -> dict:
    version_id = _id_from(job, "version_id")
    version = await db.get(AppVersion, version_id)
    if version is None or version.deleted_at is not None:
        return {"skipped": "version_deleted"}
    app = await db.get(App, version.app_id)
    profile = await db.scalar(select(IosProfile).where(IosProfile.app_id == version.app_id))
    if profile is None:
        return {"skipped": "no_profile"}   # the app's first rebuild signs it
    creds = await _credentials(db)
    profile_uuid, profile_content = profile.uuid, profile.content
    app_id, bundle_id, file_key = app.id, app.identifier, version.file_key
    existing = await db.scalar(select(SignedBuild).where(
        SignedBuild.version_id == version_id, SignedBuild.profile_uuid == profile_uuid))
    if existing is not None and existing.status == "ready":
        return {"file_key": existing.file_key}
    await db.execute(
        insert(SignedBuild).values(version_id=version_id, profile_uuid=profile_uuid,
                                   status="running")
        .on_conflict_do_update(constraint="signed_builds_version_id_profile_uuid_key",
                               set_={"status": "running", "error": None, "permanent": False}))
    await db.commit()

    key = signed_key(app_id, version_id, profile_uuid)
    try:
        with tempfile.TemporaryDirectory(prefix="devices-resign-",
                                         ignore_cleanup_errors=True) as tmp:
            work = Path(tmp)
            await storage.download_to(file_key, work / "original.ipa")
            signed = await asyncio.to_thread(
                _resign, work, bundle_id=bundle_id, profile_content=profile_content,
                p12=creds.p12, password=creds.p12_password)
            await storage.upload_from(signed, key, IPA_TYPE)
    except Exception as exc:
        permanent = isinstance(exc, (SignError, PackageError))
        message = str(exc) if permanent else f"Signing didn't finish ({type(exc).__name__})."
        await db.rollback()
        # A capability the App ID lacks fails every try until a new upload
        # (ruling R19), so looking at the page never queues another.
        await _set_signed_build(db, version_id, profile_uuid, status="failed",
                                error=message[:ERROR_MAX], file_key=None,
                                failed_at=func.now(),
                                permanent=isinstance(exc, entitlements.MissingEntitlement))
        await db.commit()
        if permanent:                      # the same IPA and certificate fail again
            raise JobFailed(message) from None
        raise

    if not await _set_signed_build(db, version_id, profile_uuid, status="ready", error=None,
                                   file_key=key):
        await storage.delete_object(key)   # the version went while it was signed
        return {"skipped": "version_deleted"}
    return {"file_key": key}


# The device count.

async def sync_devices(db: AsyncSession, job: Job) -> dict:
    creds = await _credentials(db)
    await db.commit()
    async with make_client(creds) as client:
        devices = await client.list_devices()

    # Disabled devices still hold a slot until the membership renews.
    counts = collections.Counter(d.device_class or "UNKNOWN" for d in devices
                                 if d.status in ("ENABLED", "DISABLED"))
    now = dt.datetime.now(dt.UTC)
    await db.execute(update(AppleDeviceCount).values(count=0, synced_at=now))
    for device_class, count in counts.items():
        values = {"count": count, "synced_at": now}
        await db.execute(insert(AppleDeviceCount).values(device_class=device_class, **values)
                         .on_conflict_do_update(index_elements=["device_class"], set_=values))
    return {"counts": dict(counts)}


HANDLERS = {
    "register_device": register_device,
    "disable_device": disable_device,
    "ensure_bundle": ensure_bundle,
    "rebuild_profiles": rebuild_profiles,
    "sign_build": sign_build,
    "sync_devices": sync_devices,
}


async def gave_up(db: AsyncSession, job: Job) -> None:
    """A job failed for good after its last try (or a dead worker's): leave
    its subject showing that, not waiting forever. In the caller's
    transaction."""
    payload = job.payload or {}
    try:
        if job.kind == "register_device":
            device = await db.get(IosDevice, uuid.UUID(str(payload["device_id"])))
            if device is not None and device.status == "pending":
                device.status = "failed"
                device.error = REGISTER_GAVE_UP
        elif job.kind == "disable_device":
            # Disabled here already; Apple never heard. The rebuild drops it
            # from every profile all the same (only registered iPhones go in).
            device = await db.get(IosDevice, uuid.UUID(str(payload["device_id"])))
            if device is not None and device.status == "disabled":
                device.error = DISABLE_GAVE_UP
                await enqueue(db, "rebuild_profiles", {})
        elif job.kind == "sign_build":
            await db.execute(
                update(SignedBuild)
                .where(SignedBuild.version_id == uuid.UUID(str(payload["version_id"])),
                       SignedBuild.status == "running")
                .values(status="failed", error=SIGN_GAVE_UP, failed_at=func.now()))
    except (KeyError, ValueError):
        return
