"""The event sweep, run by notification-worker every 60 s (`run_events_once`). Code that sees
something happen announces it (notifications/events.py): a notification_events row waits, with
`sent_at` null, until a sweep turns it into notifications. One sweep is one session and one
transaction:

1. **Claim** the waiting events that have failed least (`attempts`), oldest first, up to
   EVENT_BATCH, with FOR UPDATE SKIP LOCKED: production runs two workers on one database, and
   neither takes what the other holds.
2. **Each event's recipients,** in a savepoint of its own. An event whose subject is gone is
   dropped: marked sent, and nothing else. The candidates come in route order: the people the
   code named ("direct", or "rule:<id>" for a status rule's), the members of the Active groups
   it named ("group:<id>", and "rule:<id>" too when a status rule named the group), then the
   people its watches reach (watches.matching_routes). Only the first MAX_RECIPIENTS are
   considered, as the wiki does. Then: never the actor unless the code named them, active
   accounts only, and only people who can open the subject now (notifications/access.py). A
   status rule's notice is checked on what the rule matched instead, thing by thing: each
   person hears of the matched things they can open, and only those count. Someone dropped for
   access is logged `inbox_suppressed` `no_access`. An event that fails stays waiting for the
   next sweep, logged once, and the failure is counted against it, so an event that always
   fails drops behind newer ones instead of holding them up. Nothing gives up on it. Nothing
   ages it forward either: however long it has waited, it stays behind every event that has
   failed fewer times.
3. **One notification per person per kind,** and for status rule notices per rule. The items
   that reach one person become one notification for each, written with notify(), so the
   person's switches, schedule, summary and critical kinds apply as to any other. One item says
   what it says; several are counted under the kind's label, a line each, oldest first (by
   event id: the claim order only decides which events a sweep takes, so a retried event keeps
   its place), and link to the initiative they all belong to, else to the list they all share
   (a device's), else to the kind's list page. A rule's notices are counted under the rule's
   name instead, a line per initiative with its count and the matches with no initiative
   counted on their own, and link to the rule's executions; so is one notice the person can
   open only part of, since its text speaks for all of it. A rule's text is written for its
   person: it names an initiative or a site only when they can open it, and it links to the
   rule's executions only when they can open the Status rules page (a global-only one), else
   to nothing.
   The payload carries the event ids, the events' subjects and the routes (`via`) for the
   send-time re-check (a rule's matched ids stay on its events, so the payload stays small,
   and an initiative its person can't open is left out of the subjects, as of the text),
   and the inbox log row the routes, the event ids and the names of the groups and rules among
   the routes.
4. **Finish:** every handled event is marked sent, and it all commits at once. A write that
   fails rolls the whole sweep back for the next tick (the worker logs it once).

The notification's email gets a second look just before it goes out (`watch_recheck`, asked by
email.recheck_notification for a queued email and for a held one): can the person still open what
it is about (`no_access`), and does any of its events still reach them (`not_watching`)? It asks
`candidates`, the very function the sweep used, so the two cannot drift.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 4)"""

import logging
import uuid
from collections.abc import Iterable, Mapping, Sequence
from collections.abc import Set as AbstractSet
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from itertools import islice

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from serversherpa.access.resolver import AccessInfo, resolve_access_many
from serversherpa.db.models import (
    Initiative,
    Notification,
    NotificationEvent,
    NotificationGroup,
    NotificationGroupMember,
    Site,
    StatusRule,
)
from serversherpa.notifications.access import active_ids, thing_exists, viewers, visible_among
from serversherpa.notifications.delivery_log import record
from serversherpa.notifications.events import Thing
from serversherpa.notifications.inbox import notify
from serversherpa.notifications.kinds import kind_info
from serversherpa.notifications.watches import matching_routes
from serversherpa.status_rules.notify import rule_link
from serversherpa.wiki.notify import MAX_RECIPIENTS

logger = logging.getLogger("serversherpa.notifications.event_sweep")

EVENT_BATCH = 200

