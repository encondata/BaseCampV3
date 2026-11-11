"""The record types that host notes and Notes & files attachments, and the
one read rule both routers share: host resource `view` + the host row
inside the actor's scope (404 outside it). Per-item visibility (Everyone /
Internal / Admin) is layered on top by each router.

Client groups (spec answer 3): a login restricted at the host's client (a
viewer with group chips, or an individual) sees no notes and no files on
that client's assets, moves or client record. `authorize_host_view` reports
it (lists come back empty) and `host_items_hidden` is the same check for
one note or file by id (it reads as missing)."""

import uuid
from typing import TYPE_CHECKING

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.scope import is_restricted_at, scope_conditions
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


# entity_type -> the host row's client id, for the client-groups check
HOST_CLIENT = {
    "asset": lambda row: row.client_id,
    "initiative": lambda row: row.client_id,
    "client": lambda row: row.id,
}


def _err(status: int, code: str) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code})


async def authorize_host_view(
    db: AsyncSession, actor: "AuthContext", entity_type: str,
    entity_id: uuid.UUID,
) -> bool:
    """Host resource view + host row in the actor's scope (404 outside it).
    Returns False when the host's notes and files are hidden from the
    actor (client groups): the caller lists nothing."""
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
    return not await host_items_hidden(db, actor, entity_type, entity_id)


async def host_items_hidden(
    db: AsyncSession, actor: "AuthContext", entity_type: str,
    entity_id: uuid.UUID,
) -> bool:
    """True when the actor is restricted at the host's client, so every note
    and file on it is hidden. Global staff and unrestricted logins: False."""
    pick = HOST_CLIENT.get(entity_type)
    if pick is None or not actor.access.restricted_clients():
        return False
    model = NOTE_HOSTS[entity_type][1]
    row = await db.get(model, entity_id)
    return row is not None and is_restricted_at(actor.access, pick(row))
