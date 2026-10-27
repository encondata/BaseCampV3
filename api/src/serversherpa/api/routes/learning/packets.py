"""Packet routes: ordered lists of learning documents. Reads need
`learning:view`; create and copy `add`; edits `change`; archive `delete`
(`require_manager`, so wiki administrators too)."""
import uuid

from fastapi import APIRouter, HTTPException, Response

from serversherpa.api.deps import AuthContext, DbSession
from serversherpa.learning import packets
from serversherpa.learning.access import require_manager
from serversherpa.learning.models import LearningPacket
from serversherpa.learning.schemas import (
    PacketCreateIn,
    PacketListItem,
    PacketOut,
    PacketPatchIn,
)

router = APIRouter()


async def _packet(db, packet_id: uuid.UUID) -> LearningPacket:
    packet = await db.get(LearningPacket, packet_id)
    if packet is None:
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": "Not found."})
    return packet


@router.get("/packets", response_model=list[PacketListItem])
async def list_packets(
    db: DbSession,
    include_archived: bool = False,
    actor: AuthContext = require_manager("view"),
) -> list[dict]:
    return await packets.list_packets(db, include_archived=include_archived)


@router.post("/packets", response_model=PacketOut, status_code=201)
async def create_packet(
    body: PacketCreateIn,
    db: DbSession,
    actor: AuthContext = require_manager("add"),
) -> dict:
    packet = await packets.create_packet(
        db, actor_id=actor.person.id, items=body.items,
        **body.model_dump(exclude={"items"}))
    await db.commit()
    await db.refresh(packet)
    return await packets.packet_out(db, packet)


@router.get("/packets/{packet_id}", response_model=PacketOut)
async def get_packet(
    packet_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("view"),
) -> dict:
    return await packets.packet_out(db, await _packet(db, packet_id))


@router.patch("/packets/{packet_id}", response_model=PacketOut)
async def patch_packet(
    packet_id: uuid.UUID,
    body: PacketPatchIn,
    db: DbSession,
    actor: AuthContext = require_manager("change"),
) -> dict:
    packet = await _packet(db, packet_id)
    changes = body.model_dump(exclude_unset=True, exclude={"items"})
    await packets.update_packet(db, packet, actor_id=actor.person.id, changes=changes,
                                items=body.items)
    await db.commit()
    await db.refresh(packet)
    return await packets.packet_out(db, packet)


@router.post("/packets/{packet_id}/copy", response_model=PacketOut, status_code=201)
async def copy_packet(
    packet_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("add"),
) -> dict:
    copy = await packets.copy_packet(db, await _packet(db, packet_id), actor_id=actor.person.id)
    await db.commit()
    await db.refresh(copy)
    return await packets.packet_out(db, copy)


@router.delete("/packets/{packet_id}", status_code=204)
async def archive_packet(
    packet_id: uuid.UUID,
    db: DbSession,
    actor: AuthContext = require_manager("delete"),
) -> Response:
    await packets.archive_packet(db, await _packet(db, packet_id), actor_id=actor.person.id)
    await db.commit()
    return Response(status_code=204)
