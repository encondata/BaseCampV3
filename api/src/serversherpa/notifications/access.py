"""Who can see a thing. The notification worker has to say, for people other than the one
making a request, whether each of them can open an initiative, a site, a truck, a device, an
asset, a container or a worker, and the answer must be the one that thing's own page gives:
`_get_initiative` for an initiative (api/routes/initiatives.py), `get_site` and `get_truck` for
a site and a truck, the device lists and kiosk page (api/routes/devices.py, `scanning_hardware`
view) for a device, `get_asset` (api/routes/assets.py) and `get_container`
(api/routes/containers.py) for an asset and a container, and `get_worker`
(api/routes/workers.py) for a person, whose page is a worker's. A watch on something a person
can't open stays silent, an Everything watch never carries one client's work to another
client's user, and a status rule's notice tells each person only of the matched things they
can open.

`visible_among` makes that decision for many people and many things of one kind at once, in a
fixed number of queries per person however many things there are (a rule's notice can be about
thousands); `viewers` asks it about one thing. Neither checks that an account is active: ask
`active_ids` as well, the wiki's rule for who is still a person to tell (wiki/notify.py).
`thing_exists` says whether the row is still there.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (Anti-goals and section 4)"""

import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import ColumnElement, Select, any_, literal, select
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from serversherpa.access.resolver import AccessInfo, resolve_access_many
from serversherpa.access.scope import scope_conditions
from serversherpa.db.models import (
    Asset,
    Container,
    Device,
    Initiative,
    Person,
    PersonRole,
    Site,
    Truck,
    UserAccount,
    WorkerProfile,
)
from serversherpa.notifications.events import Thing


@dataclass(frozen=True)
class _Page:
    """What a kind of thing's page is made of: its table, the resource whose `view` permission
    opens it, and for a resource with row scope the column the page probes its scope condition
    through (`scope_conditions` for the resource, on that column's table). None means the
    resource is global-only: only a global person can hold its permission, so there is no row
    scope to probe. A worker's page also needs the person to hold the worker role."""

    model: type[Any]
    resource: str
    scope: InstrumentedAttribute[uuid.UUID] | None = None
    worker: bool = False


_PAGES: dict[str, _Page] = {
    "initiative": _Page(Initiative, "initiatives", Initiative.id),
    "site": _Page(Site, "sites"),
    "truck": _Page(Truck, "trucks"),
    "device": _Page(Device, "scanning_hardware"),
    # GET /assets/{id}: the client scope probe on the asset row
    "asset": _Page(Asset, "assets", Asset.id),
    "container": _Page(Container, "containers"),
    # GET /workers/{id}: `_require_worker`, then `_check_worker_scope`, the probe on the
    # worker's profile (a partner's people see the workers it supplies, a worker sees themself)
    "person": _Page(Person, "workers", WorkerProfile.person_id, worker=True),
}

# The kinds of thing `viewers` and `visible_among` can answer for.
VIEWABLE_THINGS: tuple[str, ...] = tuple(_PAGES)


def _page(thing_type: str) -> _Page:
    try:
        return _PAGES[thing_type]
    except KeyError:
        raise ValueError(f"not a viewable kind of thing: {thing_type!r}") from None


def _among(column: InstrumentedAttribute[uuid.UUID],
           ids: Iterable[uuid.UUID]) -> ColumnElement[bool]:
    """`column = ANY(ids)`, the ids bound as one array. `IN` binds each id as a parameter of
    its own, and a rule's notice can name more things than one statement takes (asyncpg stops
    at 32,767)."""
    return column == any_(literal(list(ids), ARRAY(PG_UUID(as_uuid=True))))


def _openable(page: _Page, ids: Sequence[uuid.UUID]) -> Select[tuple[uuid.UUID]]:
    """The ids among `ids` whose page can open at all: the row is there (an archived row
    counts), and for a worker's page the person holds the worker role, unrevoked (anyone
    else's answers 422 `not_a_worker` to everyone who may look)."""
    if page.worker:
        return (select(PersonRole.person_id).distinct()
                .where(_among(PersonRole.person_id, ids), PersonRole.role == "worker",
                       PersonRole.revoked_at.is_(None)))
    return select(page.model.id).where(_among(page.model.id, ids))


