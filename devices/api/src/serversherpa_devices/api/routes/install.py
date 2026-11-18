"""Installing. `router` (under /api) hands a signed-in person an install
link; `public_router` (at the app root) serves what the links point at: the
APK (/dl), and the iOS OTA manifest, its icons and the re-signed IPA (/ota).
The public routes take no session: the signed token in the path is the only
credential, since iOS fetches the manifest and IPA without cookies."""

import asyncio
import io
import plistlib
import uuid
from typing import Annotated

from botocore.exceptions import BotoCoreError, ClientError
from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse, PlainTextResponse, Response, StreamingResponse
from PIL import Image
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices import install_state
from serversherpa_devices.api.routes import api_error
from serversherpa_devices.auth.deps import require
from serversherpa_devices.auth.main_api import Principal
from serversherpa_devices.db.engine import get_db
from serversherpa_devices.db.models import App, AppVersion, SignedBuild
from serversherpa_devices.services import storage
from serversherpa_devices.services.links import LinkError, make_install_token, read_install_token

router = APIRouter(tags=["install"])
public_router = APIRouter(tags=["install"], include_in_schema=False)

Db = Annotated[AsyncSession, Depends(get_db)]

APK_TYPE = "application/vnd.android.package-archive"
IPA_TYPE = "application/octet-stream"
EXPIRED = "This install link has expired. Go back to Devices and tap Install again."
_NO_STORE = {"Cache-Control": "no-store"}
_WAITING = ("registering", "preparing")


class InstallIn(BaseModel):
    version_id: uuid.UUID | None = None
    device_ref: uuid.UUID | None = None


class InstallOut(BaseModel):
    url: str


@router.post("/apps/{app_id}/install", response_model=InstallOut,
             responses={202: {"description": "iOS: the iPhone or the build isn't ready yet"}})
async def install(app_id: uuid.UUID, body: InstallIn, db: Db,
                  # Allowed in read-only mode: it changes no catalog data
                  # (queuing re-signing is housekeeping).
                  _: Annotated[Principal, Depends(require("view", allow_read_only=True))]):
    app = await db.get(App, app_id)
    if app is None:
        raise api_error(404, "not_found", "That app doesn't exist.")
    if body.version_id is not None:
        version = await db.get(AppVersion, body.version_id)
        if version is None or version.app_id != app.id or version.deleted_at is not None:
            raise api_error(404, "not_found", "That version doesn't exist.")
    else:
        version = await install_state.current_version(db, app)
        if version is None:
            raise api_error(404, "not_found", "This app has no version to install.")

    if app.platform == "android":
        return {"url": install_state.apk_url(app, version)}

    state = await install_state.ios_state(db, app, body.device_ref, version=version)
    await db.commit()   # it may have queued re-signing
    if state["state"] == "ready":
        return {"url": state["install_url"]}
    if state["state"] in _WAITING:
        return JSONResponse({"state": state["state"], "message": state["message"]},
                            status_code=202)
    raise api_error(409, state["state"], state["message"])


# The links.

def _expired() -> PlainTextResponse:
    return PlainTextResponse(EXPIRED, status_code=410, headers=_NO_STORE)


def _not_found() -> PlainTextResponse:
    return PlainTextResponse("This app is no longer available.", status_code=404,
                             headers=_NO_STORE)


async def _stream(key: str, media_type: str, headers: dict[str, str] | None = None) -> Response:
    head = await storage.head_object(key)
    if head is None:
        return _not_found()
    return StreamingResponse(storage.open_stream(key), media_type=media_type,
                             headers={"Content-Length": str(head["size"]), **_NO_STORE,
                                      **(headers or {})})


@public_router.get("/dl/{token}/{filename}")
async def download_apk(token: str, filename: str, db: Db):
    try:
        version_id = read_install_token(token, kind="apk")
    except LinkError:
        return _expired()
    version = await db.get(AppVersion, version_id)
    app = await db.get(App, version.app_id) if version is not None else None
    if app is None or app.platform != "android" or version.deleted_at is not None:
        return _not_found()
    # The name comes from the version, never from the path.
    name = install_state.apk_filename(app, version)
    return await _stream(version.file_key, APK_TYPE,
                         {"Content-Disposition": f'attachment; filename="{name}"'})


async def _signed_target(db: AsyncSession, signed_id: uuid.UUID
                         ) -> tuple[SignedBuild, AppVersion, App] | None:
    """A ready signed build, its live version and its app."""
    signed = await db.get(SignedBuild, signed_id)
    if signed is None or signed.status != "ready" or not signed.file_key:
        return None
    version = await db.get(AppVersion, signed.version_id)
    if version is None or version.deleted_at is not None:
        return None
    app = await db.get(App, version.app_id)
    if app is None or app.platform != "ios":
        return None
    return signed, version, app


@public_router.get("/ota/{token}/manifest.plist")
async def manifest(token: str, db: Db):
    try:
        found = await _signed_target(db, read_install_token(token, kind="manifest"))
    except LinkError:
        return _expired()
    if found is None:
        return _not_found()
    signed, version, app = found
    base = install_state.public_url()
    ipa_token = make_install_token(kind="ipa", ref=signed.id)
    assets = [{"kind": "software-package", "url": f"{base}/ota/{ipa_token}/app.ipa"}]
    if app.icon_key:
        assets += [{"kind": "display-image", "url": f"{base}/ota/{token}/icon-57.png"},
                   {"kind": "full-size-image", "url": f"{base}/ota/{token}/icon-512.png"}]
    body = plistlib.dumps({"items": [{
        "assets": assets,
        "metadata": {"bundle-identifier": app.identifier,
                     "bundle-version": version.version_name,
                     "kind": "software", "title": app.name},
    }]})
    return Response(body, media_type="text/xml", headers=_NO_STORE)


def _resized_png(data: bytes, size: int) -> bytes:
    with Image.open(io.BytesIO(data)) as image:
        resized = image.convert("RGBA").resize((size, size), Image.Resampling.LANCZOS)
    out = io.BytesIO()
    resized.save(out, format="PNG")
    return out.getvalue()


async def _icon(token: str, db: AsyncSession, size: int) -> Response:
    try:
        found = await _signed_target(db, read_install_token(token, kind="manifest"))
    except LinkError:
        return _expired()
    if found is None or not found[2].icon_key:
        return _not_found()
    try:
        data = b"".join([chunk async for chunk in storage.open_stream(found[2].icon_key)])
        png = await asyncio.to_thread(_resized_png, data, size)
    except (ClientError, BotoCoreError, OSError, Image.DecompressionBombError):
        return _not_found()
    return Response(png, media_type="image/png", headers=_NO_STORE)


@public_router.get("/ota/{token}/icon-57.png")
async def icon_57(token: str, db: Db):
    return await _icon(token, db, 57)


@public_router.get("/ota/{token}/icon-512.png")
async def icon_512(token: str, db: Db):
    return await _icon(token, db, 512)


@public_router.get("/ota/{token}/app.ipa")
async def download_ipa(token: str, db: Db):
    try:
        found = await _signed_target(db, read_install_token(token, kind="ipa"))
    except LinkError:
        return _expired()
    if found is None:
        return _not_found()
    return await _stream(found[0].file_key, IPA_TYPE)
