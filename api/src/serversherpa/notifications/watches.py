"""Watches. A person, or a notification group, watches an initiative, a site, a truck, a
device or a wiki library, folder or page, or chosen kinds of event everywhere (an "Everything"
watch): `NotificationWatch`, migrations 0113 and 0116. This module validates and stores them,
lists what a person hears about, and works out which watches an event reaches
(`matching_routes`, for the event sweep and the send-time re-check), which of a person's would
hear a kind of event (`watches_hearing`, for Check delivery) and who watches a set of things at
all (`routes_watching`, for the wiki's own fan-out).

A watch on a thing hears the events whose subject is that thing, or that reach it
(`NotificationEvent.reaches`), so a watch on an initiative also hears its child initiatives.
An Everything watch names its events, and only a kind marked `everywhere` can be named. A wiki
watch names none: no kind of event reaches a wiki thing, and the wiki's fan-out (wiki/notify.py)
tells its watchers of every page update and comment, as it always has. Access is not stored: a
watch whose owner can't open its thing stays in place and is neither listed nor delivered until
they can again. Only the devices notifications check can be watched (services/device_online.py
`covered`), and no wiki folder or page in the trash.

Like notify() and announce(), nothing here commits: the routes do.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (sections 1, 2, 4, 7 and
10)"""

import uuid
from collections import defaultdict
from collections.abc import Callable, Iterable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import ColumnElement, and_, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.access.resolver import AccessInfo, resolve_access_many
from serversherpa.config import get_settings
from serversherpa.db.models import (
    Device,
    Initiative,
    NotificationEvent,
    NotificationGroup,
    NotificationGroupMember,
    NotificationWatch,
    Site,
    Truck,
    WikiNode,
    WikiSpace,
)
from serversherpa.notifications.access import viewers, visible_among
from serversherpa.notifications.events import Thing
from serversherpa.notifications.kinds import KINDS
from serversherpa.services.device_online import covered, device_link, display_name

EVERYTHING = "everything"

# The unique index over a subscriber and a thing: a second watch on the same thing, or a second
# Everything watch, collides on it.
_UNIQUE_TARGET = "uq_notification_watches_target"


def _stored_name(row: Any) -> str:
    """A thing called by its name as stored, as its page and its list show it."""
    return row.name


@dataclass(frozen=True)
class ThingSpec[Row]:
    """What a kind of thing is made of: the watch column holding its id, its table (rows of
    `Row`), what the portal calls the kind, and, worked out from a loaded row, where its page is
    and what it is called (for a device, both depend on what kind of device it is: a router is
    named as on the Routers page). `can_watch` is for a kind of which only some rows can be
    watched: it says whether this row can. None means every row can. It is not
    `KindInfo.watchable`, which says whether a kind of event can be watched for. `row_label` is
    for a kind whose rows the portal calls by different names (a wiki folder or page): what it
    calls this row. None means `label`."""

    column: str
    model: type[Row]
    label: str
    link: Callable[[Row], str]
    can_watch: Callable[[Row], bool] | None = None
    name: Callable[[Row], str] = _stored_name
    row_label: Callable[[Row], str] | None = None

    def label_of(self, row: Row) -> str:
        """What the portal calls this row's kind, as the chip beside its name says it."""
        return self.row_label(row) if self.row_label is not None else self.label


def _in_the_wiki(path: str) -> str:
    """The absolute URL of a page of the wiki, which is an app of its own (`wiki_origin`), as
    the wiki's notices link to it (wiki/notify.py `node_link`)."""
    return f"{get_settings().wiki_origin.rstrip('/')}{path}"


def _node_label(row: WikiNode) -> str:
    return "Wiki folder" if row.kind == "folder" else "Wiki page"


# The things the API takes a watch on. A device can be watched only while notifications check it
# (an RFID Station, a fixed reader or an approved router); a wiki folder or page only while it
# is out of the trash.
THINGS: Mapping[str, ThingSpec[Any]] = {
    "initiative": ThingSpec("initiative_id", Initiative, "Initiative",
                            lambda row: f"/initiatives/{row.id}"),
    "site": ThingSpec("site_id", Site, "Site", lambda row: f"/sites/{row.id}"),
    "truck": ThingSpec("truck_id", Truck, "Truck", lambda row: f"/logistics/trucks/{row.id}"),
    "device": ThingSpec("device_id", Device, "Device", device_link, can_watch=covered,
                        name=display_name),
    "wiki_space": ThingSpec("wiki_space_id", WikiSpace, "Wiki library",
                            lambda row: _in_the_wiki(f"/library/{row.key}")),
    "wiki_node": ThingSpec("wiki_node_id", WikiNode, "Wiki page",
                           lambda row: _in_the_wiki(f"/n/{row.id}"),
                           can_watch=lambda row: row.deleted_at is None,
                           name=lambda row: row.title, row_label=_node_label),
}

