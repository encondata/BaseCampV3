"""Global notes — polymorphic text notes on any registered host entity.
Permission derives from the HOST's resource: viewing notes requires viewing
the host row (scope included); writing requires change on the host resource
and a global anchor. Only 'asset' is registered in V1; new hosts are one
NOTE_HOSTS entry (plus grants) away.

Exception: 'initiative' notes are global-only for BOTH read and write —
client read access to initiative notes is deferred to a future product
decision, so the generic "view = host view + scope" rule is overridden for
this one host in _authorize_host."""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from serversherpa.access.scope import scope_conditions
from serversherpa.api.deps import AuthContext, CurrentUser, DbSession
from serversherpa.api.schemas import NoteCreateIn, NoteOut, NoteUpdateIn
from serversherpa.db.models import (
    Asset, Client, Container, Initiative, Note, Partner, Person, Site,
    Truck, WorkerProfile,
)
from serversherpa.services.audit import audit

router = APIRouter(prefix="/notes", tags=["notes"])

# entity_type -> (resource id, model) — the permission/scope anchor
NOTE_HOSTS: dict[str, tuple[str, type]] = {
    "asset": ("assets", Asset),
    "container": ("containers", Container),
    "truck": ("trucks", Truck),
    "initiative": ("initiatives", Initiative),
    "person": ("workers", Person),
    "site": ("sites", Site),
    "client": ("clients", Client),
    "partner": ("partners", Partner),
}

# person's "workers" scope columns live on WorkerProfile (keyed by
# person_id), not Person — probing Person with them would cross-join and
# match everyone. Mirror routes/workers.py::_check_worker_scope instead.
SCOPE_PROBES = {
    "person": lambda entity_id, cond: (
        select(WorkerProfile.person_id)
        .where(WorkerProfile.person_id == entity_id, cond)),
}


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _authorize_host(
    db: DbSession, actor: AuthContext, entity_type: str,
    entity_id: uuid.UUID, action: str,
) -> None:
    """view: host resource view + host row in scope (404 outside).
    write: host resource change + global anchor (client tiers are read-only)."""
    host = NOTE_HOSTS.get(entity_type)
    if host is None:
        raise _err(422, "unknown_entity_type")
    resource, model = host
    needed = "view" if action == "view" else "change"
    if not actor.access.can(resource, needed):
        raise _err(403, "forbidden")
    if action != "view" and not actor.access.is_global:
        raise _err(403, "forbidden")
    # Initiative notes stay internal-only for now, including reads — whether
    # clients should ever see notes on their own initiatives is a future
    # product decision, not something to fall out of the generic host rule.
    if entity_type == "initiative" and action == "view" \
            and not actor.access.is_global:
        raise _err(403, "forbidden")
    row = await db.get(model, entity_id)
    if row is None:
        raise _err(404, "entity_not_found")
    cond = scope_conditions(resource, actor.access, actor.person.id)
    if cond is not None:
        probe = SCOPE_PROBES.get(entity_type)
        query = (probe(entity_id, cond) if probe
                 else select(model.id).where(model.id == entity_id, cond))
        visible = await db.scalar(query)
        if visible is None:
            raise _err(404, "entity_not_found")


def _out(note: Note, authors: dict) -> NoteOut:
    return NoteOut(
        id=note.id, entity_type=note.entity_type, entity_id=note.entity_id,
        body=note.body, created_by=note.created_by,
        author_name=authors.get(note.created_by),
        created_at=note.created_at, updated_at=note.updated_at)


async def _authors(db: DbSession, ids: set) -> dict:
    ids = {i for i in ids if i}
    if not ids:
        return {}
    people = (await db.scalars(select(Person).where(Person.id.in_(ids)))).all()
    return {p.id: p.display_name for p in people}


@router.get("", response_model=list[NoteOut])
async def list_notes(
    entity_type: str,
    entity_id: uuid.UUID,
    db: DbSession,
    actor: CurrentUser,
) -> list[NoteOut]:
    await _authorize_host(db, actor, entity_type, entity_id, "view")
    notes = (await db.scalars(
        select(Note).where(Note.entity_type == entity_type,
                           Note.entity_id == entity_id,
                           Note.deleted_at.is_(None))
        .order_by(Note.created_at.desc()))).all()
    authors = await _authors(db, {n.created_by for n in notes})
    return [_out(n, authors) for n in notes]


@router.post("", response_model=NoteOut, status_code=201)
async def create_note(
    body: NoteCreateIn,
    db: DbSession,
    actor: CurrentUser,
) -> NoteOut:
    await _authorize_host(db, actor, body.entity_type, body.entity_id, "add")
    note = Note(entity_type=body.entity_type, entity_id=body.entity_id,
                body=body.body, created_by=actor.person.id)
    db.add(note)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type=body.entity_type,
          entity_id=str(body.entity_id), action="note.add",
          changes={"note_id": str(note.id)})
    await db.commit()
    authors = await _authors(db, {note.created_by})
    return _out(note, authors)


async def _get_live_note(db: DbSession, note_id: uuid.UUID) -> Note:
    note = await db.get(Note, note_id)
    if note is None or note.deleted_at is not None:
        raise _err(404, "note_not_found")
    return note


@router.patch("/{note_id}", response_model=NoteOut)
async def update_note(
    note_id: uuid.UUID,
    body: NoteUpdateIn,
    db: DbSession,
    actor: CurrentUser,
) -> NoteOut:
    note = await _get_live_note(db, note_id)
    await _authorize_host(db, actor, note.entity_type, note.entity_id, "change")
    if body.body != note.body:
        note.body = body.body
        note.updated_by = actor.person.id
        note.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type=note.entity_type,
              entity_id=str(note.entity_id), action="note.update",
              changes={"note_id": str(note.id)})
    await db.commit()
    authors = await _authors(db, {note.created_by})
    return _out(note, authors)


@router.delete("/{note_id}", status_code=204)
async def delete_note(
    note_id: uuid.UUID,
    db: DbSession,
    actor: CurrentUser,
) -> None:
    note = await _get_live_note(db, note_id)
    await _authorize_host(db, actor, note.entity_type, note.entity_id, "delete")
    note.deleted_at = datetime.now(UTC)
    note.updated_by = actor.person.id
    audit(db, actor_id=actor.person.id, entity_type=note.entity_type,
          entity_id=str(note.entity_id), action="note.remove",
          changes={"note_id": str(note.id)})
    await db.commit()
