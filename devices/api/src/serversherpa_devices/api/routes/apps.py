"""The catalog: apps with their current version, version history, icons,
and the version actions (edit notes, make current, delete)."""

import datetime as dt
import uuid
from typing import Annotated, Any

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import and_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices import catalog
from serversherpa_devices.api.routes import api_error
from serversherpa_devices.auth.deps import client_ip, require
from serversherpa_devices.auth.main_api import MainApiClient, Principal, get_main_api
from serversherpa_devices.db.engine import get_db
from serversherpa_devices.db.models import App, AppVersion, SignedBuild
from serversherpa_devices.services import storage

router = APIRouter(tags=["apps"])

Db = Annotated[AsyncSession, Depends(get_db)]
MainApi = Annotated[MainApiClient, Depends(get_main_api)]
NOTES_MAX = 5000


class VersionOut(BaseModel):
    id: uuid.UUID
    version_name: str
    build: str
    notes: str
    size: int
    uploaded_at: dt.datetime
    uploaded_by_name: str
    is_current: bool


class AppOut(BaseModel):
    id: uuid.UUID
    platform: str
    identifier: str
    name: str
    icon_url: str | None
    current: VersionOut | None
    # Task 12's install_state() fills this; None until then.
    ios_state: Any | None = None


class AppDetailOut(AppOut):
    versions: list[VersionOut]


class NotesIn(BaseModel):
    notes: str = Field(max_length=NOTES_MAX)


def version_out(version: AppVersion) -> VersionOut:
    return VersionOut.model_validate(version, from_attributes=True)


def _app_out(app: App, current: AppVersion | None) -> dict:
    return {"id": app.id, "platform": app.platform, "identifier": app.identifier,
            "name": app.name, "icon_url": f"/api/apps/{app.id}/icon" if app.icon_key else None,
            "current": version_out(current) if current is not None else None,
            "ios_state": None}


_CURRENT = and_(AppVersion.app_id == App.id, AppVersion.is_current,
                AppVersion.deleted_at.is_(None))


@router.get("/apps", response_model=list[AppOut])
async def list_apps(db: Db, _: Annotated[Principal, Depends(require("view"))]):
    rows = (await db.execute(
        select(App, AppVersion).outerjoin(AppVersion, _CURRENT)
        .order_by(App.name, App.platform, App.identifier))).all()
    return [_app_out(app, current) for app, current in rows]


@router.get("/apps/{app_id}", response_model=AppDetailOut)
async def get_app(app_id: uuid.UUID, db: Db,
                  _: Annotated[Principal, Depends(require("view"))]):
    app = await db.get(App, app_id)
    if app is None:
        raise api_error(404, "not_found", "That app doesn't exist.")
    versions = (await db.scalars(
        select(AppVersion).where(AppVersion.app_id == app.id, AppVersion.deleted_at.is_(None))
        .order_by(AppVersion.build_sort.desc(), AppVersion.uploaded_at.desc()))).all()
    current = next((v for v in versions if v.is_current), None)
    return {**_app_out(app, current), "versions": [version_out(v) for v in versions]}


@router.get("/apps/{app_id}/icon")
async def get_icon(app_id: uuid.UUID, db: Db,
                   _: Annotated[Principal, Depends(require("view"))]):
    app = await db.get(App, app_id)
    if app is None or not app.icon_key:
        raise api_error(404, "not_found", "This app has no icon.")
    try:
        data = b"".join([chunk async for chunk in storage.open_stream(app.icon_key)])
    except (ClientError, BotoCoreError, FileNotFoundError):
        raise api_error(404, "not_found", "This app has no icon.") from None
    return Response(data, media_type="image/png",
                    headers={"Cache-Control": "private, max-age=3600"})


async def _live_version(db: AsyncSession, version_id: uuid.UUID) -> AppVersion:
    version = await db.get(AppVersion, version_id)
    if version is None or version.deleted_at is not None:
        raise api_error(404, "not_found", "That version doesn't exist.")
    return version


@router.patch("/versions/{version_id}", response_model=VersionOut)
async def edit_notes(version_id: uuid.UUID, body: NotesIn, request: Request, db: Db,
                     main_api: MainApi,
                     principal: Annotated[Principal, Depends(require("change"))]):
    version = await _live_version(db, version_id)
    before = version.notes
    if body.notes != before:
        version.notes = body.notes
        await db.commit()
        await main_api.audit(actor=principal.person_id, entity_type="appdist_version",
                             entity_id=str(version.id), action="edit_notes",
                             changes={"notes": {"from": before, "to": body.notes}},
                             ip=client_ip(request))
    return version_out(version)


@router.post("/versions/{version_id}/make-current", response_model=VersionOut)
async def make_current(version_id: uuid.UUID, request: Request, db: Db, main_api: MainApi,
                       principal: Annotated[Principal, Depends(require("change"))]):
    version = await _live_version(db, version_id)
    # One switch per app at a time.
    await db.execute(select(App.id).where(App.id == version.app_id).with_for_update())
    await db.refresh(version)
    if version.deleted_at is not None:
        raise api_error(404, "not_found", "That version doesn't exist.")
    if version.is_current:   # nothing to do (the session's end releases the lock)
        return version_out(version)
    previous = await db.scalar(select(AppVersion.id).where(
        AppVersion.app_id == version.app_id, AppVersion.is_current,
        AppVersion.deleted_at.is_(None)))
    await db.execute(update(AppVersion).where(AppVersion.app_id == version.app_id,
                                              AppVersion.is_current).values(is_current=False))
    version.is_current = True
    await db.commit()
    await main_api.audit(
        actor=principal.person_id, entity_type="appdist_version", entity_id=str(version.id),
        action="make_current",
        changes={"current_version": {"from": str(previous) if previous else None,
                                     "to": str(version.id)}},
        ip=client_ip(request))
    return version_out(version)


@router.delete("/versions/{version_id}", status_code=204)
async def delete_version(version_id: uuid.UUID, request: Request, background: BackgroundTasks,
                         db: Db, main_api: MainApi,
                         principal: Annotated[Principal, Depends(require("delete"))]):
    version = await _live_version(db, version_id)
    await db.execute(select(App.id).where(App.id == version.app_id).with_for_update())
    await db.refresh(version)
    if version.deleted_at is not None:
        raise api_error(404, "not_found", "That version doesn't exist.")
    if version.is_current:
        raise api_error(409, "current_version", "Make another version current first.")
    signed = (await db.scalars(select(SignedBuild.file_key).where(
        SignedBuild.version_id == version.id, SignedBuild.file_key.is_not(None)))).all()
    version.deleted_at = dt.datetime.now(dt.UTC)
    await db.commit()
    await main_api.audit(
        actor=principal.person_id, entity_type="appdist_version", entity_id=str(version.id),
        action="delete",
        changes={"version_name": {"from": version.version_name, "to": None},
                 "build": {"from": version.build, "to": None}},
        ip=client_ip(request))
    background.add_task(catalog.delete_objects, [version.file_key, *signed])
    return Response(status_code=204)