# The wiki's two kinds of thing: their watches are the wiki's own as well (api/routes/wiki).
WIKI_THINGS = frozenset({"wiki_space", "wiki_node"})

# Every column of a watch that names a thing: an Everything watch has none of them set. THINGS
# takes every one the table has (tests/test_watch_matching.py holds the two lists together).
_THING_COLUMNS = tuple(spec.column for spec in THINGS.values())


class WatchError(Exception):
    """A watch request that can't be honored. `.status` is the HTTP status a route answers
    with and `.code` its error code."""

    def __init__(self, status: int, code: str):
        super().__init__(code)
        self.status = status
        self.code = code


# ── what a watch may name ───────────────────────────────────────────

def kinds_for(thing: str) -> list[str]:
    """The kinds of event a watch on `thing` can name, in registry order: those marked
    `everywhere` for an Everything watch, else those that reach the kind of thing."""
    if thing == EVERYTHING:
        return [kind for kind, info in KINDS.items() if info.everywhere]
    return [kind for kind, info in KINDS.items() if thing in info.reaches]


def clean_kinds(thing: str, kinds: Sequence[str]) -> list[str]:
    """`kinds` without repeats, in registry order. A kind a watch on `thing` can't name is
    422 `invalid_kind`; an Everything watch with none is 422 `kinds_required`. A thing's empty
    list stays empty: every event that applies."""
    allowed = kinds_for(thing)
    wanted = set(kinds)
    if not wanted <= set(allowed):
        raise WatchError(422, "invalid_kind")
    if thing == EVERYTHING and not wanted:
        raise WatchError(422, "kinds_required")
    return [kind for kind in allowed if kind in wanted]


def thing_of(watch: NotificationWatch) -> Thing | None:
    """What the watch is on, or None for an Everything watch."""
    for name, spec in THINGS.items():
        thing_id = getattr(watch, spec.column)
        if thing_id is not None:
            return Thing(name, thing_id)
    return None


# ── adding one ──────────────────────────────────────────────────────

async def _existing(db: AsyncSession, person_id: uuid.UUID | None, group_id: uuid.UUID | None,
                    thing: str, thing_id: uuid.UUID | None) -> uuid.UUID | None:
    """The id of the subscriber's watch on this thing (or their Everything watch), if any."""
    subscriber = (NotificationWatch.person_id == person_id if person_id is not None
                  else NotificationWatch.group_id == group_id)
    if thing == EVERYTHING:
        target = and_(*(getattr(NotificationWatch, column).is_(None)
                        for column in _THING_COLUMNS))
    else:
        target = getattr(NotificationWatch, THINGS[thing].column) == thing_id
    return await db.scalar(select(NotificationWatch.id).where(subscriber, target))


