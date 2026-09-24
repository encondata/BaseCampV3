"""Bulk Actions › Create a move in steps — the draft and its create.

A draft is ONE import_jobs row: kind "move_setup", status "preview",
initiative_id NULL until creation, owned by created_by. Its payload holds
every step:

    {"move":   {...InitiativeCreateIn fields, initiative_type "move"},
     "assets": {"check_job_id": uuid, "filename": str} | None,
     "crates": {"convention", "count", "start", "container_type",
                "tags": {tag: n}} | None,
     "trucks": {"convention", "count", "start"} | None}

The asset step is an ordinary move_assets job with no move
(options.move_setup_id = the draft id) that the import worker validates
like any other and that can never be committed on its own. Nothing reaches
the real tables until the worker applies the queued draft (apply_job) in one
transaction. payload is JSONB without mutation tracking: always reassign
job.payload, never edit it in place."""

import logging
import uuid
from datetime import UTC, datetime

from pydantic import ValidationError
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.api.schemas import MoveSetupMoveIn
from serversherpa.db.models import ImportJob
from serversherpa.imports.naming import (
    CRATE_MAX, TRUCK_MAX, NamingError, clash_sentence, generate_names,
)
from serversherpa.logistics.bulk_create import ContainerBulkError, check_tags, check_vocab
from serversherpa.logistics.bulk_create import find_clashes as container_clashes
from serversherpa.services.initiatives import ref_problem
from serversherpa.trucks.bulk_create import find_clashes as truck_clashes

logger = logging.getLogger(__name__)

KIND = "move_setup"
CHECK_KIND = "move_assets"
EDITABLE = ("preview", "failed")
PROGRESS_EVERY = 250

MOVE_REF_SENTENCES = {
    "client_not_found": "The client no longer exists. Pick another on the first step.",
    "site_not_found": "A site on the first step no longer exists. Pick another.",
    "partner_not_found": "A partner on the first step no longer exists. Pick another.",
    "unknown_status": "The move's status is no longer in the list. Pick another.",
    "unknown_initiative_type": "Moves can't be created because the Move type is missing.",
    "unknown_sub_type": "The move's sub-type is no longer in the list. Pick another.",
    "unknown_shipping_type": "A shipping type is no longer in the list. Pick others.",
}
TAG_SENTENCES = {
    "bad_tag_key": "Label tags must be Priority, Vendor, Accessories, Warehouse, or E-Waste.",
    "tags_exceed_count": "Label tag counts can't add up to more than the crate count.",
}
FILE_UNREADABLE = "The From-To file can't be read again. Upload it again, or skip the asset step."
WORKER_ERROR_MESSAGE = ("Something went wrong while creating the move. Nothing was created. "
                        "Try again.")
CONFLICT_MESSAGE = ("Another change landed while the move was being created. Nothing was "
                    "created. Try again.")


def empty_payload(move: dict) -> dict:
    return {"move": move, "assets": None, "crates": None, "trucks": None}


def typed_move(move: dict) -> dict:
    """The stored (JSON) move fields as typed values — UUIDs, datetimes —
    ready for ref_problem and the Initiative constructor."""
    data = MoveSetupMoveIn.model_validate(move).model_dump(exclude_none=True)
    data["initiative_type"] = "move"
    return data


def reopen(job: ImportJob) -> None:
    """Any edit puts a failed draft back to editable preview and counts as
    a touch for the 24-hour sweep."""
    job.status, job.error, job.results = "preview", None, None
    job.progress_at = datetime.now(UTC)


def crate_names(crates: dict) -> list[str]:
    return generate_names(crates["convention"], int(crates["count"]), int(crates["start"]),
                          max_count=CRATE_MAX)


def truck_names(trucks: dict) -> list[str]:
    return generate_names(trucks["convention"], int(trucks["count"]), int(trucks["start"]),
                          max_count=TRUCK_MAX)


async def move_problems(db: AsyncSession, move: dict) -> list[str]:
    try:
        data = typed_move(move)
    except ValidationError:
        return ["The move's details are no longer valid. Check the first step."]
    out: list[str] = []
    if not (data.get("name") or "").strip():
        out.append("The move needs a name.")
    if not data.get("origin_site_id"):
        out.append("Pick an origin site.")
    if not data.get("destination_site_id"):
        out.append("Pick a destination site.")
    if problem := await ref_problem(db, data):
        out.append(MOVE_REF_SENTENCES.get(problem[0],
                                          "Check the move's details on the first step."))
    return out


