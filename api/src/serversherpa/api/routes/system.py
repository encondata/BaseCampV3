"""System surface: process registry (super_admin+) and per-process logs
(developer-only): paged reads, a 1 s-tailing WebSocket stream, and an
audited clear. Config endpoints arrive with Plan 2."""

import asyncio
import contextlib
import logging
import socket as _socket
from datetime import UTC, datetime

from fastapi import (
    APIRouter, Body, HTTPException, WebSocket, WebSocketDisconnect,
)
from sqlalchemy import delete, func, select

from serversherpa.api.deps import (
    AuthContext, DbSession, authenticate_token, require_permission,
)
from serversherpa.api.schemas import (
    LogEntryOut, LogPageOut, SystemProcessOut,
)
from serversherpa.db.engine import get_sessionmaker
from serversherpa.db.models import (
    AuthSession, LogEntry, SystemConfig, SystemProcess,
)
from serversherpa.services.audit import audit
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

SUPER_ADMIN_RANK = 80
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
        status = derive_status(p.heartbeat_at, p.stopped_at, now)
        uptime = None
        if status == "running" and p.started_at is not None:
            uptime = int((now - p.started_at).total_seconds())
        out.append(SystemProcessOut(
            name=p.name, kind=p.kind, status=status, pid=p.pid,
            hostname=p.hostname, started_at=p.started_at,
            heartbeat_at=p.heartbeat_at, stopped_at=p.stopped_at,
            uptime_seconds=uptime, meta=p.meta))
    out.sort(key=lambda p: (_KIND_ORDER.get(p.kind, 9), p.name))
    return out


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


@router.websocket("/processes/{name}/logs/stream")
async def stream_process_logs(ws: WebSocket, name: str) -> None:
    """Live tail. Browsers cannot set Authorization on WebSockets, so
    the access token rides the `token` query param; it is validated
    with the same machinery as HTTP before accept."""
    token = ws.query_params.get("token", "")
    min_level = ws.query_params.get("min_level")
    q = ws.query_params.get("q")

    maker = get_sessionmaker()
    async with maker() as db:
        try:
            actor = await authenticate_token(db, token)
        except HTTPException:
            await ws.close(code=4401)
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

    await ws.accept()
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
    return {"entries": env_file.read_entries(env_file.default_env_path())}


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
    try:
        changed = env_file.apply_updates(
            env_file.default_env_path(), values)
    except env_file.EnvUpdateError as exc:
        raise _err(422, "invalid_env_update", unknown=exc.unknown) from None
    if changed:
        audit(db, actor_id=actor.person.id, entity_type="system",
              entity_id="env", action="env_update",
              changes={"changed": sorted(changed)})
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
