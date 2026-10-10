"""Shipment update feed — truck location reports, status changes and
containers loaded/unloaded, merged newest-first.

Sources (two set-based queries, each joined to the truck and its move):
  * `truck_updates`            -> `location` events
  * truck `audit_log` rows     -> `status`, `load`, `unload` events
      - `update` rows whose changes carry `status` (portal PATCH, bulk import)
      - `kiosk_truck_load` / `kiosk_truck_unload`        (via "kiosk")
      - `update` rows with `container_ids` {from, to} id lists, written by
        PATCH /trucks/{id}                                (via "portal")
      - `create`/`update` rows with `containers` {from, to} name lists,
        written by the bulk importer                      (via "import")
    Container changes made when a truck is created through POST /trucks, and
    the implicit unload from the previous truck when a kiosk load moves a
    crate, are not audited anywhere, so they produce no events.

Ordering and paging. Every event has a stable string `id` (`loc:<uuid>`,
`audit:<uuid>` for a kiosk row, `audit:<uuid>:status` and
`audit:<uuid>:load:<container uuid>` / `...:unload:...` for the events one
PATCH or import row expands into; a bulk-import event, which knows only the
container's name, ends in a short hash of the name instead of the name, so an
id and the cursor built from it stay short). Events sort by (`at`, `id`) descending,
the id compared as a plain string (SQL uses COLLATE "C" so the database and
Python agree). `next_before` is the compound cursor `<UTC ISO>~<id>` of the
last event returned; `before=<cursor>` returns events strictly after it in
that order, so a run of events at one timestamp is never dropped or repeated
across pages. A bare ISO timestamp is accepted too and means "strictly older
than that instant". The cursor is opaque: clients pass it back verbatim
(URL-encoded).
"""

import hashlib
import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import String, and_, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    AuditLog,
    Container,
    ContainerAsset,
    Initiative,
    Person,
    StatusValue,
    Truck,
    TruckUpdate,
)

DEFAULT_COLOR = "#51606f"
KIOSK_ACTIONS = {"kiosk_truck_load": "load", "kiosk_truck_unload": "unload"}

Position = tuple[datetime, str]


class FeedCursorError(ValueError):
    pass


def format_cursor(at: datetime, event_id: str) -> str:
    stamp = at.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    return f"{stamp}~{event_id}"


MAX_CURSOR_LENGTH = 200
_EARLIEST = datetime(1970, 1, 1, tzinfo=UTC)
_LATEST = datetime(9000, 1, 1, tzinfo=UTC)


def parse_cursor(raw: str) -> tuple[datetime, str | None]:
    """Parse `before`; anything malformed raises FeedCursorError (a 422),
    never a database error: NUL bytes, absurd lengths and timestamps outside
    1970..9000 (which overflow or Postgres rejects) are refused up front."""
    if len(raw) > MAX_CURSOR_LENGTH or "\x00" in raw:
        raise FeedCursorError(raw[:40])
    stamp, sep, event_id = raw.partition("~")
    try:
        at = datetime.fromisoformat(stamp.strip())
        if at.tzinfo is None:
            at = at.replace(tzinfo=UTC)
        at = at.astimezone(UTC)
    except (ValueError, OverflowError) as exc:
        raise FeedCursorError(raw[:40]) from exc
    if not _EARLIEST <= at <= _LATEST or (sep and not event_id):
        raise FeedCursorError(raw[:40])
    return at, (event_id if sep else None)


def _is_older(at: datetime, key: str, cursor: tuple[datetime, str | None]) -> bool:
    cur_at, cur_key = cursor
    if cur_key is None:
        return at < cur_at
    return (at, key) < (cur_at, cur_key)


def _older_than(at_col, key_col, cursor, *, audit: bool):
    """SQL twin of `_is_older`, at row level. An audit row's events carry
    suffixes after its key (`audit:<id>:load:<container>`), so when the
    cursor sits on one of them the row it came from can still hold older
    events and is kept; a bare row key (`audit:<id>`, a kiosk event or the
    "this row is spent" cursor) drops the row."""
    cur_at, cur_key = cursor
    if cur_key is None:
        return at_col < cur_at
    tie = key_col < cur_key
    parts = cur_key.split(":", 2)
    if audit and len(parts) == 3:
        tie = or_(tie, key_col == ":".join(parts[:2]))
    # `at <= cur_at` is implied by the rest; stated on its own it is a plain
    # range the `at` index can bound, so a deep page does not scan every
    # newer row to apply the (at, key) tuple compare.
    return and_(at_col <= cur_at, or_(at_col < cur_at, and_(at_col == cur_at, tie)))