# Where several items of one kind link when they don't all belong to one initiative and don't
# share a list of their own. Device offline has none: its items carry their device's list, and
# items from different lists (readers and routers, say) get no link. Status rule matched has
# none either: a rule's notices link to the matched thing or to the rule's executions (plan
# call 5, the latter for people who can open Status rules). A deleted rule's counted notice,
# and a counted notice for someone who can't open Status rules, link nowhere.
LIST_PAGES: dict[str, str | None] = {"initiative_status_changed": "/initiatives",
                                     "truck_status_changed": "/logistics/trucks",
                                     "device_offline": None,
                                     "status_rule_matched": None}

# Events whose last try failed: each is logged once per process. Only the exception's class is
# logged: its text can carry SQL parameters.
_failing: set[int] = set()

# The people an event reaches, each with the routes that reach them.
Routes = dict[uuid.UUID, set[str]]


def _canonical(raw: str | None) -> str | None:
    """An id as the items hold it, spelled one way; raises for one that is no id."""
    return str(uuid.UUID(raw)) if raw is not None else None


@dataclass(frozen=True)
class Item:
    """One handled event, as its notification tells it. A status rule's notice (status_rules/
    notify.py) also names its rule, what the rule matched (the kind of thing and the ids) and
    the site the match was read at. As one person hears it, `matched_ids` are the ones they can
    open (`seen_by`), and `whole` says whether that is every one."""

    event_id: int
    kind: str
    subject: Thing
    title: str
    line: str
    link: str | None
    initiative_id: str | None
    list_link: str | None
    rule_id: uuid.UUID | None = None
    matched_type: str | None = None
    matched_ids: tuple[uuid.UUID, ...] = ()
    site_id: str | None = None
    whole: bool = True

    @classmethod
    def from_event(cls, event: NotificationEvent) -> "Item":
        """Raises for an item without a title, or a rule's notice whose ids are not ids, so
        that event fails on its own (a rule's initiative and site are looked up by id later,
        outside the event's own try)."""
        item = event.item
        matched_type = item.get("matched_type")
        rule = matched_type is not None
        initiative_id = item.get("initiative_id")
        return cls(event.id, event.kind, Thing(event.subject_type, event.subject_id),
                   item["title"], item.get("line") or "", item.get("link"),
                   _canonical(initiative_id) if rule else initiative_id, item.get("list_link"),
                   rule_id=event.rule_id if rule else None, matched_type=matched_type,
                   matched_ids=tuple(dict.fromkeys(uuid.UUID(raw)
                                                   for raw in item.get("matched_ids") or ())),
                   site_id=_canonical(item.get("site_id")) if rule else None)

    def seen_by(self, visible: AbstractSet[uuid.UUID]) -> "Item":
        """This rule's notice as told to someone who can open `visible`, the matched things
        among `matched_ids` that they can (as visible_among gives them): the item itself when
        that is all of them, else only those, in order, no longer whole."""
        if len(visible) == len(self.matched_ids):
            return self
        return replace(self, matched_ids=tuple(thing_id for thing_id in self.matched_ids
                                               if thing_id in visible), whole=False)


@dataclass(frozen=True)
class Shown:
    """What one person's status rule notices may name and link: the initiatives and sites among
    theirs that the person can open, each by name, by id as the items hold it (controller
    ruling: a notice never names a thing its person can't open), and whether they can open the
    Status rules page (`rules`), where a counted notice links to its rule's executions. The
    page is global-only, so a client's user, say, cannot."""

    initiatives: Mapping[str, str] = field(default_factory=dict)
    sites: Mapping[str, str] = field(default_factory=dict)
    rules: bool = False


# The people who hear an event, each with the item as they hear it and the routes that reach
# them.
Heard = dict[uuid.UUID, tuple[Item, set[str]]]


@dataclass
class Batch:
    """What reaches one person of one kind (of one rule, for a rule's notices) in a sweep: the
    items as they hear them, oldest first, and every route that brought them."""

    items: list[Item] = field(default_factory=list)
    routes: set[str] = field(default_factory=set)


# ── whom an event reaches ───────────────────────────────────────────

