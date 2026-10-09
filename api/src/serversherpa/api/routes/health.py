"""Database health (Dev -> Database -> Health). Under the `devtools`
resource like the rest of the Database tab: view for every read here."""

import logging

from botocore.exceptions import ClientError
from fastapi import APIRouter, HTTPException

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.routes.devtools import testing_session_unfinished
from serversherpa.api.schemas import (
    HealthConnectionsOut,
    HealthStorageOut,
    HealthSummaryOut,
    HealthTablesOut,
    HealthVacuumOut,
)
from serversherpa.devtools import health
from serversherpa.services import storage
from serversherpa.services.audit import audit

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/devtools/health", tags=["devtools"])

# module-level so the route signatures stay free of calls in defaults
_CAN_VIEW = require_permission("devtools", "view")
_CAN_CHANGE = require_permission("devtools", "change")


@router.get("/summary", response_model=HealthSummaryOut)
async def get_summary(db: DbSession, actor: AuthContext = _CAN_VIEW) -> HealthSummaryOut:
    return HealthSummaryOut(**await health.summary(db))


@router.get("/connections", response_model=HealthConnectionsOut)
async def get_connections(
        db: DbSession, actor: AuthContext = _CAN_VIEW) -> HealthConnectionsOut:
    return HealthConnectionsOut(groups=await health.connections(db))


@router.get("/tables", response_model=HealthTablesOut)
async def get_tables(db: DbSession, actor: AuthContext = _CAN_VIEW) -> HealthTablesOut:
    return HealthTablesOut(tables=await health.tables(db))


@router.post("/tables/{name}/vacuum", response_model=HealthVacuumOut)
async def vacuum_table(
        name: str, db: DbSession, actor: AuthContext = _CAN_CHANGE) -> HealthVacuumOut:
    # Same "unfinished" test as Cleanup and the Testing tab: a DB Testing
    # session owns the database's state until it is finished or reverted.
    if await testing_session_unfinished(db):
        raise HTTPException(status_code=409, detail={
            "code": "testing_session_active",
            "message": "A DB Testing session is in progress. Finish or revert it "
                       "before vacuuming tables."})
    # End this request's transaction (the permission and testing checks opened
    # one) before the long VACUUM: otherwise the session sits "idle in
    # transaction" for the whole run, which Health itself flags and which holds
    # back the database's cleanup horizon. The audit row below starts a new one.
    await db.commit()
    try:
        result = await health.vacuum_table(name)
    except health.UnknownTable:
        raise HTTPException(status_code=404, detail={
            "code": "unknown_table",
            "message": "That isn't a table in this database."}) from None
    except health.TableBusy:
        raise HTTPException(status_code=409, detail={
            "code": "table_busy",
            "message": "Another session is holding a lock on that table. "
                       "Try again in a moment."}) from None
    audit(db, actor_id=actor.person.id, entity_type="system", entity_id=result["table"]["name"],
          action="db.vacuum",
          changes={"table": result["table"]["name"], "duration_ms": result["duration_ms"]})
    await db.commit()
    return HealthVacuumOut(**result)


@router.get("/storage", response_model=HealthStorageOut)
async def get_storage(actor: AuthContext = _CAN_VIEW) -> HealthStorageOut:
    try:
        return HealthStorageOut(**await health.storage_usage())
    except health.STORAGE_ERRORS as exc:
        # Never echo or log the message: botocore's carries the endpoint URL
        # (and sometimes the bucket name). The class and S3 error code are
        # enough to tell an outage from a bad key.
        code = exc.response.get("Error", {}).get("Code") if isinstance(exc, ClientError) else None
        # a storage client that can't be built (bad endpoint / missing key) is
        # reported the same way, naming only the class of the underlying error
        cause = exc.cause if isinstance(exc, storage.StorageConfigError) else None
        logger.warning("storage usage failed: %s (code=%s%s)", type(exc).__name__, code,
                       f", cause={cause}" if cause else "")
        raise HTTPException(status_code=502, detail={
            "code": "storage_unavailable",
            "message": "File storage couldn't be reached. Try again in a moment."}) from None
