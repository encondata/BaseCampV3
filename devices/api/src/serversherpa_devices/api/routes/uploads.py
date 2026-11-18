"""Uploading a version: a presigned PUT straight to the bucket, then
inspection (the review summary and its problems), then commit."""

import asyncio
import datetime as dt
import hashlib
import re
import tempfile
import uuid
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, BackgroundTasks, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices import catalog
from serversherpa_devices.api.routes import api_error
from serversherpa_devices.api.routes.apps import NOTES_MAX, VersionOut, version_out
from serversherpa_devices.auth.deps import client_ip, require
from serversherpa_devices.auth.main_api import MainApiClient, Principal, get_main_api
from serversherpa_devices.db.engine import get_db
from serversherpa_devices.db.models import App, AppVersion, Upload
from serversherpa_devices.packages import PackageError
from serversherpa_devices.packages.isolated import inspect_package_isolated
from serversherpa_devices.services import storage

router = APIRouter(tags=["uploads"])

Db = Annotated[AsyncSession, Depends(get_db)]
MainApi = Annotated[MainApiClient, Depends(get_main_api)]
Adder = Annotated[Principal, Depends(require("add"))]

_MIME = re.compile(r"[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,63}")
_DEFAULT_TYPE = "application/octet-stream"
NOT_UPLOADED = "The file didn't finish uploading"
ALREADY_SAVED = "This file was already saved."