async def candidates(db: AsyncSession, event: NotificationEvent) -> Routes:
    """Everyone the event may reach, in route order: the people the code named ("direct", or
    "rule:<id>" when a status rule named them), the members of the Active groups it named
    ("group:<id>", and "rule:<id>" as well when a rule named the group: plan call 8), then the
    people its watches reach. Nobody is filtered out yet."""
    routes: Routes = {}
    named = f"rule:{event.rule_id}" if event.rule_id is not None else "direct"
    for person_id in event.person_ids:
        routes.setdefault(person_id, set()).add(named)
    if event.group_ids:
        by_rule = {named} if event.rule_id is not None else set()
        for group_id, person_id in await db.execute(
                select(NotificationGroupMember.group_id, NotificationGroupMember.person_id)
                .join(NotificationGroup, NotificationGroup.id == NotificationGroupMember.group_id)
                .where(NotificationGroup.id.in_(event.group_ids),
                       NotificationGroup.enabled.is_(True))
                .order_by(NotificationGroupMember.added_at, NotificationGroupMember.person_id)):
            routes.setdefault(person_id, set()).update({f"group:{group_id}", *by_rule})
    for person_id, found in (await matching_routes(db, event)).items():
        routes.setdefault(person_id, set()).update(found)
    return routes


async def _recipients(db: AsyncSession, event: NotificationEvent, item: Item) -> Heard:
    """The people who hear the event, each with the item as they hear it. Nobody when its
    subject is gone. Otherwise the first MAX_RECIPIENTS candidates (a warning names an event
    that has more), less the actor unless the code named them, anyone whose account is not in
    use, and anyone who can't open the subject now, or for a status rule's notice any of the
    things it matched: each of those last is logged `inbox_suppressed` `no_access`. Someone who
    can open some of a rule's matched things hears of those (Item.seen_by)."""
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
    heard: Heard = {}
    if item.matched_type is not None:
        # A rule's notice is about what the rule matched: access is checked per matched thing
        # (spec section 4), for everyone at once.
        visible = await visible_among(db, item.matched_type, item.matched_ids, people)
        for person_id in people:
            if person_id in visible:
                heard[person_id] = (item.seen_by(visible[person_id]), found[person_id])
    else:
        seen = await viewers(db, subject, people)
        for person_id in people:
            if person_id in seen:
                heard[person_id] = (item, found[person_id])
    info = kind_info(event.kind)
    for person_id in people:
        if person_id not in heard:
            record(db, "inbox_suppressed", channel="inbox", person_id=person_id,
                   kind=event.kind, category=info.category if info else None,
                   reason="no_access", detail={"events": [event.id]})
    return heard


# ── one notification per person per kind, or per rule ─────────────

def _group_items(reached: Iterable[tuple[Item, Heard]],
                 ) -> dict[tuple[uuid.UUID, str, uuid.UUID | None], Batch]:
    """The items each person hears of, by person and kind, and for a status rule's notices by
    rule as well (a deleted rule's go together), oldest first, with every route that brought
    them. Oldest is by event id, whatever order the events were claimed in: a retried event is
    claimed after newer ones (it has failed more), but its line still comes first."""
    batches: dict[tuple[uuid.UUID, str, uuid.UUID | None], Batch] = {}
    for item, people in sorted(reached, key=lambda pair: pair[0].event_id):
        for person_id, (told, routes) in people.items():
            batch = batches.setdefault((person_id, item.kind, item.rule_id), Batch())
            batch.items.append(told)
            batch.routes |= routes
    return batches


def _compose(kind: str, items: Sequence[Item], names: Mapping[str, str],
             shown: Shown) -> tuple[str, str, str | None]:
    """The title, body and link of one notification about these items, oldest first. One item
    says what it says. Several are counted under the kind's label, a line each, and link to the
    initiative they all belong to, else to the list they all share, else to the kind's list
    page (none for some kinds). A status rule's notices are told their own way (`_rule_text`),
    naming and linking only what `shown` lets this person open."""
    if items[0].matched_type is not None:
        return _rule_text(kind, items, names, shown)
    if len(items) == 1:
        return items[0].title, items[0].line, items[0].link
    info = kind_info(kind)
    title = f"{info.label if info is not None else kind} ({len(items)})"
    body = "\n".join(f"{item.title} · {item.line}" if item.line else item.title
                     for item in items)
    shared = {item.initiative_id for item in items}
    if len(shared) == 1 and None not in shared:
        return title, body, f"/initiatives/{shared.pop()}"
    lists = {item.list_link for item in items}
    if len(lists) == 1 and None not in lists:
        return title, body, lists.pop()
    return title, body, LIST_PAGES.get(kind)


