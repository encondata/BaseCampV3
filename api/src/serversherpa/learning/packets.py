"""Learning packets: named, ordered lists of documents that assignment
rules (`rules.py`) hand to people. A packet is archived, never deleted
(assignments keep pointing at it); archived packets are skipped by the
rules and can't be edited.

Services never commit; each mutation adds a `learning_packet_*` audit
row to the session."""
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.ordering import natural
from serversherpa.learning.models import (
    LearningDocument,
    LearningDocumentVersion,
    LearningPacket,
    LearningPacketItem,
    LearningRule,
)
from serversherpa.services.audit import audit, diff

ENTITY = "learning_packet"
FIELDS = ("name", "description", "enforce_order", "due_offset_days", "icon", "color")


def _err(status: int, code: str, message: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, "message": message})


def _now() -> datetime:
    return datetime.now(UTC)


async def _item_rows(db: AsyncSession, packet_id: uuid.UUID) -> list[LearningPacketItem]:
    return list(await db.scalars(
        select(LearningPacketItem).where(LearningPacketItem.packet_id == packet_id)
        .order_by(LearningPacketItem.position, LearningPacketItem.created_at)))


async def packet_out(db: AsyncSession, packet: LearningPacket) -> dict:
    """The packet with its documents in order (title and current version
    number, for the editor)."""
    rows = (await db.execute(
        select(LearningPacketItem.document_id, LearningDocument.title,
               LearningDocumentVersion.version_no, LearningDocument.archived_at)
        .join(LearningDocument, LearningDocument.id == LearningPacketItem.document_id)
        .outerjoin(LearningDocumentVersion,
                   LearningDocumentVersion.id == LearningDocument.current_version_id)
        .where(LearningPacketItem.packet_id == packet.id)
        .order_by(LearningPacketItem.position, LearningPacketItem.created_at))).all()
    return {
        **{key: getattr(packet, key) for key in FIELDS},
        "id": packet.id,
        "items": [{"document_id": doc_id, "title": title, "current_version_no": version_no,
                   "archived": archived is not None}
                  for doc_id, title, version_no, archived in rows],
        "archived_at": packet.archived_at, "created_at": packet.created_at,
        "updated_at": packet.updated_at}


async def list_packets(db: AsyncSession, *, include_archived: bool = False) -> list[dict]:
    query = select(LearningPacket).order_by(natural(LearningPacket.name))
    if not include_archived:
        query = query.where(LearningPacket.archived_at.is_(None))
    packets = list(await db.scalars(query))
    if not packets:
        return []
    ids = [p.id for p in packets]
    item_counts = dict((await db.execute(
        select(LearningPacketItem.packet_id, func.count())
        .where(LearningPacketItem.packet_id.in_(ids))
        .group_by(LearningPacketItem.packet_id))).all())
    rule_counts = dict((await db.execute(
        select(LearningRule.packet_id, func.count())
        .where(LearningRule.packet_id.in_(ids))
        .group_by(LearningRule.packet_id))).all())
    return [{**{key: getattr(p, key) for key in FIELDS}, "id": p.id,
             "item_count": item_counts.get(p.id, 0), "rule_count": rule_counts.get(p.id, 0),
             "archived_at": p.archived_at} for p in packets]


async def _check_items(db: AsyncSession, document_ids: list[uuid.UUID],
                       keep: set[uuid.UUID]) -> None:
    """Every id is a document, listed once; an archived one is only
    accepted when the packet already holds it (`keep`)."""
    if len(set(document_ids)) != len(document_ids):
        raise _err(422, "duplicate_document", "A document can be in a packet only once.")
    found = {doc.id: doc for doc in await db.scalars(
        select(LearningDocument).where(LearningDocument.id.in_(document_ids)))}
    for doc_id in document_ids:
        doc = found.get(doc_id)
        if doc is None or (doc.archived_at is not None and doc_id not in keep):
            raise _err(422, "bad_document",
                       "A document in this packet doesn't exist or is archived.")


async def _set_items(db: AsyncSession, packet: LearningPacket,
                     document_ids: list[uuid.UUID]) -> list[str] | None:
    """Replace the packet's documents with `document_ids`, in that order.
    Returns the audit delta (None when nothing changed)."""
    existing = await _item_rows(db, packet.id)
    before = [str(item.document_id) for item in existing]
    await _check_items(db, document_ids, {item.document_id for item in existing})
    by_doc = {item.document_id: item for item in existing}
    for item in existing:
        if item.document_id not in document_ids:
            await db.delete(item)
    for index, doc_id in enumerate(document_ids, start=1):
        if doc_id in by_doc:
            by_doc[doc_id].position = float(index)
        else:
            db.add(LearningPacketItem(packet_id=packet.id, document_id=doc_id,
                                      position=float(index)))
    await db.flush()
    after = [str(d) for d in document_ids]
    return {"from": before, "to": after} if before != after else None


async def create_packet(db: AsyncSession, *, actor_id: uuid.UUID | None,
                        items: list[uuid.UUID], **fields: Any) -> LearningPacket:
    packet = LearningPacket(created_by=actor_id, **fields)
    db.add(packet)
    await db.flush()
    await _set_items(db, packet, items)
    audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(packet.id),
          action="learning_packet_create",
          changes={**{k: v for k, v in fields.items() if v is not None},
                   "items": [str(d) for d in items]})
    return packet


async def update_packet(db: AsyncSession, packet: LearningPacket, *,
                        actor_id: uuid.UUID | None, changes: dict[str, Any],
                        items: list[uuid.UUID] | None = None) -> None:
    """Apply `changes` (field → value) and, when `items` is given, replace
    the documents. 409 `archived` for an archived packet."""
    if packet.archived_at is not None:
        raise _err(409, "archived", "This packet is archived.")
    before = {key: getattr(packet, key) for key in changes}
    for key, value in changes.items():
        setattr(packet, key, value)
    delta = diff(before, changes)
    if items is not None:
        items_delta = await _set_items(db, packet, items)
        if items_delta:
            delta["items"] = items_delta
    if delta:
        packet.updated_at = _now()
        audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(packet.id),
              action="learning_packet_update", changes=delta)


async def archive_packet(db: AsyncSession, packet: LearningPacket, *,
                         actor_id: uuid.UUID | None) -> None:
    if packet.archived_at is not None:
        return
    packet.archived_at = packet.updated_at = _now()
    audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(packet.id),
          action="learning_packet_archive")


async def copy_packet(db: AsyncSession, source: LearningPacket, *,
                      actor_id: uuid.UUID | None) -> LearningPacket:
    """A new packet "Copy of <name>" with the same settings and documents
    (rules are not copied)."""
    name = f"Copy of {source.name}"[:200]
    copy = LearningPacket(name=name, created_by=actor_id,
                          **{k: getattr(source, k) for k in FIELDS if k != "name"})
    db.add(copy)
    await db.flush()
    for item in await _item_rows(db, source.id):
        db.add(LearningPacketItem(packet_id=copy.id, document_id=item.document_id,
                                  position=item.position))
    await db.flush()
    audit(db, actor_id=actor_id, entity_type=ENTITY, entity_id=str(copy.id),
          action="learning_packet_copy", changes={"copied_from": str(source.id), "name": name})
    return copy
