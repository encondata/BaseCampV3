"""Trucks bulk import: parse (via imports/bulk) → match by name →
preview/commit. Mirrors people/bulk_import.py.

Rows match an existing (non-archived) truck by name, case-insensitively.
Blank-cell rule: on create rows a blank status / team_drive / contact_info
takes the default (created / no / empty); on update rows a blank cell means
"no change", never a clear. Each preview row carries `cells` (the uploaded
cells before defaults) — the commit replays those, never `data`.
"""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import (
    Container, Initiative, Site, StatusValue, Truck, TruckContainer,
)
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import MAX_BYTES, MAX_ROWS, BulkImportError
from serversherpa.services.audit import audit, snapshot

__all__ = ["BulkImportError", "MAX_BYTES", "MAX_ROWS"]

COLUMNS = [
    "name", "status", "driver_name", "co_driver_name", "team_drive",
    "contact_info", "load_number", "seal_id", "tracking_type",
    "tracking_update_type", "tracker_id", "initiative", "start_site",
    "end_site", "containers",
]
SHEET = "Trucks"
TEXT_COLUMNS = ("name", "driver_name", "co_driver_name", "contact_info",
                "load_number", "seal_id")
# template column → key inside trucks.tracking_type (the edit modal's split)
TRACKING_KEYS = {"tracking_type": "type", "tracking_update_type": "update_type",
                 "tracker_id": "tracker_id"}
# template column → Truck foreign-key attribute
REF_COLUMNS = {"initiative": "initiative_id", "start_site": "start_site_id",
               "end_site": "end_site_id"}
AUDIT_FIELDS = [
    "name", "driver_name", "co_driver_name", "team_drive", "contact_info",
    "status", "load_number", "seal_id", "tracking_type",
    "initiative_id", "start_site_id", "end_site_id",
]
SEAL_MAX = 24
TRUE_WORDS = {"yes", "y", "true", "1"}
FALSE_WORDS = {"no", "n", "false", "0"}

SAMPLE_ROWS: list[dict] = [
    {"name": "Truck 12", "status": "active", "driver_name": "Marcus Reyes",
     "co_driver_name": "Dana Whitfield", "team_drive": "yes",
     "contact_info": "+1 (555) 010-2231", "load_number": "L-1042",
     "seal_id": "SEAL-88231", "tracking_type": "gps",
     "tracking_update_type": "API", "tracker_id": "TRK-0012",
     "initiative": "Example Move", "start_site": "Example DC West",
     "end_site": "Example Office", "containers": "Crate A; Crate B"},
    {"name": "Truck 13", "status": "", "driver_name": "Priya Natarajan",
     "co_driver_name": "", "team_drive": "no", "contact_info": "",
     "load_number": "L-1043", "seal_id": "", "tracking_type": "",
     "tracking_update_type": "", "tracker_id": "", "initiative": "",
     "start_site": "", "end_site": "", "containers": ""},
]


# ── parsers ─────────────────────────────────────────────────────────

def parse_bool(text: str) -> bool | None:
    """yes / no (also true / false, 1 / 0) in any case; None when the text
    is blank or not recognized."""
    key = (text or "").strip().lower()
    if key in TRUE_WORDS:
        return True
    if key in FALSE_WORDS:
        return False
    return None


def split_names(cell: str) -> list[str]:
    return [part.strip() for part in (cell or "").split(";") if part.strip()]


# ── parsing / templates (thin wrappers over the shared core) ────────

def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    return core.number_json_rows(rows, COLUMNS)


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    return core.parse_upload(filename, content, COLUMNS, SHEET)


def build_rows_csv(rows: list[dict]) -> str:
    return core.build_rows_csv(rows, COLUMNS)


def build_rows_xlsx(rows: list[dict], statuses: list[str],
                    initiatives: list[str], sites: list[str]) -> bytes:
    return core.build_rows_xlsx(rows, COLUMNS, SHEET, [
        ("Valid statuses", statuses), ("Initiative names", initiatives),
        ("Site names", sites)])


def build_template_csv() -> str:
    return build_rows_csv(SAMPLE_ROWS)


def build_template_xlsx(statuses: list[str], initiatives: list[str],
                        sites: list[str]) -> bytes:
    return build_rows_xlsx(SAMPLE_ROWS, statuses, initiatives, sites)


