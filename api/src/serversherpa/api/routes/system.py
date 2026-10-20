"""System surface: process registry (super_admin+) and per-process logs
(developer-only): paged reads, a 1 s-tailing WebSocket stream, and an
audited clear. Also: logging/env config, the admin controls (read-only
maintenance mode, worker pause, broadcast banner) — a public status
endpoint plus a settings:change-gated get/put — and Branding (the company
name and logo staff ID badges show)."""

import asyncio
import contextlib
import logging
import socket as _socket
import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import (
    APIRouter, Body, File, HTTPException, UploadFile, WebSocket, WebSocketDisconnect,
)
from sqlalchemy import update, delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert

from serversherpa.access.defaults import SUPER_ADMIN_RANK
from serversherpa.api.deps import (
    AuthContext, DbSession, authenticate_token, password_change_owed, require_permission,
)
from serversherpa.api.routes.attachments import MAX_IMAGE_BYTES, _sniff_image
from serversherpa.api.schemas import (
    BrandingIn, BrandingOut,
    RevokeAllSessionsOut, SecurityConfigIn, SecurityConfigOut,
    AiLookupConfigIn, AiLookupConfigOut,
    AdminConfigIn, AdminConfigOut, BackgroundStatusOut, LogEntryOut, LogPageOut, SystemProcessOut,
    SystemStatusOut,
)
from serversherpa.config import get_settings
from serversherpa.mail import email_enabled
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    AuthSession, LogEntry, SystemConfig, SystemProcess, TrustedDevice,
)
from serversherpa.services.audit import audit
from serversherpa.services.storage import delete_object, presign_get, put_object
from serversherpa.system.admin_config import read_admin_config
from serversherpa.system.config_store import read_section
from serversherpa.system.forwarders import (
    send_loki, send_syslog, transport_configured,
)
from serversherpa.system.logging_config import (
    apply_password_rule, mask_logging, validate_logging,
)
from serversherpa.system import env_file
from serversherpa.system.registry import derive_status

router = APIRouter(prefix="/system", tags=["system"])

_LEVELS = {"DEBUG": 10, "INFO": 20, "WARNING": 30, "ERROR": 40,
           "CRITICAL": 50}
_KIND_ORDER = {"service": 0, "worker": 1, "probe": 2}
STREAM_POLL_SECONDS = 1.0
STREAM_BATCH_CAP = 500
STREAM_PING_SECONDS = 30.0
STREAM_REAUTH_POLLS = 60


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _require_super_admin(actor: AuthContext) -> None:
    if not actor.access.is_global or actor.access.max_rank < SUPER_ADMIN_RANK:
        raise _err(403, "forbidden")


@router.get("/processes", response_model=list[SystemProcessOut])
async def list_processes(
    db: DbSession,
    actor: AuthContext = require_permission("dashboard", "view"),
) -> list[SystemProcessOut]:
    _require_super_admin(actor)
    now = datetime.now(UTC)
    rows = (await db.scalars(select(SystemProcess))).all()
    out = []
    for p in rows:
        status = derive_status(p.heartbeat_at, p.stopped_at, now, meta=p.meta)
        uptime = None
        if status in ("running", "paused") and p.started_at is not None:
            uptime = int((now - p.started_at).total_seconds())
        out.append(SystemProcessOut(
            name=p.name, kind=p.kind, status=status, pid=p.pid,
            hostname=p.hostname, started_at=p.started_at,
            heartbeat_at=p.heartbeat_at, stopped_at=p.stopped_at,
            uptime_seconds=uptime, meta=p.meta))
    out.sort(key=lambda p: (_KIND_ORDER.get(p.kind, 9), p.name))
    return out


# ── admin controls (read-only mode / worker pause / broadcast banner) ──

def _status_from(cfg: dict, background: BackgroundStatusOut | None = None) -> SystemStatusOut:
    banner = cfg["banner_message"].strip() if cfg["banner_enabled"] else ""
    return SystemStatusOut(
        read_only=cfg["read_only"],
        read_only_message=cfg["read_only_message"] if cfg["read_only"] else "",
        workers_paused=bool(cfg["read_only"] and cfg["pause_workers"]),
        banner=banner or None,
        totp_trust_days=get_settings().totp_trust_days,
        email_enabled=email_enabled(),
        password_reset_ttl_minutes=get_settings().password_reset_ttl_minutes,
        password_min_length=get_settings().password_min_length,
        background=background)