async def add_watch(db: AsyncSession, *, thing: str, thing_id: uuid.UUID | None,
                    kinds: Sequence[str], viewer_id: uuid.UUID, viewer_access: AccessInfo,
                    created_by: uuid.UUID | None, person_id: uuid.UUID | None = None,
                    group_id: uuid.UUID | None = None) -> NotificationWatch:
    """Add a watch for a person (`person_id`) or a group (`group_id`, exactly one of them) on
    `thing`, or an Everything watch when `thing` is "everything". The viewer is whoever is
    asking, the subscriber themselves or the admin adding it for a group: they have to be able
    to open the thing. It flushes and never commits.

    422 `invalid_thing` for an unknown thing, an Everything watch given an id and any other
    thing without one; 422 for kinds that don't fit (clean_kinds); 404 `thing_not_found` when
    the thing is missing or the viewer can't open it; 422 `invalid_thing` again for a thing
    the viewer can open but that can't be watched (a device notifications don't check);
    409 `already_watching` when the subscriber already has this watch, including when a
    concurrent request wins the insert."""
    if (person_id is None) == (group_id is None):
        raise ValueError("a watch is for exactly one of person_id and group_id")
    fields: dict[str, uuid.UUID] = {}
    spec: ThingSpec[Any] | None = None
    if thing == EVERYTHING:
        if thing_id is not None:
            raise WatchError(422, "invalid_thing")
    else:
        spec = THINGS.get(thing)
        if spec is None or thing_id is None:
            raise WatchError(422, "invalid_thing")
        fields[spec.column] = thing_id
    cleaned = clean_kinds(thing, kinds)
    # The same answer for a thing that isn't there and one the viewer can't open, so a 404
    # tells nothing about the thing.
    if thing_id is not None and viewer_id not in await viewers(
            db, Thing(thing, thing_id), [viewer_id], access={viewer_id: viewer_access}):
        raise WatchError(404, "thing_not_found")
    # Only now that the viewer is known to see the thing may a refusal say what it is.
    if spec is not None and spec.can_watch is not None:
        row = await db.get(spec.model, thing_id)
        if row is None:                 # deleted since the check above
            raise WatchError(404, "thing_not_found")
        if not spec.can_watch(row):
            raise WatchError(422, "invalid_thing")
    if await _existing(db, person_id, group_id, thing, thing_id) is not None:
        raise WatchError(409, "already_watching")

    watch = NotificationWatch(person_id=person_id, group_id=group_id, kinds=cleaned,
                              created_by=created_by, **fields)
    try:
        async with db.begin_nested():
            db.add(watch)
            await db.flush()
    except IntegrityError as exc:
        # Lost the check-then-insert race to a concurrent request, which the unique index
        # settled. Any other violation is a different bug and must not read as a friendly
        # duplicate (the constraint name is on asyncpg's own exception, chained onto
        # SQLAlchemy's DBAPI wrapper).
        asyncpg_exc = exc.orig.__cause__ if exc.orig is not None else None
        if getattr(asyncpg_exc, "constraint_name", None) != _UNIQUE_TARGET:
            raise
        raise WatchError(409, "already_watching") from None
    return watch


# ── listing them ────────────────────────────────────────────────────

@dataclass(frozen=True)
class WatchView:
    """A watch as it is shown: what it is on, by name and kind, and whose it is. `thing` is
    "everything" for an Everything watch, which has no id, name, kind or link. `link` is the
    thing's page in the portal, or for a wiki thing its absolute URL in the wiki. `group` is the
    group it belongs to, None for a person's own."""

    watch: NotificationWatch
    thing: str
    thing_id: uuid.UUID | None
    thing_name: str | None
    link: str | None
    group: NotificationGroup | None
    thing_label: str | None = None


_Row = tuple[NotificationWatch, NotificationGroup | None]


def _newest_first(query):
    return query.order_by(NotificationWatch.created_at.desc(), NotificationWatch.id)


async def _loaded(db: AsyncSession, things: Iterable[Thing]) -> dict[Thing, Any]:
    """The row of each thing that is still there, in one query per kind of thing."""
    ids: dict[str, list[uuid.UUID]] = defaultdict(list)
    for thing in things:
        ids[thing.type].append(thing.id)
    found: dict[Thing, Any] = {}
    for kind, thing_ids in ids.items():
        model = THINGS[kind].model
        for row in await db.scalars(select(model).where(model.id.in_(thing_ids))):
            found[Thing(kind, row.id)] = row
    return found


async def _views(db: AsyncSession, rows: Sequence[_Row]) -> list[WatchView]:
    """A view of each watch, in order. One on a thing that is gone is left out."""
    found = await _loaded(db, [thing for watch, _ in rows
                               if (thing := thing_of(watch)) is not None])
    views = []
    for watch, group in rows:
        thing = thing_of(watch)
        if thing is None:
            views.append(WatchView(watch, EVERYTHING, None, None, None, group))
        elif thing in found:
            row, spec = found[thing], THINGS[thing.type]
            views.append(WatchView(watch, thing.type, thing.id, spec.name(row), spec.link(row),
                                   group, spec.label_of(row)))
    return views


async def watch_view(db: AsyncSession, watch: NotificationWatch, *,
                     group: NotificationGroup | None = None) -> WatchView:
    """The view of one watch, for the route that has just added or changed it. A watch whose
    thing is gone is 404 `watch_not_found`."""
    views = await _views(db, [(watch, group)])
    if not views:
        raise WatchError(404, "watch_not_found")
    return views[0]


