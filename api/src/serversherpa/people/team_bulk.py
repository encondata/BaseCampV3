"""Bulk assign people to a job: parse (via imports/bulk) → resolve worker /
site / role by name → preview with per-row overrides and skips → commit.

A row names a worker, the site they worked and the role they performed on
ONE job chosen on the page. Workers match live workers by "first last" or
"preferred last" (people/bulk_import.name_keys); sites match non-archived
sites by name; roles match initiative work types by key or label. Unknown or
ambiguous values leave the row in `attention` with candidates, until the
admin picks one (an override) or skips the row. People already on the job
are updated only where the sheet sets a different value (blank = no
change) and only when the update is approved; people not in the sheet are
never touched."""

import uuid
from datetime import UTC, datetime
from typing import Any

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, InitiativePerson, Person, Site, StatusValue
from serversherpa.imports import bulk as core
from serversherpa.imports.bulk import BulkImportError
from serversherpa.people.bulk_import import _worker_query, name_keys
from serversherpa.services.audit import audit, diff, snapshot

COLUMNS = ["worker", "site", "role"]
SHEET = "Team"
FIELDS = ("worker", "site", "role")
WORK_TYPE = "initiative_work_type"
SAMPLE_ROWS: list[dict] = [
    {"worker": "Marcus Reyes", "site": "Example DC West", "role": "lead"},
    {"worker": "Dana Whitfield", "site": "", "role": "tech"},
]


def _squash(text: str) -> str:
    return " ".join((text or "").split()).casefold()


# ── parsing ─────────────────────────────────────────────────────────

def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    return core.number_json_rows(rows, COLUMNS)


def number_posted_rows(rows: Any, row_numbers: Any) -> list[tuple[int, dict]]:
    """JSON rows re-posted after a file preview carry the spreadsheet line
    numbers the preview assigned, so overrides / skips / approvals keyed by
    those numbers still line up."""
    numbered = number_json_rows(rows)
    if row_numbers is None:
        return numbered
    if (not isinstance(row_numbers, list) or len(row_numbers) != len(numbered)
            or not all(isinstance(n, int) and not isinstance(n, bool) for n in row_numbers)
            or len(set(row_numbers)) != len(row_numbers)):
        raise BulkImportError("invalid_row_numbers")
    return [(n, row) for n, (_, row) in zip(row_numbers, numbered, strict=True)]


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    return core.parse_upload(filename, content, COLUMNS, SHEET)


def parse_overrides(raw: Any) -> dict[int, dict[str, str]]:
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise BulkImportError("invalid_overrides")
    out: dict[int, dict[str, str]] = {}
    for key, picks in raw.items():
        try:
            row = int(key)
        except (TypeError, ValueError):
            raise BulkImportError("invalid_overrides") from None
        if (not isinstance(picks, dict)
                or not all(f in FIELDS and isinstance(v, str) and v for f, v in picks.items())):
            raise BulkImportError("invalid_overrides")
        out[row] = dict(picks)
    return out


def parse_row_list(raw: Any, code: str) -> set[int]:
    if raw is None:
        return set()
    if not isinstance(raw, list) or not all(
            isinstance(n, int) and not isinstance(n, bool) for n in raw):
        raise BulkImportError(code)
    return set(raw)


# ── reference data ──────────────────────────────────────────────────

def _worker_label(p: Person) -> str:
    return f"{p.first_name} {p.last_name}"


def _worker_detail(p: Person) -> str:
    return p.email or p.phone or ""


async def _reference(db: AsyncSession, initiative_id: uuid.UUID) -> dict:
    workers = [p for p, _ in (await db.execute(_worker_query())).all()]
    worker_index: dict[str, list[Person]] = {}
    for p in workers:
        for key in name_keys(p.first_name, p.last_name, p.preferred_name or ""):
            worker_index.setdefault(key, []).append(p)
    sites = list(await db.scalars(
        select(Site).where(Site.archived_at.is_(None)).order_by(Site.name)))
    site_index: dict[str, list[Site]] = {}
    for s in sites:
        site_index.setdefault(_squash(s.name), []).append(s)
    roles = list(await db.scalars(
        select(StatusValue).where(StatusValue.record_type == WORK_TYPE,
                                  StatusValue.is_active.is_(True))
        .order_by(StatusValue.sort_order)))
    role_index: dict[str, list[StatusValue]] = {}
    for r in roles:
        for key in {_squash(r.key), _squash(r.label)}:
            role_index.setdefault(key, []).append(r)
    team = {tp.person_id: tp for tp in await db.scalars(
        select(InitiativePerson).where(InitiativePerson.initiative_id == initiative_id))}
    all_site_names = {s.id: s.name for s in await db.scalars(select(Site))}
    all_role_labels = {r.key: r.label for r in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == WORK_TYPE))}
    return {
        "workers": workers, "sites": sites, "roles": roles,
        "index": {"worker": worker_index, "site": site_index, "role": role_index},
        "by_id": {"worker": {str(p.id): p for p in workers},
                  "site": {str(s.id): s for s in sites},
                  "role": {r.key: r for r in roles}},
        "team": team, "site_names": all_site_names, "role_labels": all_role_labels,
    }