async def _background(db) -> BackgroundStatusOut | None:
    now = datetime.now(UTC)
    rows = (await db.scalars(
        select(SystemProcess).where(SystemProcess.kind == "worker"))).all()
    statuses = [derive_status(p.heartbeat_at, p.stopped_at, now, meta=p.meta) for p in rows]
    # a clean stop (deploy, deliberate shutdown) is not an outage
    statuses = [s for s in statuses if s != "stopped"]
    if not statuses:
        return None
    if "failed" in statuses:
        state = "down"
    elif "paused" in statuses:
        state = "paused"
    else:
        state = "running"
    alive = sum(1 for s in statuses if s in ("running", "paused"))
    return BackgroundStatusOut(state=state, running=alive, total=len(statuses))


@router.get("/status", response_model=SystemStatusOut)
async def system_status(db: DbSession) -> SystemStatusOut:
    """Public: the login page shows banners before anyone signs in; the
    status page reads worker health (counts only)."""
    return _status_from(await read_admin_config(db), await _background(db))


@router.get("/admin", response_model=AdminConfigOut)
async def get_admin_config(
    db: DbSession,
    actor: AuthContext = require_permission("settings", "change"),
) -> AdminConfigOut:
    return AdminConfigOut(**await read_admin_config(db))


@router.put("/admin", response_model=AdminConfigOut)
async def put_admin_config(
    body: AdminConfigIn,
    db: DbSession,
    actor: AuthContext = require_permission("settings", "change"),
) -> AdminConfigOut:
    stored = await read_admin_config(db)
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items()
             if v is not None}
    for key in ("read_only_message", "banner_message"):
        if key in patch:
            patch[key] = patch[key].strip()
    data = {**stored, **patch}
    if data["banner_enabled"] and not data["banner_message"]:
        raise _err(422, "banner_message_required")

    row = await db.get(SystemConfig, "admin")
    if row is None:
        row = SystemConfig(section="admin")
        db.add(row)
    row.data = data
    row.updated_at = datetime.now(UTC)
    row.updated_by = actor.person.id
    changes = {key: {"from": stored.get(key), "to": data[key]}
               for key in data if stored.get(key) != data[key]}
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="system",
              entity_id="admin", action="admin_config_update",
              changes=changes)
    await db.commit()
    return AdminConfigOut(**data)


SECURITY_SECTION = "security"
PASSWORD_EXPIRY_DAYS_RANGE = (1, 365)
PASSWORD_HISTORY_COUNT_RANGE = (0, 24)


@router.get("/security", response_model=SecurityConfigOut)
async def get_security_config(
    db: DbSession,
    actor: AuthContext = require_permission("settings", "view"),
) -> SecurityConfigOut:
    return SecurityConfigOut(**await read_section(db, SECURITY_SECTION))


@router.put("/security", response_model=SecurityConfigOut)
async def put_security_config(
    body: SecurityConfigIn,
    db: DbSession,
    actor: AuthContext = require_permission("settings", "change"),
) -> SecurityConfigOut:
    stored = await read_section(db, SECURITY_SECTION)
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items()
             if v is not None}
    data = {**stored, **patch}
    # required ⇒ enabled; disabling enrolment also drops the requirement
    if patch.get("two_factor_required"):
        data["two_factor_enabled"] = True
    if patch.get("two_factor_enabled") is False:
        data["two_factor_required"] = False

    lo, hi = PASSWORD_EXPIRY_DAYS_RANGE
    if not lo <= data["password_expiry_days"] <= hi:
        raise _err(422, "password_expiry_days_out_of_range")
    lo, hi = PASSWORD_HISTORY_COUNT_RANGE
    if not lo <= data["password_history_count"] <= hi:
        raise _err(422, "password_history_count_out_of_range")
    # the expiry clock starts when the switch goes on, never earlier
    if data["password_expiry_enabled"] and not stored.get("password_expiry_enabled"):
        data["password_expiry_since"] = datetime.now(UTC).isoformat()
    elif not data["password_expiry_enabled"]:
        data["password_expiry_since"] = None

    row = await db.get(SystemConfig, SECURITY_SECTION)
    if row is None:
        row = SystemConfig(section=SECURITY_SECTION)
        db.add(row)
    row.data = data
    row.updated_at = datetime.now(UTC)
    row.updated_by = actor.person.id
    changes = {key: {"from": stored.get(key), "to": data[key]}
               for key in data if stored.get(key) != data[key]}
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="system",
              entity_id=SECURITY_SECTION, action="security_config_update",
              changes=changes)
    await db.commit()
    return SecurityConfigOut(**data)