def _name_ids(names: list[str]) -> dict[str, str]:
    """A short, deterministic id token per container name: the first 12 hex
    characters of its sha1, lengthened (never shared) in the astronomically
    unlikely case two names of one row collide. `names` is sorted so the
    same row always yields the same tokens."""
    taken: set[str] = set()
    out: dict[str, str] = {}
    for name in names:
        digest = hashlib.sha1(name.encode("utf-8")).hexdigest()
        token = next(digest[:n] for n in (12, 20, 40) if digest[:n] not in taken)
        taken.add(token)
        out[name] = token
    return out


def _ids(values: Any) -> list[str]:
    return [v for v in values if isinstance(v, str)] if isinstance(values, list) else []


def _uuid(value: Any) -> uuid.UUID | None:
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return None


async def _truck_vocab(db: AsyncSession) -> dict[str, tuple[str, str]]:
    rows = await db.scalars(select(StatusValue).where(StatusValue.record_type == "truck"))
    return {s.key: (s.label, s.color) for s in rows}


def _truck_fields(truck_id: uuid.UUID, name: str, load_number: str | None,
                  initiative_id: uuid.UUID | None, initiative_name: str | None) -> dict:
    return {"truck_id": truck_id, "truck_name": name, "load_number": load_number,
            "initiative_id": initiative_id, "initiative_name": initiative_name}


async def _location_rows(db: AsyncSession, limit: int, cursor, initiative_id):
    key = func.concat("loc:", cast(TruckUpdate.id, String)).collate("C")
    query = (select(TruckUpdate, Truck.name, Truck.load_number,
                    Truck.initiative_id, Initiative.name)
             .join(Truck, Truck.id == TruckUpdate.truck_id)
             .outerjoin(Initiative, Initiative.id == Truck.initiative_id))
    if initiative_id is not None:
        query = query.where(Truck.initiative_id == initiative_id)
    if cursor is not None:
        query = query.where(_older_than(TruckUpdate.recorded_at, key, cursor, audit=False))
    return (await db.execute(
        query.order_by(TruckUpdate.recorded_at.desc(), key.desc()).limit(limit + 1)
    )).all()


async def _audit_rows(db: AsyncSession, limit: int, cursor, initiative_id):
    key = func.concat("audit:", cast(AuditLog.id, String)).collate("C")
    changes = AuditLog.changes
    carries_event = or_(
        and_(AuditLog.action == "update",
             or_(changes.has_key("status"), changes.has_key("container_ids"),
                 changes.has_key("containers"))),
        and_(AuditLog.action == "create", changes.has_key("containers")),
        AuditLog.action.in_(KIOSK_ACTIONS))
    # entity_id is text; compare as text so a stray non-uuid id can never
    # raise inside a cast, and deleted trucks simply have nothing to join to.
    query = (select(AuditLog, Truck.name, Truck.load_number,
                    Truck.initiative_id, Initiative.name, Truck.id)
             .join(Truck, AuditLog.entity_id == cast(Truck.id, String))
             .outerjoin(Initiative, Initiative.id == Truck.initiative_id)
             .where(AuditLog.entity_type == "truck", carries_event))
    if initiative_id is not None:
        query = query.where(Truck.initiative_id == initiative_id)
    if cursor is not None:
        query = query.where(_older_than(AuditLog.at, key, cursor, audit=True))
    return (await db.execute(
        query.order_by(AuditLog.at.desc(), key.desc()).limit(limit + 1)
    )).all()


def _status_event(row: AuditLog, base: dict, vocab: dict) -> dict | None:
    change = row.changes.get("status")
    if row.action != "update" or not isinstance(change, dict):
        return None
    old, new = change.get("from"), change.get("to")
    if not new or old == new:
        return None

    def lc(key):
        label, color = vocab.get(key, (key, DEFAULT_COLOR)) if key else (None, None)
        return label, color

    from_label, from_color = lc(old)
    to_label, to_color = lc(new)
    return {**base, "id": f"audit:{row.id}:status", "kind": "status",
            "from_status": old, "from_label": from_label, "from_color": from_color,
            "to_status": new, "to_label": to_label, "to_color": to_color}


def _container_events(row: AuditLog, base: dict) -> list[dict]:
    """Load/unload events for one audit row. Container ids (portal PATCH) or
    names (bulk import) are diffed from -> to; one event per container."""
    kind_of = KIOSK_ACTIONS.get(row.action)
    if kind_of is not None:
        c = row.changes
        return [{**base, "id": f"audit:{row.id}", "kind": kind_of, "via": "kiosk",
                 "container_id": _uuid(c.get("container_id")),
                 "container_name": c.get("container_name"),
                 "asset_count": c.get("asset_count"),
                 "from_truck": c.get("from_truck") if kind_of == "load" else None,
                 "device": c.get("device")}]
    out: list[dict] = []
    ids = row.changes.get("container_ids")
    if isinstance(ids, dict):
        old, new = set(_ids(ids.get("from"))), set(_ids(ids.get("to")))
        for kind, group in (("load", new - old), ("unload", old - new)):
            for raw in sorted(group):
                out.append({**base, "id": f"audit:{row.id}:{kind}:{raw}",
                            "kind": kind, "via": "portal",
                            "container_id": _uuid(raw)})
    names = row.changes.get("containers")
    if isinstance(names, dict):
        old, new = set(_ids(names.get("from"))), set(_ids(names.get("to")))
        for kind, group in (("load", new - old), ("unload", old - new)):
            ordered = sorted(group)
            tokens = _name_ids(ordered)
            for name in ordered:
                out.append({**base, "id": f"audit:{row.id}:{kind}:{tokens[name]}",
                            "kind": kind, "via": "import", "container_name": name})
    return out


