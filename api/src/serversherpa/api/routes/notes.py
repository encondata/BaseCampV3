"""Global notes — polymorphic text notes on any registered host entity.
Permission derives from the HOST's resource (access/hosts.py): viewing notes
requires viewing the host row (scope included); writing requires change on
the host resource and a global anchor. New hosts are one NOTE_HOSTS entry
(plus grants) away.

Each note carries a visibility level. Everyone: anyone who can see the host
record, clients included. Internal: global (staff) actors only. Admin:
global actors at Admin rank or higher. A note above the actor's level reads
as missing (404 on edit and delete), and an actor may only set a level they
can see themselves. Spec: docs/superpowers/specs/2026-10-08-note-file-
visibility-design.md"""

import uuid
from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException
from sqlalchemy import select

from serversherpa.access.hosts import NOTE_HOSTS, authorize_host_view
from serversherpa.access.visibility import can_set_visibility, visible_levels
from serversherpa.api.deps import AuthContext, CurrentUser, DbSession
from serversherpa.api.schemas import NoteCreateIn, NoteOut, NoteUpdateIn
from serversherpa.db.models import Note, Person
from serversherpa.services.audit import audit

router = APIRouter(prefix="/notes", tags=["notes"])


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


async def _authorize_host(
    db: DbSession, actor: AuthContext, entity_type: str,
    entity_id: uuid.UUID, action: str,
) -> None:
    """view: the shared host read rule (host view + scope, 404 outside).
    write: host resource change + global anchor (client tiers are read-only).
    The global anchor spans every row, so no scope probe is needed."""
    if action == "view":
        await authorize_host_view(db, actor, entity_type, entity_id)
        return
    host = NOTE_HOSTS.get(entity_type)
    if host is None:
        raise _err(422, "unknown_entity_type")
    resource, model = host
    if not actor.access.can(resource, "change"):
        raise _err(403, "forbidden")
    if not actor.access.is_global:
        raise _err(403, "forbidden")
    row = await db.get(model, entity_id)
    if row is None:
        raise _err(404, "entity_not_found")


def _out(note: Note, authors: dict) -> NoteOut:
    return NoteOut(
        id=note.id, entity_type=note.entity_type, entity_id=note.entity_id,
        body=note.body, visibility=note.visibility, created_by=note.created_by,
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
                           Note.deleted_at.is_(None),
                           Note.visibility.in_(visible_levels(actor.access)))
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
    if not can_set_visibility(actor.access, body.visibility):
        raise _err(403, "visibility_not_allowed")
    note = Note(entity_type=body.entity_type, entity_id=body.entity_id,
                body=body.body, visibility=body.visibility,
                created_by=actor.person.id)
    db.add(note)
    await db.flush()
    audit(db, actor_id=actor.person.id, entity_type=body.entity_type,
          entity_id=str(body.entity_id), action="note.add",
          changes={"note_id": str(note.id), "visibility": body.visibility})
    await db.commit()
    authors = await _authors(db, {note.created_by})
    return _out(note, authors)


async def _get_live_note(
    db: DbSession, note_id: uuid.UUID, actor: AuthContext,
) -> Note:
    note = await db.get(Note, note_id)
    if note is None or note.deleted_at is not None \
            or note.visibility not in visible_levels(actor.access):
        raise _err(404, "note_not_found")
    return note


@router.patch("/{note_id}", response_model=NoteOut)
async def update_note(
    note_id: uuid.UUID,
    body: NoteUpdateIn,
    db: DbSession,
    actor: CurrentUser,
) -> NoteOut:
    note = await _get_live_note(db, note_id, actor)
    await _authorize_host(db, actor, note.entity_type, note.entity_id, "change")
    if body.body is None and body.visibility is None:
        raise _err(422, "nothing_to_update")
    if body.visibility is not None \
            and not can_set_visibility(actor.access, body.visibility):
        raise _err(403, "visibility_not_allowed")
    changes: dict = {"note_id": str(note.id)}
    edited = body.body is not None and body.body != note.body
    if edited:
        note.body = body.body
    if body.visibility is not None and body.visibility != note.visibility:
        changes["visibility"] = {"from": note.visibility, "to": body.visibility}
        note.visibility = body.visibility
    if edited or len(changes) > 1:
        note.updated_by = actor.person.id
        note.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor.person.id, entity_type=note.entity_type,
              entity_id=str(note.entity_id), action="note.update",
              changes=changes)
    await db.commit()
    authors = await _authors(db, {note.created_by})
    return _out(note, authors)


@router.delete("/{note_id}", status_code=204)
async def delete_note(
    note_id: uuid.UUID,
    db: DbSession,
    actor: CurrentUser,
) -> None:
    note = await _get_live_note(db, note_id, actor)
    await _authorize_host(db, actor, note.entity_type, note.entity_id, "delete")
    note.deleted_at = datetime.now(UTC)
    note.updated_by = actor.person.id
    audit(db, actor_id=actor.person.id, entity_type=note.entity_type,
          entity_id=str(note.entity_id), action="note.remove",
          changes={"note_id": str(note.id)})
    await db.commit()