AI_LOOKUP_SECTION = "ai_lookup"


@router.get("/ai-lookup", response_model=AiLookupConfigOut)
async def get_ai_lookup_config(
    db: DbSession,
    actor: AuthContext = require_permission("settings", "view"),
) -> AiLookupConfigOut:
    return AiLookupConfigOut(**await read_section(db, AI_LOOKUP_SECTION))


@router.put("/ai-lookup", response_model=AiLookupConfigOut)
async def put_ai_lookup_config(
    body: AiLookupConfigIn,
    db: DbSession,
    actor: AuthContext = require_permission("settings", "change"),
) -> AiLookupConfigOut:
    stored = await read_section(db, AI_LOOKUP_SECTION)
    patch = {k: v for k, v in body.model_dump(exclude_unset=True).items()
             if v is not None}
    data = {**stored, **patch}
    row = await db.get(SystemConfig, AI_LOOKUP_SECTION)
    if row is None:
        row = SystemConfig(section=AI_LOOKUP_SECTION)
        db.add(row)
    row.data = data
    row.updated_at = datetime.now(UTC)
    row.updated_by = actor.person.id
    changes = {key: {"from": stored.get(key), "to": data[key]}
               for key in data if stored.get(key) != data[key]}
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="system",
              entity_id=AI_LOOKUP_SECTION, action="ai_lookup_config_update",
              changes=changes)
    await db.commit()
    return AiLookupConfigOut(**data)


# ── Branding (System settings › Branding) ──────────────────────────
# The company staff ID badges name and show (labels/people_badge.py). The
# logo is stored as uploaded (uncropped) under a key the server picks; its
# key lives in this section, where the cleanup sweep finds it.

BRANDING_SECTION = "branding"
BRANDING_LOGO_PREFIX = "branding/company-logo/"
# what a badge logo may be (no GIF: a logo is one still picture)
BRANDING_LOGO_TYPES = frozenset({"image/png", "image/jpeg", "image/webp"})
_branding_logger = logging.getLogger("serversherpa.system.branding")


def _branding_out(cfg: dict) -> BrandingOut:
    key = cfg.get("company_logo_key") or None
    return BrandingOut(company_name=cfg.get("company_name") or "", has_logo=key is not None,
                       logo_url=presign_get(key))


async def _locked_branding(db: DbSession) -> SystemConfig:
    """The branding row, created if missing and locked for this
    transaction, so two writes (a name and a logo, or two logos) never
    overwrite each other's change or leave a logo no row points at."""
    await db.execute(pg_insert(SystemConfig).values(section=BRANDING_SECTION, data={})
                     .on_conflict_do_nothing(index_elements=[SystemConfig.section]))
    return await db.get(SystemConfig, BRANDING_SECTION, with_for_update=True,
                        populate_existing=True)


async def _save_branding(db: DbSession, row: SystemConfig, actor: AuthContext,
                         data: dict) -> None:
    """Write the section (defaults merged in, as the other sections) and
    audit what changed. The caller commits."""
    stored = await read_section(db, BRANDING_SECTION)
    merged = {**stored, **data}
    row.data = merged
    row.updated_at = datetime.now(UTC)
    row.updated_by = actor.person.id
    changes = {key: {"from": stored.get(key), "to": merged[key]}
               for key in merged if stored.get(key) != merged[key]}
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="system",
              entity_id=BRANDING_SECTION, action="branding_update", changes=changes)