def _rule_text(kind: str, items: Sequence[Item], names: Mapping[str, str],
               shown: Shown) -> tuple[str, str, str | None]:
    """One rule's notices to one person (plan call 7), naming an initiative or a site only when
    `shown` says the person can open it (controller ruling).

    One match they can open says "{rule}: {thing}" as the event holds it, with a line of the
    initiative and the scan's site, a hidden one left out with its joiner, and links to the
    thing (plan call 5), which they can open. Anything else is counted: "{rule} ({count})", a
    line per initiative, "{initiative} · {count}" or the count alone when the initiative is
    hidden, in the order they came, then the matches with no initiative counted on a line of
    their own, linked to the rule's executions when `shown` says the person can open Status
    rules (controller ruling), else to nothing. Only the matched things the person can open
    count. A rule deleted since it matched has no name left to give: its notices are counted
    under the kind's label, with the kind's list page (none)."""
    if len(items) == 1 and items[0].whole and len(items[0].matched_ids) == 1:
        item = items[0]
        where = (shown.initiatives.get(item.initiative_id) if item.initiative_id else None,
                 shown.sites.get(item.site_id) if item.site_id else None)
        return item.title, " · ".join(part for part in where if part), item.link
    per_initiative: dict[str, int] = {}
    loose = 0
    for item in items:
        if item.initiative_id is None:
            loose += len(item.matched_ids)
        else:
            per_initiative[item.initiative_id] = (per_initiative.get(item.initiative_id, 0)
                                                  + len(item.matched_ids))
    lines = [f"{shown.initiatives[initiative_id]} · {count}"
             if initiative_id in shown.initiatives else str(count)
             for initiative_id, count in per_initiative.items()]
    if loose:
        lines.append(str(loose))
    total = sum(per_initiative.values()) + loose
    rule_id = items[0].rule_id
    rule = names.get(f"rule:{rule_id}") if rule_id is not None else None
    if rule is None:
        info = kind_info(kind)
        return (f"{info.label if info is not None else kind} ({total})", "\n".join(lines),
                LIST_PAGES.get(kind))
    return f"{rule} ({total})", "\n".join(lines), rule_link(rule_id) if shown.rules else None


async def _names(db: AsyncSession, routes: Iterable[str],
                 rule_ids: Iterable[uuid.UUID]) -> dict[str, str]:
    """The name of each group and status rule among `routes` ("group:<id>", "rule:<id>"), and
    of each rule in `rule_ids` (whose notices are counted under its name), by route."""
    groups: set[uuid.UUID] = set()
    rules = set(rule_ids)
    for route in routes:
        prefix, _, raw = route.partition(":")
        if prefix == "group":
            groups.add(uuid.UUID(raw))
        elif prefix == "rule":
            rules.add(uuid.UUID(raw))
    names: dict[str, str] = {}
    if groups:
        names |= {f"group:{group_id}": name for group_id, name in await db.execute(
            select(NotificationGroup.id, NotificationGroup.name)
            .where(NotificationGroup.id.in_(groups)))}
    if rules:
        names |= {f"rule:{rule_id}": name for rule_id, name in await db.execute(
            select(StatusRule.id, StatusRule.name).where(StatusRule.id.in_(rules)))}
    return names


