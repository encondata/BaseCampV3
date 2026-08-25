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
from sqlalchemy import String, cast, func, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.sql.schema import Table

from serversherpa.api.deps import AuthContext, CurrentUser, DbSession, require_permission
from serversherpa.api.schemas import (
    GodModeIn, PendingDeleteCreateIn, PendingDeleteFailure, PendingDeleteOut,
    PendingDeleteReconcileOut, PendingDeleteReference,
)
from serversherpa.config import get_settings
from serversherpa.db.models import (
    Asset, AssetModel, Base, Client, Container, Initiative, Partner,
    PendingDelete, Person, Site,
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


# Frozen label-column map for reference discovery: how to render a human
# label for a row in a referencing table. Unmapped tables fall back to the
# row's own primary key, stringified — never blank.
_NAME_LABELED = {"initiatives", "sites", "containers", "clients", "partners"}


def _label_expr(table: Table):
    if table.name in _NAME_LABELED:
        return table.c.name
    if table.name == "assets":
        return func.coalesce(table.c.serial_number, table.c.name)
    if table.name == "people":
        return table.c.first_name + " " + table.c.last_name
    if table.name == "asset_models":
        return table.c.make + " " + table.c.model
    pk = next(iter(table.primary_key.columns))
    return cast(pk, String)


def _references_to(model: type):
    """Yields (table, column) for every column anywhere in the schema whose
    foreign key targets `model`'s primary key — the mechanism behind both
    reference discovery and force-null."""
    target_pk = next(iter(model.__table__.primary_key.columns))
    for table in Base.metadata.tables.values():
        for fk in table.foreign_keys:
            if fk.column is target_pk:
                yield table, fk.parent


async def _find_references(
    db: DbSession, model: type, entity_id: uuid.UUID,
) -> list[PendingDeleteReference]:
    """Walks the schema for every column that FKs to `model`'s primary key
    and reports which ones currently have rows pointing at `entity_id` —
    the "what's still using this" detail behind an fk_violation failure."""
    refs: list[PendingDeleteReference] = []
    for table, col in _references_to(model):
        count = await db.scalar(
            select(func.count()).select_from(table).where(col == entity_id))
        if not count:
            continue
        labels = list(await db.scalars(
            select(_label_expr(table)).select_from(table)
            .where(col == entity_id).limit(3)))
        refs.append(PendingDeleteReference(
            table=table.name, column=col.name, nullable=col.nullable,
            count=count, labels=[str(v) for v in labels]))
    return refs


async def _null_references(
    db: DbSession, model: type, entity_id: uuid.UUID,
) -> dict[str, int]:
    """Force-mode mechanics: nulls out every NULLABLE column anywhere that
    references `entity_id`, ahead of the delete. Non-nullable references are
    left untouched — if one still blocks the delete, the IntegrityError path
    below reports it as a reference like any other failure."""
    nulled: dict[str, int] = {}
    for table, col in _references_to(model):
        if not col.nullable:
            continue
        result = await db.execute(
            update(table).where(col == entity_id).values({col.name: None}))
        if result.rowcount:
            nulled[f"{table.name}.{col.name}"] = result.rowcount
    return nulled


async def _reconcile_markers(
    db: DbSession, actor: AuthContext, markers: list[PendingDelete],
    force: bool = False,
) -> PendingDeleteReconcileOut:
    """Hard-delete the given marked targets. Each target runs inside its own
    savepoint so one FK violation rolls back only that row, not the batch:
    a poisoned marker further down the list still gets its chance.

    `force` (single-marker reconcile only — bulk reconcile never sets it)
    nulls every NULLABLE reference to the target before deleting it;
    non-nullable references are left alone, so if one still blocks the
    delete the IntegrityError path reports it exactly like any other
    fk_violation failure."""
    deleted = 0
    failed: list[PendingDeleteFailure] = []
    for marker in markers:
        model = DELETABLE[marker.entity_type]
        try:
            async with db.begin_nested():
                target = await db.get(model, marker.entity_id)
                if target is not None:
                    nulled = (await _null_references(db, model, marker.entity_id)
                              if force else {})
                    await db.delete(target)
                    await db.flush()
                    audit(db, actor_id=actor.person.id,
                          entity_type=marker.entity_type,
                          entity_id=str(marker.entity_id), action="hard_delete",
                          changes={"nulled_references": nulled} if nulled else None)
                # a target already gone is a success too — clear the marker
                await db.delete(marker)
                await db.flush()
        except IntegrityError:
            # savepoint rolled back automatically: the target, the marker,
            # any nulled references, and any audit row attempted inside this
            # block are all as if nothing happened — the marker is retained
            # for a later retry. The session is still usable post-rollback,
            # so we can look up what's still blocking right here.
            failed.append(PendingDeleteFailure(
                entity_type=marker.entity_type, entity_id=marker.entity_id,
                label=marker.entity_label, reason="fk_violation",
                references=await _find_references(db, model, marker.entity_id)))
            continue
        deleted += 1
    await db.commit()
    return PendingDeleteReconcileOut(deleted=deleted, failed=failed)


@router.post("/pending-deletes/reconcile", response_model=PendingDeleteReconcileOut)
async def reconcile_pending_deletes(
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
) -> PendingDeleteReconcileOut:
    markers = list(await db.scalars(
        select(PendingDelete).order_by(PendingDelete.marked_at)))
    return await _reconcile_markers(db, actor, markers)


@router.post("/pending-deletes/{marker_id}/reconcile",
             response_model=PendingDeleteReconcileOut)
async def reconcile_pending_delete(
    marker_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_permission("devtools", "change"),
    force: bool = False,
) -> PendingDeleteReconcileOut:
    """Hard-delete a single marked target — same semantics and summary
    shape as the bulk reconcile, scoped to one marker. `force=true` nulls
    every nullable reference to the target before deleting it; bulk
    reconcile has no such switch."""
    marker = await db.get(PendingDelete, marker_id)
    if marker is None:
        raise _err(404, "marker_not_found")
    return await _reconcile_markers(db, actor, [marker], force=force)