class UploadIn(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    size: int = Field(gt=0)
    content_type: str = Field(default="", max_length=255)


class UploadOut(BaseModel):
    upload_id: uuid.UUID
    put_url: str
    headers: dict[str, str]


class ReviewApp(BaseModel):
    exists: bool
    id: uuid.UUID | None = None
    name: str
    platform: str
    identifier: str


class InspectOut(BaseModel):
    app: ReviewApp
    version_name: str
    build: str
    signing_digest: str | None = None
    min_os: str | None = None
    problems: list[str]


class CommitIn(BaseModel):
    notes: str = Field(default="", max_length=NOTES_MAX)


class CommitOut(BaseModel):
    app_id: uuid.UUID
    version: VersionOut


@router.post("/uploads", status_code=201, response_model=UploadOut)
async def create_upload(body: UploadIn, db: Db, principal: Adder):
    if body.size > catalog.UPLOAD_LIMIT:
        raise api_error(413, "too_large", catalog.TOO_LARGE)
    await catalog.purge_stale_uploads(db)

    content_type = body.content_type if _MIME.fullmatch(body.content_type) else _DEFAULT_TYPE
    upload_id = uuid.uuid4()
    filename = catalog.safe_filename(body.filename)
    key = catalog.upload_key(upload_id, filename)
    db.add(Upload(id=upload_id, file_key=key, filename=filename, size=body.size,
                  created_by=principal.person_id))
    await db.commit()
    return {"upload_id": upload_id, "put_url": storage.presign_put(key, content_type, body.size),
            "headers": {"Content-Type": content_type}}


async def _own_upload(db: AsyncSession, upload_id: uuid.UUID, principal: Principal, *,
                      lock: bool = False) -> Upload:
    """The caller's own upload (anyone else's is a 404), not yet committed."""
    query = select(Upload).where(Upload.id == upload_id)
    upload = await db.scalar(query.with_for_update() if lock else query)
    if upload is None or upload.created_by != principal.person_id:
        raise api_error(404, "not_found", "That upload doesn't exist.")
    if upload.committed_at is not None:
        raise api_error(409, "already_saved", ALREADY_SAVED)
    return upload


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _inspect_out(review: dict, app: App | None, problems: list[str]) -> dict:
    if app is not None:
        summary = {"exists": True, "id": app.id, "name": app.name,
                   "platform": app.platform, "identifier": app.identifier}
    else:
        summary = {"exists": False, "name": review["name"], "platform": review["platform"],
                   "identifier": review["identifier"]}
    return {"app": summary, "version_name": review["version_name"], "build": review["build"],
            "signing_digest": review["signing_digest"], "min_os": review["min_os"],
            "problems": problems}


@router.post("/uploads/{upload_id}/inspect", response_model=InspectOut,
             response_model_exclude_none=True)
async def inspect_upload(upload_id: uuid.UUID, background: BackgroundTasks, db: Db,
                         principal: Adder):
    upload = await _own_upload(db, upload_id, principal)
    # A fresh PUT, or else (checking again) the copy an earlier inspection kept.
    source = upload.file_key
    head = await storage.head_object(source)
    if head is None and upload.inspected is not None:
        source = catalog.inspected_key(upload.id, upload.filename)
        head = await storage.head_object(source)
    if head is None or head["size"] != upload.size:
        raise api_error(409, "not_uploaded", NOT_UPLOADED)

    with tempfile.TemporaryDirectory(prefix="devices-upload-") as tmp:
        path = Path(tmp) / upload.filename
        await storage.download_to(source, path)
        try:
            # A child process with a 60 s limit: never on the event loop.
            info = await asyncio.to_thread(inspect_package_isolated, path)
        except PackageError as exc:
            raise api_error(422, "unreadable_package", exc.message) from None
        sha256 = await asyncio.to_thread(_sha256, path)
        size = path.stat().st_size
        # Commit stores these bytes, never the client-writable object.
        await storage.upload_from(path, catalog.inspected_key(upload.id, upload.filename),
                                  _DEFAULT_TYPE)
        if info.icon_png:
            icon = Path(tmp) / "icon.png"
            icon.write_bytes(info.icon_png)
            await storage.upload_from(icon, catalog.upload_icon_key(upload.id), "image/png")

    review = {"platform": info.platform, "identifier": info.identifier, "name": info.name,
              "version_name": info.version_name, "build": info.build,
              # A string: an iOS sort key is wider than JSON numbers are safe for.
              "build_sort": str(info.build_sort), "min_os": info.min_os,
              "signing_digest": info.signing_digest, "sha256": sha256, "size": size,
              "inspected_key": catalog.inspected_key(upload.id, upload.filename),
              "has_icon": bool(info.icon_png)}
    app = await catalog.find_app(db, info.platform, info.identifier)
    problems = await catalog.problems(db, review, app)
    upload.inspected = {**review, "problems": problems}
    await db.commit()
    background.add_task(catalog.delete_objects, [upload.file_key])
    return _inspect_out(review, app, problems)


@router.post("/uploads/{upload_id}/commit", status_code=201, response_model=CommitOut)
async def commit_upload(upload_id: uuid.UUID, body: CommitIn, request: Request,
                        background: BackgroundTasks, db: Db, main_api: MainApi,
                        principal: Adder):
    upload = await _own_upload(db, upload_id, principal, lock=True)
    review = upload.inspected
    if review is None or "inspected_key" not in review:
        raise api_error(409, "not_inspected", "Check the file before saving it.")
    # Checked again: another upload may have been saved since the inspection.
    app = await catalog.find_app(db, review["platform"], review["identifier"], lock=True)
    problems = await catalog.problems(db, review, app)
    if problems:
        raise api_error(409, "upload_problems", problems[0], problems=problems)

    new_app = app is None
    if app is None:
        app = App(id=uuid.uuid4(), platform=review["platform"], identifier=review["identifier"],
                  name=review["name"],
                  signing_digest=review["signing_digest"] if review["platform"] == "android"
                  else None)
        db.add(app)
    else:
        app.name = review["name"]
        await db.execute(update(AppVersion).where(AppVersion.app_id == app.id,
                                                  AppVersion.is_current)
                         .values(is_current=False))

    version = AppVersion(
        id=uuid.uuid4(), app_id=app.id, version_name=review["version_name"],
        build=review["build"], build_sort=int(review["build_sort"]), notes=body.notes,
        file_key="", size=review["size"], sha256=review["sha256"], min_os=review["min_os"],
        uploaded_by=principal.person_id, uploaded_by_name=principal.display_name,
        is_current=True)
    version.file_key = catalog.version_key(app.id, version.id, upload.filename)
    copied = [version.file_key]
    await storage.copy_object(review["inspected_key"], version.file_key)
    if review["has_icon"]:
        await storage.copy_object(catalog.upload_icon_key(upload.id), catalog.app_icon_key(app.id))
        app.icon_key = catalog.app_icon_key(app.id)
        if new_app:
            copied.append(app.icon_key)
    db.add(version)
    upload.committed_at = dt.datetime.now(dt.UTC)
    if app.platform == "ios":
        await catalog.queue_job(db, "ensure_bundle", {"app_id": str(app.id)})
        await catalog.queue_job(db, "sign_build", {"version_id": str(version.id)})
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        background.add_task(catalog.delete_objects, copied)
        raise api_error(409, "conflict", "Another upload of this app was saved at the same "
                        "time. Check the file again.") from None
    await db.refresh(version)

    ip = client_ip(request)
    if new_app:
        await main_api.audit(
            actor=principal.person_id, entity_type="appdist_app", entity_id=str(app.id),
            action="create",
            changes={k: {"from": None, "to": getattr(app, k)}
                     for k in ("platform", "identifier", "name")},
            ip=ip)
    await main_api.audit(
        actor=principal.person_id, entity_type="appdist_version", entity_id=str(version.id),
        action="upload",
        changes={"app_id": {"from": None, "to": str(app.id)},
                 **{k: {"from": None, "to": getattr(version, k)}
                    for k in ("version_name", "build", "size")}},
        ip=ip)
    background.add_task(catalog.delete_objects, catalog.upload_object_keys(upload))
    return {"app_id": app.id, "version": version_out(version)}
