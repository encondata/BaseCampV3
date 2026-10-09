"""Database health (Dev -> Database -> Health). Under the `devtools`
resource like the rest of the Database tab: view for every read here."""

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
from serversherpa.services.audit import audit

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
    except health.STORAGE_ERRORS:
        # Never echo the exception: botocore messages carry the endpoint URL
        # (and sometimes the bucket name).
        raise HTTPException(status_code=502, detail={
            "code": "storage_unavailable",
            "message": "File storage couldn't be reached. Try again in a moment."}) from None