async def _drop_logo(key: str | None) -> None:
    """Delete a logo object nothing points at any more. Only a key these
    routes chose (under BRANDING_LOGO_PREFIX): whatever else a config row
    might hold is never deleted from here. Best effort: the config is
    already saved, so a failure only leaves an unused object."""
    if not key or not key.startswith(BRANDING_LOGO_PREFIX):
        return
    try:
        await delete_object(key)
    except Exception as exc:  # noqa: BLE001 - the change itself succeeded
        _branding_logger.warning("branding logo %s left behind: %s", key, exc)


@router.get("/branding", response_model=BrandingOut)
async def get_branding(
    db: DbSession,
    actor: AuthContext = require_permission("settings", "view"),
) -> BrandingOut:
    return _branding_out(await read_section(db, BRANDING_SECTION))


@router.patch("/branding", response_model=BrandingOut)
async def patch_branding(
    body: BrandingIn,
    db: DbSession,
    actor: AuthContext = require_permission("settings", "change"),
) -> BrandingOut:
    """The company name, trimmed; 422 `company_name_required` when blank."""
    name = body.company_name.strip()
    if not name:
        raise _err(422, "company_name_required")
    row = await _locked_branding(db)
    await _save_branding(db, row, actor, {"company_name": name})
    await db.commit()
    return _branding_out(await read_section(db, BRANDING_SECTION))


@router.put("/branding/logo", response_model=BrandingOut)
async def put_branding_logo(
    db: DbSession,
    file: Annotated[UploadFile, File()],
    actor: AuthContext = require_permission("settings", "change"),
) -> BrandingOut:
    """Upload (or replace) the company logo: PNG, JPEG or WebP, up to 5 MiB
    and 40 megapixels, stored as uploaded. The logo it replaces is deleted.
    413 `file_too_large`; 422 `empty_file`, `invalid_file_type`,
    `unreadable_image`, `image_too_large`."""
    from serversherpa.labels import image_prep    # Pillow, only when a logo arrives

    data = await file.read(MAX_IMAGE_BYTES + 1)
    if not data:
        raise _err(422, "empty_file")
    if len(data) > MAX_IMAGE_BYTES:
        raise _err(413, "file_too_large")
    sniffed = _sniff_image(data)
    if sniffed is None or sniffed[0] not in BRANDING_LOGO_TYPES:
        raise _err(422, "invalid_file_type")
    try:
        info = await asyncio.to_thread(image_prep.probe, data)
    except image_prep.ImageTooLarge as exc:
        raise _err(422, "image_too_large") from exc
    except image_prep.UnreadableImage as exc:
        raise _err(422, "unreadable_image") from exc
    key = f"{BRANDING_LOGO_PREFIX}{uuid.uuid4()}{info.ext}"
    await put_object(key, data, info.mime)
    try:
        row = await _locked_branding(db)
        old = (await read_section(db, BRANDING_SECTION)).get("company_logo_key")
        await _save_branding(db, row, actor, {"company_logo_key": key})
        await db.commit()
    except Exception:
        # the key was never committed, so nothing else can reach the object
        await db.rollback()
        await _drop_logo(key)
        raise
    await _drop_logo(old)
    return _branding_out(await read_section(db, BRANDING_SECTION))


@router.delete("/branding/logo", response_model=BrandingOut)
async def delete_branding_logo(
    db: DbSession,
    actor: AuthContext = require_permission("settings", "change"),
) -> BrandingOut:
    """Remove the company logo (its object is deleted). Staff badges print
    no logo until a new one is uploaded. A no-op without a logo."""
    row = await _locked_branding(db)
    old = (await read_section(db, BRANDING_SECTION)).get("company_logo_key")
    if old:
        await _save_branding(db, row, actor, {"company_logo_key": None})
    await db.commit()
    await _drop_logo(old)
    return _branding_out(await read_section(db, BRANDING_SECTION))