async def crate_problems(db: AsyncSession, crates: dict) -> list[str]:
    """Everything wrong with the crate step except name clashes."""
    try:
        names = crate_names(crates)
    except NamingError as exc:
        return [exc.message]
    if not names:
        return []
    out: list[str] = []
    if not crates.get("container_type"):
        out.append("Pick a crate type.")
    else:
        try:
            await check_vocab(db, crates["container_type"], None)
        except ContainerBulkError:
            out.append("Pick a crate type from the list.")
    try:
        check_tags(crates.get("tags") or {}, len(names))
    except ContainerBulkError as exc:
        out.append(TAG_SENTENCES[exc.code])
    return out


async def names_preview(db: AsyncSession, section: dict | None, *, kind: str) -> dict | None:
    if section is None:
        return None
    try:
        names = crate_names(section) if kind == "crates" else truck_names(section)
    except NamingError as exc:
        return {"names": [], "clashes": [], "error": exc.message}
    finder = container_clashes if kind == "crates" else truck_clashes
    return {"names": names, "clashes": await finder(db, names), "error": None}


async def previews(db: AsyncSession, payload: dict | None) -> dict:
    payload = payload or {}
    return {"crates": await names_preview(db, payload.get("crates"), kind="crates"),
            "trucks": await names_preview(db, payload.get("trucks"), kind="trucks")}


async def check_job(db: AsyncSession, payload: dict | None) -> ImportJob | None:
    assets = (payload or {}).get("assets")
    if not assets:
        return None
    return await db.get(ImportJob, uuid.UUID(assets["check_job_id"]))


def asset_problems(check: ImportJob | None) -> list[str]:
    if check is None:
        return [("The From-To file check is missing. Upload the file again, "
                 "or skip the asset step.")]
    if check.status in ("queued", "running"):
        return [("The From-To file is still being checked. Wait for it to finish, "
                 "then create the move.")]
    if check.status != "completed":
        return [("The From-To file check didn't finish. Upload the file again, "
                 "or skip the asset step.")]
    return []


async def draft_problems(db: AsyncSession, payload: dict) -> tuple[list[str], list[str]]:
    """(invalid, clashes) as sentences. The create route rejects either; the
    worker treats `invalid` as setup_invalid and re-checks clashes itself
    right before each create (a clash there is name_taken)."""
    invalid = await move_problems(db, payload.get("move") or {})
    if payload.get("assets") is not None:
        invalid += asset_problems(await check_job(db, payload))
    clashes: list[str] = []
    if (crates := payload.get("crates")) is not None:
        problems = await crate_problems(db, crates)
        invalid += problems
        if not problems and (found := await container_clashes(db, crate_names(crates))):
            clashes.append(clash_sentence("crate", found))
    if (trucks := payload.get("trucks")) is not None:
        try:
            names = truck_names(trucks)
        except NamingError as exc:
            invalid.append(exc.message)
        else:
            if found := await truck_clashes(db, names):
                clashes.append(clash_sentence("truck", found))
    return invalid, clashes


async def new_check(db: AsyncSession, draft: ImportJob, *, filename: str, options: dict,
                    file_key: str = "") -> ImportJob:
    check = ImportJob(kind=CHECK_KIND, initiative_id=None, created_by=draft.created_by,
                      filename=filename, file_key=file_key,
                      options={**options, "move_setup_id": str(draft.id)},
                      phase="validate", status="queued")
    db.add(check)
    await db.flush()
    return check


async def attach_check(db: AsyncSession, draft: ImportJob, check: ImportJob) -> None:
    """Point the draft at `check` and retire every other check it had."""
    await retire_check_jobs(db, draft.id, keep=check.id)
    draft.payload = {**(draft.payload or {}),
                     "assets": {"check_job_id": str(check.id), "filename": check.filename}}
    reopen(draft)


async def retire_check_jobs(db: AsyncSession, draft_id: uuid.UUID, *,
                            keep: uuid.UUID | None = None) -> None:
    """Delete the draft's check jobs (except `keep`). A running one is only
    flagged: the worker still holds it and writes its result, so deleting
    it would fail that write; the sweep removes it once finished."""
    for check in await db.scalars(select(ImportJob).where(
            ImportJob.kind == CHECK_KIND, ImportJob.initiative_id.is_(None),
            ImportJob.options["move_setup_id"].astext == str(draft_id))):
        if check.id == keep:
            continue
        if check.status == "running":
            check.cancel_requested = True
        else:
            await db.delete(check)
