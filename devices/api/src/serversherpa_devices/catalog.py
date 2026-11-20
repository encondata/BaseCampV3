"""The app catalog's rules, shared by the upload and catalog routes (and,
for the iOS owner message, by Task 12's install state): object keys, the
review problems an upload can have, stale-upload cleanup, job queueing."""

import datetime as dt
import inspect
import logging
import re
import uuid
from collections.abc import Iterable

from botocore.exceptions import BotoCoreError, ClientError
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices.config import get_settings
from serversherpa_devices.db.models import App, AppleSettings, AppVersion, Upload
from serversherpa_devices.services import storage
from serversherpa_devices.worker import queue as worker_queue

log = logging.getLogger(__name__)

UPLOAD_LIMIT = 500 * 1024 * 1024
TOO_LARGE = "Files over 500 MB aren't accepted"
STALE_UPLOAD_AGE = dt.timedelta(hours=24)
_STALE_BATCH = 100

# The worker's queue. Looked up through this module on every call, so a test
# can swap it (for a plain function, too).
enqueue = worker_queue.enqueue


async def queue_job(db: AsyncSession, kind: str, payload: dict) -> None:
    """Queue a worker job in the caller's transaction (through `enqueue`,
    awaited when it returns an awaitable)."""
    result = enqueue(db, kind, payload)
    if inspect.isawaitable(result):
        await result


# Object keys.

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")
_MAX_NAME = 120


def safe_filename(name: str) -> str:
    """The last path part, with anything but letters, digits, '.', '_' and
    '-' turned into '_', no leading dots, at most 120 characters."""
    base = _UNSAFE.sub("_", name.replace("\\", "/").rsplit("/", 1)[-1]).lstrip(".")
    if len(base) > _MAX_NAME:
        stem, dot, ext = base.rpartition(".")
        if stem and dot and len(ext) <= 16:   # keep the extension
            base = stem[:_MAX_NAME - len(ext) - 1] + "." + ext
        else:
            base = base[:_MAX_NAME]
    return base or "upload"


def upload_key(upload_id: uuid.UUID, filename: str) -> str:
    return f"uploads/{upload_id}/{filename}"


def inspected_key(upload_id: uuid.UUID, inspection_id: uuid.UUID, filename: str) -> str:
    """Where one inspection keeps the bytes it read. Each inspection gets its
    own key and nothing ever rewrites it, so a review always describes the
    object it names. The client never gets a URL for it (its presigned key
    has no '/' after the upload id)."""
    return f"uploads/{upload_id}/inspected/{inspection_id}/{filename}"


def inspected_icon_key(upload_id: uuid.UUID, inspection_id: uuid.UUID) -> str:
    # A leading dot: safe_filename never produces one, so it can't clash.
    return f"uploads/{upload_id}/inspected/{inspection_id}/.icon.png"


def review_object_keys(review: dict | None) -> list[str]:
    """The objects one stored review owns."""
    if not review:
        return []
    return [key for key in (review.get("inspected_key"), review.get("icon_key")) if key]


def upload_object_keys(upload: Upload) -> list[str]:
    """Every object an upload owns: the client's PUT and its current review's."""
    return [upload.file_key, *review_object_keys(upload.inspected)]


def version_key(app_id: uuid.UUID, version_id: uuid.UUID, filename: str) -> str:
    return f"apps/{app_id}/{version_id}/{filename}"


def app_icon_key(app_id: uuid.UUID) -> str:
    return f"apps/{app_id}/icon.png"


async def delete_objects(keys: Iterable[str]) -> None:
    """Best effort (runs in the background): a failure is logged by class only."""
    for key in keys:
        try:
            await storage.delete_object(key)
        except (ClientError, BotoCoreError, OSError) as exc:
            log.warning("storage: couldn't delete an object: %s", type(exc).__name__)


# iOS ownership.

async def apple_settings_ready(db: AsyncSession) -> bool:
    row = await db.get(AppleSettings, 1)
    return row is not None and row.p12_enc is not None


def ios_not_set_up_message() -> str:
    owner = get_settings().ios_owner_url
    return f"iOS installs are set up on {owner}." if owner else "Apple settings aren't set up yet."


# Review.

async def find_app(db: AsyncSession, platform: str, identifier: str, *,
                   lock: bool = False) -> App | None:
    query = select(App).where(App.platform == platform, App.identifier == identifier)
    return await db.scalar(query.with_for_update() if lock else query)


async def problems(db: AsyncSession, review: dict, app: App | None) -> list[str]:
    """Why an inspected upload (`review`, as stored in uploads.inspected)
    can't be saved as a new version; empty when it can."""
    found: list[str] = []
    version_name, build = review["version_name"], review["build"]
    if app is not None:
        # Deleted versions count in both checks: their version and build can't
        # come back, and phones may still have a deleted build installed.
        duplicate = await db.scalar(select(AppVersion.id).where(
            AppVersion.app_id == app.id, AppVersion.version_name == version_name,
            AppVersion.build == build).limit(1))
        highest = await db.scalar(
            select(AppVersion).where(AppVersion.app_id == app.id)
            .order_by(AppVersion.build_sort.desc()).limit(1))
        if duplicate is not None:
            found.append(f"{version_name} ({build}) is already uploaded.")
        elif highest is not None and int(review["build_sort"]) <= highest.build_sort:
            found.append(f"Build {build} isn't newer than "
                         f"{highest.version_name} ({highest.build}).")
        new_digest, old_digest = review.get("signing_digest"), app.signing_digest
        if app.platform == "android" and old_digest and new_digest != old_digest:
            found.append(f"This APK is signed with a different key ({(new_digest or '')[:12]}…) "
                         f"than earlier versions ({old_digest[:12]}…). "
                         "Phones would refuse it as an update.")
    if review["platform"] == "ios" and not await apple_settings_ready(db):
        found.append(ios_not_set_up_message())
    return found


# Cleanup.

async def purge_stale_uploads(db: AsyncSession) -> None:
    """Delete uploads older than 24 hours that were never committed: their
    objects, then their rows. Rows whose objects can't be deleted stay for
    the next run. Commits."""
    cutoff = dt.datetime.now(dt.UTC) - STALE_UPLOAD_AGE
    stale = (await db.scalars(
        select(Upload).where(Upload.committed_at.is_(None), Upload.created_at < cutoff)
        .order_by(Upload.created_at).limit(_STALE_BATCH)
        .with_for_update(skip_locked=True))).all()
    gone: list[uuid.UUID] = []
    for upload in stale:
        try:
            for key in upload_object_keys(upload):
                await storage.delete_object(key)
        except (ClientError, BotoCoreError, OSError) as exc:
            log.warning("storage: couldn't purge a stale upload: %s", type(exc).__name__)
            continue
        gone.append(upload.id)
    if gone:
        await db.execute(delete(Upload).where(Upload.id.in_(gone)))
    await db.commit()
