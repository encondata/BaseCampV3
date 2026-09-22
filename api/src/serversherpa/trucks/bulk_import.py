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
    statuses = set(await db.scalars(select(StatusValue.key).where(
        StatusValue.record_type == "truck")))
    initiatives = _index(await db.scalars(select(Initiative)))
    sites = _index(await db.scalars(select(Site).where(Site.archived_at.is_(None))))
    containers = _index(await db.scalars(
        select(Container).where(Container.archived_at.is_(None))))
    trucks = list(await db.scalars(select(Truck).where(Truck.archived_at.is_(None))))
    return {
        "statuses": statuses, "initiatives": initiatives, "sites": sites,
        "containers": containers, "by_name": _index(trucks),
        "linked": await _linked_containers(db, [t.id for t in trucks]),
        "initiative_names": {i.id: i.name for group in initiatives.values() for i in group},
        "site_names": {s.id: s.name for group in sites.values() for s in group},
    }


def _resolve_one(index: dict, name: str, label: str, errors: list[str]):
    """Exactly one record by name, else a row error. None when blank or
    unresolved."""
    if not name:
        return None
    matches = index.get(name.lower(), [])
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
            "start_site": _resolve_one(ref["sites"], row["start_site"], "site", errors),
            "end_site": _resolve_one(ref["sites"], row["end_site"], "site", errors),
        }
        container_objs = []
        for cname in split_names(row["containers"]):
            obj = _resolve_one(ref["containers"], cname, "container", errors)
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
