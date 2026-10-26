"""The learning dashboard, an initiative's compliance grid, a person's
learning history and their sign-off certificate PDF.

The dashboard and grid are for learning managers (`require_manager`). A
person's history also opens to someone with `workers:view` over that worker
(the worker detail's Learning history panel; a worker outside their scope is
a 404, never a 403), without initiative names unless they can view
initiatives. The certificate (typed names, drawn signatures) is for
learning managers only."""
import re
import uuid

from fastapi import APIRouter, HTTPException, Response

from serversherpa.api.deps import AuthContext, CurrentUser, DbSession
from serversherpa.api.routes.workers import _check_worker_scope, _require_worker
from serversherpa.db.models import Initiative, Person
from serversherpa.learning import certificate, stats
from serversherpa.learning.access import is_manager, require_manager
from serversherpa.learning.schemas import DashboardOut, GridOut, HistoryOut

router = APIRouter()

WINDOWS = (7, 30, 90)


def _not_found(code: str = "not_found") -> HTTPException:
    return HTTPException(status_code=404, detail={"code": code, "message": "Not found."})


async def _readable_person(db: DbSession, actor: AuthContext, person_id: uuid.UUID) -> Person:
    """The person, when the actor may read their learning: a manager, or a
    `workers:view` holder with the worker in scope."""
    manager = is_manager(actor.access, "view")
    if not manager and not actor.access.can("workers", "view"):
        raise HTTPException(status_code=403, detail={"code": "forbidden"})
    person = await db.get(Person, person_id)
    if person is None:
        raise _not_found("person_not_found")
    if not manager:
        await _check_worker_scope(db, actor, person_id)
        await _require_worker(db, person_id)
    return person


@router.get("/dashboard", response_model=DashboardOut)
async def dashboard(
    db: DbSession,
    days: int = 30,
    actor: AuthContext = require_manager("view"),
) -> dict:
    if days not in WINDOWS:
        raise HTTPException(status_code=422, detail={
            "code": "bad_days", "message": "Pick 7, 30 or 90 days."})
    return await stats.dashboard(db, days)


@router.get("/initiatives/{initiative_id}/grid", response_model=GridOut)
async def compliance_grid(
    initiative_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("view"),
) -> dict:
    initiative = await db.get(Initiative, initiative_id)
    if initiative is None:
        raise _not_found()
    return await stats.grid(db, initiative)


@router.get("/people/{person_id}/history", response_model=HistoryOut)
async def person_history(
    person_id: uuid.UUID,
    db: DbSession,
    actor: CurrentUser,
) -> dict:
    person = await _readable_person(db, actor, person_id)
    # a workers:view reader may not be allowed to see initiatives at all
    names = is_manager(actor.access, "view") or actor.access.can("initiatives", "view")
    return await stats.history(db, person, initiative_names=names)


@router.get("/people/{person_id}/certificate.pdf")
async def person_certificate(
    person_id: uuid.UUID,
    db: DbSession,
    actor: CurrentUser,
    initiative_id: uuid.UUID | None = None,
) -> Response:
    # typed names and drawn signatures: learning managers only
    if not is_manager(actor.access, "view"):
        raise HTTPException(status_code=403, detail={"code": "forbidden"})
    person = await db.get(Person, person_id)
    if person is None:
        raise _not_found("person_not_found")
    pdf = await certificate.certificate_pdf(db, person_id, initiative_id=initiative_id)
    slug = re.sub(r"[^A-Za-z0-9]+", "-", person.display_name).strip("-").lower() or "worker"
    return Response(content=pdf, media_type="application/pdf", headers={
        "Content-Disposition": f'attachment; filename="learning-certificate-{slug}.pdf"',
        "Cache-Control": "no-store"})