@router.post("/sessions/revoke-all", response_model=RevokeAllSessionsOut)
async def revoke_all_sessions(
    db: DbSession,
    actor: AuthContext = require_permission("settings", "change"),
) -> RevokeAllSessionsOut:
    """Sign everyone out everywhere — every live session family except the
    caller's own current one (so the admin pressing the button isn't
    dumped mid-action; they can sign themselves out from /me) — and forget
    every trusted browser too, so a revoked-out device can't skip the 2FA
    challenge on its next sign-in."""
    live = (await db.execute(
        select(AuthSession.family_id, AuthSession.person_id)
        .where(AuthSession.revoked_at.is_(None),
               AuthSession.family_id != actor.session.family_id))).all()
    families = {f for f, _ in live}
    people = {p for _, p in live}
    now = datetime.now(UTC)
    if families:
        await db.execute(
            update(AuthSession)
            .where(AuthSession.family_id.in_(families),
                   AuthSession.revoked_at.is_(None))
            .values(revoked_at=now, revoke_reason="admin"))
    await db.execute(
        update(TrustedDevice).where(TrustedDevice.revoked_at.is_(None))
        .values(revoked_at=now))
    audit(db, actor_id=actor.person.id, entity_type="auth",
          entity_id="all", action="sessions.revoke_all",
          changes={"revoked_sessions": len(live), "revoked_people": len(people)})
    await db.commit()
    return RevokeAllSessionsOut(revoked_sessions=len(live), revoked_people=len(people))


async def _no_probe(db: DbSession, name: str) -> None:
    row = await db.get(SystemProcess, name)
    if row is not None and row.kind == "probe":
        raise _err(404, "process_has_no_logs")


def _logs_query(name: str, min_level: str | None, q: str | None):
    stmt = select(LogEntry).where(LogEntry.process == name)
    if min_level:
        levelno = _LEVELS.get(min_level.upper())
        if levelno is None:
            raise _err(422, "unknown_level")
        stmt = stmt.where(LogEntry.levelno >= levelno)
    if q:
        stmt = stmt.where(LogEntry.message.ilike(f"%{q}%"))
    return stmt


@router.get("/processes/{name}/logs", response_model=LogPageOut)
async def get_process_logs(
    name: str,
    db: DbSession,
    min_level: str | None = None,
    q: str | None = None,
    before_id: int | None = None,
    limit: int = 200,
    actor: AuthContext = require_permission("devtools", "change"),
) -> LogPageOut:
    await _no_probe(db, name)
    limit = max(1, min(limit, 1000))
    stmt = _logs_query(name, min_level, q)
    if before_id is not None:
        stmt = stmt.where(LogEntry.id < before_id)
    rows = (await db.scalars(
        stmt.order_by(LogEntry.id.desc()).limit(limit + 1))).all()
    has_more = len(rows) > limit
    return LogPageOut(
        entries=[LogEntryOut.model_validate(r) for r in rows[:limit]],
        has_more=has_more)


