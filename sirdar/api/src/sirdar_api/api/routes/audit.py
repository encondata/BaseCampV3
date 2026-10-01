import uuid
from datetime import datetime

from fastapi import APIRouter, Query
from pydantic import BaseModel
from sqlalchemy import select

from sirdar_api.api.deps import AuthContext, DbSession, require_permission
from sirdar_api.db.models import AuditLog, User

router = APIRouter(prefix="/audit", tags=["audit"])


class AuditLogItem(BaseModel):
    id: int
    at: datetime
    action: str
    entity_type: str
    entity_id: str | None
    ip: str | None
    actor_id: uuid.UUID | None
    actor_name: str | None
    changes: dict


@router.get("", response_model=list[AuditLogItem])
async def list_audit(db: DbSession, entity_type: str | None = None, action: str | None = None,
                     actor_id: uuid.UUID | None = None,
                     limit: int = Query(100, ge=1, le=500), offset: int = Query(0, ge=0),
                     actor: AuthContext = require_permission("audit", "view")):
    q = (select(AuditLog, User).outerjoin(User, User.person_id == AuditLog.actor_id)
         .order_by(AuditLog.at.desc(), AuditLog.id.desc()).limit(limit).offset(offset))
    if entity_type:
        q = q.where(AuditLog.entity_type == entity_type)
    if action:
        q = q.where(AuditLog.action == action)
    if actor_id:
        q = q.where(AuditLog.actor_id == actor_id)
    return [AuditLogItem(id=row.id, at=row.at, action=row.action, entity_type=row.entity_type,
                         entity_id=row.entity_id, ip=str(row.ip) if row.ip else None,
                         actor_id=row.actor_id,
                         actor_name=user.display_name if user else None, changes=row.changes)
            for row, user in (await db.execute(q)).all()]


@router.get("/facets")
async def facets(db: DbSession, actor: AuthContext = require_permission("audit", "view")):
    types = await db.scalars(select(AuditLog.entity_type).distinct())
    actions = await db.scalars(select(AuditLog.action).distinct())
    return {"entity_types": sorted(types), "actions": sorted(actions)}
