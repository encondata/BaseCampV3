"""MacroPoint manual update — group parsed emails by load, match each load
to an active truck, build the preview, and apply it (Task 4 adds the apply
half). Parsing is in parse.py; this module owns the database side.

Active trucks are the only match candidates and the only picker options:
not archived and not inactive/historical. A load matches (1) the one
active truck whose tracking_type.macropoint_order is the load's order
token, else (2) the one whose tracking_type.tracker_id equals the ID Number
(whitespace/case-insensitive). Several candidates at a step = ambiguous.
"""

import asyncio
import uuid
from dataclasses import dataclass, field
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, StatusValue, Truck, TruckEvent, TruckUpdate
from serversherpa.db.ordering import natural, natural_key
from serversherpa.services.audit import audit
from serversherpa.trucks.location import format_location
from serversherpa.trucks.macropoint.parse import (
    ParsedMessage,
    ParseError,
    normalize_id,
    parse_inputs,
)
from serversherpa.trucks.trip import apply_status_change

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
    # Parsing is CPU-bound (up to 500 files): keep it off the event loop.
    parsed = await asyncio.to_thread(parse_inputs, files, text)
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


def _detail(m: ParsedMessage) -> str:
    if m.kind == "location":
        loc = row_location(m)
        return f"{loc} · {m.address}" if m.address else loc
    return m.event or ""


async def _insert(db: AsyncSession, truck: Truck, m: ParsedMessage,
                  actor_id: uuid.UUID) -> bool:
    """Insert one update/event; False when the truck already has it."""
    if m.kind == "location":
        stmt = pg_insert(TruckUpdate).values(
            truck_id=truck.id, recorded_at=m.recorded_at, location=row_location(m),
            lat=m.lat, lng=m.lng, approximate_address=m.address,
            source="macropoint", source_ref=m.source_ref,
        ).on_conflict_do_nothing(constraint="uq_truck_updates_truck_source_ref"
                                 ).returning(TruckUpdate.id)
    else:
        stmt = pg_insert(TruckEvent).values(
            truck_id=truck.id, recorded_at=m.recorded_at, event=m.event,
            event_kind=m.event_kind, stop=m.stop, source="macropoint",
            source_ref=m.source_ref, created_by=actor_id,
        ).on_conflict_do_nothing(constraint="uq_truck_events_truck_source_ref"
                                 ).returning(TruckEvent.id)
    return (await db.execute(stmt)).scalar_one_or_none() is not None


def _learn_link(db: AsyncSession, actor_id: uuid.UUID, truck: Truck,
                group: Group) -> str | None:
    """Fill the truck's blank tracking keys from the load; never overwrite.
    Returns "linked_to_other_order" when the truck holds another token."""
    current = dict(truck.tracking_type or {})
    new = dict(current)
    note = None
    have = tracking_value(truck, "macropoint_order")
    if group.order_token:
        if not have:
            new["macropoint_order"] = group.order_token
        elif have != group.order_token:
            note = "linked_to_other_order"
    if not tracking_value(truck, "tracker_id"):
        new["tracker_id"] = group.id_number
    if not tracking_value(truck, "type"):
        new["type"] = "MacroPoint"
    if new != current:
        truck.tracking_type = new               # a new dict, so the JSONB change persists
        truck.updated_at = datetime.now(UTC)
        audit(db, actor_id=actor_id, entity_type="truck", entity_id=str(truck.id),
              action="update", changes={"tracking_type": {"from": current, "to": new}})
    return note


async def apply_messages(db: AsyncSession, actor_id: uuid.UUID,
                         messages: list[ParsedMessage], errors: list[ParseError],
                         assignments: dict[str, uuid.UUID | None]) -> dict:
    """Write the assigned loads in one transaction. Loads left unassigned are
    `skipped`; a truck that is no longer active makes its rows `error`."""
    groups = group_messages(messages)
    wanted = {tid for tid in assignments.values() if tid}
    trucks = {t.id: t for t in await db.scalars(
        select(Truck).where(Truck.id.in_(wanted)).order_by(Truck.id)   # fixed lock order
        .with_for_update())} if wanted else {}
    labels = await _status_labels(db)
    rows: list[dict] = []

    def add(**kw) -> None:
        rows.append({"row": len(rows) + 1, "group_key": None, "id_number": None,
                     "truck_id": None, "truck_name": None, "kind": None,
                     "recorded_at": None, "detail": "", "status_change": None,
                     "reason": None, "note": None, **kw})

    for g in groups:
        base = {"group_key": g.key, "id_number": g.id_number}
        truck_id = assignments.get(g.key)
        truck = trucks.get(truck_id) if truck_id else None
        if truck_id is None:
            for m in g.messages:
                add(**base, source=m.source, kind=m.kind, recorded_at=m.recorded_at,
                    detail=_detail(m), result="skipped", reason="no_truck")
            continue
        if truck is None or truck.archived_at is not None or truck.status in ACTIVE_EXCLUDED:
            for m in g.messages:
                add(**base, source=m.source, kind=m.kind, recorded_at=m.recorded_at,
                    detail=_detail(m), result="error", reason="truck_not_active")
            continue
        base |= {"truck_id": truck.id, "truck_name": truck.name}
        note = _learn_link(db, actor_id, truck, g)
        counts = {"location": 0, "trip_event": 0}
        for m in g.messages:
            row = {**base, "source": m.source, "kind": m.kind,
                   "recorded_at": m.recorded_at, "detail": _detail(m), "note": note}
            if not await _insert(db, truck, m, actor_id):
                add(**row, result="duplicate")
                continue
            counts[m.kind] += 1
            to = status_target(truck.status, m)
            if to:
                old = truck.status
                apply_status_change(truck, to, now=m.recorded_at)
                truck.updated_at = datetime.now(UTC)
                audit(db, actor_id=actor_id, entity_type="truck", entity_id=str(truck.id),
                      action="update", changes={
                          "status": {"from": old, "to": to},
                          "source": {"from": None, "to": "MacroPoint"}})
                row["status_change"] = f"{labels.get(old, old)} → {labels.get(to, to)}"
            add(**row, result="added")
        if counts["location"] or counts["trip_event"]:
            audit(db, actor_id=actor_id, entity_type="truck", entity_id=str(truck.id),
                  action="macropoint_update", changes={"updates": {
                      "from": None,
                      "to": f"{counts['location']} locations, "
                            f"{counts['trip_event']} trip events"}})

    for e in errors:
        add(source=e.source, result="error", reason=e.reason)
    await db.commit()

    def count(result: str) -> int:
        return sum(1 for r in rows if r["result"] == result)

    return {"added": count("added"), "duplicates": count("duplicate"),
            "skipped": count("skipped"), "errors": count("error"),
            "status_changes": sum(1 for r in rows if r["status_change"]), "rows": rows}


async def apply_updates(db: AsyncSession, actor_id: uuid.UUID,
                        files: list[tuple[str, bytes]], text: str,
                        assignments: dict[str, uuid.UUID | None]) -> dict:
    """Re-parse the same input the preview saw (parsing is deterministic) and
    apply it; the client never sends parsed rows."""
    parsed = await asyncio.to_thread(parse_inputs, files, text)
    return await apply_messages(
        db, actor_id,
        [p for p in parsed if isinstance(p, ParsedMessage)],
        [p for p in parsed if isinstance(p, ParseError)],
        assignments)
