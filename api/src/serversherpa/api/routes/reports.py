"""Reports: definitions (the Available tab) and runs (History + the
Generate modal). Reads gate on reports:view; clone/generate on
reports:add; edit on reports:change; delete on reports:delete."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import select

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import ReportDefinitionOut, ReportDefinitionUpdateIn
from serversherpa.db.models import ReportDefinition
from serversherpa.reports.registry import OptionsError, get_module
from serversherpa.services.audit import audit, diff, snapshot

router = APIRouter(prefix="/reports", tags=["reports"])

DEFINITION_FIELDS = ["name", "description", "options"]


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _definition(db: DbSession, definition_id: uuid.UUID) -> ReportDefinition:
    d = await db.get(ReportDefinition, definition_id)
    if d is None or d.archived_at is not None:
        raise _err(404, "definition_not_found")
    return d


async def _name_taken(db: DbSession, name: str, *, exclude: uuid.UUID | None) -> bool:
    q = select(ReportDefinition.id).where(ReportDefinition.name == name,
                                          ReportDefinition.archived_at.is_(None))
    if exclude is not None:
        q = q.where(ReportDefinition.id != exclude)
    return (await db.scalar(q)) is not None


def _validated_options(report_type: str, options: dict) -> dict:
    try:
        return get_module(report_type).validate_options(options)
    except OptionsError as exc:
        raise _err(422, "invalid_options", problems=exc.problems) from None


@router.get("/definitions", response_model=list[ReportDefinitionOut])
async def list_definitions(
    db: DbSession, _actor: AuthContext = require_permission("reports", "view"),
) -> list[ReportDefinitionOut]:
    rows = await db.scalars(select(ReportDefinition)
                            .where(ReportDefinition.archived_at.is_(None))
                            .order_by(ReportDefinition.is_system.desc(), ReportDefinition.name))
    return list(rows)


@router.post("/definitions/{definition_id}/clone", response_model=ReportDefinitionOut,
             status_code=201)
async def clone_definition(
    definition_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("reports", "add"),
) -> ReportDefinitionOut:
    src = await _definition(db, definition_id)
    name = f"{src.name} (copy)"
    n = 2
    while await _name_taken(db, name, exclude=None):
        name = f"{src.name} (copy {n})"
        n += 1
    d = ReportDefinition(name=name, description=src.description,
                         report_type=src.report_type, options=dict(src.options),
                         is_system=False, created_by=actor.person.id)
    db.add(d)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="report_definition",
          entity_id=str(d.id), action="clone",
          changes={"source_id": {"from": None, "to": str(src.id)},
                   "name": {"from": None, "to": name}})
    await db.commit()
    await db.refresh(d)
    return d


@router.patch("/definitions/{definition_id}", response_model=ReportDefinitionOut)
async def update_definition(
    definition_id: uuid.UUID, body: ReportDefinitionUpdateIn, db: DbSession,
    actor: AuthContext = require_permission("reports", "change"),
) -> ReportDefinitionOut:
    d = await _definition(db, definition_id)
    before = snapshot(d, DEFINITION_FIELDS)
    patch = body.model_dump(exclude_unset=True)
    if "name" in patch:
        patch["name"] = patch["name"].strip()
        if await _name_taken(db, patch["name"], exclude=d.id):
            raise _err(409, "name_in_use")
    if "options" in patch:
        patch["options"] = _validated_options(d.report_type, patch["options"])
    for k, v in patch.items():
        setattr(d, k, v)
    d.updated_at = datetime.now(UTC)
    changes = diff(before, snapshot(d, DEFINITION_FIELDS))
    if changes:
        audit(db, actor_id=actor.person.id, entity_type="report_definition",
              entity_id=str(d.id), action="update", changes=changes)
    await db.commit()
    await db.refresh(d)
    return d


@router.delete("/definitions/{definition_id}", status_code=204)
async def delete_definition(
    definition_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("reports", "delete"),
) -> Response:
    d = await _definition(db, definition_id)
    if d.is_system:
        raise _err(409, "system_definition")
    d.archived_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="report_definition",
          entity_id=str(d.id), action="delete",
          changes={"name": {"from": d.name, "to": None}})
    await db.commit()
    return Response(status_code=204)