async def reference_lists(db: AsyncSession) -> tuple[list[str], list[str], list[str]]:
    """What the xlsx Reference sheet lists: truck status keys by sort order,
    initiative names, live site names, both alphabetical."""
    statuses = list(await db.scalars(
        select(StatusValue.key).where(StatusValue.record_type == "truck")
        .order_by(StatusValue.sort_order)))
    initiatives = list(await db.scalars(
        select(Initiative.name).order_by(Initiative.name)))
    sites = list(await db.scalars(
        select(Site.name).where(Site.archived_at.is_(None)).order_by(Site.name)))
    return statuses, initiatives, sites


# ── export ──────────────────────────────────────────────────────────

async def _linked_containers(
    db: AsyncSession, truck_ids: list[uuid.UUID],
) -> dict[uuid.UUID, dict[uuid.UUID, str]]:
    """truck_id → {container_id: container name} for the given trucks."""
    out: dict[uuid.UUID, dict[uuid.UUID, str]] = {}
    if not truck_ids:
        return out
    rows = (await db.execute(
        select(TruckContainer.truck_id, Container.id, Container.name)
        .join(Container, Container.id == TruckContainer.container_id)
        .where(TruckContainer.truck_id.in_(truck_ids)))).all()
    for truck_id, container_id, cname in rows:
        out.setdefault(truck_id, {})[container_id] = cname
    return out


async def export_rows(db: AsyncSession) -> list[dict]:
    """Every live truck in template shape, so an export re-uploads clean."""
    trucks = list(await db.scalars(
        select(Truck).where(Truck.archived_at.is_(None)).order_by(Truck.name)))
    initiative_names = dict((await db.execute(
        select(Initiative.id, Initiative.name))).all())
    site_names = dict((await db.execute(select(Site.id, Site.name))).all())
    linked = await _linked_containers(db, [t.id for t in trucks])
    out = []
    for t in trucks:
        tracking = t.tracking_type or {}
        row = {
            "name": t.name, "status": t.status or "",
            "driver_name": t.driver_name or "",
            "co_driver_name": t.co_driver_name or "",
            "team_drive": "yes" if t.team_drive else "no",
            "contact_info": t.contact_info or "",
            "load_number": t.load_number or "", "seal_id": t.seal_id or "",
            "initiative": (initiative_names.get(t.initiative_id, "")
                           if t.initiative_id else ""),
            "start_site": site_names.get(t.start_site_id, "") if t.start_site_id else "",
            "end_site": site_names.get(t.end_site_id, "") if t.end_site_id else "",
            "containers": "; ".join(sorted(linked.get(t.id, {}).values(),
                                           key=str.lower)),
        }
        for col, key in TRACKING_KEYS.items():
            value = tracking.get(key)
            row[col] = str(value) if value not in (None, "") else ""
        out.append(row)
    return out


# ── validation + preview ────────────────────────────────────────────

def _index(objs) -> dict[str, list]:
    out: dict[str, list] = {}
    for o in objs:
        out.setdefault(o.name.lower(), []).append(o)
    return out


async def _reference_data(db: AsyncSession) -> dict:
    """Sites and containers are indexed twice — live and archived. An
    archived record still has to resolve, otherwise an export of a truck
    that points at one comes back as `unknown site '…'` and blocks the
    whole upload; `preview_rows` then decides whether the archived hit is
    allowed. `site_names` covers every site (live and archived) so a
    diff's `old` renders a name instead of null."""
    statuses = set(await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == "truck")))
    initiatives = _index(await db.scalars(select(Initiative)))
    all_sites = list(await db.scalars(select(Site)))
    all_containers = list(await db.scalars(select(Container)))
    trucks = list(await db.scalars(select(Truck).where(Truck.archived_at.is_(None))))
    return {
        "statuses": statuses, "initiatives": initiatives,
        "sites": _index(s for s in all_sites if s.archived_at is None),
        "sites_archived": _index(s for s in all_sites if s.archived_at is not None),
        "containers": _index(c for c in all_containers if c.archived_at is None),
        "containers_archived": _index(
            c for c in all_containers if c.archived_at is not None),
        "by_name": _index(trucks),
        "linked": await _linked_containers(db, [t.id for t in trucks]),
        "initiative_names": {i.id: i.name for group in initiatives.values() for i in group},
        "site_names": {s.id: s.name for s in all_sites},
    }


