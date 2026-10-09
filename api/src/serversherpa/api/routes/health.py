"""Database health (Dev -> Database -> Health). Under the `devtools`
resource like the rest of the Database tab: view for every read here."""

from fastapi import APIRouter

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import HealthConnectionsOut, HealthSummaryOut
from serversherpa.devtools import health

router = APIRouter(prefix="/devtools/health", tags=["devtools"])

# module-level so the route signatures stay free of calls in defaults
_CAN_VIEW = require_permission("devtools", "view")


@router.get("/summary", response_model=HealthSummaryOut)
async def get_summary(db: DbSession, actor: AuthContext = _CAN_VIEW) -> HealthSummaryOut:
    return HealthSummaryOut(**await health.summary(db))


@router.get("/connections", response_model=HealthConnectionsOut)
async def get_connections(
        db: DbSession, actor: AuthContext = _CAN_VIEW) -> HealthConnectionsOut:
    return HealthConnectionsOut(groups=await health.connections(db))
