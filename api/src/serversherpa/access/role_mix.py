"""One person never holds a client tier and the `worker` role at once.

The worker role grants `kiosk:view`, and the kiosk sync routes check only
that, so a client contact who is also a worker would reach every move's
full roster and bypass their client's group limits. Every path that grants
either side asks `assert_no_client_worker_mix` first: granting `worker` to
someone with an active client-anchored role, or a client-anchored role to
someone with an active `worker` role, raises `RoleMixError`, which the API
answers with 409 `client_worker_conflict` (api/app.py). A bulk importer
fails that row instead, with the same reason.

Combinations that existed before this rule are left alone: nothing here
revokes a role, and a grant that is already held is not a new grant. Such a
person can't be given group chips either (`holds_worker`, checked by the
contact PATCH), and the kiosk routes that hand out roster or asset data
refuse anyone with group limits outright (api/deps.py
`require_kiosk_data`), which also covers cloned worker roles and kiosk
overrides this name-based rule can't see.

Spec: docs/superpowers/specs/2026-11-10-client-groups-design.md (Answers to
the open questions, item 4)"""

import uuid
from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import PersonRole, Role

WORKER_ROLE = "worker"
CONFLICT_CODE = "client_worker_conflict"
# A bulk import row's error for a person this rule refuses.
CONFLICT_ROW_ERROR = f"A client contact can't also be a worker ({CONFLICT_CODE})."


class RoleMixError(Exception):
    """A grant that would give one person a client tier and the worker role."""

    code = CONFLICT_CODE

    def __init__(self) -> None:
        super().__init__(CONFLICT_CODE)


async def client_contact_ids(db: AsyncSession,
                             person_ids: Iterable[uuid.UUID] | None = None) -> set[uuid.UUID]:
    """The people (among `person_ids`, or everyone) holding an active
    client-anchored role (`client_owner`, `client_admin`, `client_viewer`,
    `client_individual`)."""
    q = (select(PersonRole.person_id).distinct()
         .join(Role, Role.name == PersonRole.role)
         .where(Role.scope_anchor == "client", PersonRole.revoked_at.is_(None)))
    if person_ids is not None:
        ids = list(dict.fromkeys(person_ids))
        if not ids:
            return set()
        q = q.where(PersonRole.person_id.in_(ids))
    return set(await db.scalars(q))


async def holds_worker(db: AsyncSession, person_id: uuid.UUID) -> bool:
    """True when the person holds an active `worker` role."""
    return await db.scalar(select(PersonRole.id).where(
        PersonRole.person_id == person_id, PersonRole.role == WORKER_ROLE,
        PersonRole.revoked_at.is_(None)).limit(1)) is not None


async def assert_no_client_worker_mix(db: AsyncSession, person_id: uuid.UUID,
                                      adding_role: str) -> None:
    """Raise RoleMixError when granting `adding_role` to the person would
    give them a client tier and the worker role at once. Any other role, a
    partner tier say, passes. Reads only."""
    if adding_role == WORKER_ROLE:
        if await client_contact_ids(db, [person_id]):
            raise RoleMixError()
        return
    anchor = await db.scalar(select(Role.scope_anchor).where(Role.name == adding_role))
    if anchor == "client" and await holds_worker(db, person_id):
        raise RoleMixError()
