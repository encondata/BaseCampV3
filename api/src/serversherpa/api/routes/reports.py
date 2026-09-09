"""Reports: definitions (the Available tab) and runs (History + the
Generate modal). Reads gate on reports:view; clone/generate on
reports:add; edit on reports:change; delete on reports:delete."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Response
from sqlalchemy import or_, select

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import (
    ReportDefinitionOut, ReportDefinitionUpdateIn, ReportDownloadOut,
    ReportRunCreateIn, ReportRunNotifyIn, ReportRunOut,
)
from serversherpa.db.models import Initiative, Person, ReportDefinition, ReportRun
from serversherpa.reports.registry import OptionsError, get_module
from serversherpa.services.audit import audit, diff, snapshot
from serversherpa.services.storage import presign_get

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


# ── runs ───────────────────────────────────────────────────────────

RUNS_DEFAULT_LIMIT = 100
RUNS_MAX_LIMIT = 500


def _run_out(run: ReportRun, definition_name: str, initiative_name: str,
             preferred: str | None, first: str, last: str) -> ReportRunOut:
    return ReportRunOut(
        id=run.id, definition_id=run.definition_id, definition_name=definition_name,
        report_type=run.report_type, initiative_id=run.initiative_id,
        initiative_name=initiative_name, options=run.options, status=run.status,
        error=run.error, requested_by=run.requested_by,
        requested_by_name=f"{preferred or first} {last}".strip(),
        requested_rank=run.requested_rank,
        notify=run.notify, filename=run.filename, size_bytes=run.size_bytes,
        started_at=run.started_at, finished_at=run.finished_at, created_at=run.created_at)


def _visible_runs(actor: AuthContext):
    """The history gate as a SQL predicate: own runs always; otherwise only
    runs requested at or below the actor's rank; and the initiative must be
    in the actor's scope."""
    q = (select(ReportRun, ReportDefinition.name, Initiative.name,
                Person.preferred_name, Person.first_name, Person.last_name)
         .join(ReportDefinition, ReportDefinition.id == ReportRun.definition_id)
         .join(Initiative, Initiative.id == ReportRun.initiative_id)
         .join(Person, Person.id == ReportRun.requested_by)
         .where(or_(ReportRun.requested_by == actor.person.id,
                    ReportRun.requested_rank <= actor.access.max_rank)))
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if cond is not None:
        q = q.where(cond)
    return q


async def _visible_run(db: DbSession, run_id: uuid.UUID, actor: AuthContext) -> ReportRunOut:
    row = (await db.execute(_visible_runs(actor).where(ReportRun.id == run_id))).first()
    if row is None:
        raise _err(404, "run_not_found")
    return _run_out(*row)


@router.post("/runs", response_model=ReportRunOut, status_code=201)
async def create_run(
    body: ReportRunCreateIn, db: DbSession,
    actor: AuthContext = require_permission("reports", "add"),
) -> ReportRunOut:
    d = await _definition(db, body.definition_id)
    ini = await db.get(Initiative, body.initiative_id)
    cond = scope_conditions("initiatives", actor.access, actor.person.id)
    if ini is None or ini.archived_at is not None or (
            cond is not None and await db.scalar(
                select(Initiative.id).where(Initiative.id == ini.id, cond)) is None):
        raise _err(404, "initiative_not_found")
    options = _validated_options(d.report_type, body.options)
    run = ReportRun(definition_id=d.id, report_type=d.report_type, initiative_id=ini.id,
                    options=options, requested_by=actor.person.id,
                    requested_rank=actor.access.max_rank, notify=body.notify)
    db.add(run)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="report_run", entity_id=str(run.id),
          action="create", changes={"definition": {"from": None, "to": d.name},
                                    "initiative_id": {"from": None, "to": str(ini.id)}})
    await db.commit()
    return await _visible_run(db, run.id, actor)


@router.get("/runs", response_model=list[ReportRunOut])
async def list_runs(
    db: DbSession, status: str | None = None, report_type: str | None = None,
    initiative_id: uuid.UUID | None = None, before: datetime | None = None,
    limit: int = RUNS_DEFAULT_LIMIT,
    actor: AuthContext = require_permission("reports", "view"),
) -> list[ReportRunOut]:
    q = _visible_runs(actor)
    if status is not None:
        q = q.where(ReportRun.status == status)
    if report_type is not None:
        q = q.where(ReportRun.report_type == report_type)
    if initiative_id is not None:
        q = q.where(ReportRun.initiative_id == initiative_id)
    if before is not None:
        q = q.where(ReportRun.created_at < before)
    q = (q.order_by(ReportRun.created_at.desc(), ReportRun.id.desc())
          .limit(max(1, min(limit, RUNS_MAX_LIMIT))))
    return [_run_out(*row) for row in (await db.execute(q)).all()]


@router.get("/runs/{run_id}", response_model=ReportRunOut)
async def get_run(
    run_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("reports", "view"),
) -> ReportRunOut:
    return await _visible_run(db, run_id, actor)


@router.get("/runs/{run_id}/download", response_model=ReportDownloadOut)
async def download_run(
    run_id: uuid.UUID, db: DbSession,
    actor: AuthContext = require_permission("reports", "view"),
) -> ReportDownloadOut:
    out = await _visible_run(db, run_id, actor)
    run = await db.get(ReportRun, run_id)
    if out.status != "completed" or not run.storage_key:
        raise _err(409, "not_ready")
    url = presign_get(run.storage_key, download_filename=run.filename)
    assert url is not None
    return ReportDownloadOut(url=url)


@router.patch("/runs/{run_id}", response_model=ReportRunOut)
async def set_run_notify(
    run_id: uuid.UUID, body: ReportRunNotifyIn, db: DbSession,
    actor: AuthContext = require_permission("reports", "view"),
) -> ReportRunOut:
    await _visible_run(db, run_id, actor)
    run = await db.get(ReportRun, run_id)
    if run.requested_by != actor.person.id:
        raise _err(403, "forbidden")
    run.notify = body.notify
    await db.commit()
    return await _visible_run(db, run_id, actor)
