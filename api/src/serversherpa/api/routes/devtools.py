"""God mode — reveals the developer nav section.

This is a VISIBILITY toggle, not a permission. The server enforces the
`devtools` permission on every request regardless of god-mode state, so
guessing a word grants nothing: a non-developer who types the correct word
gets the same 404 as someone typing gibberish. That property is why this
needs no rate limiting — there is nothing behind the door to force.

The words live in SS_GOD_MODE_WORDS (server-side). A VITE_* equivalent
would be inlined into the portal bundle and readable from devtools.
"""

import secrets
import uuid

from fastapi import APIRouter, HTTPException
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from serversherpa.api.deps import AuthContext, CurrentUser, DbSession, require_permission
from serversherpa.api.schemas import (
    GodModeIn, PendingDeleteCreateIn, PendingDeleteFailure, PendingDeleteOut,
    PendingDeleteReconcileOut,
)
from serversherpa.config import get_settings
from serversherpa.db.models import (
    Asset, AssetModel, Client, Container, Initiative, Partner, PendingDelete,
    Person, Site,
)
from serversherpa.services.audit import audit

router = APIRouter(prefix="/devtools", tags=["devtools"])

# Frozen registry of every entity type god-mode is allowed to hard-delete.
# Never built from user input — a string that doesn't appear here as a key
# 422s before it can reach a query.
DELETABLE: dict[str, type] = {
    "person": Person,
    "client": Client,
    "partner": Partner,
    "site": Site,
    "asset": Asset,
    "asset_model": AssetModel,
    "container": Container,
    "initiative": Initiative,
}


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


# One refusal for every reason — wrong word, right word from a non-developer,
# feature unconfigured. Any variance between them is the leak this avoids.
_REFUSED = HTTPException(status_code=404, detail={"code": "not_found"})


def _word_matches(candidate: str) -> bool:
    raw = get_settings().god_mode_words.get_secret_value()
    words = [w.strip() for w in raw.split(",") if w.strip()]
    # Matching is case-insensitive: these are typed by hand into the palette,
    # and case carries no defensive value here (guessing grants nothing — see
    # the module docstring).
    #
    # Compare BYTES, not str: secrets.compare_digest raises TypeError on
    # non-ASCII str, so a palette query like "café" would 500 — which both
    # errors and breaks the identical-refusal property a 500 is distinguishable
    # from a 404. Encoding sidesteps it for any input.
    probe = candidate.casefold().encode("utf-8")
    # `any()` short-circuits, but the timing tells an attacker nothing usable.
    return any(secrets.compare_digest(probe, w.casefold().encode("utf-8"))
               for w in words)


@router.post("/unlock", include_in_schema=False)
async def unlock(body: GodModeIn, user: CurrentUser, db: DbSession) -> dict:
    # Order is deliberate: Python short-circuits `or`, so a wrong word never
    # even reaches the permission check. That's safe to skip because
    # `user.access.can(...)` is a pre-resolved in-memory dict lookup, not a
    # DB call or anything else with a measurable cost — there's no timing
    # signal for an attacker to learn from which branch short-circuited.
    if not _word_matches(body.word) or not user.access.can("devtools", "view"):
        raise _REFUSED
    audit(db, actor_id=user.person.id, entity_type="auth",
          entity_id=str(user.person.id), action="godmode.enable")
    await db.commit()
    return {"nav_color": get_settings().god_mode_nav_color}


def _out(marker: PendingDelete, name: str | None) -> PendingDeleteOut:
    return PendingDeleteOut(
        id=marker.id, entity_type=marker.entity_type,
        entity_id=marker.entity_id, entity_label=marker.entity_label,
        marked_by=marker.marked_by, marked_by_name=name,
        marked_at=marker.marked_at)


@router.get("/pending-deletes", response_model=list[PendingDeleteOut])
async def list_pending_deletes(
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "view"),
) -> list[PendingDeleteOut]:
    rows = (await db.execute(
        select(PendingDelete, Person)
        .outerjoin(Person, Person.id == PendingDelete.marked_by)
        .order_by(PendingDelete.marked_at.desc()))).all()
    return [_out(marker, f"{p.first_name} {p.last_name}" if p else None)
            for marker, p in rows]


@router.post("/pending-deletes", response_model=PendingDeleteOut, status_code=201)
async def mark_pending_delete(
    body: PendingDeleteCreateIn,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> PendingDeleteOut:
    model = DELETABLE.get(body.entity_type)
    if model is None:
        raise _err(422, "unknown_entity_type")
    if await db.get(model, body.entity_id) is None:
        raise _err(422, "entity_not_found")
    existing = await db.scalar(select(PendingDelete).where(
        PendingDelete.entity_type == body.entity_type,
        PendingDelete.entity_id == body.entity_id))
    if existing is not None:
        raise _err(409, "already_pending")
    marker = PendingDelete(
        entity_type=body.entity_type, entity_id=body.entity_id,
        entity_label=body.entity_label, marked_by=actor.person.id)
    db.add(marker)
    await db.commit()
    return _out(marker, f"{actor.person.first_name} {actor.person.last_name}")


@router.delete("/pending-deletes/{marker_id}", status_code=204)
async def unmark_pending_delete(
    marker_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> None:
    marker = await db.get(PendingDelete, marker_id)
    if marker is None:
        raise _err(404, "marker_not_found")
    await db.delete(marker)
    await db.commit()


@router.post("/pending-deletes/reconcile", response_model=PendingDeleteReconcileOut)
async def reconcile_pending_deletes(
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> PendingDeleteReconcileOut:
    """Hard-delete every marked target. Each target runs inside its own
    savepoint so one FK violation rolls back only that row, not the batch:
    a poisoned marker further down the list still gets its chance."""
    markers = list(await db.scalars(
        select(PendingDelete).order_by(PendingDelete.marked_at)))
    deleted = 0
    failed: list[PendingDeleteFailure] = []
    for marker in markers:
        model = DELETABLE[marker.entity_type]
        try:
            async with db.begin_nested():
                target = await db.get(model, marker.entity_id)
                if target is not None:
                    await db.delete(target)
                    await db.flush()
                    audit(db, actor_id=actor.person.id,
                          entity_type=marker.entity_type,
                          entity_id=str(marker.entity_id), action="hard_delete")
                # a target already gone is a success too — clear the marker
                await db.delete(marker)
                await db.flush()
        except IntegrityError:
            # savepoint rolled back automatically: the target, the marker,
            # and any audit row attempted inside this block are all as if
            # nothing happened — the marker is retained for a later retry
            failed.append(PendingDeleteFailure(
                entity_type=marker.entity_type, entity_id=marker.entity_id,
                label=marker.entity_label, reason="fk_violation"))
            continue
        deleted += 1
    await db.commit()
    return PendingDeleteReconcileOut(deleted=deleted, failed=failed)