@router.delete("/processes/{name}/logs")
async def clear_process_logs(
    name: str,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    await _no_probe(db, name)
    result = await db.execute(
        delete(LogEntry).where(LogEntry.process == name))
    deleted = result.rowcount or 0
    audit(db, actor_id=actor.person.id, entity_type="system",
          entity_id=name, action="logs_clear",
          changes={"process": name, "deleted": deleted})
    await db.commit()
    return {"deleted": deleted}


# The live tail's auth subprotocol. The browser opens the socket with the
# subprotocol list ["ss-bearer", "<access token>"], which the handshake
# carries as `Sec-WebSocket-Protocol: ss-bearer, <token>`; the server
# accepts "ss-bearer" so the browser completes the handshake.
WS_AUTH_SUBPROTOCOL = "ss-bearer"


def _token_from_subprotocols(header: str | None) -> str | None:
    """Pull the access token out of a `Sec-WebSocket-Protocol` header of
    the form `ss-bearer, <token>`. None when the header is missing, the
    first entry is not ss-bearer, or there is no second entry."""
    if not header:
        return None
    parts = [p.strip() for p in header.split(",")]
    if len(parts) < 2 or parts[0] != WS_AUTH_SUBPROTOCOL or not parts[1]:
        return None
    return parts[1]


@router.websocket("/processes/{name}/logs/stream")
async def stream_process_logs(ws: WebSocket, name: str) -> None:
    """Live tail. Browsers cannot set Authorization on WebSockets, so the
    access token rides the Sec-WebSocket-Protocol header as the second
    entry of the subprotocol list (`ss-bearer, <token>`) — never the URL,
    because query strings land in access logs and proxy logs. It is
    validated with the same machinery as HTTP before accept.

    Close codes: 4400 bad filter; 4401 unauthenticated (token missing,
    malformed, invalid, or the session ends mid-stream); 4403 forbidden
    (no devtools:change, a password change owed — a temp password, or one
    that had already expired at sign-in — or a kiosk-scoped session); 4404
    no such tailable process.

    Read-only maintenance mode is deliberately NOT applied here: a tail is
    a read, and enforce_read_only only gates mutating HTTP methods."""
    token = _token_from_subprotocols(ws.headers.get("sec-websocket-protocol"))
    min_level = ws.query_params.get("min_level")
    q = ws.query_params.get("q")

    if token is None:
        # no header, or the token offered some other way (e.g. `?token=`)
        await ws.close(code=4401)
        return

    maker = get_sessionmaker()
    async with maker() as db:
        try:
            actor = await authenticate_token(db, token)
        except HTTPException:
            await ws.close(code=4401)
            return
        # Mirror of get_current_user's kiosk-scope guard (403 kiosk_session
        # on HTTP): a kiosk login skips the 2FA challenge, so its session
        # may reach only the kiosk routes — never a portal-only log tail.
        if actor.session.client == "kiosk":
            await ws.close(code=4403)
            return
        # Mirror of get_current_user's forced-password-change guard (403
        # password_change_required on HTTP): a temp-password session, or
        # one that signed in with an already-expired password, may only
        # finish the auth lifecycle, so it may not open a tail either.
        if await password_change_owed(db, actor):
            await ws.close(code=4403)
            return
        if not actor.access.can("devtools", "change"):
            await ws.close(code=4403)
            return
        row = await db.get(SystemProcess, name)
        if row is not None and row.kind == "probe":
            await ws.close(code=4404)
            return
        try:
            _logs_query(name, min_level, q)      # validates min_level
        except HTTPException:
            await ws.close(code=4400)
            return
        cursor = await db.scalar(
            select(func.max(LogEntry.id)).where(
                LogEntry.process == name)) or 0

    await ws.accept(subprotocol=WS_AUTH_SUBPROTOCOL)
    idle = 0.0
    poll_count = 0
    try:
        while True:
            async with maker() as db:
                poll_count += 1
                if poll_count % STREAM_REAUTH_POLLS == 0:
                    session = await db.get(AuthSession, actor.session.id)
                    if (
                        session is None
                        or session.revoked_at is not None
                        or session.expires_at <= datetime.now(UTC)
                    ):
                        await ws.close(code=4401)
                        return
                stmt = _logs_query(name, min_level, q).where(
                    LogEntry.id > cursor
                ).order_by(LogEntry.id).limit(STREAM_BATCH_CAP)
                rows = (await db.scalars(stmt)).all()
                # cursor advances past filtered-out rows too
                latest = await db.scalar(
                    select(func.max(LogEntry.id)).where(
                        LogEntry.process == name,
                        LogEntry.id > cursor))
            if rows:
                cursor = max(cursor, rows[-1].id)
                if len(rows) < STREAM_BATCH_CAP and latest is not None:
                    cursor = max(cursor, latest)   # remainder was filtered out
                await ws.send_json({"entries": [
                    LogEntryOut.model_validate(r).model_dump(mode="json")
                    for r in rows]})
                idle = 0.0
            elif latest is not None:
                cursor = latest
            else:
                idle += STREAM_POLL_SECONDS
                if idle >= STREAM_PING_SECONDS:
                    await ws.send_json({"ping": True})
                    idle = 0.0
            await asyncio.sleep(STREAM_POLL_SECONDS)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        with contextlib.suppress(Exception):
            await ws.close()


# ── logging config (Plan 2) ────────────────────────────────────────

_config_logger = logging.getLogger("serversherpa.system.config")


@router.get("/config/logging")
async def get_logging_config(
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    return mask_logging(await read_section(db, "logging"))


@router.put("/config/logging")
async def put_logging_config(
    db: DbSession,
    body: dict = Body(...),
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    stored = await read_section(db, "logging")
    data = apply_password_rule(body, stored)
    errors = validate_logging(data)
    if errors:
        raise _err(422, "invalid_logging_config", fields=errors)

    row = await db.get(SystemConfig, "logging")
    if row is None:
        row = SystemConfig(section="logging")
        db.add(row)
    row.data = data
    row.updated_at = datetime.now(UTC)
    row.updated_by = actor.person.id
    before, after = mask_logging(stored), mask_logging(data)
    changes = {key: {"from": before.get(key), "to": after.get(key)}
               for key in after if before.get(key) != after.get(key)}
    audit(db, actor_id=actor.person.id, entity_type="system",
          entity_id="logging", action="logging_config_update",
          changes=changes)
    await db.commit()
    return mask_logging(data)


@router.post("/config/logging/test")
async def test_logging_config(
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    _config_logger.warning("Test event from System Config")
    cfg = await read_section(db, "logging")
    forwarded, error = False, None
    if transport_configured(cfg):
        row = {"process": "api", "level": "WARNING", "levelno": 30,
               "logger": "serversherpa.system.config",
               "message": "Test event from System Config", "extra": {},
               "at": datetime.now(UTC)}
        try:
            if cfg.get("transport", "loki") == "loki":
                await send_loki(cfg["loki"], [row], _socket.gethostname())
            else:
                await send_syslog(cfg["syslog"], [row],
                                  _socket.gethostname())
            forwarded = True
        except Exception as exc:
            error = str(exc)
    return {"logged": True, "forwarded": forwarded, "error": error}


# ── environment file (System Config ENV tab) ───────────────────────


@router.get("/env")
async def get_env(
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    path = env_file.default_env_path()
    return {"entries": env_file.read_entries(path),
            "missing": env_file.read_missing(
                path, env_file.default_example_path())}


@router.put("/env")
async def put_env(
    db: DbSession,
    body: dict = Body(...),
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    values = body.get("values")
    if not isinstance(values, dict) or not all(
            isinstance(v, str) for v in values.values()):
        raise _err(422, "invalid_env_update", unknown=[])
    descriptions = body.get("descriptions")
    if descriptions is None:
        descriptions = {}
    elif not isinstance(descriptions, dict) or not all(
            isinstance(v, str) for v in descriptions.values()):
        raise _err(422, "invalid_env_update", unknown=[])
    # A value or description containing any line-break character (as
    # defined by str.splitlines(), not just \n/\r) would splice a new
    # physical line into .env on rewrite, letting a devtools user inject a
    # hidden key (e.g. SS_DATABASE_URL) past the classification gate.
    # Reject up front — descriptions land in the same trailing-comment
    # slot as values, so they get the identical guard.
    if any(env_file.has_linebreak(v) for v in values.values()) or any(
            env_file.has_linebreak(v) for v in descriptions.values()):
        raise _err(422, "invalid_env_update", unknown=[])
    try:
        changed, added = env_file.apply_updates_detailed(
            env_file.default_env_path(), values, descriptions,
            example_path=env_file.default_example_path())
    except env_file.EnvUpdateError as exc:
        raise _err(422, "invalid_env_update", unknown=exc.unknown) from None
    if changed:
        audit(db, actor_id=actor.person.id, entity_type="system",
              entity_id="env", action="env_update",
              changes={"changed": sorted(changed),
                       "added": sorted(added)})
        await db.commit()
    return {"changed": sorted(changed)}


@router.post("/env/restart")
async def restart_processes(
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> dict:
    env_file.touch_sentinel()
    audit(db, actor_id=actor.person.id, entity_type="system",
          entity_id="env", action="env_restart", changes={})
    await db.commit()
    return {"restarting": True}
