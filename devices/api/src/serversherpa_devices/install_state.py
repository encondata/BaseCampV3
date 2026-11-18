"""What installing an app takes right now, and the signed links that do it.

- `ios_state`: for the web page, whether this iPhone can install an iOS app
  yet (registered with Apple, in the app's Ad Hoc profile, and the version
  re-signed with that profile). Looking queues the re-signing when it is
  missing or failed, in the caller's transaction.
- `apk_url` / `ios_install_url`: the links phones download from. Their
  tokens are the only credential (iOS fetches without cookies)."""

import uuid
from typing import NotRequired, TypedDict
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices import catalog
from serversherpa_devices.config import get_settings
from serversherpa_devices.db.models import App, AppVersion, IosDevice, IosProfile, Job, SignedBuild
from serversherpa_devices.services.links import make_install_token

REGISTER_FIRST = "This iPhone isn't registered."
REGISTERING = "Registering this iPhone with Apple…"
DISABLED = "This iPhone was removed from Devices."
PREPARING = "Preparing the app for this iPhone…"


class IosState(TypedDict):
    state: str     # not_set_up | register_first | registering | failed | disabled | preparing | ready
    message: str
    install_url: NotRequired[str]


def _state(state: str, message: str) -> IosState:
    return {"state": state, "message": message}


# Links.

def public_url() -> str:
    return get_settings().public_url.rstrip("/")


def apk_filename(app: App, version: AppVersion) -> str:
    return catalog.safe_filename(f"{app.name}-{version.version_name}.apk")


def apk_url(app: App, version: AppVersion) -> str:
    token = make_install_token(kind="apk", ref=version.id)
    return f"{public_url()}/dl/{token}/{apk_filename(app, version)}"


def ios_install_url(signed: SignedBuild) -> str:
    token = make_install_token(kind="manifest", ref=signed.id)
    manifest = f"{public_url()}/ota/{token}/manifest.plist"
    return f"itms-services://?action=download-manifest&url={quote(manifest, safe='')}"


# Signed builds.

async def current_version(db: AsyncSession, app: App) -> AppVersion | None:
    return await db.scalar(select(AppVersion).where(
        AppVersion.app_id == app.id, AppVersion.is_current, AppVersion.deleted_at.is_(None)))


async def app_profile(db: AsyncSession, app: App) -> IosProfile | None:
    return await db.scalar(select(IosProfile).where(IosProfile.app_id == app.id))


async def _queue_signing(db: AsyncSession, version_id: uuid.UUID) -> None:
    """Queue sign_build for the version unless one is queued or running."""
    waiting = await db.scalar(select(Job.id).where(
        Job.kind == "sign_build", Job.status.in_(("queued", "running")),
        Job.payload["version_id"].astext == str(version_id)).limit(1))
    if waiting is None:
        await catalog.queue_job(db, "sign_build", {"version_id": str(version_id)})


async def ready_build(db: AsyncSession, version: AppVersion,
                      profile: IosProfile) -> SignedBuild | None:
    """The version re-signed with `profile`, when that is ready. Otherwise
    None, and re-signing is queued when it never started or failed (the
    worker never retries a failed one by itself)."""
    signed = await db.scalar(select(SignedBuild).where(
        SignedBuild.version_id == version.id, SignedBuild.profile_uuid == profile.uuid))
    if signed is not None and signed.status == "ready" and signed.file_key:
        return signed
    if signed is None or signed.status == "failed":
        await _queue_signing(db, version.id)
    return None


# The web page's state.

async def ios_state(db: AsyncSession, app: App, device_ref: uuid.UUID | None, *,
                    version: AppVersion | None = None) -> IosState:
    """Whether the iPhone `device_ref` (an ios_devices id) can install
    `version` (default: the current one) of the iOS app `app`."""
    if not await catalog.apple_settings_ready(db):
        return _state("not_set_up", catalog.ios_not_set_up_message())
    device = await db.get(IosDevice, device_ref) if device_ref is not None else None
    if device is None:
        return _state("register_first", REGISTER_FIRST)
    if device.status == "pending":
        return _state("registering", REGISTERING)
    if device.status == "failed":
        return _state("failed", device.error or "")
    if device.status == "disabled":
        return _state("disabled", DISABLED)

    version = version or await current_version(db, app)
    profile = await app_profile(db, app)
    # No profile yet, or one made before this iPhone was registered: the
    # rebuild that registering queued makes a new one and signs with it.
    if version is None or profile is None or device.id not in (profile.device_ids or []):
        return _state("preparing", PREPARING)
    signed = await ready_build(db, version, profile)
    if signed is None:
        return _state("preparing", PREPARING)
    return {"state": "ready", "message": "", "install_url": ios_install_url(signed)}