def _resolve_one(index: dict, name: str, label: str, errors: list[str],
                 archived: dict | None = None):
    """Exactly one record by name, else a row error. None when blank or
    unresolved. With no live match we fall back to `archived` (same
    one-or-error rule) so the caller can tell "archived" from "unknown";
    the live index always wins, so live behavior is unchanged."""
    if not name:
        return None
    matches = index.get(name.lower(), []) or (archived or {}).get(name.lower(), [])
    if not matches:
        errors.append(f"unknown {label} '{name}'")
        return None
    if len(matches) > 1:
        errors.append(f"ambiguous {label} '{name}'")
        return None
    return matches[0]


async def preview_rows(db: AsyncSession, numbered: list[tuple[int, dict]]) -> dict:
    ref = await _reference_data(db)
    names_seen: dict[str, list[int]] = {}
    for n, row in numbered:
        if row["name"]:
            names_seen.setdefault(row["name"].lower(), []).append(n)

    pending: list[dict] = []
    for n, row in numbered:
        errors: list[str] = []
        name = row["name"]
        if not name:
            errors.append("name is required")
        elif len(names_seen[name.lower()]) > 1:
            errors.append(f"duplicate name '{name}' within the import")
        if row["status"] and row["status"] not in ref["statuses"]:
            errors.append(f"unknown status '{row['status']}'")
        team_drive = parse_bool(row["team_drive"])
        if row["team_drive"] and team_drive is None:
            errors.append("team_drive must be yes or no")
        if len(row["seal_id"]) > SEAL_MAX:
            errors.append(f"seal_id is longer than {SEAL_MAX} characters")
        refs = {
            "initiative": _resolve_one(ref["initiatives"], row["initiative"], "initiative", errors),
            "start_site": _resolve_one(ref["sites"], row["start_site"], "site",
                                       errors, ref["sites_archived"]),
            "end_site": _resolve_one(ref["sites"], row["end_site"], "site",
                                     errors, ref["sites_archived"]),
        }
        container_objs = []
        for cname in split_names(row["containers"]):
            obj = _resolve_one(ref["containers"], cname, "container", errors,
                               ref["containers_archived"])
            if obj is not None:
                container_objs.append(obj)

        blank = {"status": row["status"] == "", "team_drive": row["team_drive"] == "",
                 "contact_info": row["contact_info"] == "",
                 "containers": row["containers"] == ""}
        data = dict(row)
        data["status"] = row["status"] or "created"
        data["team_drive"] = team_drive if team_drive is not None else False
        for col, obj in refs.items():
            if obj is not None:
                data[col] = obj.name
        data["containers"] = [c.name for c in container_objs]

        target: Truck | None = None
        matched_by: str | None = None
        if not errors:
            hits = ref["by_name"].get(name.lower(), [])
            if len(hits) > 1:
                errors.append(f"multiple existing trucks named '{name}'")
            elif hits:
                target, matched_by = hits[0], "name"

        # An archived site or container is only allowed where it is what
        # the matched truck already has — that is what lets an export of
        # an older fleet re-upload as `unchanged` (an unchanged value
        # never produces a diff). Anything else, create rows included, is
        # a row error that names the real reason instead of "unknown".
        for col in ("start_site", "end_site"):
            obj = refs[col]
            if obj is not None and obj.archived_at is not None and not (
                    target is not None
                    and getattr(target, REF_COLUMNS[col]) == obj.id):
                errors.append(f"site '{obj.name}' is archived")
        for obj in container_objs:
            if obj.archived_at is not None and not (
                    target is not None
                    and obj.id in ref["linked"].get(target.id, {})):
                errors.append(f"container '{obj.name}' is archived")

        pending.append({"row": n, "cells": dict(row), "name": name,
                        "errors": errors, "data": data, "blank": blank,
                        "target": target, "matched_by": matched_by,
                        "refs": refs, "container_objs": container_objs})

    # two upload rows resolving to the same truck would apply twice, last
    # write winning silently — both rows are errors instead
    same_target: dict[uuid.UUID, list[dict]] = {}
    for p in pending:
        if p["target"] is not None:
            same_target.setdefault(p["target"].id, []).append(p)
    for group in same_target.values():
        if len(group) > 1:
            for p in group:
                p["errors"].append("two rows match the same existing truck "
                                   f"'{p['target'].name}'")

    results = []
    for p in pending:
        errors, target = p["errors"], p["target"]
        action, diff_out, truck_id = "create", None, None
        if errors:
            action = "error"
        elif target is not None:
            truck_id = str(target.id)
            changes = _diff_row(target, p["data"], p["blank"], p["refs"],
                                p["container_objs"],
                                ref["linked"].get(target.id, {}), ref)
            action = "update" if changes else "unchanged"
            diff_out = changes or None
        results.append({"row": p["row"], "name": p["name"] or None,
                        "action": action,
                        "matched_by": p["matched_by"] if action != "error" else None,
                        "matched_name": (target.name if target is not None
                                         and action != "error" else None),
                        "errors": errors, "diff": diff_out, "truck_id": truck_id,
                        "cells": p["cells"],
                        "data": p["data"] if action != "error" else None})

    can_commit = bool(results) and all(r["action"] != "error" for r in results)
    return {"rows": results, "can_commit": can_commit}


