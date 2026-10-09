"""Data cleanup (Dev -> Database -> Cleanup): preview what can be removed
and purge it, on demand. Under the `devtools` resource like the rest of the
Database tab: view to preview, change to run."""

from dataclasses import asdict

from fastapi import APIRouter, HTTPException

from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.api.schemas import CleanupPreviewOut, CleanupRunIn, CleanupRunOut
from serversherpa.db.engine import get_sessionmaker
from serversherpa.devtools import cleanup
from serversherpa.services.audit import audit

router = APIRouter(prefix="/devtools/cleanup", tags=["devtools"])

# module-level so the route signatures stay free of calls in defaults
_CAN_VIEW = require_permission("devtools", "view")
_CAN_CHANGE = require_permission("devtools", "change")


def _refuse(exc: cleanup.CleanupError) -> HTTPException:
    return HTTPException(status_code=422, detail={"code": exc.code})


@router.get("/preview", response_model=CleanupPreviewOut)
async def preview_cleanup(
    db: DbSession,
    older_than_days: int = 90,
    actor: AuthContext = _CAN_VIEW,
) -> CleanupPreviewOut:
    try:
        days = cleanup.validate_age(older_than_days)
    except cleanup.CleanupError as exc:
        raise _refuse(exc) from None
    return CleanupPreviewOut(groups=await cleanup.preview(db, days))


@router.post("/run", response_model=CleanupRunOut)
async def run_cleanup(
    body: CleanupRunIn,
    db: DbSession,
    actor: AuthContext = _CAN_CHANGE,
) -> CleanupRunOut:
    group = cleanup.GROUPS.get(body.group)
    # a group with no age field ignores whatever was sent
    age = body.older_than_days if group is not None and group.needs_age else None
    failure: cleanup.CleanupFailed | None = None
    try:
        results = await cleanup.run(get_sessionmaker(), body.group, body.categories, age)
    except cleanup.CleanupFailed as exc:
        failure, results = exc, exc.results
    except cleanup.CleanupError as exc:
        raise _refuse(exc) from None

    counts = {r.key: {k: v for k, v in asdict(r).items() if k != "key"} for r in results}
    changes = {"group": body.group, "older_than_days": age, "categories": counts}
    if failure is not None:
        changes["error"] = failure.message
    audit(db, actor_id=actor.person.id, entity_type="system", entity_id=body.group,
          action="cleanup.run", changes=changes)
    await db.commit()
    if failure is not None:
        # what was committed before the failure stays deleted; say so
        raise HTTPException(status_code=500, detail={
            "code": "cleanup_failed", "message": failure.message,
            "categories": [asdict(r) for r in results]})
    return CleanupRunOut(group=body.group, older_than_days=age,
                         categories=[asdict(r) for r in results])
