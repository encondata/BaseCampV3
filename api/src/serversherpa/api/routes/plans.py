"""Project plans: an MS Project-style schedule per initiative (spec
2026-10-27-project-plans-design). The logic lives in serversherpa.plans;
these routes check access, parse bodies and map errors.

Every route requires its `project_plans` action first, then resolves the
initiative (or the plan) through the actor's initiatives scope, so an id
the actor cannot see reads as 404, never 403."""

import asyncio
import dataclasses
import logging
import uuid
from datetime import UTC, date, datetime
from typing import Annotated

from fastapi import APIRouter, Query, Request, Response
from sqlalchemy import Text, cast, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.exceptions import HTTPException as StarletteHTTPException

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.db.models import Initiative
from serversherpa.db.ordering import natural
from serversherpa.plans import (
    excel,
    importer,
    mspdi,
    notices,
    ops,
    plan_writes,
    service,
    templates,
    timeline,
)
from serversherpa.plans.calendar import CalendarError, WorkCalendar
from serversherpa.plans.floating import format_floating, parse_floating, plan_now
from serversherpa.plans.models import PlanTask, PlanTemplate
from serversherpa.plans.ops_progress import UpdateProjectOp
from serversherpa.plans.schemas import (
    BaselineIn,
    OpsIn,
    OpsOut,
    PlanCreateIn,
    PlanImportOut,
    PlanOut,
    PlanPatchIn,
    PlanTemplateOut,
    PlanTemplatePatchIn,
    PlanTemplateSaveIn,
    PlanTimelineOut,
    PlanVersionOut,
    UpdateProjectIn,
)
from serversherpa.plans.service import PlanState, err
from serversherpa.services.audit import audit
from serversherpa.services.storage import content_disposition

router = APIRouter(tags=["plans"])
logger = logging.getLogger("serversherpa.api.routes.plans")

PLAN_UNIQUE = "project_plans_initiative_id_key"
TEMPLATE_UNIQUE = "plan_templates_name_key"


@router.get("/plans/timeline", response_model=PlanTimelineOut)
async def plans_timeline(
    db: DbSession,
    first: Annotated[date, Query(alias="from")],
    last: Annotated[date, Query(alias="to")],
    actor: AuthContext = require_permission("project_plans", "view"),
) -> PlanTimelineOut:
    """The all-initiatives Timeline page's plan overlay (plans/timeline.py):
    the flagged tasks finishing `from`..`to` (days, both included) and each
    visible plan's % complete and next flagged task. Scope-filtered like GET
    /initiatives. 422 `bad_range` when `to` is before `from`."""
    if last < first:
        raise err(422, "bad_range")
    return await timeline.timeline_out(db, actor, first, last)


@router.get("/initiatives/{initiative_id}/plan", response_model=PlanOut)
async def get_plan(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "view"),
) -> PlanOut:
    await service.visible_initiative(db, initiative_id, actor)
    plan = await service.plan_of_initiative(db, initiative_id)
    if plan is None:
        raise err(404, "no_plan")
    return await service.plan_out(db, await service.load_state(db, plan), actor)


@router.post("/initiatives/{initiative_id}/plan", response_model=PlanOut, status_code=201)
async def create_plan(
    initiative_id: uuid.UUID,
    body: PlanCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "add"),
) -> PlanOut:
    """A new plan: empty on the system calendar, or from `template_id`
    (404 `template_not_found`) with the template's tasks, links, calendar
    and settings, its dates shifted to `project_start`."""
    initiative = await service.visible_initiative(db, initiative_id, actor)
    if await service.plan_of_initiative(db, initiative_id) is not None:
        raise err(409, "plan_exists")
    # a date-only start begins at the default start of the calendar the new
    # plan gets (from a template: its week and times, the system's exceptions)
    template = None
    if body.template_id is not None:
        template = await service.template_or_404(db, body.template_id)
    try:
        calendar = WorkCalendar.from_json(await service.new_plan_calendar(db, template))
    except CalendarError as exc:
        raise service.calendar_error(exc) from None
    try:
        project_start = parse_floating(body.project_start,
                                       date_only_time=calendar.default_start)
    except ValueError:
        raise err(422, "bad_field", field="project_start") from None
    owner_id = body.owner_id
    if "owner_id" not in body.model_fields_set:
        owner_id = await _default_owner(db, actor)
    elif owner_id is not None and not await service.is_staff(db, owner_id):
        raise err(422, "bad_owner")
    try:
        plan = await service.create_plan(db, initiative, actor, project_start=project_start,
                                         owner_id=owner_id, template=template)
        await db.commit()
    except IntegrityError as exc:
        _plan_exists(exc)
        await db.rollback()
        raise err(409, "plan_exists") from None
    return await service.plan_out(db, await service.load_state(db, plan), actor)


