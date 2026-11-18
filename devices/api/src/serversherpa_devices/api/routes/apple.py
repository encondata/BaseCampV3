"""Apple settings: the team's App Store Connect API key (.p8) and its Apple
Distribution certificate (.p12 and password). Saved once by an admin; no
answer ever carries the secrets."""

import datetime as dt
from collections.abc import AsyncIterator
from typing import Annotated, Literal

import httpx
from fastapi import APIRouter, Depends, File, Form, Request, Response, UploadFile
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa_devices import catalog
from serversherpa_devices.api.routes import api_error
from serversherpa_devices.apple import asc
from serversherpa_devices.apple.settings import (
    AppleSettingsError,
    is_configured,
    read_certificate,
)
from serversherpa_devices.auth.deps import client_ip, require
from serversherpa_devices.auth.main_api import MainApiClient, Principal, get_main_api
from serversherpa_devices.config import get_settings
from serversherpa_devices.db.engine import get_db
from serversherpa_devices.db.models import App, AppleSettings, IosProfile
from serversherpa_devices.services.secrets import SecretError, seal, unseal

router = APIRouter(tags=["apple"])

Db = Annotated[AsyncSession, Depends(get_db)]
MainApi = Annotated[MainApiClient, Depends(get_main_api)]
Changer = Annotated[Principal, Depends(require("change"))]

FILE_LIMIT = 64 * 1024        # a .p8 is ~250 bytes, a .p12 a few KB
FIELD_MAX = 200
LABELS = {"team_id": "Team ID", "issuer_id": "Issuer ID", "key_id": "Key ID",
          "p8": "API key (.p8)", "p12": "Distribution certificate (.p12)",
          "p12_password": "Certificate password"}
# Non-secret columns: the audit trail shows their before and after.
_AUDITED = ("team_id", "issuer_id", "key_id", "cert_name", "cert_serial", "cert_expires_at",
            "asc_certificate_id")


async def get_asc_http() -> AsyncIterator[httpx.AsyncClient]:
    """The HTTP client for App Store Connect calls (overridden in tests)."""
    async with httpx.AsyncClient(timeout=asc.TIMEOUT) as client:
        yield client


AscHttp = Annotated[httpx.AsyncClient, Depends(get_asc_http)]


class ProfileOut(BaseModel):
    app_name: str
    expires_at: dt.datetime


class AppleOut(BaseModel):
    configured: bool
    team_id: str | None
    key_id: str | None
    issuer_id: str | None
    cert_name: str | None
    cert_expires_at: dt.datetime | None
    profiles: list[ProfileOut]
    ios_owner_url: str | None


class ClearIn(BaseModel):
    confirm: Literal["clear"]


async def _apple_out(db: AsyncSession, row: AppleSettings | None) -> dict:
    profiles = (await db.execute(
        select(App.name, IosProfile.expires_at).join(App, App.id == IosProfile.app_id)
        .order_by(App.name, App.identifier))).all()
    return {"configured": is_configured(row),
            "team_id": row.team_id if row else None,
            "key_id": row.key_id if row else None,
            "issuer_id": row.issuer_id if row else None,
            "cert_name": row.cert_name if row else None,
            "cert_expires_at": row.cert_expires_at if row else None,
            "profiles": [{"app_name": name, "expires_at": expires} for name, expires in profiles],
            "ios_owner_url": get_settings().ios_owner_url or None}


async def _locked_row(db: AsyncSession) -> AppleSettings | None:
    return await db.scalar(select(AppleSettings).where(AppleSettings.id == 1)
                           .with_for_update().execution_options(populate_existing=True))


def _audit_value(value: object) -> object:
    return value.isoformat() if isinstance(value, dt.datetime) else value


@router.get("/apple", response_model=AppleOut)
async def get_apple(db: Db, _: Changer):
    return await _apple_out(db, await db.get(AppleSettings, 1))


async def _file(part: UploadFile | None, name: str) -> bytes | None:
    """An uploaded file's bytes; None when the part is absent or empty."""
    if part is None:
        return None
    data = await part.read(FILE_LIMIT + 1)
    if len(data) > FILE_LIMIT:
        raise api_error(422, "file_too_large", f"The {LABELS[name]} file is too large.")
    return data or None


def _stored(row: AppleSettings | None, column: str, name: str) -> bytes | None:
    sealed = getattr(row, column) if row is not None else None
    if sealed is None:
        return None
    try:
        return unseal(sealed)
    except SecretError:
        raise api_error(422, "stored_secret_unreadable",
                        f"The saved {LABELS[name]} can't be read. Upload it again.") from None


