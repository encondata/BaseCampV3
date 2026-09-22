"""Container bulk import — create-only. Mirrors sites/bulk_import.py's
preview/commit split; resolution is case-insensitive against site names and
the container/container_type vocabularies (label OR key). Unresolvable
values are per-row errors, never silent drops — no hidden defaults (the
V2 bug this replaces).

Parsing/numbering comes from the shared core (imports/bulk.py); only the
resolution and commit logic is container-specific.
"""

import uuid
from typing import Any

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Container, Site, StatusValue
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import MAX_ROWS, BulkImportError
from serversherpa.labels.tags import resolve_label_tag
from serversherpa.services.audit import audit, snapshot

TEMPLATE_COLUMNS = [
    "name", "container_type", "rfid_tag", "site_name",
    "location_detail", "status", "label_tag",
]
AUDIT_FIELDS = [
    "name", "rfid_tag", "container_type", "status", "site_id",
    "label_tag", "location_detail",
]


def check_columns(keys: list[str]) -> None:
    core.check_columns(keys, TEMPLATE_COLUMNS)


def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    """A bare JSON payload has no header line, so rows are numbered from 1
    (unlike CSV parsing, which would start data at row 2)."""
    return core.number_json_rows(rows, TEMPLATE_COLUMNS)


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
    rfids = {t.lower() for t in await db.scalars(
        select(Container.rfid_tag).where(Container.rfid_tag.is_not(None)))}
    return {"sites": sites, "statuses": vocab("container"),
            "types": vocab("container_type"), "names": names, "rfids": rfids}


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
        if raw.lower() in refs["rfids"]:
            errors.append("duplicate_rfid_tag")
    if raw := str(row.get("location_detail", "")).strip():
        data["location_detail"] = raw
    if raw := str(row.get("label_tag", "")).strip():
        if key := resolve_label_tag(raw):
            data["label_tag"] = key
        else:
            errors.append("bad_label_tag")
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
    seen_rfids: set[str] = set()
    for row_no, row in numbered:
        data, errors = _resolve(row, refs)
        key = data["name"].lower()
        if key and key in seen:
            errors.append("duplicate_name")
        seen.add(key)
        tag_key = data.get("rfid_tag", "").lower()
        if tag_key and tag_key in seen_rfids:
            errors.append("duplicate_rfid_tag")
        seen_rfids.add(tag_key)
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
    seen_rfids: set[str] = set()
    for row_no, row in numbered:
        data, errors = _resolve(row, refs)
        key = data["name"].lower()
        if key and key in seen:
            errors.append("duplicate_name")
        seen.add(key)
        tag_key = data.get("rfid_tag", "").lower()
        if tag_key and tag_key in seen_rfids:
            errors.append("duplicate_rfid_tag")
        seen_rfids.add(tag_key)
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
            label_tag=data.get("label_tag"),
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
