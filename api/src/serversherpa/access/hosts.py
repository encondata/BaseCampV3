"""The record types that host notes and Notes & files attachments, and the
one read rule both routers share: host resource `view` + the host row
inside the actor's scope (404 outside it). Per-item visibility (Everyone /
Internal / Admin) is layered on top by each router."""

import uuid
from typing import TYPE_CHECKING

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.scope import scope_conditions
from serversherpa.db.models import (
    Asset,
    Client,
    Container,
    Initiative,
    Partner,
    Person,
    Site,
    Truck,
    WorkerProfile,
)

if TYPE_CHECKING:
    from serversherpa.api.deps import AuthContext

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


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def authorize_host_view(
    db: AsyncSession, actor: "AuthContext", entity_type: str,
    entity_id: uuid.UUID,
) -> None:
    """Host resource view + host row in the actor's scope (404 outside it)."""
    host = NOTE_HOSTS.get(entity_type)
    if host is None:
        raise _err(422, "unknown_entity_type")
    resource, model = host
    if not actor.access.can(resource, "view"):
        raise _err(403, "forbidden")
    row = await db.get(model, entity_id)
    if row is None:
        raise _err(404, "entity_not_found")
    cond = scope_conditions(resource, actor.access, actor.person.id)
    if cond is not None:
        probe = SCOPE_PROBES.get(entity_type)
        query = (probe(entity_id, cond) if probe
                 else select(model.id).where(model.id == entity_id, cond))
        if await db.scalar(query) is None:
            raise _err(404, "entity_not_found")