async def _visible(db: AsyncSession, person_id: uuid.UUID, rows: Sequence[_Row]) -> list[_Row]:
    """The rows whose thing the person can open now, by the rule the thing's own page uses
    (notifications/access.py), asked once per kind of thing however many there are (the wiki
    watches what its people create, so they can have many). Everything has no thing to open and
    stays."""
    ids: dict[str, list[uuid.UUID]] = defaultdict(list)
    for watch, _group in rows:
        if (thing := thing_of(watch)) is not None:
            ids[thing.type].append(thing.id)
    if not ids:
        return list(rows)
    access = await resolve_access_many(db, [person_id])
    seen: set[Thing] = set()
    for thing_type, thing_ids in ids.items():
        theirs = (await visible_among(db, thing_type, thing_ids, [person_id],
                                      access=access)).get(person_id, frozenset())
        seen.update(Thing(thing_type, thing_id) for thing_id in theirs)
    return [(watch, group) for watch, group in rows
            if (thing := thing_of(watch)) is None or thing in seen]


async def _person_rows(db: AsyncSession, person_id: uuid.UUID) -> list[_Row]:
    """The watches that speak for the person: their own, then those of the Active groups they
    belong to (a Paused group delivers nothing), each newest first. Access is not asked."""
    own = (await db.scalars(_newest_first(
        select(NotificationWatch).where(NotificationWatch.person_id == person_id)))).all()
    by_group = (await db.execute(_newest_first(
        select(NotificationWatch, NotificationGroup)
        .join(NotificationGroup, NotificationGroup.id == NotificationWatch.group_id)
        .join(NotificationGroupMember, and_(
            NotificationGroupMember.group_id == NotificationGroup.id,
            NotificationGroupMember.person_id == person_id))
        .where(NotificationGroup.enabled.is_(True))))).all()
    rows: list[_Row] = [(watch, None) for watch in own]
    rows += [(watch, group) for watch, group in by_group]
    return rows


async def person_watches(db: AsyncSession, person_id: uuid.UUID) -> list[WatchView]:
    """What the person hears about by watches: their own, then those of the Active groups they
    belong to (a Paused group delivers nothing, so lists nothing), each newest first. Only
    things they can open now are listed, so no thing's name leaves through a group; the rest
    stay stored and silent. Everything is always listed."""
    return await _views(db, await _visible(db, person_id, await _person_rows(db, person_id)))


def _hears(watch: NotificationWatch, kind: str) -> bool:
    """Whether the watch would hear an event of `kind`: it is on a kind of thing that event
    reaches (or is an Everything watch and the kind may be watched everywhere), and its events
    are empty (every one that applies) or name the kind. No kind reaches a wiki thing, so a
    wiki watch hears none of them: the wiki's own fan-out decides who hears of a page."""
    thing = thing_of(watch)
    on = thing.type if thing is not None else EVERYTHING
    return kind in kinds_for(on) and (not watch.kinds or kind in watch.kinds)


async def watches_hearing(db: AsyncSession, person_id: uuid.UUID, kind: str) -> list[WatchView]:
    """The person's watches that would hear an event of `kind`: their own, then those of the
    Active groups they belong to, each newest first. Check delivery asks this, so unlike
    `person_watches` it does not ask about access: a watch on something the person can't open
    is listed, though it delivers only the things they can open (the sweep decides, per
    thing). `kind` is a registered kind; a kind nobody can watch hears nothing."""
    rows = [(watch, group) for watch, group in await _person_rows(db, person_id)
            if _hears(watch, kind)]
    return await _views(db, rows)


async def group_watches(db: AsyncSession, group_id: uuid.UUID) -> list[WatchView]:
    """Every watch of the group, newest first, whoever is asking: what the asker may see of
    them is for the route to decide."""
    group = await db.get(NotificationGroup, group_id)
    if group is None:
        return []
    watches = (await db.scalars(_newest_first(
        select(NotificationWatch).where(NotificationWatch.group_id == group_id)))).all()
    return await _views(db, [(watch, group) for watch in watches])