async def _fill_containers(db: AsyncSession, events: list[dict]) -> None:
    """Names and asset counts for PATCH events, which only recorded ids.
    Both are read now, not as of the event (the audit row has no history);
    a container deleted since then has neither (both null)."""
    portal = [e for e in events if e.get("via") == "portal" and e.get("container_id")]
    wanted = {e["container_id"] for e in portal}
    if not wanted:
        return
    names = dict((await db.execute(
        select(Container.id, Container.name).where(Container.id.in_(wanted)))).all())
    counts = dict((await db.execute(
        select(ContainerAsset.container_id, func.count())
        .where(ContainerAsset.container_id.in_(wanted))
        .group_by(ContainerAsset.container_id))).all())
    for e in portal:
        cid = e["container_id"]
        e["container_name"] = names.get(cid)
        e["asset_count"] = counts.get(cid, 0) if cid in names else None


async def _actor_names(db: AsyncSession, ids: set[uuid.UUID]) -> dict[uuid.UUID, str]:
    if not ids:
        return {}
    # same text as Person.display_name, without loading whole people rows
    name = func.concat(func.coalesce(func.nullif(Person.preferred_name, ""),
                                     Person.first_name), " ", Person.last_name)
    rows = await db.execute(select(Person.id, name).where(Person.id.in_(ids)))
    return dict(rows.all())


async def build_feed(db: AsyncSession, *, limit: int, before: str | None,
                     initiative_id: uuid.UUID | None) -> dict:
    cursor = parse_cursor(before) if before else None

    loc_rows = await _location_rows(db, limit, cursor, initiative_id)
    audit_rows = await _audit_rows(db, limit, cursor, initiative_id)

    # A source with more than `limit` rows is cut at its limit-th row; events
    # older than the newest such cut might be missing, so they are held back
    # for the next page (their rows are re-read from the cursor).
    watermarks: list[Position] = []
    if len(loc_rows) > limit:
        loc_rows = loc_rows[:limit]
        last = loc_rows[-1][0]
        watermarks.append((last.recorded_at, f"loc:{last.id}"))
    if len(audit_rows) > limit:
        audit_rows = audit_rows[:limit]
        last = audit_rows[-1][0]
        watermarks.append((last.at, f"audit:{last.id}"))
    floor = max(watermarks) if watermarks else None

    vocab = await _truck_vocab(db)
    events: list[dict] = []
    for u, name, load_number, init_id, init_name in loc_rows:
        events.append({
            **_truck_fields(u.truck_id, name, load_number, init_id, init_name),
            "id": f"loc:{u.id}", "at": u.recorded_at, "kind": "location",
            "location": u.location, "lat": u.lat, "lng": u.lng,
            "address": u.approximate_address or None, "source": u.source})
    actor_of: dict[str, uuid.UUID | None] = {}
    audit_events: list[dict] = []
    for row, name, load_number, init_id, init_name, truck_id in audit_rows:
        base = {**_truck_fields(truck_id, name, load_number, init_id, init_name),
                "at": row.at}
        found = [e for e in (_status_event(row, base, vocab),) if e]
        found += _container_events(row, base)
        for e in found:
            actor_of[e["id"]] = row.actor_person_id
        audit_events += found
    await _fill_containers(db, audit_events)
    events += audit_events

    actors = await _actor_names(db, {a for a in actor_of.values() if a})
    for e in events:
        a = actor_of.get(e["id"])
        e["actor_name"] = actors.get(a) if a else None

    events = [e for e in events
              if (cursor is None or _is_older(e["at"], e["id"], cursor))
              and (floor is None or (e["at"], e["id"]) >= floor)]
    events.sort(key=lambda e: (e["at"], e["id"]), reverse=True)
    page = events[:limit]
    more = len(events) > limit or floor is not None
    next_before = None
    if more:
        if page:
            next_before = format_cursor(page[-1]["at"], page[-1]["id"])
        else:
            next_before = format_cursor(*floor)
    return {"events": page, "next_before": next_before}