async def active_ids(db: AsyncSession, person_ids: Iterable[uuid.UUID]) -> set[uuid.UUID]:
    """The people among `person_ids` with an account that is still in use: an account row
    exists, it isn't disabled and the person isn't archived (the wiki's rule). A person
    with no account is not among them."""
    ids = list(dict.fromkeys(person_ids))
    if not ids:
        return set()
    return set((await db.scalars(
        select(UserAccount.person_id)
        .join(Person, Person.id == UserAccount.person_id)
        .where(UserAccount.person_id.in_(ids),
               UserAccount.disabled_at.is_(None),
               Person.archived_at.is_(None))
    )).all())


async def thing_exists(db: AsyncSession, thing: Thing) -> bool:
    """Whether the row is there now. An archived row counts: its page still opens (a device
    is never archived, only deleted). Raises ValueError for a kind of thing outside
    VIEWABLE_THINGS."""
    model = _page(thing.type).model
    return await db.scalar(select(model.id).where(model.id == thing.id)) is not None


async def visible_among(db: AsyncSession, thing_type: str, ids: Iterable[uuid.UUID],
                        person_ids: Iterable[uuid.UUID], *,
                        access: Mapping[uuid.UUID, AccessInfo] | None = None,
                        ) -> dict[uuid.UUID, frozenset[uuid.UUID]]:
    """For each person among `person_ids` who can open some of the things `ids`, all of one
    kind (`thing_type`), the ids of the ones they can open right now: what each thing's page
    would say for each of them.

    A page needs its resource's `view` permission and, for anyone who isn't global, the thing to
    be in their row scope: a client's user sees that client's initiatives and assets only, a
    partner's people the workers it supplies, and a worker themself. Sites, trucks, devices and
    containers are global-only, so no row scope applies. A person's page is a worker's: it opens
    only while they hold the worker role. A thing whose row is gone opens for nobody.

    The cost doesn't grow with the number of things: one query finds the ones whose page can
    open at all, one batch resolves everyone's access, and only a person with row scope costs one
    more, for all the things at once. People who can open none are left out, and people who open
    all of them share one set, so never change one. Raises ValueError for a kind of thing outside
    VIEWABLE_THINGS, before anything else. `access` skips resolving and is used as it stands: a
    person it has no entry for opens nothing."""
    page = _page(thing_type)
    things = list(dict.fromkeys(ids))
    people = list(dict.fromkeys(person_ids))
    if not things or not people:
        return {}
    present = frozenset(await db.scalars(_openable(page, things)))
    if not present:
        return {}
    if access is None:
        access = await resolve_access_many(db, people)
    out: dict[uuid.UUID, frozenset[uuid.UUID]] = {}
    for person_id in people:
        info = access.get(person_id)
        if info is None or not info.can(page.resource, "view"):
            continue
        cond = (scope_conditions(page.resource, info, person_id)
                if page.scope is not None else None)
        if cond is None:                  # global, or a global-only resource
            out[person_id] = present
            continue
        theirs = frozenset(await db.scalars(
            select(page.scope).where(_among(page.scope, present), cond)))
        if theirs:
            out[person_id] = theirs
    return out


async def viewers(db: AsyncSession, thing: Thing, person_ids: Iterable[uuid.UUID], *,
                  access: Mapping[uuid.UUID, AccessInfo] | None = None) -> set[uuid.UUID]:
    """The people among `person_ids` who can open `thing`'s page right now: `visible_among`,
    asked about the one thing. Raises ValueError for a kind of thing outside VIEWABLE_THINGS,
    before anything else. `access` is used as it stands: a person it has no entry for is not a
    viewer."""
    return set(await visible_among(db, thing.type, [thing.id], person_ids, access=access))