def _diff_row(truck: Truck, data: dict, blank: dict, refs: dict,
              container_objs: list, linked: dict, ref: dict) -> dict:
    """Changed fields only; blank in the row = no change. `blank` remembers
    the create-only defaults so they never read as edits."""
    out: dict = {}
    for col in TEXT_COLUMNS:
        raw = data[col]
        if col == "contact_info" and blank["contact_info"]:
            continue
        if raw == "":
            continue
        old = getattr(truck, col)
        if (old or "") != raw:
            out[col] = {"old": old, "new": raw}
    if not blank["status"] and (truck.status or "") != data["status"]:
        out["status"] = {"old": truck.status, "new": data["status"]}
    if not blank["team_drive"] and bool(truck.team_drive) != data["team_drive"]:
        out["team_drive"] = {"old": bool(truck.team_drive), "new": data["team_drive"]}
    tracking = truck.tracking_type or {}
    for col, key in TRACKING_KEYS.items():
        raw = data[col]
        if raw == "":
            continue
        old = tracking.get(key)
        old_text = str(old) if old not in (None, "") else ""
        if old_text != raw:
            out[col] = {"old": old if old_text else None, "new": raw}
    for col, attr in REF_COLUMNS.items():
        obj = refs[col]
        if obj is None:
            continue
        current = getattr(truck, attr)
        if current != obj.id:
            names = ref["initiative_names"] if col == "initiative" else ref["site_names"]
            out[col] = {"old": names.get(current) if current else None, "new": obj.name}
    if not blank["containers"]:
        want = {c.id: c.name for c in container_objs}
        add = sorted(n for i, n in want.items() if i not in linked)
        remove = sorted(n for i, n in linked.items() if i not in want)
        if add or remove:
            out["containers"] = {"add": add, "remove": remove}
    return out


# ── commit ──────────────────────────────────────────────────────────

async def commit_rows(db: AsyncSession, actor_id: uuid.UUID,
                      numbered: list[tuple[int, dict]], *,
                      approved_updates: set[str], source_label: str) -> dict:
    """All-or-nothing: re-validates everything, then writes creates plus
    APPROVED updates in one transaction; unapproved updates are skipped.
    Raises rows_invalid (carrying the full preview payload) if any row
    errors — nothing is written. `numbered` must be the ORIGINAL uploaded
    cells (the preview's `cells`), never its normalized `data`."""
    preview = await preview_rows(db, numbered)
    if not preview["rows"] or any(r["action"] == "error" for r in preview["rows"]):
        raise BulkImportError("rows_invalid", rows=preview["rows"])

    ref = await _reference_data(db)
    counts = {"created": 0, "updated": 0, "skipped": 0, "unchanged": 0}
    applied: list[dict] = []
    for r in preview["rows"]:
        if r["action"] == "unchanged":
            action = "unchanged"
        elif r["action"] == "create":
            truck = await _create_truck(db, actor_id, r["data"], ref)
            r["truck_id"] = str(truck.id)
            action = "created"
        elif r["truck_id"] in approved_updates:
            await _apply_update(db, actor_id, r, ref)
            action = "updated"
        else:
            action = "skipped"
        counts[action] += 1
        applied.append({"row": r["row"], "name": r["name"],
                        "truck_id": r["truck_id"], "action": action,
                        "diff": r["diff"] if action in ("updated", "skipped") else None})
    audit(db, actor_id=actor_id, entity_type="truck", entity_id=None,
          action="bulk_import", changes={**counts, "source": source_label})
    await db.commit()
    return {**counts, "rows": applied}