async def own_watch_on(db: AsyncSession, person_id: uuid.UUID, thing: str,
                       thing_id: uuid.UUID) -> NotificationWatch | None:
    """The person's own watch on this thing, if any. A group's watch isn't theirs. 422
    `invalid_thing` for a kind of thing that can't be watched."""
    spec = THINGS.get(thing)
    if spec is None:
        raise WatchError(422, "invalid_thing")
    return await db.scalar(select(NotificationWatch).where(
        NotificationWatch.person_id == person_id,
        getattr(NotificationWatch, spec.column) == thing_id))


# ── whom an event reaches ───────────────────────────────────────────

def _on_any(things: Iterable[Thing]) -> list[ColumnElement[bool]]:
    """A condition per kind of thing among `things`: a watch on one of them. A kind of thing
    nobody can watch gives none."""
    ids: dict[str, list[uuid.UUID]] = defaultdict(list)
    for thing in things:
        spec = THINGS.get(thing.type)
        if spec is not None:
            ids[spec.column].append(thing.id)
    return [getattr(NotificationWatch, column).in_(thing_ids)
            for column, thing_ids in ids.items()]


async def _reached(db: AsyncSession, *where: ColumnElement[bool]) -> dict[uuid.UUID, set[str]]:
    """The people the watches matching `where` reach, and by which routes: "watch" for a watch
    of their own, "group:<id>" for each Active group they belong to whose watch matches (a
    Paused group's watch gives nothing). In a fixed order, for a cap: people with a watch of
    their own first, oldest watch first, then the members of the matching groups,
    longest-standing first."""
    found = (await db.execute(
        select(NotificationWatch.person_id, NotificationWatch.group_id)
        .where(*where)
        .order_by(NotificationWatch.created_at, NotificationWatch.id))).all()
    routes: dict[uuid.UUID, set[str]] = {}
    for person_id, _group_id in found:
        if person_id is not None:
            routes.setdefault(person_id, set()).add("watch")
    group_ids = list(dict.fromkeys(group_id for _person_id, group_id in found
                                   if group_id is not None))
    if group_ids:
        for group_id, person_id in await db.execute(
                select(NotificationGroupMember.group_id, NotificationGroupMember.person_id)
                .join(NotificationGroup, NotificationGroup.id == NotificationGroupMember.group_id)
                .where(NotificationGroup.id.in_(group_ids), NotificationGroup.enabled.is_(True))
                .order_by(NotificationGroupMember.added_at, NotificationGroupMember.person_id)):
            routes.setdefault(person_id, set()).add(f"group:{group_id}")
    return routes


async def matching_routes(db: AsyncSession, event: NotificationEvent) -> dict[uuid.UUID, set[str]]:
    """The people the event's watches reach, and by which routes: "watch" for a watch of
    their own, "group:<id>" for each Active group they belong to whose watch matches. A Paused
    group's watch gives nothing, and none do when the event says `watchers` is off.

    A watch matches when its kinds are empty (every event that applies) or hold the event's
    kind, and its thing is the event's subject or one of the things it reaches; an Everything
    watch also matches when the kind is `everywhere`. Whether the people are still active,
    can open the thing or are the actor is for the sweep to decide.

    The result is in a fixed order, for the sweep's cap: people with a watch of their own
    first, oldest watch first, then the members of the matching groups, longest-standing first."""
    if not event.watchers:
        return {}
    targets = _on_any([Thing(event.subject_type, event.subject_id),
                       *(Thing.from_json(raw) for raw in event.reaches)])
    info = KINDS.get(event.kind)
    if info is not None and info.everywhere:
        targets.append(and_(*(getattr(NotificationWatch, column).is_(None)
                              for column in _THING_COLUMNS)))
    if not targets:
        return {}
    return await _reached(db, or_(*targets),
                          or_(func.cardinality(NotificationWatch.kinds) == 0,
                              NotificationWatch.kinds.contains([event.kind])))


async def routes_watching(db: AsyncSession, things: Iterable[Thing]) -> dict[uuid.UUID, set[str]]:
    """The people who watch any of `things`, whatever events their watches name, and by which
    routes, in `matching_routes`' order: for a fan-out that decides for itself what its watches
    hear, the wiki's (wiki/notify.py), whose watches name none. Whether the people are still
    active, can see the things or are the actor is for that fan-out to decide."""
    targets = _on_any(things)
    if not targets:
        return {}
    return await _reached(db, or_(*targets))
