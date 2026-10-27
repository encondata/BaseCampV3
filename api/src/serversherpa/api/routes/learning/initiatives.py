"""Initiative learning routes: the per-initiative dry run (and its apply),
manual assignment, pushing a document's new version to people outside an
initiative, and the initiative's Learning tab — summary, invite schedule,
Send now / Resend, Send reminder, the roster, Regenerate / Revoke a person's code and the
printable code sheet.

Reads need `learning:view`; a dry run applies with `add`; manual
assignment and pushed versions need `add`; the schedule, sends and codes
need `change` (`require_manager`)."""
import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException, Query, Response

from serversherpa.api.deps import AuthContext, DbSession
from serversherpa.config import learn_url
from serversherpa.db.models import Initiative
from serversherpa.learning import assign, emails, invites, progress
from serversherpa.learning.access import is_manager, require_manager
from serversherpa.learning.models import LearningDocument
from serversherpa.learning.schemas import (
    AssignIn,
    AssignSummaryOut,
    DryRunIn,
    InitiativeLearningOut,
    PushVersionIn,
    RegenerateOut,
    RemindIn,
    RemindOut,
    RevokeCodesOut,
    RosterRowOut,
    RosterStatus,
    ScheduleIn,
    ScheduleOut,
    SendInvitesIn,
    SendInvitesOut,
)
from serversherpa.reports.move_report.render import render_pdf_async

router = APIRouter()


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail={"code": "not_found", "message": "Not found."})


async def _initiative(db, initiative_id: uuid.UUID) -> Initiative:
    initiative = await db.get(Initiative, initiative_id)
    if initiative is None:
        raise _not_found()
    return initiative


async def _member(db, initiative_id: uuid.UUID, person_id: uuid.UUID) -> None:
    if not await invites.on_initiative(db, initiative_id, person_id):
        raise _not_found()


@router.post("/initiatives/{initiative_id}/dry-run", response_model=AssignSummaryOut)
async def dry_run(
    initiative_id: uuid.UUID,
    body: DryRunIn,
    db: DbSession,
    actor: AuthContext = require_manager("view"),
) -> dict:
    if body.apply and not is_manager(actor.access, "add"):
        raise HTTPException(status_code=403, detail={"code": "forbidden"})
    if await db.get(Initiative, initiative_id) is None:
        raise _not_found()
    out = await assign.dry_run(db, initiative_id, apply=body.apply, actor_id=actor.person.id)
    if body.apply:
        await db.commit()
    return out


@router.post("/assign", response_model=AssignSummaryOut)
async def assign_manual(
    body: AssignIn,
    db: DbSession,
    actor: AuthContext = require_manager("add"),
) -> dict:
    out = await assign.assign_manual(
        db, actor_id=actor.person.id, person_ids=body.person_ids,
        initiative_id=body.initiative_id, packet_id=body.packet_id,
        document_ids=body.document_ids)
    await db.commit()
    return out


@router.post("/documents/{document_id}/push-version", response_model=AssignSummaryOut)
async def push_version(
    document_id: uuid.UUID,
    body: PushVersionIn,
    db: DbSession,
    actor: AuthContext = require_manager("add"),
) -> dict:
    document = await db.get(LearningDocument, document_id)
    if document is None:
        raise _not_found()
    out = await assign.push_version(db, document, actor_id=actor.person.id,
                                    person_ids=body.person_ids)
    for row in out["rows"]:
        if row["will_get"]:
            await emails.send_new_version(db, row["person_id"], document)
    await db.commit()
    return out


# ── the initiative's Learning tab ────────────────────────────────────


@router.get("/initiatives/{initiative_id}", response_model=InitiativeLearningOut)
async def initiative_summary(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("view"),
) -> dict:
    initiative = await _initiative(db, initiative_id)
    return await progress.summary(db, initiative, now=datetime.now(UTC))


