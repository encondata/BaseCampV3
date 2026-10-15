"""MacroPoint manual update — group parsed emails by load, match each load
to an active truck, build the preview, and apply it (Task 4 adds the apply
half). Parsing is in parse.py; this module owns the database side.

Active trucks are the only match candidates and the only picker options:
not archived and not inactive/historical. A load matches (1) the one
active truck whose tracking_type.macropoint_order is the load's order
token, else (2) the one whose tracking_type.tracker_id equals the ID Number
(whitespace/case-insensitive). Several candidates at a step = ambiguous.
"""

import uuid
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, StatusValue, Truck, TruckEvent, TruckUpdate
from serversherpa.db.ordering import natural, natural_key
from serversherpa.trucks.location import format_location
from serversherpa.trucks.macropoint.parse import (
    ParsedMessage,
    ParseError,
    normalize_id,
    parse_inputs,
)

ACTIVE_EXCLUDED = ("inactive", "historical")
DEPART_FROM = frozenset({"created", "active"})
ARRIVE_FROM = frozenset({"created", "active", "in_transit"})

MAX_FILES = 500
MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_TOTAL_BYTES = 20 * 1024 * 1024
MAX_TEXT_BYTES = 1024 * 1024


@dataclass
class Group:
    key: str
    id_number: str
    order_token: str | None
    carrier: str
    messages: list[ParsedMessage] = field(default_factory=list)


@dataclass
class Match:
    truck_id: uuid.UUID | None
    by: str | None
    ambiguous_ids: list[uuid.UUID]


def group_messages(messages: list[ParsedMessage]) -> list[Group]:
    by_token: dict[str, Group] = {}
    loose: list[ParsedMessage] = []
    for m in messages:
        if m.order_token:
            g = by_token.get(m.order_token)
            if g is None:
                g = by_token[m.order_token] = Group(
                    f"order:{m.order_token}", m.id_number, m.order_token, m.carrier)
            g.messages.append(m)
        else:
            loose.append(m)
    owners: dict[str, list[Group]] = {}
    for g in by_token.values():
        owners.setdefault(normalize_id(g.id_number), []).append(g)
    by_id: dict[str, Group] = {}
    for m in loose:
        nid = normalize_id(m.id_number)
        found = owners.get(nid, [])
        if len(found) == 1:
            found[0].messages.append(m)
            continue
        g = by_id.get(nid)
        if g is None:
            g = by_id[nid] = Group(f"id:{nid}", m.id_number, None, m.carrier)
        g.messages.append(m)
    groups = [*by_token.values(), *by_id.values()]
    for g in groups:
        g.messages.sort(key=lambda m: (m.recorded_at, m.kind, m.source))
    groups.sort(key=lambda g: (natural_key(g.id_number), g.key))
    return groups


def tracking_value(truck: Truck, key: str) -> str:
    value = (truck.tracking_type or {}).get(key)
    return value.strip() if isinstance(value, str) else ""


def match_group(group: Group, trucks: list[Truck]) -> Match:
    if group.order_token:
        hits = [t for t in trucks if tracking_value(t, "macropoint_order") == group.order_token]
        if len(hits) == 1:
            return Match(hits[0].id, "order", [])
        if hits:
            return Match(None, None, [t.id for t in hits])
    nid = normalize_id(group.id_number)
    hits = [t for t in trucks
            if tracking_value(t, "tracker_id")
            and normalize_id(tracking_value(t, "tracker_id")) == nid]
    if len(hits) == 1:
        return Match(hits[0].id, "tracker_id", [])
    return Match(None, None, [t.id for t in hits])


def status_target(status: str, message: ParsedMessage) -> str | None:
    """The status a trip event moves the truck to, or None. Forward only."""
    if message.kind != "trip_event":
        return None
    if message.event_kind == "departed" and message.stop == "pickup" and status in DEPART_FROM:
        return "in_transit"
    if message.event_kind == "arrived" and message.stop == "drop_off" and status in ARRIVE_FROM:
        return "at_destination"
    return None


async def active_trucks(db: AsyncSession) -> list[Truck]:
    return list(await db.scalars(
        select(Truck).where(Truck.archived_at.is_(None),
                            Truck.status.not_in(ACTIVE_EXCLUDED))
        .order_by(natural(Truck.name))))


async def _status_labels(db: AsyncSession) -> dict[str, str]:
    rows = await db.execute(select(StatusValue.key, StatusValue.label)
                            .where(StatusValue.record_type == "truck"))
    return dict(rows.all())


async def existing_refs(db: AsyncSession, truck_id: uuid.UUID, refs: list[str]) -> set[str]:
    if not refs:
        return set()
    updates = await db.scalars(select(TruckUpdate.source_ref).where(
        TruckUpdate.truck_id == truck_id, TruckUpdate.source_ref.in_(refs)))
    events = await db.scalars(select(TruckEvent.source_ref).where(
        TruckEvent.truck_id == truck_id, TruckEvent.source_ref.in_(refs)))
    return set(updates) | set(events)


def row_location(m: ParsedMessage) -> str | None:
    if m.kind != "location" or m.lat is None or m.lng is None:
        return None
    return format_location(m.lat, m.lng)


async def _truck_options(db: AsyncSession, trucks: list[Truck],
                         labels: dict[str, str]) -> list[dict]:
    ini_ids = {t.initiative_id for t in trucks if t.initiative_id}
    names: dict = {}
    if ini_ids:
        names = dict((await db.execute(select(Initiative.id, Initiative.name)
                                       .where(Initiative.id.in_(ini_ids)))).all())
    return [{"id": t.id, "name": t.name, "status": t.status,
             "status_label": labels.get(t.status, t.status),
             "tracker_id": tracking_value(t, "tracker_id") or None,
             "initiative_name": names.get(t.initiative_id)} for t in trucks]


async def build_preview(db: AsyncSession, files: list[tuple[str, bytes]], text: str) -> dict:
    parsed = parse_inputs(files, text)
    messages = [p for p in parsed if isinstance(p, ParsedMessage)]
    errors = [p for p in parsed if isinstance(p, ParseError)]
    trucks = await active_trucks(db)
    by_id = {t.id: t for t in trucks}
    labels = await _status_labels(db)
    groups = []
    for g in group_messages(messages):
        match = match_group(g, trucks)
        truck = by_id.get(match.truck_id) if match.truck_id else None
        seen = (await existing_refs(db, truck.id, [m.source_ref for m in g.messages])
                if truck else set())
        status = truck.status if truck else None
        rows = []
        for m in g.messages:
            duplicate = m.source_ref in seen
            seen.add(m.source_ref)
            to = status_target(status, m) if truck and not duplicate else None
            if to:
                status = to
            rows.append({"source": m.source, "kind": m.kind, "recorded_at": m.recorded_at,
                         "location": row_location(m), "address": m.address,
                         "event": m.event, "status_to": to,
                         "status_to_label": labels.get(to, to) if to else None,
                         "duplicate": duplicate})
        dupes = sum(1 for r in rows if r["duplicate"])
        groups.append({"group_key": g.key, "id_number": g.id_number,
                       "order_token": g.order_token, "carrier": g.carrier,
                       "match": {"truck_id": match.truck_id, "by": match.by,
                                 "ambiguous_ids": match.ambiguous_ids},
                       "rows": rows, "new": len(rows) - dupes, "duplicates": dupes})
    return {"groups": groups,
            "errors": [{"source": e.source, "reason": e.reason} for e in errors],
            "trucks": await _truck_options(db, trucks, labels)}
