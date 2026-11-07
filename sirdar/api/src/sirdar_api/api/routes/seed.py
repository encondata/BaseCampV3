"""Seed Data: browse a snapshot in the scratch Postgres and cut seed
snapshots with recipes. The router's guard gives every endpoint its
seed_data:view check and its 409 scratch_not_configured (SIRDAR_SCRATCH_URL
blank or unusable); an endpoint that needs more adds require_permission
for that action only."""

import logging
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Literal

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel

from sirdar_api.api.deps import AuthContext, CurrentUser, DbSession
from sirdar_api.config import get_settings
from sirdar_api.db.models import Snapshot
from sirdar_api.seed import SeedError, browse, closure, scratch

log = logging.getLogger(__name__)

# SeedError codes and their HTTP status (anything else answers 400).
_STATUS = {"scratch_unavailable": 503, "scratch_not_configured": 409, "restore_failed": 409,
           "no_primary_key": 409, "table_not_found": 404, "column_not_found": 404}


async def _seed_ready(user: CurrentUser) -> AuthContext:
    """Router guard: signed in, allowed to see Seed Data, scratch configured."""
    if not user.access.can("seed_data", "view"):
        raise HTTPException(status_code=403, detail={"code": "forbidden"})
    if not scratch.configured(get_settings()):
        raise HTTPException(status_code=409, detail={"code": "scratch_not_configured"})
    return user


router = APIRouter(prefix="/seed", tags=["seed"],
                   dependencies=[Depends(_seed_ready)])


async def _snapshot(db, snapshot_id: uuid.UUID) -> Snapshot:
    snap = await db.get(Snapshot, snapshot_id)
    if snap is None:
        raise HTTPException(status_code=404, detail={"code": "snapshot_not_found"})
    return snap


@router.post("/snapshots/{snapshot_id}/open")
async def open_snapshot(snapshot_id: uuid.UUID, db: DbSession):
    """Restore the snapshot into its browse database (in the background)."""
    snap = await _snapshot(db, snapshot_id)
    if snap.status != "ready" or not snap.bundle_file:
        raise HTTPException(status_code=409, detail={"code": "snapshot_not_ready"})
    return {"status": scratch.start_restore(get_settings(), snap)}


@router.get("/snapshots/{snapshot_id}")
async def snapshot_status(snapshot_id: uuid.UUID, db: DbSession):
    await _snapshot(db, snapshot_id)
    return {"status": scratch.status(snapshot_id)}


def _http(e: SeedError) -> HTTPException:
    """A SeedError as the API answers it: its code only (never a Postgres
    message, which may quote the snapshot's rows)."""
    return HTTPException(status_code=_STATUS.get(e.code, 400), detail={"code": e.code})


@asynccontextmanager
async def _browse_conn(db, snapshot_id: uuid.UUID
                       ) -> AsyncIterator[tuple[asyncpg.Connection, str]]:
    """(connection, database name) for the snapshot's browse database, for
    one request (closed after it). The snapshot must have been opened (and
    be ready)."""
    snap = await _snapshot(db, snapshot_id)
    current = scratch.status(snap.id)
    if current != "ready":
        raise HTTPException(status_code=409,
                            detail={"code": "snapshot_not_open", "status": current})
    settings = get_settings()
    try:
        name = await scratch.ensure_restored(settings, snap)
        try:
            conn = await scratch.connect(settings, name)
        except SeedError:
            raise                                 # scratch_not_configured
        except Exception as e:  # noqa: BLE001 - asyncpg's messages may quote the server
            log.warning("couldn't connect to the scratch database for snapshot %s: %s",
                        snap.id, type(e).__name__)
            raise SeedError("scratch_unavailable") from None
    except SeedError as e:
        raise _http(e) from None
    try:
        yield conn, name
    except SeedError as e:
        raise _http(e) from None
    except (OSError, asyncpg.PostgresError, asyncpg.InterfaceError) as e:
        # A lost connection, or the server cancelling or shutting down: the
        # scratch server's trouble, told by type only (messages may quote rows).
        log.warning("lost the scratch database for snapshot %s: %s", snap.id, type(e).__name__)
        raise _http(SeedError("scratch_unavailable")) from None
    finally:
        await conn.close()


@router.get("/snapshots/{snapshot_id}/tables")
async def list_tables(snapshot_id: uuid.UUID, db: DbSession):
    async with _browse_conn(db, snapshot_id) as (conn, name):
        return await browse.tables(conn, name)


@router.get("/snapshots/{snapshot_id}/tables/{table}/rows")
async def table_rows(snapshot_id: uuid.UUID, table: str, db: DbSession,
                     page: int = Query(1, ge=1, le=10**9),
                     size: int = Query(50, ge=1, le=1000),
                     sort: str | None = None,
                     dir: Literal["asc", "desc"] = "asc",
                     filter_col: str = "", filter: str = ""):
    async with _browse_conn(db, snapshot_id) as (conn, name):
        return await browse.rows(conn, table, page=page, size=size, sort=sort or None,
                                 direction=dir, filter_col=filter_col, needle=filter,
                                 db_name=name)


@router.get("/snapshots/{snapshot_id}/tables/{table}/keys")
async def table_keys(snapshot_id: uuid.UUID, table: str, db: DbSession,
                     filter_col: str = "", filter: str = ""):
    """Every matching row's primary key, for Check all / Deselect all."""
    async with _browse_conn(db, snapshot_id) as (conn, _):
        return await browse.keys(conn, table, filter_col=filter_col, needle=filter)


class TableSelection(BaseModel):
    mode: Literal["rows", "all"]
    pks: list[dict[str, str]] = []


class ResolveIn(BaseModel):
    tables: dict[str, TableSelection] = {}


@router.post("/snapshots/{snapshot_id}/resolve")
async def resolve(snapshot_id: uuid.UUID, body: ResolveIn, db: DbSession):
    """The rows the selection can't exist without (needed rows), why each
    was added, and the ticked keys the snapshot doesn't have."""
    tables = {name: sel.model_dump() for name, sel in body.tables.items()}
    async with _browse_conn(db, snapshot_id) as (conn, _):
        return await closure.resolve(conn, tables)
