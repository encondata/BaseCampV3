"""What installing an app takes right now, and the signed links that do it.

- `ios_state`: for the web page, whether this iPhone or iPad can install an iOS app
  yet (registered with Apple, in the app's Ad Hoc profile, and the version
  re-signed with that profile). Looking queues the re-signing when it is
  missing or failed, in the caller's transaction.
- `apk_url` / `ios_install_url`: the links phones download from. Their
  tokens are the only credential (iOS fetches without cookies)."""

import datetime as dt
import uuid
from typing import NotRequired, TypedDict
from urllib.parse import quote

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices import catalog
from serversherpa_devices.config import get_settings
from serversherpa_devices.db.models import App, AppVersion, IosDevice, IosProfile, Job, SignedBuild
from serversherpa_devices.services.links import make_install_token

# The messages name the device: "iPad" or "iPhone" when that's known (see
# device_noun), else "device". Fill one in with worded().
REGISTER_FIRST = "This {device} isn't registered."
REGISTERING = "Registering this {device} with Apple…"
DISABLED = "This {device} was removed from Devices."
PREPARING = "Preparing the app for this {device}…"
BUILD_FAILED = ("This app couldn't be prepared for this {device}. "
                "It will try again in a few minutes.")
DEVICE = "device"
# Apple's device classes, and the hint the web page sends (only these two;
# anything else is ignored, never echoed).
_CLASS_NOUNS = {"IPAD": "iPad", "IPHONE": "iPhone"}
_HINT_NOUNS = {"ipad": "iPad", "iphone": "iPhone"}
# A failed re-signing is tried again at most this often.
RETRY_AFTER = dt.timedelta(minutes=10)


class IosState(TypedDict):
    # not_set_up | register_first | registering | failed (registering the
    # device) | disabled | preparing | build_failed (re-signing the app) | ready
    state: str
    message: str
    install_url: NotRequired[str]
    # failed and build_failed: whether the worker (or the next look) will try
    # again by itself, so the page keeps checking.
    retrying: NotRequired[bool]


def _state(state: str, message: str) -> IosState:
    return {"state": state, "message": message}


def hint_noun(hint: str | None) -> str | None:
    """"iPad" or "iPhone" for the page's `device` hint ("ipad" | "iphone");
    None for anything else."""
    return _HINT_NOUNS.get(hint) if isinstance(hint, str) else None


def device_noun(device: IosDevice | None, hint: str | None = None) -> str:
    """What to call the viewer's device: its registered class (iPad or
    iPhone), else the page's hint, else "device"."""
    if device is not None and device.device_class in _CLASS_NOUNS:
        return _CLASS_NOUNS[device.device_class]
    return hint_noun(hint) or DEVICE


def worded(template: str, noun: str = DEVICE) -> str:
    """One of the messages above, naming the device `noun`."""
    return template.format(device=noun)


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


async def _job_waiting(db: AsyncSession, kind: str, key: str, ident: uuid.UUID) -> bool:
    """A `kind` job for payload[key] == ident is queued or running."""
    return await db.scalar(select(Job.id).where(
        Job.kind == kind, Job.status.in_(("queued", "running")),
        Job.payload[key].astext == str(ident)).limit(1)) is not None


async def _signing_failed_lately(db: AsyncSession, version_id: uuid.UUID) -> bool:
    """A sign_build for the version failed within RETRY_AFTER. Covers the
    failures that come before the job writes its signed_builds row (no
    readable credentials, say), which the row's failed_at can't pace."""
    since = dt.datetime.now(dt.UTC) - RETRY_AFTER
    return await db.scalar(select(Job.id).where(
        Job.kind == "sign_build", Job.status == "failed", Job.finished_at >= since,
        Job.payload["version_id"].astext == str(version_id)).limit(1)) is not None


async def build_state(db: AsyncSession, version: AppVersion,
                      profile: IosProfile) -> tuple[str, SignedBuild | None]:
    """Where re-signing the version with `profile` stands:
    - ("ready", the build);
    - ("preparing", None): queued or running;
    - ("failed", None): it failed less than RETRY_AFTER ago;
    - ("refused", the build): it failed for good (signed.permanent, such as
      a capability the App ID lacks); its error says why, and only a new
      upload tries again.
    The worker never retries a failed build by itself, so looking queues
    re-signing when it never started, or when it failed RETRY_AFTER ago or
    more."""
    signed = await db.scalar(select(SignedBuild).where(
        SignedBuild.version_id == version.id, SignedBuild.profile_uuid == profile.uuid))
    if signed is not None and signed.status == "ready" and signed.file_key:
        return "ready", signed
    if signed is not None and signed.status != "failed":
        return "preparing", None          # queued or running
    if signed is not None and signed.permanent:
        return "refused", signed
    if await _job_waiting(db, "sign_build", "version_id", version.id):
        return "preparing", None
    if signed is not None and signed.failed_at is not None \
            and dt.datetime.now(dt.UTC) - signed.failed_at < RETRY_AFTER:
        return "failed", None
    if await _signing_failed_lately(db, version.id):
        return "failed", None
    await catalog.queue_job(db, "sign_build", {"version_id": str(version.id)})
    return "preparing", None


async def capability_refused(db: AsyncSession, app: App) -> bool:
    """Some version of `app` was refused signing for good with its current
    profile. That profile predates any fix in Apple's developer site, so
    the next version needs a new one."""
    return await db.scalar(
        select(SignedBuild.id)
        .join(AppVersion, AppVersion.id == SignedBuild.version_id)
        .join(IosProfile, IosProfile.app_id == AppVersion.app_id)
        .where(AppVersion.app_id == app.id, SignedBuild.permanent,
               SignedBuild.profile_uuid == IosProfile.uuid)
        .limit(1)) is not None


# The web page's state.

async def ios_state(db: AsyncSession, app: App, device_ref: uuid.UUID | None, *,
                    version: AppVersion, hint: str | None = None) -> IosState:
    """Whether the iPhone or iPad `device_ref` (an ios_devices id) can
    install `version` of the iOS app `app`. `hint` is the page's guess at
    what it runs on ("ipad" | "iphone"), for the wording only. An app with
    no version to install has no state at all (the caller leaves it out)."""
    if not await catalog.apple_settings_ready(db):
        return _state("not_set_up", catalog.ios_not_set_up_message())
    device = await db.get(IosDevice, device_ref) if device_ref is not None else None
    noun = device_noun(device, hint)
    if device is None:
        return _state("register_first", worded(REGISTER_FIRST, noun))
    if device.status == "pending":
        return _state("registering", worded(REGISTERING, noun))
    if device.status == "failed":
        # Adding it again starts over; until then the worker may still be
        # trying (Apple refused it, but not for good).
        return {"state": "failed", "message": device.error or "",
                "retrying": await _job_waiting(db, "register_device", "device_id", device.id)}
    if device.status == "disabled":
        return _state("disabled", worded(DISABLED, noun))

    profile = await app_profile(db, app)
    # No profile yet, or one made before this device was registered: the
    # rebuild that registering queued makes a new one and signs with it.
    if profile is None or device.id not in (profile.device_ids or []):
        return _state("preparing", worded(PREPARING, noun))
    state, signed = await build_state(db, version, profile)
    if state == "failed":
        return {"state": "build_failed", "message": worded(BUILD_FAILED, noun), "retrying": True}
    if state == "refused":
        return {"state": "build_failed", "message": signed.error or worded(BUILD_FAILED, noun),
                "retrying": False}
    if signed is None:
        return _state("preparing", worded(PREPARING, noun))
    return {"state": "ready", "message": "", "install_url": ios_install_url(signed)}