def _candidate(field: str, obj) -> dict:
    if field == "worker":
        return {"id": str(obj.id), "label": _worker_label(obj), "detail": _worker_detail(obj)}
    if field == "site":
        return {"id": str(obj.id), "label": obj.name, "detail": ""}
    return {"id": obj.key, "label": obj.label, "detail": obj.key}


def _resolve(ref: dict, field: str, cell: str, picked: str | None,
             issues: list[dict], errors: list[str]):
    """One record for this cell: the admin's pick wins; otherwise exactly
    one match by name. Unknown / ambiguous → an issue with candidates; a
    pick that points at nothing → an error. None when blank or unresolved."""
    if picked:
        obj = ref["by_id"][field].get(picked)
        if obj is None:
            errors.append(f"the chosen {field} no longer exists — pick again")
        return obj
    if not cell:
        return None
    matches = ref["index"][field].get(_squash(cell), [])
    unique = list({id(m): m for m in matches}.values())
    if len(unique) == 1:
        return unique[0]
    issues.append({"field": field, "kind": "ambiguous" if unique else "unknown",
                   "value": cell, "candidates": [_candidate(field, m) for m in unique]})
    return None


# ── preview ─────────────────────────────────────────────────────────

async def preview_rows(db: AsyncSession, initiative_id: uuid.UUID,
                       numbered: list[tuple[int, dict]], *,
                       overrides: dict[int, dict[str, str]] | None = None,
                       skip: set[int] | None = None) -> dict:
    ref = await _reference(db, initiative_id)
    overrides = overrides or {}
    skip = skip or set()
    out: list[dict] = []
    for n, row in numbered:
        base = {"row": n, "worker": row["worker"] or None, "person_id": None,
                "person_name": None, "site_id": None, "site_name": None,
                "role_key": None, "role_label": None, "errors": [], "issues": [],
                "diff": None, "cells": row}
        if n in skip:
            out.append({**base, "action": "skipped"})
            continue
        picks = overrides.get(n, {})
        errors: list[str] = []
        issues: list[dict] = []
        if not row["worker"] and not picks.get("worker"):
            errors.append("worker is required")
            person = None
        else:
            person = _resolve(ref, "worker", row["worker"], picks.get("worker"), issues, errors)
        site = _resolve(ref, "site", row["site"], picks.get("site"), issues, errors)
        role = _resolve(ref, "role", row["role"], picks.get("role"), issues, errors)
        out.append({
            **base, "errors": errors, "issues": issues,
            "person_id": str(person.id) if person else None,
            "person_name": _worker_label(person) if person else None,
            "site_id": str(site.id) if site else None, "site_name": site.name if site else None,
            "role_key": role.key if role else None, "role_label": role.label if role else None,
            "action": "error" if errors else ("attention" if issues else "pending"),
        })

    seen: dict[str, list[dict]] = {}
    for r in out:
        if r["person_id"]:
            seen.setdefault(r["person_id"], []).append(r)
    for group in seen.values():
        if len(group) > 1:
            lines = ", ".join(str(g["row"]) for g in group)
            for g in group:
                g["errors"].append(
                    f"{g['person_name']} appears on more than one row ({lines})")
                g["action"] = "error"

    for r in out:
        if r["action"] != "pending":
            continue
        current = ref["team"].get(uuid.UUID(r["person_id"]))
        if current is None:
            r["action"] = "add"
            continue
        changes: dict[str, dict] = {}
        if r["site_id"] and str(current.site_worked_id) != r["site_id"]:
            changes["site"] = {"old": ref["site_names"].get(current.site_worked_id),
                               "new": r["site_name"]}
        if r["role_key"] and current.work_type != r["role_key"]:
            changes["role"] = {"old": ref["role_labels"].get(current.work_type),
                               "new": r["role_label"]}
        r["action"] = "update" if changes else "unchanged"
        r["diff"] = changes or None

    counts = {k: 0 for k in ("add", "update", "unchanged", "attention", "error", "skipped")}
    for r in out:
        counts[r["action"]] += 1
    return {"rows": out, "counts": counts,
            "can_commit": bool(out) and counts["attention"] == 0 and counts["error"] == 0}


# ── commit ──────────────────────────────────────────────────────────

