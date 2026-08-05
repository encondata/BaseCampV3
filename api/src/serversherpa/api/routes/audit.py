"""Audit log viewer API — the admin-facing read side of audit_log.
Read-only by design: audit rows are written exclusively by the audit
service inside mutation transactions; nothing edits or deletes them."""

import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import AuditLogItem
from serversherpa.db.models import AuditLog, Person

router = APIRouter(prefix="/audit", tags=["audit"])


def _require_global(actor: AuthContext) -> None:
    """audit's visible_to is global-only, so the resolver already hard-gates
    org actors — kept as defence in depth if the gate is ever widened."""
    if not actor.access.is_global:
        raise HTTPException(status_code=403, detail={"code": "forbidden"})


@router.get("", response_model=list[AuditLogItem])
async def list_audit(
    db: DbSession,
    actor: AuthContext = require_permission("audit", "view"),
    entity_type: str | None = None,
    action: str | None = None,
    actor_id: uuid.UUID | None = None,
    entity_id: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = Query(100, ge=1, le=500),
    offset: int = Query(0, ge=0),
) -> list[AuditLogItem]:
    _require_global(actor)
    query = (select(AuditLog, Person)
             .outerjoin(Person, Person.id == AuditLog.actor_person_id)
             .order_by(AuditLog.at.desc())
             .limit(limit).offset(offset))
    if entity_type is not None:
        query = query.where(AuditLog.entity_type == entity_type)
    if action is not None:
        query = query.where(AuditLog.action == action)
    if actor_id is not None:
        query = query.where(AuditLog.actor_person_id == actor_id)
    if entity_id is not None:
        query = query.where(AuditLog.entity_id == entity_id)
    if since is not None:
        query = query.where(AuditLog.at >= since)
    if until is not None:
        query = query.where(AuditLog.at <= until)

    rows = (await db.execute(query)).all()
    return [AuditLogItem(
        id=log.id, at=log.at, action=log.action,
        entity_type=log.entity_type, entity_id=log.entity_id,
        ip=str(log.ip) if log.ip else None,
        actor_id=log.actor_person_id,
        actor_name=person.display_name if person is not None else None,
        changes=log.changes or {},
    ) for log, person in rows]


@router.get("/facets")
async def audit_facets(
    db: DbSession,
    actor: AuthContext = require_permission("audit", "view"),
) -> dict:
    """Distinct filterable values — cheap enough while the log is young;
    revisit with a materialized summary if it ever isn't."""
    _require_global(actor)
    entity_types = sorted(await db.scalars(
        select(AuditLog.entity_type).distinct()))
    actions = sorted(await db.scalars(select(AuditLog.action).distinct()))
    return {"entity_types": entity_types, "actions": actions}
