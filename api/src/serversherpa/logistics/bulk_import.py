"""Container bulk import — create-only. Mirrors sites/bulk_import.py's
preview/commit split; resolution is case-insensitive against site names and
the container/container_type vocabularies (label OR key). Unresolvable
values are per-row errors, never silent drops — no hidden defaults (the
V2 bug this replaces).

Only `BulkImportError` is imported from sites/bulk_import.py: its
`number_json_rows`/`parse_upload`/`_check_columns` are entangled with
sites' own COLUMNS list (e.g. "code", "type", "partner"), so reusing them
here would reject legitimate container columns like "container_type" and
"site_name". The row-numbering logic below is a minimal, content-agnostic
copy scoped to this module's own TEMPLATE_COLUMNS.
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Container, Site, StatusValue
from serversherpa.services.audit import audit, snapshot
from serversherpa.sites.bulk_import import BulkImportError  # content-agnostic

TEMPLATE_COLUMNS = [
    "name", "container_type", "rfid_tag", "site_name",
    "location_detail", "status",
]
AUDIT_FIELDS = [
    "name", "rfid_tag", "container_type", "status", "site_id",
    "location_detail",
]
MAX_ROWS = 1000


def check_columns(keys: list[str]) -> None:
    if unknown := [k for k in keys if k not in TEMPLATE_COLUMNS]:
        raise BulkImportError("unknown_columns", columns=unknown)


def _cell(value: Any) -> str:
    """Normalize a raw JSON cell (str/float/int/bool/None) to trimmed text.
    Integral floats drop the .0 so numeric-looking text round-trips."""
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    """A bare JSON payload has no header line, so rows are numbered from 1
    (unlike CSV parsing, which would start data at row 2)."""
    if isinstance(rows, dict):
        rows = [rows]           # a single bare object is a one-row import
    if not isinstance(rows, list) or not all(isinstance(r, dict) for r in rows):
        raise BulkImportError("invalid_json")
    if len(rows) > MAX_ROWS:
        raise BulkImportError("too_many_rows", limit=MAX_ROWS)
    out: list[tuple[int, dict]] = []
    for i, raw in enumerate(rows):
        check_columns(list(raw.keys()))
        row = {col: _cell(raw.get(col)) for col in TEMPLATE_COLUMNS}
        if any(v != "" for v in row.values()):        # skip fully blank rows
            out.append((1 + i, row))
    return out


def build_template_csv() -> str:
    return ",".join(TEMPLATE_COLUMNS) + "\n"


async def _reference_data(db: AsyncSession) -> dict:
    sites = {s.name.lower(): s for s in await db.scalars(select(Site))}
    vocab_rows = (await db.scalars(select(StatusValue).where(
        StatusValue.record_type.in_(("container", "container_type"))))).all()

    def vocab(record_type: str) -> dict:
        out = {}
        for v in vocab_rows:
            if v.record_type == record_type:
                out[v.key.lower()] = v.key
                out[v.label.lower()] = v.key
        return out

    names = {n.lower() for n in await db.scalars(select(Container.name))}
    return {"sites": sites, "statuses": vocab("container"),
            "types": vocab("container_type"), "names": names}


def _resolve(row: dict, refs: dict) -> tuple[dict, list[str]]:
    """One row → (normalized data, error codes). data keeps site_name as
    the resolved display name; site_id rides along for commit."""
    errors: list[str] = []
    data: dict[str, Any] = {}
    name = str(row.get("name", "")).strip()
    if not name:
        errors.append("name_required")
    elif name.lower() in refs["names"]:
        errors.append("duplicate_name")
    data["name"] = name

    if raw := str(row.get("container_type", "")).strip():
        if key := refs["types"].get(raw.lower()):
            data["container_type"] = key
        else:
            errors.append("unknown_container_type")
    if raw := str(row.get("status", "")).strip():
        if key := refs["statuses"].get(raw.lower()):
            data["status"] = key
        else:
            errors.append("unknown_status")
    if raw := str(row.get("site_name", "")).strip():
        if site := refs["sites"].get(raw.lower()):
            data["site_id"] = site.id
            data["site_name"] = site.name
        else:
            errors.append("unknown_site")
    if raw := str(row.get("rfid_tag", "")).strip():
        data["rfid_tag"] = raw
    if raw := str(row.get("location_detail", "")).strip():
        data["location_detail"] = raw
    return data, errors


async def preview_rows(db: AsyncSession,
                       numbered: list[tuple[int, dict]]) -> list[dict]:
    if len(numbered) > MAX_ROWS:
        raise BulkImportError("too_many_rows", limit=MAX_ROWS)
    if numbered:
        check_columns(list(numbered[0][1].keys()))
    refs = await _reference_data(db)
    results = []
    seen: set[str] = set()
    for row_no, row in numbered:
        data, errors = _resolve(row, refs)
        key = data["name"].lower()
        if key and key in seen:
            errors.append("duplicate_name")
        seen.add(key)
        results.append({
            "row": row_no,
            "action": "error" if errors else "create",
            "data": {k: v for k, v in data.items() if k != "site_id"},
            "errors": errors,
        })
    return results


async def commit_rows(db: AsyncSession, actor_person_id: uuid.UUID,
                      numbered: list[tuple[int, dict]]) -> dict:
    if len(numbered) > MAX_ROWS:
        raise BulkImportError("too_many_rows", limit=MAX_ROWS)
    if numbered:
        check_columns(list(numbered[0][1].keys()))
    refs = await _reference_data(db)
    resolved = []
    seen: set[str] = set()
    for row_no, row in numbered:
        data, errors = _resolve(row, refs)
        key = data["name"].lower()
        if key and key in seen:
            errors.append("duplicate_name")
        seen.add(key)
        if errors:
            raise BulkImportError("rows_invalid")
        resolved.append(data)

    created = 0
    for data in resolved:
        container = Container(
            name=data["name"],
            container_type=data.get("container_type"),
            rfid_tag=data.get("rfid_tag"),
            site_id=data.get("site_id"),
            location_detail=data.get("location_detail", ""),
            status=data.get("status", "available"),
            source="bulk_import", created_by=actor_person_id)
        db.add(container)
        await db.flush()
        initial = snapshot(container, AUDIT_FIELDS)
        changes = {field: {"from": None, "to": value}
                   for field, value in initial.items() if value not in (None, "")}
        audit(db, actor_id=actor_person_id, entity_type="container",
              entity_id=str(container.id), action="create", changes=changes)
        created += 1
    await db.commit()
    return {"created": created}