def _ref_id(ref: dict, col: str, name: str) -> uuid.UUID | None:
    """The id for a canonical reference name resolved at preview time; a
    name that vanished between preview and commit raises so the whole
    transaction rolls back rather than auditing a change never applied."""
    if not name:
        return None
    if col == "initiative":
        index, archived = ref["initiatives"], {}
    else:
        index, archived = ref["sites"], ref["sites_archived"]
    # same live-then-archived fallback as the preview: an approved update
    # may legitimately keep an archived value it already had
    matches = index.get(name.lower(), []) or archived.get(name.lower(), [])
    if len(matches) != 1:
        raise ValueError(f"{col} '{name}' vanished between preview and commit")
    return matches[0].id


def _container_ids(ref: dict, names: list[str]) -> set[uuid.UUID]:
    out = set()
    for cname in names:
        matches = (ref["containers"].get(cname.lower(), [])
                   or ref["containers_archived"].get(cname.lower(), []))
        if len(matches) != 1:
            raise ValueError(f"container '{cname}' vanished between preview and commit")
        out.add(matches[0].id)
    return out


async def _create_truck(db: AsyncSession, actor_id: uuid.UUID, data: dict,
                        ref: dict) -> Truck:
    tracking = {key: data[col] for col, key in TRACKING_KEYS.items() if data[col]}
    truck = Truck(
        name=data["name"], driver_name=data["driver_name"] or None,
        co_driver_name=data["co_driver_name"] or None,
        team_drive=data["team_drive"], contact_info=data["contact_info"],
        status=data["status"], load_number=data["load_number"] or None,
        seal_id=data["seal_id"] or None, tracking_type=tracking,
        initiative_id=_ref_id(ref, "initiative", data["initiative"]),
        start_site_id=_ref_id(ref, "start_site", data["start_site"]),
        end_site_id=_ref_id(ref, "end_site", data["end_site"]),
        created_by=actor_id)
    db.add(truck)
    await db.flush()
    for container_id in sorted(_container_ids(ref, data["containers"]), key=str):
        db.add(TruckContainer(truck_id=truck.id, container_id=container_id))
    changes = {field: {"from": None, "to": value}
               for field, value in snapshot(truck, AUDIT_FIELDS).items()
               if value not in (None, "", {}, False)}
    if data["containers"]:
        changes["containers"] = {"from": [], "to": sorted(data["containers"])}
    audit(db, actor_id=actor_id, entity_type="truck",
          entity_id=str(truck.id), action="create", changes=changes)
    return truck


async def _apply_update(db: AsyncSession, actor_id: uuid.UUID, r: dict,
                        ref: dict) -> None:
    truck = await db.get(Truck, uuid.UUID(r["truck_id"]))
    changes: dict = {}
    tracking = dict(truck.tracking_type or {})
    tracking_changed = False
    for col, change in (r["diff"] or {}).items():
        if col in TEXT_COLUMNS or col in ("status", "team_drive"):
            setattr(truck, col, change["new"])
        elif col in TRACKING_KEYS:
            tracking[TRACKING_KEYS[col]] = change["new"]
            tracking_changed = True
        elif col in REF_COLUMNS:
            setattr(truck, REF_COLUMNS[col], _ref_id(ref, col, change["new"]))
        elif col == "containers":
            want = _container_ids(ref, r["data"]["containers"])
            current = set(await db.scalars(
                select(TruckContainer.container_id)
                .where(TruckContainer.truck_id == truck.id)))
            for container_id in current - want:
                await db.execute(delete(TruckContainer).where(
                    TruckContainer.truck_id == truck.id,
                    TruckContainer.container_id == container_id))
            for container_id in want - current:
                db.add(TruckContainer(truck_id=truck.id, container_id=container_id))
            # the audit row speaks the single-record endpoint's vocabulary
            # ({from, to} full lists, which auditFormat.ts renders); the
            # preview/commit response keeps its own {add, remove} diff
            changes["containers"] = {
                "from": sorted(ref["linked"].get(truck.id, {}).values()),
                "to": sorted(r["data"]["containers"])}
            continue
        changes[col] = {"from": change["old"], "to": change["new"]}
    if tracking_changed:
        truck.tracking_type = tracking
    truck.updated_at = datetime.now(UTC)
    audit(db, actor_id=actor_id, entity_type="truck",
          entity_id=str(truck.id), action="update", changes=changes)
