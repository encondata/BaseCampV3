"""Bulk Actions › Create a move in steps — /bulk/move-setup. The wizard's
state is one server-side draft (imports/move_setup.py); these routes edit it,
run the From-To check without a move, and queue the create, which the import
worker applies in one transaction. Admin bulk rank, a global actor, and
initiatives/containers/trucks add; a draft is visible only to its creator."""

import uuid
from datetime import UTC, datetime
from pathlib import PurePosixPath

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from serversherpa.api.bulk_routes import require_bulk_rank
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.routes.initiatives import IMPORT_EXTENSIONS, MAKE_MODEL_MODES
from serversherpa.api.schemas import (
    ImportJobOut, MoveSetupCratesIn, MoveSetupMoveIn, MoveSetupOut, MoveSetupPatchIn,
    MoveSetupTrucksIn,
)
from serversherpa.db.models import ImportJob
from serversherpa.imports import move_setup
from serversherpa.imports.naming import CRATE_MAX, TRUCK_MAX, NamingError, generate_names
from serversherpa.imports.parsing import MAX_BYTES
from serversherpa.logistics import bulk_create as container_create
from serversherpa.services.audit import audit
from serversherpa.services.initiatives import ref_problem
from serversherpa.services.storage import put_object

router = APIRouter(prefix="/bulk/move-setup", tags=["bulk"])


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _guard(actor: AuthContext) -> None:
    """Admin bulk rank + a global actor (require_bulk_rank), and every kind
    of record the create writes. Runs before anything is looked up."""
    require_bulk_rank(actor)
    if not (actor.access.can("containers", "add") and actor.access.can("trucks", "add")):
        raise _err(403, "forbidden")


async def _draft(db: DbSession, draft_id: uuid.UUID, actor: AuthContext, *,
                 lock: bool = False) -> ImportJob:
    """Only the creator's own draft; anyone else's id reads as missing. A
    mutating route locks the row so an edit and a create serialize."""
    job = await db.get(ImportJob, draft_id, with_for_update=lock or None,
                       populate_existing=lock)
    if job is None or job.kind != move_setup.KIND or job.created_by != actor.person.id:
        raise _err(404, "draft_not_found")
    return job


def _require_editable(job: ImportJob) -> None:
    if job.status not in move_setup.EDITABLE:
        raise _err(409, "draft_not_editable")


async def _move_data(db: DbSession, body: MoveSetupMoveIn) -> dict:
    typed = body.model_dump(exclude_none=True)
    typed["initiative_type"] = "move"
    if not (typed.get("name") or "").strip():
        raise _err(422, "name_required")
    if not typed.get("origin_site_id"):
        raise _err(422, "origin_required")
    if not typed.get("destination_site_id"):
        raise _err(422, "destination_required")
    if problem := await ref_problem(db, typed):
        code, extra = problem
        raise _err(422, code, **extra)
    stored = body.model_dump(mode="json", exclude_none=True)
    stored["initiative_type"] = "move"
    stored["name"] = stored["name"].strip()
    return stored


async def _crates_data(db: DbSession, body: MoveSetupCratesIn) -> dict:
    data = body.model_dump()
    data["convention"] = data["convention"].strip()
    try:
        generate_names(data["convention"], data["count"], data["start"], max_count=CRATE_MAX)
        container_create.check_tags(data["tags"], data["count"])
        if data["container_type"]:
            await container_create.check_vocab(db, data["container_type"], None)
    except NamingError as exc:
        raise _err(422, "invalid_naming", message=exc.message) from None
    except container_create.ContainerBulkError as exc:
        raise _err(exc.status, exc.code, **exc.extra) from None
    return data


def _trucks_data(body: MoveSetupTrucksIn) -> dict:
    data = body.model_dump()
    data["convention"] = data["convention"].strip()
    try:
        generate_names(data["convention"], data["count"], data["start"], max_count=TRUCK_MAX)
    except NamingError as exc:
        raise _err(422, "invalid_naming", message=exc.message) from None
    return data


async def _out(db: DbSession, job: ImportJob, *, with_previews: bool = False) -> MoveSetupOut:
    return MoveSetupOut(
        id=job.id, status=job.status, error=job.error, payload=job.payload,
        initiative_id=job.initiative_id, total_rows=job.total_rows,
        processed_rows=job.processed_rows, results=job.results, created_at=job.created_at,
        previews=(await move_setup.previews(db, job.payload)
                  if with_previews and job.payload else None))


@router.post("", response_model=MoveSetupOut, status_code=201)
async def create_draft(
    body: MoveSetupMoveIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> MoveSetupOut:
    _guard(actor)
    move = await _move_data(db, body)
    job = ImportJob(kind=move_setup.KIND, initiative_id=None, created_by=actor.person.id,
                    filename=move["name"], status="preview", phase="preview",
                    payload=move_setup.empty_payload(move))
    move_setup.reopen(job)
    db.add(job)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type="initiative", entity_id=None,
          action="move_setup_draft_create",
          changes={"draft_id": {"from": None, "to": str(job.id)},
                   "name": {"from": None, "to": move["name"]}})
    await db.commit()
    return await _out(db, job)