async def _default_owner(db: AsyncSession, actor: AuthContext) -> uuid.UUID | None:
    """A new plan's owner when none is sent: the creator when they could be
    named its owner (the same staff check); otherwise none — a default
    never refuses the plan. (An explicit null still means no owner.)"""
    person_id = actor.person.id if actor.person is not None else None
    if person_id is not None and await service.is_staff(db, person_id):
        return person_id
    return None


def _plan_exists(exc: IntegrityError) -> None:
    """Re-raise `exc` unless it is another create for the same initiative
    winning the race (the caller answers 409 `plan_exists`)."""
    if PLAN_UNIQUE not in str(getattr(exc, "orig", "")) and PLAN_UNIQUE not in str(exc):
        raise exc


@router.delete("/initiatives/{initiative_id}/plan", status_code=204)
async def delete_plan(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "delete"),
) -> None:
    await service.visible_initiative(db, initiative_id, actor)
    plan = await service.plan_of_initiative(db, initiative_id, lock=True)
    if plan is None:
        raise err(404, "no_plan")
    tasks = await db.scalar(
        select(func.count()).select_from(PlanTask).where(PlanTask.plan_id == plan.id))
    audit(db, actor_id=actor.person.id, entity_type="project_plan", entity_id=str(plan.id),
          action="plan_delete",
          changes={"initiative_id": str(initiative_id), "tasks": tasks})
    # tasks, links, assignments and reminder rows go with it (FK cascade)
    await db.delete(plan)
    await db.commit()