async def _shown(db: AsyncSession, batches: Mapping[tuple[uuid.UUID, str, uuid.UUID | None],
                                                    Batch]) -> dict[uuid.UUID, Shown]:
    """For each person with status rule notices in the sweep, the initiatives and scan sites
    their notices name that they can open now, by name: a notice never names a thing its person
    can't open (controller ruling). Also whether they can open the Status rules page, from the
    same access, for the link of a counted notice. Asked for everyone at once: a query per kind
    of thing, the names, one batch of access, and a probe more only for a person with row scope
    (a client's user, for initiatives; sites have none)."""
    wanted: dict[uuid.UUID, list[Item]] = {}
    for (person_id, _kind, _rule_id), batch in batches.items():
        for item in batch.items:
            if item.matched_type is not None:
                wanted.setdefault(person_id, []).append(item)
    if not wanted:
        return {}
    access = await resolve_access_many(db, list(wanted))
    initiatives = await _names_they_can_open(
        db, "initiative", Initiative,
        {person_id: {item.initiative_id for item in items} for person_id, items in wanted.items()},
        access)
    sites = await _names_they_can_open(
        db, "site", Site,
        {person_id: {item.site_id for item in items} for person_id, items in wanted.items()},
        access)
    return {person_id: Shown(initiatives.get(person_id, {}), sites.get(person_id, {}),
                             rules=access[person_id].can("status_rules", "view"))
            for person_id in wanted}


async def _names_they_can_open(db: AsyncSession, thing_type: str, model: type[Initiative | Site],
                               asked: Mapping[uuid.UUID, AbstractSet[str | None]],
                               access: Mapping[uuid.UUID, AccessInfo],
                               ) -> dict[uuid.UUID, dict[str, str]]:
    """For each person, the names of the things of one kind `asked` lists for them (ids as the
    items hold them, None for none) that they can open, by id."""
    ids = {raw for raws in asked.values() for raw in raws if raw is not None}
    if not ids:
        return {}
    keys = [uuid.UUID(raw) for raw in ids]
    names = {str(row_id): name for row_id, name in await db.execute(
        select(model.id, model.name).where(model.id.in_(keys)))}
    seen = await visible_among(db, thing_type, keys, list(asked), access=access)
    return {person_id: {raw: names[raw] for raw in asked[person_id]
                        if raw in names and uuid.UUID(raw) in theirs}
            for person_id, theirs in seen.items()}


async def _write(db: AsyncSession, person_id: uuid.UUID, kind: str, batch: Batch,
                 names: Mapping[str, str], shown: Shown) -> bool:
    """One person's notification of one kind (or one rule); True when it was written (their
    Inbox switch for the category may turn it down). The payload's subjects are the events'
    (for a rule's notice its initiative, or the thing when there is none): the matched ids stay
    on the events, where the send-time re-check reads them, so the payload stays small. A rule's
    notice keeps an initiative among them only if its person can open it, as it names it in the
    text only then; its other subjects are matched things, which they can open by construction
    (they hear only of those)."""
    title, body, link = _compose(kind, batch.items, names, shown)
    via = sorted(batch.routes)
    events = [item.event_id for item in batch.items]
    rule_notice = batch.items[0].matched_type is not None
    subjects = [thing.to_json() for thing in dict.fromkeys(item.subject for item in batch.items)
                if not rule_notice or thing.type != "initiative"
                or str(thing.id) in shown.initiatives]
    row = await notify(db, person_id, kind, title, body=body, link=link,
                       payload={"events": events, "subjects": subjects, "via": via},
                       log_detail={"via": via, "events": events,
                                   "names": {route: names[route] for route in via
                                             if route in names}})
    return row is not None