@router.get("/{draft_id}", response_model=MoveSetupOut)
async def get_draft(
    draft_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> MoveSetupOut:
    _guard(actor)
    return await _out(db, await _draft(db, draft_id, actor))


@router.patch("/{draft_id}", response_model=MoveSetupOut)
async def update_draft(
    draft_id: uuid.UUID,
    body: MoveSetupPatchIn,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> MoveSetupOut:
    _guard(actor)
    job = await _draft(db, draft_id, actor, lock=True)
    _require_editable(job)
    payload = dict(job.payload or {})
    if body.move is not None:
        payload["move"] = await _move_data(db, body.move)
        job.filename = payload["move"]["name"]
    if body.crates is not None:
        payload["crates"] = await _crates_data(db, body.crates)
    if body.trucks is not None:
        payload["trucks"] = _trucks_data(body.trucks)
    for section in body.skip:
        payload[section] = None
        if section == "assets":
            await move_setup.retire_check_jobs(db, job.id)
    job.payload = payload
    move_setup.reopen(job)
    await db.commit()
    return await _out(db, job, with_previews=True)


@router.post("/{draft_id}/assets", response_model=ImportJobOut, status_code=201)
async def upload_draft_assets(
    draft_id: uuid.UUID,
    db: DbSession,
    file: UploadFile = File(...),
    make_model_mode: str = Form("fuzzy"),
    generate_serials: bool = Form(False),
    actor: AuthContext = require_permission("initiatives", "add"),
) -> ImportJob:
    _guard(actor)
    job = await _draft(db, draft_id, actor, lock=True)
    _require_editable(job)
    if make_model_mode not in MAKE_MODEL_MODES:
        raise _err(422, "invalid_make_model_mode")
    filename = file.filename or "upload.csv"
    if not filename.lower().endswith(IMPORT_EXTENSIONS):
        raise _err(422, "unsupported_file")
    content = await file.read()
    if len(content) > MAX_BYTES:
        raise _err(422, "file_too_large", limit=MAX_BYTES)
    if not content:
        raise _err(422, "empty_file")
    check = await move_setup.new_check(
        db, job, filename=filename,
        options={"make_model_mode": make_model_mode, "generate_serials": generate_serials})
    # our key, never the uploader's name (same rule as the move import)
    key = (f"import-jobs/move-setup/{job.id}/"
           f"{check.id}{PurePosixPath(filename).suffix.lower()}")
    await put_object(key, content, file.content_type or "application/octet-stream")
    check.file_key = key
    await move_setup.attach_check(db, job, check)
    await db.commit()
    return check


@router.post("/{draft_id}/assets/recheck", response_model=ImportJobOut, status_code=201)
async def recheck_draft_assets(
    draft_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> ImportJob:
    _guard(actor)
    job = await _draft(db, draft_id, actor, lock=True)
    _require_editable(job)
    old = await move_setup.check_job(db, job.payload)
    if old is None:
        raise _err(409, "no_asset_file")
    options = {k: v for k, v in (old.options or {}).items() if k != "move_setup_id"}
    check = await move_setup.new_check(db, job, filename=old.filename, options=options,
                                       file_key=old.file_key)
    await move_setup.attach_check(db, job, check)
    await db.commit()
    return check


@router.post("/{draft_id}/create", response_model=MoveSetupOut)
async def create_move_from_draft(
    draft_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> MoveSetupOut:
    _guard(actor)
    job = await _draft(db, draft_id, actor, lock=True)
    _require_editable(job)
    invalid, clashes = await move_setup.draft_problems(db, job.payload or {})
    if invalid or clashes:
        raise _err(422, "setup_invalid", reasons=invalid + clashes)
    job.status, job.phase, job.error, job.results = "queued", "commit", None, None
    job.processed_rows = job.total_rows = 0
    job.cancel_requested = False
    job.started_at = job.finished_at = None
    job.progress_at = datetime.now(UTC)
    audit(db, actor_id=actor.person.id, entity_type="initiative", entity_id=None,
          action="move_setup_queued", changes={"draft_id": {"from": None, "to": str(job.id)}})
    await db.commit()
    return await _out(db, job)


@router.delete("/{draft_id}", status_code=204)
async def delete_draft(
    draft_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("initiatives", "add"),
) -> None:
    _guard(actor)
    job = await _draft(db, draft_id, actor, lock=True)
    _require_editable(job)
    await move_setup.retire_check_jobs(db, job.id)
    await db.delete(job)
    await db.commit()
