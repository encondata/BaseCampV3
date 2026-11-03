"""The event sweep, run by notification-worker every 60 s (`run_events_once`). Code that sees
something happen announces it (notifications/events.py): a notification_events row waits, with
`sent_at` null, until a sweep turns it into notifications. One sweep is one session and one
transaction:

1. **Claim** the oldest waiting events, up to EVENT_BATCH, with FOR UPDATE SKIP LOCKED:
   production runs two workers on one database, and neither takes what the other holds.
2. **Each event's recipients,** in a savepoint of its own. An event whose subject is gone is
   dropped: marked sent, and nothing else. The candidates come in route order: the people the
   code named ("direct", or "rule:<id>" for a status rule's), the members of the Active groups
   it named ("group:<id>"), then the people its watches reach (watches.matching_routes). Only
   the first MAX_RECIPIENTS are considered, as the wiki does. Then: never the actor unless the
   code named them, active accounts only, and only people who can open the subject now
   (notifications/access.py); someone dropped for access is logged `inbox_suppressed`
   `no_access`. An event that fails stays waiting for the next sweep, logged once.
3. **One notification per person per kind.** The items that reach one person become one
   notification for each kind, written with notify(), so the person's switches, schedule,
   summary and critical kinds apply as to any other. One item says what it says; several are
   counted under the kind's label, a line each, oldest first. The payload carries the event
   ids, the subjects and the routes (`via`) for the send-time re-check, and the inbox log row
   the routes, the event ids and the groups' names.
4. **Finish:** every handled event is marked sent, and it all commits at once. A write that
   fails rolls the whole sweep back for the next tick (the worker logs it once).

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 4)"""

import logging
import uuid
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import UTC, datetime
from itertools import islice

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from serversherpa.db.models import NotificationEvent, NotificationGroup, NotificationGroupMember
from serversherpa.notifications.access import active_ids, thing_exists, viewers
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.events import Thing
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.kinds import kind_info
from serversherpa.notifications.watches import matching_routes
from serversherpa.wiki.notify import MAX_RECIPIENTS

logger = logging.getLogger("serversherpa.notifications.event_sweep")

EVENT_BATCH = 200

# Where several items of one kind link when they don't all belong to one initiative.
LIST_PAGES: dict[str, str] = {"initiative_status_changed": "/initiatives",
                              "truck_status_changed": "/logistics/trucks"}

# Events whose last try failed: each is logged once per process. Only the exception's class is
# logged: its text can carry SQL parameters.
_failing: set[int] = set()

# The people an event reaches, each with the routes that reach them.
Routes = dict[uuid.UUID, set[str]]


@dataclass(frozen=True)
class Item:
    """One handled event, as its notification tells it."""

    event_id: int
    kind: str
    subject: Thing
    title: str
    line: str
    link: str | None
    initiative_id: str | None

    @classmethod
    def from_event(cls, event: NotificationEvent) -> "Item":
        """Raises for an item without a title, so that event fails on its own."""
        item = event.item
        return cls(event.id, event.kind, Thing(event.subject_type, event.subject_id),
                   item["title"], item.get("line") or "", item.get("link"),
                   item.get("initiative_id"))


@dataclass
class Batch:
    """What reaches one person of one kind in a sweep: the items, oldest first, and every route
    that brought them."""

    items: list[Item] = field(default_factory=list)
    routes: set[str] = field(default_factory=set)


# ── whom an event reaches ───────────────────────────────────────────

async def candidates(db: AsyncSession, event: NotificationEvent) -> Routes:
    """Everyone the event may reach, in route order: the people the code named ("direct", or
    "rule:<id>" when a status rule named them), the members of the Active groups it named
    ("group:<id>"), then the people its watches reach. Nobody is filtered out yet."""
    routes: Routes = {}
    named = f"rule:{event.rule_id}" if event.rule_id is not None else "direct"
    for person_id in event.person_ids:
        routes.setdefault(person_id, set()).add(named)
    if event.group_ids:
        for group_id, person_id in await db.execute(
                select(NotificationGroupMember.group_id, NotificationGroupMember.person_id)
                .join(NotificationGroup, NotificationGroup.id == NotificationGroupMember.group_id)
                .where(NotificationGroup.id.in_(event.group_ids),
                       NotificationGroup.enabled.is_(True))
                .order_by(NotificationGroupMember.added_at, NotificationGroupMember.person_id)):
            routes.setdefault(person_id, set()).add(f"group:{group_id}")
    for person_id, found in (await matching_routes(db, event)).items():
        routes.setdefault(person_id, set()).update(found)
    return routes