async def run_events_once(maker: async_sessionmaker, *, now: datetime | None = None) -> int:
    """One sweep: the waiting events that have failed least, oldest first, up to EVENT_BATCH,
    become notifications. Returns how many were written. An event that fails is logged (once
    per event), counts the failure and waits for the next sweep while the rest go on; a
    notification that can't be written raises, and nothing of the sweep is kept (the failure
    counts included). Handled events are stamped with `now` (aware), by default the current
    time."""
    now = datetime.now(UTC) if now is None else now
    if now.tzinfo is None or now.utcoffset() is None:
        raise ValueError("now must be timezone-aware")
    async with maker() as db:
        events = list(await db.scalars(
            select(NotificationEvent).where(NotificationEvent.sent_at.is_(None))
            .order_by(NotificationEvent.attempts, NotificationEvent.id).limit(EVENT_BATCH)
            .with_for_update(skip_locked=True)))
        if not events:      # nothing waiting, or another sweep holds it all
            return 0
        handled: list[NotificationEvent] = []
        reached: list[tuple[Item, Heard]] = []
        for event in events:
            event_id = event.id
            try:
                item = Item.from_event(event)
                async with db.begin_nested():
                    people = await _recipients(db, event, item)
            except Exception as exc:  # noqa: BLE001 — one event's failure must not stop the rest
                if event_id not in _failing:
                    logger.warning("could not send notification event %s — retrying (%s)",
                                   event_id, type(exc).__name__)
                _failing.add(event_id)
                # Counted in SQL, in the sweep's own transaction (any savepoint is rolled back
                # by now), so the event object is never read after a rollback.
                await db.execute(update(NotificationEvent)
                                 .where(NotificationEvent.id == event_id)
                                 .values(attempts=NotificationEvent.attempts + 1)
                                 .execution_options(synchronize_session=False))
                continue
            handled.append(event)
            reached.append((item, people))

        batches = _group_items(reached)
        names = await _names(db, {route for batch in batches.values() for route in batch.routes},
                             {rule_id for _person_id, _kind, rule_id in batches
                              if rule_id is not None})
        shown = await _shown(db, batches)
        written = 0
        for (person_id, kind, _rule_id), batch in batches.items():
            if await _write(db, person_id, kind, batch, names, shown.get(person_id, Shown())):
                written += 1
        handled_ids = [event.id for event in handled]
        for event in handled:
            event.sent_at = now
        await db.commit()
    _failing.difference_update(handled_ids)
    return written


# ── the send-time re-check ──────────────────────────────────────────

def _judged(notification: Notification,
            events: Sequence[NotificationEvent]) -> dict[str, list[uuid.UUID]]:
    """What the person must still be able to open one of, by kind of thing: a status rule's
    notice is judged by the things its events matched, read from the events (its payload lists
    only their subjects, so it stays small); any other notification by its payload's
    subjects."""
    things: dict[str, list[uuid.UUID]] = {}
    rule_items = [Item.from_event(event) for event in events
                  if event.item.get("matched_type") is not None]
    if rule_items:
        for item in rule_items:
            things.setdefault(item.matched_type, []).extend(item.matched_ids)
        return things
    for raw in notification.payload.get("subjects") or ():
        thing = Thing.from_json(raw)
        things.setdefault(thing.type, []).append(thing.id)
    return things


async def _opens_any(db: AsyncSession, person_id: uuid.UUID,
                     things: Mapping[str, Sequence[uuid.UUID]]) -> bool:
    """Whether the person can open at least one of these things now. One visible_among per
    kind of thing, however many there are: a rule's batch can match thousands."""
    access = await resolve_access_many(db, [person_id])
    for thing_type, ids in things.items():
        if person_id in await visible_among(db, thing_type, ids, [person_id], access=access):
            return True
    return False


async def watch_recheck(db: AsyncSession, notification: Notification) -> str | None:
    """Why the email of a notification this sweep wrote should no longer go out, as a reason
    code, or None when it still should. This is the part of the send-time re-check
    (email.recheck_notification) that only these notifications have; it runs once the person
    is known to be active, and before their Email switch:

    - `no_access`: the person can open none of the notification's subjects now (a thing that is
      gone has no viewers). A status rule's notice is judged by its events' matched things
      instead, read from the stored events (`_judged`).
    - `not_watching`: none of its events reaches the person any more. A route still holds when
      the code named them, they belong to an Active group the code named, or a watch matches
      (their own, or an Active group's they belong to): `candidates`, asked again now. So
      deleting a watch, pausing a group and leaving one each end a route.

    None, with nothing asked, for a notification that names no events (every other kind), and
    when none of the events it names is stored any more (the Logging retention removes old
    ones): there is nothing to check the person against. `payload.subjects` is de-duplicated,
    so it does not line up with `payload.events`; the two are never paired by position. Reads
    only."""
    event_ids = notification.payload.get("events")
    if not event_ids:
        return None
    events = list(await db.scalars(
        select(NotificationEvent).where(NotificationEvent.id.in_(event_ids))
        .order_by(NotificationEvent.id)))
    if not events:
        return None
    person_id = notification.person_id
    things = _judged(notification, events)
    if things and not await _opens_any(db, person_id, things):
        return "no_access"
    for event in events:
        if person_id in await candidates(db, event):
            return None
    return "not_watching"