@router.put("/initiatives/{initiative_id}/schedule", response_model=ScheduleOut)
async def put_schedule(
    initiative_id: uuid.UUID,
    body: ScheduleIn,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> dict:
    initiative = await _initiative(db, initiative_id)
    changes = body.model_dump(exclude_unset=True)
    if "send_time" in changes:
        changes["send_time"] = invites.parse_hhmm(changes["send_time"])
    row = await invites.save_schedule(db, initiative, changes, actor_id=actor.person.id)
    out = await progress.schedule_out(db, initiative, row)
    await db.commit()
    return out


@router.post("/initiatives/{initiative_id}/send", response_model=SendInvitesOut)
async def send_invites(
    initiative_id: uuid.UUID,
    body: SendInvitesIn,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> dict:
    await _initiative(db, initiative_id)
    out = await invites.send_initiative(db, initiative_id, actor.person.id,
                                        person_ids=body.person_ids)
    await db.commit()
    return out


@router.post("/initiatives/{initiative_id}/remind", response_model=RemindOut)
async def send_reminders(
    initiative_id: uuid.UUID,
    body: RemindIn,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> dict:
    await _initiative(db, initiative_id)
    out = await invites.remind_initiative(db, initiative_id, actor.person.id,
                                          person_ids=body.person_ids)
    await db.commit()
    return out


@router.get("/initiatives/{initiative_id}/roster", response_model=list[RosterRowOut])
async def roster(
    initiative_id: uuid.UUID,
    db: DbSession,
    status: RosterStatus | None = None,
    actor: AuthContext = require_manager("view"),
) -> list:
    initiative = await _initiative(db, initiative_id)
    rows = await progress.roster(db, initiative, now=datetime.now(UTC))
    return [r.out() for r in rows if status is None or r.status == status]


@router.post("/initiatives/{initiative_id}/people/{person_id}/regenerate",
             response_model=RegenerateOut)
async def regenerate_code(
    initiative_id: uuid.UUID,
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> dict:
    """A new code (the old one, its link and sessions stop working), emailed.
    Someone without email gets theirs from the code sheet instead."""
    await _initiative(db, initiative_id)
    await _member(db, initiative_id, person_id)
    if not await emails.address_for(db, person_id):
        raise HTTPException(status_code=422, detail={
            "code": "no_email",
            "message": "This person has no email. Print a code sheet for them instead."})
    sent = await invites.send_invite_for(db, person_id, initiative_id, actor.person.id)
    await db.commit()
    return {"sent": sent}


@router.post("/initiatives/{initiative_id}/people/{person_id}/revoke",
             response_model=RevokeCodesOut)
async def revoke_codes(
    initiative_id: uuid.UUID,
    person_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> dict:
    await _initiative(db, initiative_id)
    await _member(db, initiative_id, person_id)
    revoked = await invites.revoke_person(db, initiative_id, person_id,
                                          actor_id=actor.person.id)
    await db.commit()
    return {"revoked": revoked}


@router.post("/initiatives/{initiative_id}/code-sheet.pdf")
async def code_sheet(
    initiative_id: uuid.UUID,
    db: DbSession,
    everyone: bool = Query(default=False, alias="all"),
    actor: AuthContext = require_manager("change"),
) -> Response:
    """Fresh codes for the people with open assignments and no email (with
    `all=1`, everyone with open assignments), printed. Each replaces the
    person's earlier code; the sheet says so. A POST: it revokes codes, so
    a link preview, history or a retried download must never reach it.
    Rendered before the commit, so a failed render issues nothing."""
    initiative = await _initiative(db, initiative_id)
    rows = await invites.issue_sheet_codes(db, initiative_id, everyone=everyone,
                                           actor_id=actor.person.id)
    pdf = await render_pdf_async(invites.code_sheet_html(
        initiative.name, rows, learn_origin=learn_url("")))
    await db.commit()
    return Response(content=pdf, media_type="application/pdf", headers={
        "Content-Disposition": 'attachment; filename="learning-codes.pdf"',
        "Cache-Control": "no-store"})