async def _recipients(db: AsyncSession, event: NotificationEvent) -> Routes:
    """The people who hear the event. Nobody when its subject is gone. Otherwise the first
    MAX_RECIPIENTS candidates (a warning names an event that has more), less the actor unless
    the code named them, anyone whose account is not in use, and anyone who can't open the
    subject now: each of those last is logged `inbox_suppressed` `no_access`."""
    subject = Thing(event.subject_type, event.subject_id)
    if not await thing_exists(db, subject):
        return {}
    found = await candidates(db, event)
    if len(found) > MAX_RECIPIENTS:
        logger.warning("notification event %s capped at %d of %d candidates",
                       event.id, MAX_RECIPIENTS, len(found))
        found = dict(islice(found.items(), MAX_RECIPIENTS))
    people = [person_id for person_id in found
              if person_id != event.actor_id or person_id in event.person_ids]
    active = await active_ids(db, people)
    people = [person_id for person_id in people if person_id in active]
    seen = await viewers(db, subject, people)
    info = kind_info(event.kind)
    for person_id in people:
        if person_id not in seen:
            record(db, "inbox_suppressed", channel="inbox", person_id=person_id,
                   kind=event.kind, category=info.category if info else None,
                   reason="no_access", detail={"events": [event.id]})
    return {person_id: found[person_id] for person_id in people if person_id in seen}


# ── one notification per person per kind ───────────────────────────

def _group_items(reached: Iterable[tuple[Item, Routes]]) -> dict[tuple[uuid.UUID, str], Batch]:
    """The items each person hears of, by person and kind, in the order given (oldest first),
    with every route that brought them."""
    batches: dict[tuple[uuid.UUID, str], Batch] = {}
    for item, people in reached:
        for person_id, routes in people.items():
            batch = batches.setdefault((person_id, item.kind), Batch())
            batch.items.append(item)
            batch.routes |= routes
    return batches


def _compose(kind: str, items: Sequence[Item]) -> tuple[str, str, str | None]:
    """The title, body and link of one notification about these items, oldest first. One item
    says what it says. Several are counted under the kind's label, a line each, and link to
    the initiative they all belong to, else to the kind's list page."""
    if len(items) == 1:
        return items[0].title, items[0].line, items[0].link
    info = kind_info(kind)
    title = f"{info.label if info is not None else kind} ({len(items)})"
    body = "\n".join(f"{item.title} · {item.line}" if item.line else item.title
                     for item in items)
    shared = {item.initiative_id for item in items}
    if len(shared) == 1 and None not in shared:
        return title, body, f"/initiatives/{shared.pop()}"
    return title, body, LIST_PAGES.get(kind)


async def _group_names(db: AsyncSession, routes: Iterable[str]) -> dict[str, str]:
    """The name of each group among `routes`, by its route ("group:<id>")."""
    ids = {uuid.UUID(route.removeprefix("group:")) for route in routes
           if route.startswith("group:")}
    if not ids:
        return {}
    return {f"group:{group_id}": name for group_id, name in await db.execute(
        select(NotificationGroup.id, NotificationGroup.name).where(NotificationGroup.id.in_(ids)))}


async def _write(db: AsyncSession, person_id: uuid.UUID, kind: str, batch: Batch,
                 names: Mapping[str, str]) -> bool:
    """One person's notification of one kind; True when it was written (their Inbox switch for
    the category may turn it down)."""
    title, body, link = _compose(kind, batch.items)
    via = sorted(batch.routes)
    events = [item.event_id for item in batch.items]
    subjects = [thing.to_json() for thing in dict.fromkeys(item.subject for item in batch.items)]
    row = await notify(db, person_id, kind, title, body=body, link=link,
                       payload={"events": events, "subjects": subjects, "via": via},
                       log_detail={"via": via, "events": events,
                                   "names": {route: names[route] for route in via
                                             if route in names}})
    return row is not None


async def run_events_once(maker: async_sessionmaker, *, now: datetime | None = None) -> int:
    """One sweep: the oldest waiting events, up to EVENT_BATCH, become notifications. Returns
    how many were written. An event that fails is logged (once per event) and waits for the
    next sweep while the rest go on; a notification that can't be written raises, and nothing
    of the sweep is kept. Handled events are stamped with `now` (aware), by default the
    current time."""
    now = datetime.now(UTC) if now is None else now
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    async with maker() as db:
        events = list(await db.scalars(
            select(NotificationEvent).where(NotificationEvent.sent_at.is_(None))
            .order_by(NotificationEvent.id).limit(EVENT_BATCH)
            .with_for_update(skip_locked=True)))
        if not events:      # nothing waiting, or another sweep holds it all
            return 0
        handled: list[NotificationEvent] = []
        reached: list[tuple[Item, Routes]] = []
        for event in events:
            event_id = event.id
            try:
                item = Item.from_event(event)
                async with db.begin_nested():
                    people = await _recipients(db, event)
            except Exception as exc:  # noqa: BLE001 — one event's failure must not stop the rest
                if event_id not in _failing:
                    logger.warning("could not send notification event %s — retrying (%s)",
                                   event_id, type(exc).__name__)
                _failing.add(event_id)
                continue
            handled.append(event)
            reached.append((item, people))

        batches = _group_items(reached)
        names = await _group_names(db, {route for batch in batches.values()
                                        for route in batch.routes})
        written = 0
        for (person_id, kind), batch in batches.items():
            if await _write(db, person_id, kind, batch, names):
                written += 1
        handled_ids = [event.id for event in handled]
        for event in handled:
            event.sent_at = now
        await db.commit()
    _failing.difference_update(handled_ids)
    return written
