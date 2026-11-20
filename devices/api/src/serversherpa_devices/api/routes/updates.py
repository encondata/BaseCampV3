"""GET /api/updates: the kiosk apps' update check. Any kiosk session (or a
portal session holding `view`) may ask. It answers with the current version
only when that is newer than the installed one, so a rollback (Make current
on an older version) never downgrades a phone."""

from typing import Annotated, Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices import catalog, install_state
from serversherpa_devices.api.routes import api_error
from serversherpa_devices.auth.deps import kiosk_principal
from serversherpa_devices.auth.main_api import Principal
from serversherpa_devices.db.engine import get_db
from serversherpa_devices.db.models import App, AppVersion
from serversherpa_devices.packages.versions import ios_build_sort

router = APIRouter(tags=["updates"])

Db = Annotated[AsyncSession, Depends(get_db)]


class UpdateOut(BaseModel):
    # up_to_date | available | reinstall_required | register_first | preparing | not_set_up
    status: str
    version_name: str | None = None
    build: str | None = None
    notes: str | None = None
    size: int | None = None
    install_url: str | None = None
    message: str | None = None


def _bad_query(message: str):
    return api_error(422, "invalid_query", message)


def _normal_digest(digest: str) -> str:
    """SHA-256 hex as stored (lower case), from any case and colon pairs."""
    return digest.replace(":", "").strip().lower()


def _available(version: AppVersion, install_url: str) -> dict:
    return {"status": "available", "version_name": version.version_name,
            "build": version.build, "notes": version.notes, "size": version.size,
            "install_url": install_url}


async def _android(db: AsyncSession, package: str, version_code: int,
                   signing_digest: str) -> dict:
    app = await catalog.find_app(db, "android", package)
    current = await install_state.current_version(db, app) if app is not None else None
    if current is None or current.build_sort <= version_code:
        return {"status": "up_to_date"}
    if app.signing_digest and _normal_digest(signing_digest) != app.signing_digest:
        return {"status": "reinstall_required",
                "message": "This copy came from Google Play. Uninstall it and install from "
                           f"{install_state.public_url()} once to get updates."}
    return _available(current, install_state.apk_url(app, current))


async def _ios(db: AsyncSession, bundle_id: str, build_sort: int, profile_kind: str) -> dict:
    if not await catalog.apple_settings_ready(db):
        return {"status": "not_set_up", "message": catalog.ios_not_set_up_message()}
    app: App | None = await catalog.find_app(db, "ios", bundle_id)
    current = await install_state.current_version(db, app) if app is not None else None
    if current is None or current.build_sort <= build_sort:
        return {"status": "up_to_date"}
    # Only an Ad Hoc install means this device was in a profile we signed with.
    if profile_kind != "adhoc":
        return {"status": "register_first",
                "message": f"Add this device on {install_state.public_url()} first."}
    profile = await install_state.app_profile(db, app)
    if profile is None:
        return {"status": "preparing", "message": install_state.worded(install_state.PREPARING)}
    state, signed = await install_state.build_state(db, current, profile)
    if state == "refused":
        # Still "preparing" to the app, with the reason a new upload is needed.
        return {"status": "preparing",
                "message": signed.error or install_state.worded(install_state.BUILD_FAILED)}
    if signed is None:
        # A failure inside the retry window is still "preparing" to the app.
        template = install_state.BUILD_FAILED if state == "failed" else install_state.PREPARING
        return {"status": "preparing", "message": install_state.worded(template)}
    return _available(current, install_state.ios_install_url(signed))


@router.get("/updates", response_model=UpdateOut, response_model_exclude_none=True)
async def check_updates(
    db: Db,
    _: Annotated[Principal, Depends(kiosk_principal)],
    platform: Literal["android", "ios"],
    package: str | None = None,
    version_code: int | None = None,
    signing_digest: str = "",
    bundle_id: str | None = None,
    build: str | None = None,
    profile_kind: Literal["adhoc", "development", "none"] | None = None,
):
    if platform == "android":
        if not package or version_code is None:
            raise _bad_query("Android checks need package and version_code.")
        return await _android(db, package, version_code, signing_digest)

    if not bundle_id or build is None or profile_kind is None:
        raise _bad_query("iOS checks need bundle_id, build and profile_kind.")
    try:
        installed = ios_build_sort(build)
    except ValueError:
        raise _bad_query("The build isn't up to four dot-separated numbers.") from None
    answer = await _ios(db, bundle_id, installed, profile_kind)
    await db.commit()   # it may have queued re-signing
    return answer
