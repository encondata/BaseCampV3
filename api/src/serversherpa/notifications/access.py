"""Who can see a thing. The notification worker has to say, for people other than the one
making a request, whether each of them can open an initiative, a site, a truck or a device,
and the answer must be the one that thing's own page gives: `_get_initiative` for an
initiative (api/routes/initiatives.py), `get_site` and `get_truck` for a site and a truck,
and the device lists and kiosk page (api/routes/devices.py, `scanning_hardware` view) for a
device. A watch on something a person can't open stays silent, and an Everything watch never
carries one client's work to another client's user.

`viewers` makes that decision for many people at once. `active_ids` is the wiki's rule for
who is still a person to tell (wiki/notify.py), and `thing_exists` says whether the row is
still there. `viewers` does not check that an account is active: ask `active_ids` as well.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (Anti-goals and section 4)"""

import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import AccessInfo, resolve_access_many
from serversherpa.access.scope import scope_conditions
from serversherpa.db.models import Device, Initiative, Person, Site, Truck, UserAccount
from serversherpa.notifications.events import Thing


@dataclass(frozen=True)
class _Page:
    """What a kind of thing's page is made of: its table, and the resource whose `view`
    permission opens it."""

    model: type[Initiative] | type[Site] | type[Truck] | type[Device]
    resource: str


_PAGES: dict[str, _Page] = {
    "initiative": _Page(Initiative, "initiatives"),
    "site": _Page(Site, "sites"),
    "truck": _Page(Truck, "trucks"),
    "device": _Page(Device, "scanning_hardware"),
}

# The kinds of thing `viewers` can answer for: initiative, site, truck, device.
VIEWABLE_THINGS: tuple[str, ...] = tuple(_PAGES)


def _page(thing: Thing) -> _Page:
    try:
        return _PAGES[thing.type]
    except KeyError:
        raise ValueError(f"not a viewable kind of thing: {thing.type!r}") from None


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
    model = _page(thing).model
    return await db.scalar(select(model.id).where(model.id == thing.id)) is not None


async def _initiative_in_scope(db: AsyncSession, initiative_id: uuid.UUID,
                               person_id: uuid.UUID, info: AccessInfo) -> bool:
    """The row-scope half of `_get_initiative`: the same condition, probed the same way. A
    global person is unrestricted; a client's user sees that client's initiatives only."""
    cond = scope_conditions("initiatives", info, person_id)
    if cond is None:
        return True
    return await db.scalar(
        select(Initiative.id).where(Initiative.id == initiative_id, cond)) is not None


async def viewers(db: AsyncSession, thing: Thing, person_ids: Iterable[uuid.UUID], *,
                  access: Mapping[uuid.UUID, AccessInfo] | None = None) -> set[uuid.UUID]:
    """The people among `person_ids` who can open `thing`'s page right now.

    An initiative needs `initiatives:view` and, for anyone who isn't global, the initiative
    to be in their scope (archived ones are still readable). A site needs `sites:view`, a
    truck `trucks:view` and a device `scanning_hardware:view`; those resources are
    global-only, so no row scope applies. A thing whose row is gone has no viewers. Raises
    ValueError for a kind of thing outside VIEWABLE_THINGS, before anything else.

    Everyone's access is resolved in one batch. `access` skips that and is used as it stands:
    a person it has no entry for is not a viewer."""
    page = _page(thing)
    ids = list(dict.fromkeys(person_ids))
    if not ids or not await thing_exists(db, thing):
        return set()
    if access is None:
        access = await resolve_access_many(db, ids)
    out: set[uuid.UUID] = set()
    for person_id in ids:
        info = access.get(person_id)
        if info is None or not info.can(page.resource, "view"):
            continue
        # Sites, trucks and devices have no row scope: only a global person can hold their
        # permission.
        if thing.type == "initiative" and not await _initiative_in_scope(
                db, thing.id, person_id, info):
            continue
        out.add(person_id)
    return out