@router.put("/apple", response_model=AppleOut)
async def put_apple(
    request: Request, db: Db, main_api: MainApi, http: AscHttp, principal: Changer,
    team_id: Annotated[str, Form(max_length=FIELD_MAX)] = "",
    issuer_id: Annotated[str, Form(max_length=FIELD_MAX)] = "",
    key_id: Annotated[str, Form(max_length=FIELD_MAX)] = "",
    p12_password: Annotated[str, Form(max_length=FIELD_MAX)] = "",
    p8: Annotated[UploadFile | None, File()] = None,
    p12: Annotated[UploadFile | None, File()] = None,
):
    fields = {"team_id": team_id.strip(), "issuer_id": issuer_id.strip(),
              "key_id": key_id.strip()}
    new_p8, new_p12 = await _file(p8, "p8"), await _file(p12, "p12")
    new_password = p12_password or None

    # An omitted file (or password) keeps the saved one.
    row = await db.get(AppleSettings, 1)
    p8_bytes = new_p8 or _stored(row, "p8_enc", "p8")
    p12_bytes = new_p12 or _stored(row, "p12_enc", "p12")
    password_bytes = (new_password.encode() if new_password is not None
                      else None if new_p12 else _stored(row, "p12_password_enc", "p12_password"))
    present = {**fields, "p8": p8_bytes, "p12": p12_bytes, "p12_password": password_bytes}
    missing = [LABELS[name] for name in LABELS if not present[name]]
    if missing:
        raise api_error(422, "missing_parts", f"Add the missing parts: {', '.join(missing)}.")
    await db.rollback()   # no transaction held open through Apple's answer

    try:
        cert = read_certificate(p12_bytes, password_bytes.decode())
    except AppleSettingsError as exc:
        raise api_error(422, "bad_certificate", exc.message) from None
    try:
        client = asc.AscClient(fields["key_id"], fields["issuer_id"], p8_bytes, http=http)
    except ValueError:
        raise api_error(422, "bad_api_key", "The API key (.p8) can't be read.") from None
    try:
        found = await client.find_certificate_by_serial(cert.serial)
    except asc.AscError as exc:
        if exc.status in (401, 403):
            raise api_error(422, "api_key_refused",
                            f"Apple refused the API key: {exc.detail}") from None
        raise api_error(502, "apple_unavailable",
                        f"App Store Connect couldn't check the settings: {exc.detail}") from None
    if found is None:
        raise api_error(422, "certificate_not_listed",
                        f"Apple doesn't list this certificate on team {fields['team_id']}.")

    # Save exactly what was checked, under the row lock.
    await db.execute(insert(AppleSettings).values(id=1).on_conflict_do_nothing())
    row = await _locked_row(db)
    before = {name: getattr(row, name) for name in _AUDITED}
    after = {**fields, "cert_name": cert.name, "cert_serial": cert.serial,
             "cert_expires_at": cert.expires_at, "asc_certificate_id": found.id}
    changes = {name: {"from": _audit_value(before[name]), "to": _audit_value(after[name])}
               for name in _AUDITED if before[name] != after[name]}
    for name, plain in (("p8", p8_bytes), ("p12", p12_bytes), ("p12_password", password_bytes)):
        column = f"{name}_enc"
        current = getattr(row, column)
        try:
            same = current is not None and unseal(current) == plain
        except SecretError:
            same = False
        if not same:
            setattr(row, column, seal(plain))
            changes.setdefault("replaced", []).append(name)
    if not changes:
        await db.rollback()
        return await _apple_out(db, await db.get(AppleSettings, 1))

    for name, value in after.items():
        setattr(row, name, value)
    row.updated_by = principal.person_id
    row.updated_by_name = principal.display_name
    row.updated_at = dt.datetime.now(dt.UTC)
    # Profiles name the certificate they were made for: after any change
    # (a renewed certificate above all) they are made again, and their new
    # UUIDs re-sign every app's current version.
    await catalog.queue_job(db, "rebuild_profiles", {})
    await db.commit()
    await main_api.audit(actor=principal.person_id, entity_type="appdist_apple",
                         entity_id="apple", action="update", changes=changes,
                         ip=client_ip(request))
    return await _apple_out(db, row)


@router.delete("/apple", status_code=204)
async def clear_apple(body: ClearIn, request: Request, db: Db, main_api: MainApi,
                      principal: Changer):
    row = await _locked_row(db)
    if row is None:
        return Response(status_code=204)
    changes = {name: {"from": _audit_value(getattr(row, name)), "to": None}
               for name in _AUDITED if getattr(row, name) is not None}
    await db.execute(delete(AppleSettings).where(AppleSettings.id == 1))
    await db.commit()
    await main_api.audit(actor=principal.person_id, entity_type="appdist_apple",
                         entity_id="apple", action="clear", changes=changes,
                         ip=client_ip(request))
    return Response(status_code=204)
