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
