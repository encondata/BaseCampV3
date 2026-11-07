"""Seed Data: browse a snapshot in the scratch Postgres and cut seed
snapshots with recipes. Every endpoint needs seed_data:view, and answers
409 scratch_not_configured while SIRDAR_SCRATCH_URL is blank."""

import uuid

from fastapi import APIRouter, Depends, HTTPException

from sirdar_api.api.deps import AuthContext, CurrentUser, DbSession, require_permission
from sirdar_api.config import get_settings
from sirdar_api.db.models import Snapshot
from sirdar_api.seed import scratch


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
async def open_snapshot(snapshot_id: uuid.UUID, db: DbSession,
                        actor: AuthContext = require_permission("seed_data", "view")):
    """Restore the snapshot into its browse database (in the background)."""
    snap = await _snapshot(db, snapshot_id)
    if snap.status != "ready" or not snap.bundle_file:
        raise HTTPException(status_code=409, detail={"code": "snapshot_not_ready"})
    return {"status": scratch.start_restore(get_settings(), snap)}


@router.get("/snapshots/{snapshot_id}")
async def snapshot_status(snapshot_id: uuid.UUID, db: DbSession,
                          actor: AuthContext = require_permission("seed_data", "view")):
    await _snapshot(db, snapshot_id)
    return {"status": scratch.status(snapshot_id)}