@router.post("/plans/{plan_id}/ops", response_model=OpsOut)
async def post_ops(
    plan_id: uuid.UUID,
    body: OpsIn,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> OpsOut:
    """One atomic batch of edits (plans/ops.py). Every restore op must carry
    the server's signature for this plan; anything but a progress-only
    batch needs an unlocked plan and `base_version` equal to its version.
    People the batch newly assigned are told in the same transaction
    (plans/notices.py), so a failed batch tells nobody; the notices run in
    a savepoint, so a failing notice never fails the edit."""
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    ops.check_restores(plan.id, body.ops)
    if not ops.is_progress_only(body.ops):
        if plan.locked_at is not None:
            raise err(409, "plan_locked")
        if body.base_version != plan.version:
            raise err(409, "plan_changed", version=plan.version)
    run = await ops.run_batch(db, plan, body.ops, actor)
    await _assignment_notices(db, run, actor)
    await db.commit()
    return run.out


# set while assignment notices keep failing: logged once per outage
_notices_failing = {"failed": False}


async def _assignment_notices(db: AsyncSession, run: ops.BatchRun, actor: AuthContext) -> None:
    """Tell the people the batch newly assigned, in a savepoint: when that
    fails its rows are rolled back and the edit is committed without them.
    Only the exception's class is logged (its text can carry SQL
    parameters: rendered emails)."""
    try:
        async with db.begin_nested():
            await notices.assignment_notices(db, run.state, run.newly_assigned, actor,
                                             run.settings)
    except Exception as exc:  # noqa: BLE001 — a notice must never fail the edit
        if not _notices_failing["failed"]:
            logger.warning("could not send the assignment notices for plan %s: %s",
                           run.state.plan.id, type(exc).__name__)
        _notices_failing["failed"] = True
    else:
        _notices_failing["failed"] = False


@router.post("/plans/{plan_id}/update-project", response_model=OpsOut)
async def update_project(
    plan_id: uuid.UUID,
    body: UpdateProjectIn,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> OpsOut:
    """MS Project's Update Project: stores the status date (null = now)
    and, with `complete_through`, completes every incomplete leaf finishing
    by then and marks every one spanning it on track through it (never
    lowering a %), under the completion rules (plans/ops_progress.py). A
    progress edit: no version to match, and accepted on a locked plan. Its
    `inverse` puts the tasks back; the status date stays. Statuses that
    change only with the status date are not in `tasks` (UpdateProjectIn)."""
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    try:
        end_of_day = service.calendar_of(plan).default_end
    except CalendarError as exc:
        raise service.calendar_error(exc) from None
    moments = {}
    for name in ("status_date", "complete_through"):
        text = getattr(body, name)
        try:
            moments[name] = None if text is None else parse_floating(
                text, date_only_time=end_of_day)
        except ValueError:
            raise err(422, "bad_field", field=name) from None
    plan.status_date = moments["status_date"]
    run = await ops.run_batch(
        db, plan, [UpdateProjectOp(through=moments["complete_through"], confirm=body.confirm)],
        actor, changes={name: format_floating(value) for name, value in moments.items()})
    await db.commit()
    return run.out


async def _answer(db: DbSession, state: PlanState, actor: AuthContext) -> PlanOut:
    """The plan after a plan-level write, serialized inside the write's
    transaction, then committed."""
    out = await service.plan_out(db, state, actor)
    await db.commit()
    return out


@router.patch("/plans/{plan_id}", response_model=PlanOut)
async def patch_plan(
    plan_id: uuid.UUID,
    body: PlanPatchIn,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> PlanOut:
    """Plan settings: the overrides, calendar, project start, timezone,
    status date and owner (PlanPatchIn has the rules)."""
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    state = await plan_writes.patch_plan(db, plan, body, actor)
    return await _answer(db, state, actor)


@router.post("/plans/{plan_id}/lock", response_model=PlanOut)
async def lock_plan(
    plan_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> PlanOut:
    """Lock the schedule: then only progress edits (ops.is_progress_only,
    Update project) and a PATCH of the status date or owner are accepted."""
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    plan_writes.set_lock(db, plan, actor, locked=True)
    return await _answer(db, await service.load_state(db, plan), actor)


@router.delete("/plans/{plan_id}/lock", response_model=PlanOut)
async def unlock_plan(
    plan_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> PlanOut:
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    plan_writes.set_lock(db, plan, actor, locked=False)
    return await _answer(db, await service.load_state(db, plan), actor)


@router.post("/plans/{plan_id}/baseline", response_model=PlanOut)
async def set_baseline(
    plan_id: uuid.UUID,
    db: DbSession,
    body: BaselineIn | None = None,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> PlanOut:
    """Set the baseline (the one there is): every task's start, finish and
    duration. 409 `baseline_exists` {set_at} unless `replace`."""
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    state = await plan_writes.set_baseline(db, plan, actor,
                                           replace=body is not None and body.replace)
    return await _answer(db, state, actor)


@router.delete("/plans/{plan_id}/baseline", response_model=PlanOut)
async def clear_baseline(
    plan_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> PlanOut:
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    state = await plan_writes.clear_baseline(db, plan, actor)
    return await _answer(db, state, actor)


@router.get("/plans/{plan_id}/version", response_model=PlanVersionOut)
async def plan_version(
    plan_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "view"),
) -> PlanVersionOut:
    """The plan's version, polled by an open tab to notice another admin's
    change; every write bumps it."""
    plan = await service.plan_for_actor(db, plan_id, actor)
    return await plan_writes.version_out(db, plan)


# --- import and export (plans/importer.py, plans/mspdi.py, plans/excel.py) ----------

# room for the multipart form's boundaries and part headers around the file
_FORM_OVERHEAD = 64 * 1024


def _download_name(initiative: Initiative, suffix: str) -> str:
    """`<code or name> - Project plan<suffix>`, with no path separator."""
    label = (initiative.code or initiative.name or "Project").replace("/", "-").replace("\\", "-")
    return f"{label} - Project plan{suffix}"


@router.get("/plans/{plan_id}/export.xml")
async def export_xml(
    plan_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "view"),
) -> Response:
    """The plan as MS Project XML (MSPDI, plans/mspdi.py): its calendar,
    tasks with outline, durations, links, constraints, deadlines and
    progress, and the people and partners it assigns. Never task colors."""
    plan = await service.plan_for_actor(db, plan_id, actor)
    state = await service.load_state(db, plan)
    initiative = await db.get(Initiative, plan.initiative_id)
    try:
        units = service.calendar_of(plan).units
    except CalendarError as exc:
        raise service.calendar_error(exc) from None
    content = mspdi.export_xml(state, initiative.name, units,
                               resource_names=await mspdi.resource_names(db, state))
    return Response(content, media_type="application/xml", headers={
        "Content-Disposition": content_disposition(_download_name(initiative, ".xml"))})


@router.get("/plans/{plan_id}/export.xlsx")
async def export_xlsx(
    plan_id: uuid.UUID,
    db: DbSession,
    columns: str | None = None,
    actor: AuthContext = require_permission("project_plans", "view"),
) -> Response:
    """The plan's sheet as an Excel workbook (plans/excel.py): `columns` is
    the sheet's visible column keys (`id,name,duration,...`; its icon
    column is skipped, ID and Task Name are always there; none means the
    sheet's default set; a key the sheet doesn't have is 422 `bad_field`
    {field: columns}), then Outline Level, and Color when a task has one.
    Built in a worker thread: a large plan takes a second or two."""
    try:
        keys = excel.column_keys(columns)
    except ValueError:
        raise err(422, "bad_field", field="columns") from None
    plan = await service.plan_for_actor(db, plan_id, actor)
    state = await service.load_state(db, plan)
    initiative = await db.get(Initiative, plan.initiative_id)
    try:
        units = service.calendar_of(plan).units
    except CalendarError as exc:
        raise service.calendar_error(exc) from None
    settings = await service.settings_of(db, plan)
    outline = await service.tasks_out(db, state)
    content = await asyncio.to_thread(excel.export_xlsx, state, outline, units, keys,
                                      show_times=settings.show_times)
    return Response(content, media_type=excel.XLSX_MIME, headers={
        "Content-Disposition": content_disposition(_download_name(initiative, ".xlsx"))})


class _TooLarge(Exception):
    """The upload passed the cap while it was being read."""


async def _import_upload(request: Request) -> tuple[str, str, bytes]:
    """The multipart `file` of an import: (its filename, its content type,
    its bytes). The 20 MB cap (importer.MAX_FILE_BYTES) holds while the
    body is read: a declared length past it (plus the form's own overhead)
    is refused before anything is read, and the stream is counted as it
    arrives, so a chunked body is cut off there too. 413 `file_too_large`; 422
    `bad_file` {message} when there is no single `file`."""
    cap = importer.MAX_FILE_BYTES + _FORM_OVERHEAD
    too_large = err(413, "file_too_large", limit=importer.MAX_FILE_BYTES)
    declared = request.headers.get("content-length")
    if declared is not None and declared.isascii() and declared.isdigit() and (
            len(declared) > len(str(cap)) or int(declared) > cap):
        raise too_large
    received = 0

    async def receive():
        nonlocal received
        message = await request.receive()
        if message["type"] == "http.request":
            received += len(message.get("body", b""))
            if received > cap:
                raise _TooLarge
        return message

    try:
        form = await Request(request.scope, receive).form(max_files=1, max_fields=8,
                                                          max_part_size=1024)
    except _TooLarge:
        raise too_large from None
    except StarletteHTTPException:
        # Starlette's own form limits: more than one file, a malformed form
        raise err(422, "bad_file", message="Send one file, as the form's `file`.") from None
    try:
        upload = form.get("file")
        if upload is None or isinstance(upload, str):
            raise err(422, "bad_file", message="No file was sent.")
        content = await upload.read(importer.MAX_FILE_BYTES + 1)
        if len(content) > importer.MAX_FILE_BYTES:
            raise too_large
        return upload.filename or "", upload.content_type or "", content
    finally:
        await form.close()


# what an upload is, by its extension, else by its content type
_FILE_KINDS = {".xml": "xml", ".xlsx": "xlsx", ".csv": "csv"}
_MEDIA_KINDS = {"application/xml": "xml", "text/xml": "xml", excel.XLSX_MIME: "xlsx",
                "text/csv": "csv", "application/csv": "csv",
                "text/comma-separated-values": "csv"}
_REFUSED_FILES = {
    ".xls": "Excel 97-2003 workbooks (.xls) can't be read, so save it as an Excel "
            "Workbook (.xlsx) first.",
    ".mpp": "MS Project files (.mpp) can't be read directly, so save it from MS Project "
            "as XML first.",
}
_CHOOSE_FILE = "Choose an MS Project XML (.xml), Excel workbook (.xlsx) or CSV (.csv) file."


def _file_kind(filename: str, content_type: str) -> str:
    """"xml", "xlsx" or "csv" by the file's extension, else by its content
    type (a browser may send a .csv as application/vnd.ms-excel); 422
    `bad_file` {message} for anything else."""
    name = filename.strip().lower()
    suffix = name[name.rfind("."):] if "." in name else ""
    if suffix in _FILE_KINDS:
        return _FILE_KINDS[suffix]
    if suffix in _REFUSED_FILES:
        raise err(422, "bad_file", message=_REFUSED_FILES[suffix])
    kind = _MEDIA_KINDS.get(content_type.partition(";")[0].strip().lower())
    if kind is None:
        raise err(422, "bad_file", message=_CHOOSE_FILE)
    return kind


async def _parse_upload(filename: str, content_type: str, content: bytes
                        ) -> importer.ParsedPlan:
    """The uploaded file as a ParsedPlan: MS Project XML (plans/mspdi.py),
    an Excel workbook or a CSV (plans/excel.py), parsed in a worker thread
    (a 20 MB file takes seconds, which the event loop must not wait out).
    A file it cannot read is answered as its ImportFileError says."""
    kind = _file_kind(filename, content_type)
    parse = {"xml": mspdi.parse_xml, "xlsx": excel.parse_workbook, "csv": excel.parse_csv}[kind]
    try:
        return await asyncio.to_thread(parse, content)
    except importer.ImportFileError as exc:
        raise err(exc.status, exc.code, **exc.extra) from None


def _import_out(rows: list[importer.ImportRow], problems: list[str],
                version: int | None) -> PlanImportOut:
    return PlanImportOut(rows=[dataclasses.asdict(row) for row in rows], problems=problems,
                         summary=importer.summary(rows, problems), version=version)


@router.post("/plans/{plan_id}/import", response_model=PlanImportOut)
async def import_into_plan(
    plan_id: uuid.UUID,
    request: Request,
    db: DbSession,
    dry_run: bool = True,
    mode: str = "append",
    base_version: int | None = None,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> PlanImportOut:
    """Import a file (multipart `file`: MS Project XML, an Excel .xlsx or a
    CSV, by extension or content type) into the plan (plans/importer.py):
    a change to an existing plan, so `project_plans:change` like every
    other plan write (creating a plan from a file is an add). `mode=append`
    adds its tasks after the last task, `fill` fills an empty plan and
    takes the file's calendar, project start and status date (409
    `plan_not_empty` on a plan with tasks). `dry_run=1` (the default)
    answers the rows applying would create, with their problems and how
    far the schedule moves each, and the version it saw, and writes
    nothing; `dry_run=0` applies them in one transaction (one ops batch:
    the version bumped, audited `plan_import`) and answers the new
    version. An apply sent with `base_version` (the version the preview
    saw) is 409 `plan_changed` {version} when the plan has changed since; a
    dry run ignores it. 409 `plan_locked` on a locked plan; the file's
    errors are 413 `file_too_large`, 422 `bad_file` {message} (one this
    can't read, or isn't one of the three kinds), `too_many_rows` {limit};
    the engine's 422s (a link cycle) as on any batch."""
    if mode not in importer.IMPORT_MODES:
        raise err(422, "bad_field", field="mode")
    # read before the plan row is locked: a slow upload holds no lock
    parsed = await _parse_upload(*await _import_upload(request))
    plan = await service.plan_for_actor(db, plan_id, actor, lock=True)
    if not dry_run and base_version is not None and base_version != plan.version:
        raise err(409, "plan_changed", version=plan.version)
    state = await service.load_state(db, plan)
    if dry_run:
        # read now: the preview's rolled-back savepoint expires the plan row
        version = plan.version
        rows = await importer.preview(db, state, parsed, mode, actor)
    else:
        rows = await importer.apply(db, state, parsed, mode, actor)
        version = plan.version
        await db.commit()
    return _import_out(rows, importer.file_problems(parsed, mode), version)


async def _new_plan_start(db: AsyncSession, initiative: Initiative,
                          parsed: importer.ParsedPlan) -> datetime:
    """A plan made from a file starts at the file's project start, else
    its earliest task start (a day alone at the new plan's calendar's
    default start: the system default calendar's), else today at that
    default start in the plan's zone."""
    if parsed.project_start is not None:
        return parsed.project_start
    try:
        calendar = WorkCalendar.from_json(await service.new_plan_calendar(db, None))
    except CalendarError as exc:
        raise service.calendar_error(exc) from None
    starts = [importer.dated(task, "start", calendar) for task in parsed.tasks
              if task.start is not None]
    if starts:
        return min(starts)
    today = plan_now(await service.plan_zone(db, initiative)).date()
    return datetime.combine(today, calendar.default_start)


@router.post("/initiatives/{initiative_id}/plan/import", response_model=PlanImportOut)
async def import_new_plan(
    initiative_id: uuid.UUID,
    request: Request,
    db: DbSession,
    dry_run: bool = True,
    actor: AuthContext = require_permission("project_plans", "add"),
) -> PlanImportOut:
    """Create the initiative's plan from a file (multipart `file`): made as
    POST /initiatives/{id}/plan makes one (owner: the creator when staff),
    starting at the file's project start, then filled from the file
    (`fill` mode: its calendar too). `dry_run=1` (the default) answers the
    rows and creates nothing (its `version` is null: there is no plan yet);
    `dry_run=0` creates and fills the plan in one transaction (audited
    `plan_create` and `plan_import`) and answers its version. 409
    `plan_exists`; the file's errors as on POST /plans/{id}/import."""
    initiative = await service.visible_initiative(db, initiative_id, actor)
    parsed = await _parse_upload(*await _import_upload(request))
    if await service.plan_of_initiative(db, initiative_id) is not None:
        raise err(409, "plan_exists")
    start = await _new_plan_start(db, initiative, parsed)
    owner_id = await _default_owner(db, actor)

    async def create_and_fill() -> tuple[list[importer.ImportRow], int]:
        plan = await service.create_plan(db, initiative, actor, project_start=start,
                                         owner_id=owner_id)
        rows = await importer.apply(db, await service.load_state(db, plan), parsed, "fill",
                                    actor)
        return rows, plan.version

    try:
        if dry_run:
            async with db.begin_nested() as savepoint:
                rows, _version = await create_and_fill()
                await savepoint.rollback()
            version = None
        else:
            rows, version = await create_and_fill()
            await db.commit()
    except IntegrityError as exc:
        _plan_exists(exc)
        await db.rollback()
        raise err(409, "plan_exists") from None
    return _import_out(rows, importer.file_problems(parsed, "fill"), version)


# --- templates (plans/templates.py) -------------------------------------------------


def _template_name(text: str | None) -> str:
    """A template name, trimmed: 1-120 characters, else 422 `bad_field`."""
    name = (text or "").strip()
    if not name or len(name) > templates.MAX_NAME:
        raise err(422, "bad_field", field="name")
    return name


def _template_description(text: str | None) -> str | None:
    """A description, trimmed (blank = none): up to 1,000 characters."""
    description = (text or "").strip()
    if len(description) > templates.MAX_DESCRIPTION:
        raise err(422, "bad_field", field="description")
    return description or None


async def _name_taken(db: AsyncSession, name: str, but: uuid.UUID | None = None) -> bool:
    """True when another template has `name`, ignoring case (CITEXT)."""
    stmt = select(PlanTemplate.id).where(PlanTemplate.name == name)
    if but is not None:
        stmt = stmt.where(PlanTemplate.id != but)
    return await db.scalar(stmt.limit(1)) is not None


async def _templates_out(db: AsyncSession, template_id: uuid.UUID | None = None
                         ) -> list[PlanTemplateOut]:
    """Every template (or just `template_id`) by name, naturally sorted,
    without its data: the task count is read in SQL."""
    task_count = func.coalesce(func.jsonb_array_length(PlanTemplate.data["tasks"]), 0)
    stmt = select(PlanTemplate.id, PlanTemplate.name, PlanTemplate.description,
                  task_count.label("task_count"), PlanTemplate.created_by,
                  PlanTemplate.updated_at)
    if template_id is not None:
        stmt = stmt.where(PlanTemplate.id == template_id)
    rows = (await db.execute(
        stmt.order_by(natural(cast(PlanTemplate.name, Text)), PlanTemplate.id))).all()
    names = await service.person_names(db, [row.created_by for row in rows])
    return [PlanTemplateOut(id=row.id, name=row.name, description=row.description,
                            task_count=row.task_count,
                            created_by_name=names.get(row.created_by),
                            updated_at=row.updated_at)
            for row in rows]


async def _flush_template(db: AsyncSession) -> None:
    """Flush a new or renamed template: another save or rename to the same
    name at once trips the unique index, 409 `template_exists`."""
    try:
        await db.flush()
    except IntegrityError as exc:
        if TEMPLATE_UNIQUE not in str(getattr(exc, "orig", "")) and TEMPLATE_UNIQUE not in str(exc):
            raise
        await db.rollback()
        raise err(409, "template_exists") from None


@router.get("/plan-templates", response_model=list[PlanTemplateOut])
async def list_templates(
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "view"),
) -> list[PlanTemplateOut]:
    """Every plan template, by name. Templates belong to no initiative."""
    return await _templates_out(db)


@router.post("/plans/{plan_id}/save-as-template", response_model=PlanTemplateOut,
             status_code=201)
async def save_as_template(
    plan_id: uuid.UUID,
    body: PlanTemplateSaveIn,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "add"),
) -> PlanTemplateOut:
    """Save the plan's structure as a new template (plans/templates.py,
    snapshot): names, outline, durations, links, constraints, deadlines,
    notes, colors, the calendar and the settings overrides, every date as
    an offset from the project start; never assignees, progress or the
    baseline. 409 `template_exists` when the name is taken (ignoring case)."""
    plan = await service.plan_for_actor(db, plan_id, actor)
    name = _template_name(body.name)
    description = _template_description(body.description)
    if await _name_taken(db, name):
        raise err(409, "template_exists")
    data = templates.snapshot(await service.load_state(db, plan))
    now = datetime.now(UTC)
    template = PlanTemplate(id=uuid.uuid4(), name=name, description=description, data=data,
                            created_by=actor.person.id, updated_by=actor.person.id,
                            created_at=now, updated_at=now)
    db.add(template)
    await _flush_template(db)
    audit(db, actor_id=actor.person.id, entity_type="plan_template", entity_id=str(template.id),
          action="plan_template_save",
          changes={"plan_id": str(plan.id), "initiative_id": str(plan.initiative_id),
                   "name": name, "tasks": len(data["tasks"]), "links": len(data["links"])})
    out = (await _templates_out(db, template.id))[0]
    await db.commit()
    return out


@router.patch("/plan-templates/{template_id}", response_model=PlanTemplateOut)
async def patch_template(
    template_id: uuid.UUID,
    body: PlanTemplatePatchIn,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "change"),
) -> PlanTemplateOut:
    """Rename a template or change its description (PlanTemplatePatchIn);
    audited `plan_template_update` with each field's from/to. A PATCH that
    changes nothing writes nothing."""
    template = await service.template_or_404(db, template_id)
    sent = body.model_fields_set
    new: dict = {}
    if "name" in sent:
        new["name"] = _template_name(body.name)
    if "description" in sent:
        new["description"] = _template_description(body.description)
    changes = {key: {"from": getattr(template, key), "to": value}
               for key, value in new.items() if getattr(template, key) != value}
    if changes:
        if "name" in changes and await _name_taken(db, new["name"], but=template.id):
            raise err(409, "template_exists")
        for key in changes:
            setattr(template, key, new[key])
        template.updated_at, template.updated_by = datetime.now(UTC), actor.person.id
        await _flush_template(db)
        audit(db, actor_id=actor.person.id, entity_type="plan_template",
              entity_id=str(template.id), action="plan_template_update", changes=changes)
    out = (await _templates_out(db, template.id))[0]
    await db.commit()
    return out


@router.delete("/plan-templates/{template_id}", status_code=204)
async def delete_template(
    template_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("project_plans", "delete"),
) -> None:
    """Delete a template; plans made from it keep their tasks."""
    template = await service.template_or_404(db, template_id)
    tasks = template.data.get("tasks") if isinstance(template.data, dict) else None
    audit(db, actor_id=actor.person.id, entity_type="plan_template", entity_id=str(template.id),
          action="plan_template_delete",
          changes={"name": template.name,
                   "tasks": len(tasks) if isinstance(tasks, list) else 0})
    await db.delete(template)
    await db.commit()
