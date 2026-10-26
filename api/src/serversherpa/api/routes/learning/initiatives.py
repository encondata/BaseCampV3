"""Assignment routes: the per-initiative dry run (and its apply), manual
assignment, and pushing a document's new version to people outside an
initiative. A dry run reads with `learning:view` and applies with `add`;
manual assignment and pushed versions need `add` (`require_manager`)."""
import uuid

from fastapi import APIRouter, HTTPException

from serversherpa.api.deps import AuthContext, DbSession
from serversherpa.db.models import Initiative
from serversherpa.learning import assign
from serversherpa.learning.access import is_manager, require_manager
from serversherpa.learning.models import LearningDocument
from serversherpa.learning.schemas import AssignIn, AssignSummaryOut, DryRunIn, PushVersionIn

router = APIRouter()


def _not_found() -> HTTPException:
    return HTTPException(status_code=404, detail={"code": "not_found", "message": "Not found."})


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
    await db.commit()
    return out
