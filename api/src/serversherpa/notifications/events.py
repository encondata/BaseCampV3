"""Announcing an event. Code that sees something happen (a status change, or a device
that stops checking in) calls `announce()`, which adds one `notification_events` row
to the CALLER's session and never commits, so an event can't outlive a rolled-back
change. The notification worker's sweep later turns the rows still waiting (`sent_at`
null) into notifications for the people who watch the thing, or the things around it.

An event names its subject (what it is about) and the other things it reaches: the
watchers of any of them hear it. `Thing` is one of those, `EventItem` is what the
notification will say.

Spec: docs/superpowers/specs/2026-11-02-notifications-phase2-design.md (section 4)"""

import uuid
from collections.abc import Iterable, Mapping
from dataclasses import dataclass
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import NotificationEvent
from serversherpa.notifications.kinds import KINDS


@dataclass(frozen=True)
class Thing:
    """Something an event is about or reaches, and a watch can point at: a kind of
    thing ("initiative", "site", "truck", "device") and its id."""

    type: str
    id: uuid.UUID

    def to_json(self) -> dict:
        return {"type": self.type, "id": str(self.id)}

    @classmethod
    def from_json(cls, raw: Mapping) -> "Thing":
        return cls(raw["type"], uuid.UUID(raw["id"]))


@dataclass(frozen=True)
class EventItem:
    """What the notification says. `initiative_id` is the initiative the item belongs
    to (items of one initiative link to it together). `at` is when it happened, for an
    item that is announced later than it happened (a MacroPoint message). `list_link` is
    the portal list the item's thing is on (a device's kiosks, readers or routers list):
    items that share no initiative but share a list link to it together.

    A status rule's notice (status_rules/notify.py) also says what the rule matched: the
    kind of thing (`matched_type`: "asset", "container" or "person") and their ids, one
    or many, and the site the match was read at (`site_id`, the scan's), so the sweep can
    name the initiative and the site only to the people who can open them."""

    title: str
    line: str = ""
    link: str | None = None
    initiative_id: uuid.UUID | None = None
    at: datetime | None = None
    list_link: str | None = None
    matched_type: str | None = None
    matched_ids: tuple[uuid.UUID, ...] = ()
    site_id: uuid.UUID | None = None

    def to_json(self) -> dict:
        """The stored form: every key, ids and times as strings. A rule's notice adds
        `count`, `matched_type`, `matched_ids` and `site_id`; no other item has them."""
        stored = {"title": self.title, "line": self.line, "link": self.link,
                  "initiative_id": (str(self.initiative_id)
                                    if self.initiative_id is not None else None),
                  "at": self.at.isoformat() if self.at is not None else None,
                  "list_link": self.list_link}
        if self.matched_type is not None:
            stored |= {"count": len(self.matched_ids), "matched_type": self.matched_type,
                       "matched_ids": [str(thing_id) for thing_id in self.matched_ids],
                       "site_id": str(self.site_id) if self.site_id is not None else None}
        return stored


def announce(db: AsyncSession, kind: str, *, subject: Thing, item: EventItem,
             reaches: Iterable[Thing] = (), actor_id: uuid.UUID | None = None,
             person_ids: Iterable[uuid.UUID] = (), group_ids: Iterable[uuid.UUID] = (),
             watchers: bool = True, rule_id: uuid.UUID | None = None) -> NotificationEvent:
    """Add an event of this registered kind to the caller's session. Does not flush or
    commit; the caller commits. `reaches` are the other things whose watchers hear it
    (de-duplicated in order, the subject left out). `actor_id` is the person whose
    action caused it: they are never told. `person_ids` and `group_ids` are people and
    groups the announcing code names, and `watchers` says whether watches apply.
    Raises ValueError for a kind that is not registered."""
    if kind not in KINDS:
        raise ValueError(f"unregistered notification kind: {kind!r}")
    others = [thing for thing in dict.fromkeys(reaches) if thing != subject]
    event = NotificationEvent(
        kind=kind, subject_type=subject.type, subject_id=subject.id,
        reaches=[thing.to_json() for thing in others], actor_id=actor_id,
        person_ids=list(person_ids), group_ids=list(group_ids),
        watchers=watchers, rule_id=rule_id, item=item.to_json())
    db.add(event)
    return event