async def commit_rows(db: AsyncSession, actor_id: uuid.UUID, initiative_id: uuid.UUID,
                      numbered: list[tuple[int, dict]], *,
                      overrides: dict[int, dict[str, str]], skip: set[int],
                      approved_updates: set[int], source_label: str) -> dict:
    """All-or-nothing: re-runs the preview with the same picks and skips,
    refuses (rows_invalid, nothing written) if anything still needs
    attention or errors, then writes adds and APPROVED updates in one
    transaction. Unapproved updates are reported as skipped."""
    preview = await preview_rows(db, initiative_id, numbered, overrides=overrides, skip=skip)
    if not preview["can_commit"]:
        raise BulkImportError("rows_invalid", rows=preview["rows"])

    now = datetime.now(UTC)
    counts = {"created": 0, "updated": 0, "unchanged": 0, "skipped": 0}
    applied: list[dict] = []
    for r in preview["rows"]:
        action = r["action"]
        if action == "add":
            person_id = uuid.UUID(r["person_id"])
            db.add(InitiativePerson(
                initiative_id=initiative_id, person_id=person_id,
                site_worked_id=uuid.UUID(r["site_id"]) if r["site_id"] else None,
                work_type=r["role_key"]))
            audit(db, actor_id=actor_id, entity_type="initiative",
                  entity_id=str(initiative_id), action="person_add",
                  changes={"person_id": {"from": None, "to": r["person_id"]}})
            result = "created"
        elif action == "update" and r["row"] in approved_updates:
            assoc = await db.scalar(select(InitiativePerson).where(
                InitiativePerson.initiative_id == initiative_id,
                InitiativePerson.person_id == uuid.UUID(r["person_id"])))
            fields = ["site_worked_id", "work_type"]
            before = snapshot(assoc, fields)
            if r["site_id"]:
                assoc.site_worked_id = uuid.UUID(r["site_id"])
            if r["role_key"]:
                assoc.work_type = r["role_key"]
            assoc.updated_at = now
            audit(db, actor_id=actor_id, entity_type="initiative",
                  entity_id=str(initiative_id), action="person_update",
                  changes=diff(before, snapshot(assoc, fields)))
            result = "updated"
        elif action == "update":
            result = "skipped"
        else:
            result = action          # "unchanged" or "skipped"
        counts[result] += 1
        applied.append({"row": r["row"], "name": r["person_name"] or r["worker"],
                        "person_id": r["person_id"], "action": result,
                        "diff": r["diff"] if result in ("updated", "skipped") else None})

    job = await db.get(Initiative, initiative_id)
    job.updated_at = now
    audit(db, actor_id=actor_id, entity_type="initiative", entity_id=str(initiative_id),
          action="bulk_import", changes={**counts, "source": source_label})
    try:
        await db.commit()
    except IntegrityError:
        # a concurrent add of the same person beat us to initiative_people_uniq
        await db.rollback()
        raise BulkImportError("rows_invalid", reason="duplicate_worker") from None
    return {**counts, "rows": applied}


# ── templates / export ──────────────────────────────────────────────

def build_rows_csv(rows: list[dict]) -> str:
    return core.build_rows_csv(rows, COLUMNS)


def build_rows_xlsx(rows: list[dict], workers: list[str], sites: list[str],
                    roles: list[str]) -> bytes:
    return core.build_rows_xlsx(rows, COLUMNS, SHEET, [
        ("Workers", workers), ("Sites", sites), ("Roles", roles)])


def build_template_csv() -> str:
    return build_rows_csv(SAMPLE_ROWS)


async def _reference_lists(db: AsyncSession) -> tuple[list[str], list[str], list[str]]:
    workers = [_worker_label(p) for p, _ in (await db.execute(_worker_query())).all()]
    sites = list(await db.scalars(
        select(Site.name).where(Site.archived_at.is_(None)).order_by(Site.name)))
    roles = list(await db.scalars(
        select(StatusValue.label).where(StatusValue.record_type == WORK_TYPE,
                                        StatusValue.is_active.is_(True))
        .order_by(StatusValue.sort_order)))
    return workers, sites, roles


async def build_template_xlsx(db: AsyncSession) -> bytes:
    return build_rows_xlsx(SAMPLE_ROWS, *await _reference_lists(db))


async def export_rows(db: AsyncSession, initiative_id: uuid.UUID) -> list[dict]:
    """The job's current team in template shape, so an export re-uploads
    as all-unchanged."""
    site_names = {s.id: s.name for s in await db.scalars(select(Site))}
    role_labels = {r.key: r.label for r in await db.scalars(
        select(StatusValue).where(StatusValue.record_type == WORK_TYPE))}
    rows = (await db.execute(
        select(InitiativePerson, Person)
        .join(Person, Person.id == InitiativePerson.person_id)
        .where(InitiativePerson.initiative_id == initiative_id)
        .order_by(Person.last_name, Person.first_name))).all()
    return [{"worker": _worker_label(p),
             "site": site_names.get(tp.site_worked_id, "") if tp.site_worked_id else "",
             "role": role_labels.get(tp.work_type, "") if tp.work_type else ""}
            for tp, p in rows]


async def build_export_xlsx(db: AsyncSession, initiative_id: uuid.UUID) -> bytes:
    return build_rows_xlsx(await export_rows(db, initiative_id), *await _reference_lists(db))
