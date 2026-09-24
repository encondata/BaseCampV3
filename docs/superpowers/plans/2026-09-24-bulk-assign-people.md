# Bulk assign people to a job — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An admin picks a job, uploads `worker, site, role` rows, fixes unknown/ambiguous values with per-line dropdowns in the preview, and applies adds + approved updates in one transaction with the usual per-row summary.

**Architecture:** A service module `people/team_bulk.py` (parse → resolve → preview → commit) on the shared bulk core, four endpoints under `/initiatives/{id}/people/bulk/*`, and a portal page with a job picker plus a dedicated upload pane that re-previews with per-row overrides and skips.

**Tech Stack:** FastAPI + SQLAlchemy async, openpyxl (via `imports/bulk.py`), React + TypeScript + vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-24-bulk-assign-people-design.md`.

## Global Constraints

- Work ONLY in `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-assign` (branch `bulk-initiative-people`). Never cd to the main checkout. `.env`, `api/.venv`, `portal/node_modules` are symlinks — leave them.
- API tests: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/bulk-assign/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_bulk_assign /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest <files> -v` — FOREGROUND, one continuous command, timeout 600000 ms. Never background a run, never start a second pytest while one runs, never end a turn waiting on one.
- Portal tests: `cd …/bulk-assign/portal && npx vitest run <files>`; typecheck `npx tsc -b`.
- Columns exactly `worker`, `site`, `role`. Sheet name `Team`. Reference blocks titled `Workers`, `Sites`, `Roles`.
- Worker matching: live workers only (non-revoked `PersonRole(role="worker")`, `Person.archived_at IS NULL`), keys from `people.bulk_import.name_keys(first, last, preferred)`; the cell is squashed + casefolded the same way (`" ".join(text.split()).casefold()`).
- Site matching: non-archived sites by `name.casefold()`. Role matching: active `StatusValue(record_type="initiative_work_type")` by `key.casefold()` or `label.casefold()`.
- Blank `site`/`role` on an existing assignment = no change; on a new one = none. People on the job but not in the sheet are never touched.
- Row actions in the preview: `add`, `update`, `unchanged`, `attention`, `error`, `skipped`. Commit result actions: `created`, `updated`, `unchanged`, `skipped` (the names `BulkApplySummary` already renders).
- Row numbers: the file preview numbers spreadsheet lines from 2. Every later request (re-preview, commit) posts `rows` (the preview's `cells`) plus `row_numbers` so overrides, skips and approvals stay keyed to spreadsheet lines.
- Updates are approved per row number; unapproved updates are reported `skipped`. Approvals start unchecked.
- All four endpoints: `require_bulk_rank(actor)` and permission `initiatives:change`; job resolved via `_get_initiative` (scope → 404) then `_require_global`; archived job → 409 `initiative_archived`.
- Audit: per row `person_add` / `person_update` (entity_type `initiative`, entity_id the job), plus one `bulk_import` summary row.
- Error strings shown to users are sentences in American English. Ruff line length 100.
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit `api/src/serversherpa/_dev_reload.py`.

---

### Task 1: Service module — parse, resolve, preview, commit

**Files:**
- Create: `api/src/serversherpa/people/team_bulk.py`
- Test: `api/tests/test_team_bulk_service.py`

**Interfaces (produced, used by Task 2):**
```python
COLUMNS = ["worker", "site", "role"]; SHEET = "Team"; SAMPLE_ROWS: list[dict]
def number_json_rows(rows) -> list[tuple[int, dict]]
def number_posted_rows(rows, row_numbers) -> list[tuple[int, dict]]
def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]
def parse_overrides(raw) -> dict[int, dict[str, str]]
def parse_row_list(raw, code: str) -> set[int]
def build_rows_csv(rows) -> str
def build_rows_xlsx(rows, workers, sites, roles) -> bytes
def build_template_csv() -> str
async def build_template_xlsx(db) -> bytes
async def export_rows(db, initiative_id) -> list[dict]
async def build_export_xlsx(db, initiative_id) -> bytes
async def preview_rows(db, initiative_id, numbered, *, overrides=None, skip=None) -> dict
async def commit_rows(db, actor_id, initiative_id, numbered, *, overrides, skip,
                      approved_updates: set[int], source_label: str) -> dict
```

- [ ] **Step 1: Write the failing tests** — `api/tests/test_team_bulk_service.py`:

```python
"""Bulk assign people to a job (no HTTP): parse, resolve, preview, commit."""
from sqlalchemy import func, select

from serversherpa.db.models import (
    AuditLog, Initiative, InitiativePerson, Person, PersonRole, Site,
)
from serversherpa.imports.bulk import BulkImportError
from serversherpa.people import team_bulk as tb


async def mk_job(db, name="Move A", archived=False):
    job = Initiative(name=name, initiative_type="move",
                     archived_at=func.now() if archived else None)
    db.add(job)
    await db.commit()
    return job


async def mk_worker(db, first, last, preferred=None, email=None, role="worker",
                    archived=False, revoked=False):
    p = Person(first_name=first, last_name=last, preferred_name=preferred, email=email,
               archived_at=func.now() if archived else None)
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role=role,
                      revoked_at=func.now() if revoked else None))
    await db.commit()
    return p


async def mk_site(db, name, archived=False):
    s = Site(name=name, archived_at=func.now() if archived else None)
    db.add(s)
    await db.commit()
    return s


async def assign(db, job, person, site=None, role=None):
    db.add(InitiativePerson(initiative_id=job.id, person_id=person.id,
                            site_worked_id=site.id if site else None, work_type=role))
    await db.commit()


async def preview(db, job, rows, **kw):
    return await tb.preview_rows(db, job.id, tb.number_json_rows(rows), **kw)


async def commit(db, actor, job, rows, *, overrides=None, skip=(), approved=(),
                 source="team.csv"):
    return await tb.commit_rows(db, actor.id, job.id, tb.number_json_rows(rows),
                                overrides=overrides or {}, skip=set(skip),
                                approved_updates=set(approved), source_label=source)


def by_row(result):
    return {r["row"]: r for r in result["rows"]}


# ── shape / parsing ─────────────────────────────────────────────────

def test_columns_and_template_round_trip():
    assert tb.COLUMNS == ["worker", "site", "role"]
    from_csv = tb.parse_upload("t.csv", tb.build_template_csv().encode())
    assert [r for _, r in from_csv] == [r for _, r in tb.number_json_rows(tb.SAMPLE_ROWS)]
    assert [n for n, _ in from_csv] == [2, 3]


def test_number_posted_rows_keeps_spreadsheet_numbers():
    rows = [{"worker": "A B"}, {"worker": "C D"}]
    assert [n for n, _ in tb.number_posted_rows(rows, [5, 9])] == [5, 9]
    assert [n for n, _ in tb.number_posted_rows(rows, None)] == [1, 2]
    for bad in ([5], [5, 5], ["5", 9], "x"):
        try:
            tb.number_posted_rows(rows, bad)
        except BulkImportError as exc:
            assert exc.code == "invalid_row_numbers"
        else:
            raise AssertionError(bad)


def test_parse_overrides_and_row_lists():
    assert tb.parse_overrides({"3": {"worker": "abc", "role": "lead"}}) == {
        3: {"worker": "abc", "role": "lead"}}
    assert tb.parse_overrides(None) == {}
    for bad in ([], {"x": {}}, {"3": {"nope": "a"}}, {"3": {"worker": 7}}):
        try:
            tb.parse_overrides(bad)
        except BulkImportError as exc:
            assert exc.code == "invalid_overrides"
        else:
            raise AssertionError(bad)
    assert tb.parse_row_list([2, 3], "invalid_skip") == {2, 3}
    assert tb.parse_row_list(None, "invalid_skip") == set()


# ── preview ─────────────────────────────────────────────────────────

async def test_add_update_unchanged(db, seeded_user):
    job = await mk_job(db)
    east, west = await mk_site(db, "DC East"), await mk_site(db, "DC West")
    ana = await mk_worker(db, "Ana", "Lopez")
    ben = await mk_worker(db, "Ben", "Ng")
    cy = await mk_worker(db, "Cy", "Park")
    await assign(db, job, ben, east, "tech")
    await assign(db, job, cy, east, "tech")
    res = await preview(db, job, [
        {"worker": "ana lopez", "site": "DC West", "role": "Lead"},
        {"worker": "Ben  Ng", "site": "DC West", "role": ""},
        {"worker": "Cy Park", "site": "", "role": "TECH"},
    ])
    rows = by_row(res)
    assert rows[1]["action"] == "add" and rows[1]["person_id"] == str(ana.id)
    assert rows[1]["site_id"] == str(west.id) and rows[1]["role_key"] == "lead"
    assert rows[2]["action"] == "update"
    assert rows[2]["diff"] == {"site": {"old": "DC East", "new": "DC West"}}
    assert rows[3]["action"] == "unchanged"
    assert res["can_commit"] is True
    assert res["counts"] == {"add": 1, "update": 1, "unchanged": 1, "attention": 0,
                             "error": 0, "skipped": 0}


async def test_preferred_name_matches(db, seeded_user):
    job = await mk_job(db)
    await mk_worker(db, "Robert", "Stone", preferred="Bob")
    row = (await preview(db, job, [{"worker": "Bob Stone"}]))["rows"][0]
    assert row["action"] == "add"


async def test_unknown_and_ambiguous_need_attention(db, seeded_user):
    job = await mk_job(db)
    j1 = await mk_worker(db, "Jimmy", "Henderson", email="j1@x.test")
    j2 = await mk_worker(db, "Jimmy", "Henderson", email="j2@x.test")
    await mk_site(db, "Dup Site")
    await mk_site(db, "Dup Site")
    res = await preview(db, job, [
        {"worker": "Jimmy Henderson", "site": "Dup Site", "role": "wizard"},
        {"worker": "Nobody Here"},
    ])
    rows = by_row(res)
    assert rows[1]["action"] == "attention"
    kinds = {(i["field"], i["kind"]) for i in rows[1]["issues"]}
    assert kinds == {("worker", "ambiguous"), ("site", "ambiguous"), ("role", "unknown")}
    worker_issue = next(i for i in rows[1]["issues"] if i["field"] == "worker")
    assert {c["id"] for c in worker_issue["candidates"]} == {str(j1.id), str(j2.id)}
    assert {c["detail"] for c in worker_issue["candidates"]} == {"j1@x.test", "j2@x.test"}
    assert rows[2]["action"] == "attention"
    assert rows[2]["issues"] == [{"field": "worker", "kind": "unknown", "value": "Nobody Here",
                                  "candidates": []}]
    assert res["can_commit"] is False


async def test_archived_or_non_worker_people_do_not_match(db, seeded_user):
    job = await mk_job(db)
    await mk_worker(db, "Old", "Timer", archived=True)
    await mk_worker(db, "Ex", "Worker", revoked=True)
    await mk_worker(db, "Only", "Staff", role="staff")
    await mk_site(db, "Closed DC", archived=True)
    res = await preview(db, job, [{"worker": "Old Timer"}, {"worker": "Ex Worker"},
                                  {"worker": "Only Staff"},
                                  {"worker": "Old Timer", "site": "Closed DC"}])
    assert all(r["action"] == "attention" for r in res["rows"])


async def test_overrides_resolve_rows(db, seeded_user):
    job = await mk_job(db)
    j1 = await mk_worker(db, "Jimmy", "Henderson")
    await mk_worker(db, "Jimmy", "Henderson")
    site = await mk_site(db, "DC East")
    res = await preview(db, job, [{"worker": "Jimmy Henderson", "site": "DC Est", "role": "ld"}],
                        overrides={1: {"worker": str(j1.id), "site": str(site.id), "role": "lead"}})
    row = res["rows"][0]
    assert row["action"] == "add" and row["person_id"] == str(j1.id)
    assert row["site_id"] == str(site.id) and row["role_key"] == "lead"


async def test_bad_override_is_an_error(db, seeded_user):
    job = await mk_job(db)
    await mk_worker(db, "Ana", "Lopez")
    res = await preview(db, job, [{"worker": "Ana Lopez"}],
                        overrides={1: {"site": "00000000-0000-0000-0000-000000000000"}})
    assert res["rows"][0]["action"] == "error"
    assert "no longer exists" in res["rows"][0]["errors"][0]


async def test_duplicate_worker_in_file_including_via_override(db, seeded_user):
    job = await mk_job(db)
    ana = await mk_worker(db, "Ana", "Lopez")
    await mk_worker(db, "Ben", "Ng")
    res = await preview(db, job, [{"worker": "Ana Lopez"}, {"worker": "Ben Ng"},
                                  {"worker": "Typo Name"}],
                        overrides={3: {"worker": str(ana.id)}})
    rows = by_row(res)
    assert rows[1]["action"] == "error" and rows[3]["action"] == "error"
    assert "more than one row" in rows[1]["errors"][0]
    assert rows[2]["action"] == "add"


async def test_blank_worker_is_an_error_and_skip_wins(db, seeded_user):
    job = await mk_job(db)
    res = await preview(db, job, [{"site": "X"}, {"worker": "Nobody"}], skip={2})
    rows = by_row(res)
    assert rows[1]["action"] == "error" and rows[1]["errors"] == ["worker is required"]
    assert rows[2]["action"] == "skipped"


async def test_export_round_trips_as_unchanged(db, seeded_user):
    job = await mk_job(db)
    east = await mk_site(db, "DC East")
    ana = await mk_worker(db, "Ana", "Lopez")
    ben = await mk_worker(db, "Ben", "Ng")
    await assign(db, job, ana, east, "lead")
    await assign(db, job, ben)
    exported = await tb.export_rows(db, job.id)
    assert exported == [{"worker": "Ana Lopez", "site": "DC East", "role": "Lead"},
                        {"worker": "Ben Ng", "site": "", "role": ""}]
    res = await preview(db, job, exported)
    assert [r["action"] for r in res["rows"]] == ["unchanged", "unchanged"]


# ── commit ──────────────────────────────────────────────────────────

async def test_commit_adds_and_approved_updates_only(db, seeded_user):
    job = await mk_job(db)
    east, west = await mk_site(db, "DC East"), await mk_site(db, "DC West")
    ana = await mk_worker(db, "Ana", "Lopez")
    ben = await mk_worker(db, "Ben", "Ng")
    cy = await mk_worker(db, "Cy", "Park")
    await assign(db, job, ben, east, "tech")
    await assign(db, job, cy, east, "tech")
    rows = [{"worker": "Ana Lopez", "site": "DC West", "role": "lead"},
            {"worker": "Ben Ng", "site": "DC West"},
            {"worker": "Cy Park", "role": "lead"}]
    out = await commit(db, seeded_user, job, rows, approved={2})
    assert (out["created"], out["updated"], out["skipped"], out["unchanged"]) == (1, 1, 1, 0)
    assert [r["action"] for r in out["rows"]] == ["created", "updated", "skipped"]
    assert out["rows"][0]["name"] == "Ana Lopez"
    team = {tp.person_id: tp for tp in await db.scalars(
        select(InitiativePerson).where(InitiativePerson.initiative_id == job.id))}
    await db.refresh(team[ben.id])
    await db.refresh(team[cy.id])
    assert team[ana.id].site_worked_id == west.id and team[ana.id].work_type == "lead"
    assert team[ben.id].site_worked_id == west.id and team[ben.id].work_type == "tech"
    assert team[cy.id].work_type == "tech"      # not approved → untouched
    actions = [a.action for a in await db.scalars(
        select(AuditLog).where(AuditLog.entity_id == str(job.id)))]
    assert sorted(actions) == ["bulk_import", "person_add", "person_update"]


async def test_commit_refuses_unresolved_and_writes_nothing(db, seeded_user):
    job = await mk_job(db)
    await mk_worker(db, "Ana", "Lopez")
    try:
        await commit(db, seeded_user, job, [{"worker": "Ana Lopez"}, {"worker": "Nobody"}])
    except BulkImportError as exc:
        assert exc.code == "rows_invalid"
        assert {r["action"] for r in exc.extra["rows"]} == {"add", "attention"}
    else:
        raise AssertionError("expected rows_invalid")
    count = await db.scalar(select(func.count()).select_from(InitiativePerson))
    assert count == 0


async def test_commit_with_override_and_skip(db, seeded_user):
    job = await mk_job(db)
    ana = await mk_worker(db, "Ana", "Lopez")
    out = await commit(db, seeded_user, job,
                       [{"worker": "Anna Lopes"}, {"worker": "Nobody"}],
                       overrides={1: {"worker": str(ana.id)}}, skip={2})
    assert (out["created"], out["skipped"]) == (1, 1)
    assert await db.scalar(select(func.count()).select_from(InitiativePerson)) == 1
```

- [ ] **Step 2: Run to see it fail** — Global Constraints command with `tests/test_team_bulk_service.py`. Expected: `ImportError: cannot import name 'team_bulk'`.

- [ ] **Step 3: Implement** — `api/src/serversherpa/people/team_bulk.py`:

```python
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
```

Note: `_worker_query` is a private name in `people/bulk_import.py`; importing it is intentional reuse. If ruff flags the private import, rename it there to `worker_query` (updating its one internal caller) rather than duplicating the query.

`Person.phone` — confirm the attribute name on the model; if it differs, use the real one.

- [ ] **Step 4: Run** the Step 2 command. Expected: all pass. Fix the implementation, not the tests, unless a test contradicts the spec (report any such case).

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/people/team_bulk.py api/tests/test_team_bulk_service.py
git commit -m "feat(api): bulk assign people to a job — resolve, preview with overrides, commit"
```

---

### Task 2: Endpoints

**Files:**
- Modify: `api/src/serversherpa/api/routes/initiatives.py`
- Test: `api/tests/test_team_bulk_api.py`

**Interfaces (produced, used by Task 3):** `GET /initiatives/{id}/people/bulk/template?format=csv|xlsx`, `GET /initiatives/{id}/people/bulk/export?format=csv|xlsx`, `POST /initiatives/{id}/people/bulk/preview` (multipart `file`, or JSON `{rows, row_numbers?, overrides?, skip?}`), `POST /initiatives/{id}/people/bulk/commit` (JSON `{rows, row_numbers?, overrides?, skip?, approved_updates?, source?}`).

- [ ] **Step 1: Write the failing tests** — `api/tests/test_team_bulk_api.py`:

```python
"""Bulk assign people endpoints: gates, formats, preview, commit."""
import io

import openpyxl
import pytest
from sqlalchemy import func, select

from serversherpa.db.models import Initiative, InitiativePerson, Person, PersonRole
from serversherpa.people import team_bulk as tb
from tests.test_sites_api import login, make_login
from tests.test_team_bulk_service import mk_job, mk_site, mk_worker


@pytest.fixture
async def admin_hdrs(db, client):
    person = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return await make_login(db, client, person, "ada@test.example.com")


def base(job):
    return f"/initiatives/{job.id}/people/bulk"


async def test_staff_forbidden_on_all_four(client, db, seeded_user):
    job = await mk_job(db)
    hdrs = await login(client)
    assert (await client.get(f"{base(job)}/template?format=csv", headers=hdrs)).status_code == 403
    assert (await client.get(f"{base(job)}/export?format=csv", headers=hdrs)).status_code == 403
    assert (await client.post(f"{base(job)}/preview", headers=hdrs,
                              json={"rows": [{"worker": "X"}]})).status_code == 403
    assert (await client.post(f"{base(job)}/commit", headers=hdrs,
                              json={"rows": [{"worker": "X"}]})).status_code == 403


async def test_unknown_and_archived_job(client, db, seeded_user, admin_hdrs):
    missing = "00000000-0000-0000-0000-000000000000"
    resp = await client.post(f"/initiatives/{missing}/people/bulk/preview", headers=admin_hdrs,
                             json={"rows": [{"worker": "X"}]})
    assert resp.status_code == 404 and resp.json()["detail"]["code"] == "initiative_not_found"
    archived = await mk_job(db, "Old", archived=True)
    resp = await client.post(f"{base(archived)}/preview", headers=admin_hdrs,
                             json={"rows": [{"worker": "X"}]})
    assert resp.status_code == 409 and resp.json()["detail"]["code"] == "initiative_archived"


async def test_template_and_export_formats(client, db, seeded_user, admin_hdrs):
    job = await mk_job(db)
    await mk_site(db, "DC East")
    await mk_worker(db, "Ana", "Lopez")
    csv_resp = await client.get(f"{base(job)}/template?format=csv", headers=admin_hdrs)
    assert csv_resp.status_code == 200
    assert csv_resp.headers["content-disposition"] == 'attachment; filename="team-template.csv"'
    assert csv_resp.text.splitlines()[0] == "worker,site,role"
    xlsx = await client.get(f"{base(job)}/template?format=xlsx", headers=admin_hdrs)
    wb = openpyxl.load_workbook(io.BytesIO(xlsx.content))
    assert wb.sheetnames == ["Team", "Reference"]
    ref_values = [c.value for c in wb["Reference"]["A"] if c.value]
    assert "Workers" in ref_values and "Ana Lopez" in ref_values and "DC East" in ref_values
    assert "Lead" in ref_values
    exp = await client.get(f"{base(job)}/export?format=csv", headers=admin_hdrs)
    assert exp.status_code == 200 and exp.text.splitlines() == ["worker,site,role"]
    bad = await client.get(f"{base(job)}/template?format=pdf", headers=admin_hdrs)
    assert bad.status_code == 422


async def test_file_preview_then_json_commit_with_override(client, db, seeded_user, admin_hdrs):
    job = await mk_job(db)
    ana = await mk_worker(db, "Ana", "Lopez")
    csv = "worker,site,role\nAnna Lopes,,lead\nBen Nobody,,\n"
    resp = await client.post(f"{base(job)}/preview", headers=admin_hdrs,
                             files={"file": ("team.csv", csv.encode(), "text/csv")})
    assert resp.status_code == 200, resp.text
    rows = resp.json()["rows"]
    assert [r["row"] for r in rows] == [2, 3]
    assert [r["action"] for r in rows] == ["attention", "attention"]
    body = {"rows": [r["cells"] for r in rows], "row_numbers": [2, 3],
            "overrides": {"2": {"worker": str(ana.id)}}, "skip": [3]}
    again = await client.post(f"{base(job)}/preview", headers=admin_hdrs, json=body)
    assert [r["action"] for r in again.json()["rows"]] == ["add", "skipped"]
    assert again.json()["can_commit"] is True
    done = await client.post(f"{base(job)}/commit", headers=admin_hdrs,
                             json={**body, "approved_updates": [], "source": "team.csv"})
    assert done.status_code == 200, done.text
    out = done.json()
    assert (out["created"], out["skipped"]) == (1, 1)
    assert [r["row"] for r in out["rows"]] == [2, 3]
    assert await db.scalar(select(func.count()).select_from(InitiativePerson)) == 1


async def test_commit_unresolved_is_422_rows_invalid(client, db, seeded_user, admin_hdrs):
    job = await mk_job(db)
    resp = await client.post(f"{base(job)}/commit", headers=admin_hdrs,
                             json={"rows": [{"worker": "Nobody"}]})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "rows_invalid"


async def test_bad_bodies_are_422(client, db, seeded_user, admin_hdrs):
    job = await mk_job(db)
    for body, code in (
        ({"rows": [{"worker": "X"}], "row_numbers": [1, 2]}, "invalid_row_numbers"),
        ({"rows": [{"worker": "X"}], "overrides": {"1": {"bogus": "x"}}}, "invalid_overrides"),
        ({"rows": [{"worker": "X"}], "skip": "all"}, "invalid_skip"),
        ({"rows": [{"nope": "X"}]}, "unknown_columns"),
    ):
        resp = await client.post(f"{base(job)}/preview", headers=admin_hdrs, json=body)
        assert resp.status_code == 422 and resp.json()["detail"]["code"] == code, body
```

- [ ] **Step 2: Run to see it fail** — command with `tests/test_team_bulk_api.py`. Expected: 404s from the unknown paths.

- [ ] **Step 3: Implement** — in `api/src/serversherpa/api/routes/initiatives.py`:

Imports (add `Request` to the fastapi import):

```python
from serversherpa.api.bulk_routes import bulk_http_error, require_bulk_rank
from serversherpa.people import team_bulk
```

Place this block right after `add_initiative_person` (the paths have four segments, so ordering against `/{initiative_id}` does not matter):

```python
# ── bulk assign people to a job ─────────────────────────────────────

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _attachment(filename: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


async def _bulk_job(db: DbSession, initiative_id: uuid.UUID, actor: AuthContext) -> Initiative:
    require_bulk_rank(actor)
    job = await _get_initiative(db, initiative_id, actor)
    _require_global(actor)
    if job.archived_at is not None:
        raise _err(409, "initiative_archived")
    return job


async def _team_bulk_body(request: Request) -> tuple[list, dict, set, dict]:
    """(numbered rows, overrides, skip, raw body). Multipart = a first file
    preview (no picks yet); JSON = a re-preview or commit that re-posts the
    preview's cells with the spreadsheet row numbers."""
    try:
        if request.headers.get("content-type", "").startswith("multipart/"):
            form = await request.form()
            upload = form.get("file")
            if upload is None or isinstance(upload, str):
                raise team_bulk.BulkImportError("missing_file")
            numbered = team_bulk.parse_upload(upload.filename or "", await upload.read())
            return numbered, {}, set(), {}
        body = await request.json()
        if not isinstance(body, dict):
            raise team_bulk.BulkImportError("invalid_json")
        numbered = team_bulk.number_posted_rows(body.get("rows"), body.get("row_numbers"))
        overrides = team_bulk.parse_overrides(body.get("overrides"))
        skip = team_bulk.parse_row_list(body.get("skip"), "invalid_skip")
        return numbered, overrides, skip, body
    except team_bulk.BulkImportError as exc:
        raise bulk_http_error(exc) from None
    except ValueError:
        raise _err(422, "invalid_json") from None


@router.get("/{initiative_id}/people/bulk/template")
async def team_bulk_template(
    initiative_id: uuid.UUID, db: DbSession, format: str = "csv",
    actor: AuthContext = require_permission("initiatives", "change"),
):
    await _bulk_job(db, initiative_id, actor)
    if format == "csv":
        return Response(team_bulk.build_template_csv(), media_type="text/csv",
                        headers=_attachment("team-template.csv"))
    if format == "xlsx":
        return Response(await team_bulk.build_template_xlsx(db), media_type=_XLSX,
                        headers=_attachment("team-template.xlsx"))
    raise _err(422, "unknown_format")


@router.get("/{initiative_id}/people/bulk/export")
async def team_bulk_export(
    initiative_id: uuid.UUID, db: DbSession, format: str = "xlsx",
    actor: AuthContext = require_permission("initiatives", "change"),
):
    """The job's current team in the template layout — edit, re-upload."""
    await _bulk_job(db, initiative_id, actor)
    if format == "csv":
        rows = await team_bulk.export_rows(db, initiative_id)
        return Response(team_bulk.build_rows_csv(rows), media_type="text/csv",
                        headers=_attachment("team-export.csv"))
    if format == "xlsx":
        return Response(await team_bulk.build_export_xlsx(db, initiative_id),
                        media_type=_XLSX, headers=_attachment("team-export.xlsx"))
    raise _err(422, "unknown_format")


@router.post("/{initiative_id}/people/bulk/preview")
async def team_bulk_preview(
    initiative_id: uuid.UUID, request: Request, db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> dict:
    await _bulk_job(db, initiative_id, actor)
    numbered, overrides, skip, _ = await _team_bulk_body(request)
    return await team_bulk.preview_rows(db, initiative_id, numbered,
                                        overrides=overrides, skip=skip)


@router.post("/{initiative_id}/people/bulk/commit")
async def team_bulk_commit(
    initiative_id: uuid.UUID, request: Request, db: DbSession,
    actor: AuthContext = require_permission("initiatives", "change"),
) -> dict:
    await _bulk_job(db, initiative_id, actor)
    if not request.headers.get("content-type", "").startswith("application/json"):
        raise _err(422, "invalid_json")
    numbered, overrides, skip, body = await _team_bulk_body(request)
    try:
        approved = team_bulk.parse_row_list(body.get("approved_updates"), "invalid_approved")
        return await team_bulk.commit_rows(
            db, actor.person.id, initiative_id, numbered, overrides=overrides, skip=skip,
            approved_updates=approved, source_label=str(body.get("source") or "upload"))
    except team_bulk.BulkImportError as exc:
        raise bulk_http_error(exc) from None
```

`team_bulk.BulkImportError` is re-exported by the module's `from serversherpa.imports.bulk import BulkImportError`; keep that import there. The commit JSON content-type check: httpx `json=` sets `application/json`; FastAPI test clients do too.

- [ ] **Step 4: Run** `tests/test_team_bulk_api.py tests/test_team_bulk_service.py tests/test_initiatives_api.py tests/test_trucks_bulk_import_api.py` (if `test_initiatives_api.py` is named differently, use `ls tests | grep initiative`). Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add api/src/serversherpa/api/routes/initiatives.py api/tests/test_team_bulk_api.py
git commit -m "feat(api): /initiatives/{id}/people/bulk template, export, preview, commit"
```

---

### Task 3: Portal client, column guide, page, registry, route

**Files:**
- Modify: `portal/src/lib/api.ts` (append after the trucks bulk block, ~line 1415)
- Create: `portal/src/lib/teamBulk.ts`, `portal/src/lib/teamBulk.test.ts`
- Create: `portal/src/pages/BulkInitiativePeople.tsx`, `portal/src/pages/BulkInitiativePeople.test.tsx`
- Modify: `portal/src/pages/BulkActions.tsx` (`BULK_TOOLS`), `portal/src/pages/BulkActions.test.tsx`, `portal/src/App.tsx`

**Interfaces (produced, used by Task 4):**
```ts
export interface TeamBulkCandidate { id: string; label: string; detail: string }
export interface TeamBulkIssue { field: 'worker' | 'site' | 'role'; kind: 'unknown' | 'ambiguous'; value: string; candidates: TeamBulkCandidate[] }
export type TeamBulkAction = 'add' | 'update' | 'unchanged' | 'attention' | 'error' | 'skipped';
export interface TeamBulkRow { row: number; worker: string | null; person_id: string | null; person_name: string | null; site_id: string | null; site_name: string | null; role_key: string | null; role_label: string | null; action: TeamBulkAction; errors: string[]; issues: TeamBulkIssue[]; diff: BulkDiff | null; cells: Record<string, string> }
export interface TeamBulkPreview { rows: TeamBulkRow[]; counts: Record<TeamBulkAction, number>; can_commit: boolean }
export type TeamBulkOverrides = Record<string, Partial<Record<'worker' | 'site' | 'role', string>>>;
export interface TeamBulkPosted { rows: Record<string, string>[]; row_numbers: number[]; overrides: TeamBulkOverrides; skip: number[] }
export interface TeamBulkAppliedRow { row: number; name: string | null; person_id: string | null; action: 'created' | 'updated' | 'skipped' | 'unchanged'; diff: BulkDiff | null }
export interface TeamBulkCommitResult { created: number; updated: number; unchanged: number; skipped: number; rows: TeamBulkAppliedRow[] }
export async function previewTeamBulkFile(jobId: string, file: File | Blob, filename: string): Promise<TeamBulkPreview>
export async function previewTeamBulk(jobId: string, body: TeamBulkPosted): Promise<TeamBulkPreview>
export async function commitTeamBulk(jobId: string, body: TeamBulkPosted & { approved_updates: number[]; source: string }): Promise<TeamBulkCommitResult>
export function downloadTeamTemplate(jobId: string, format: 'csv' | 'xlsx'): Promise<void>
export function downloadTeamExport(jobId: string, format: 'csv' | 'xlsx'): Promise<void>
// lib/teamBulk.ts
export const TEAM_COLUMN_GUIDE: BulkColumnGuide[]; export const TEAM_BULK_ERRORS: Record<string, string>;
export function jobOptionLabel(job: InitiativeItem): string; export function jobOptionDetail(job: InitiativeItem): string;
```

- [ ] **Step 1: Write the failing tests.**

`portal/src/lib/teamBulk.test.ts`:

```ts
import { describe, expect, it } from 'vitest';

import { jobOptionDetail, TEAM_COLUMN_GUIDE, TEAM_BULK_ERRORS } from './teamBulk';

describe('team bulk guide', () => {
  it('lists exactly the API columns, worker required', () => {
    expect(TEAM_COLUMN_GUIDE.map((c) => c.key)).toEqual(['worker', 'site', 'role']);
    expect(TEAM_COLUMN_GUIDE.filter((c) => c.required).map((c) => c.key)).toEqual(['worker']);
  });
  it('maps the API error codes the page can hit', () => {
    for (const code of ['rows_invalid', 'initiative_archived', 'invalid_overrides',
      'invalid_row_numbers', 'unknown_columns', 'too_many_rows', 'forbidden']) {
      expect(TEAM_BULK_ERRORS[code]).toBeTruthy();
    }
  });
  it('describes a job so two same-named jobs are distinguishable', () => {
    const job = { type_label: 'Move', client_name: 'Acme', scheduled_start: '2026-10-01T00:00:00Z' };
    expect(jobOptionDetail(job as never)).toBe('Move · Acme · Oct 1, 2026');
    expect(jobOptionDetail({ type_label: 'Event', client_name: null, scheduled_start: null } as never)).toBe('Event');
  });
});
```

`portal/src/pages/BulkInitiativePeople.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(async () => [
    { id: 'j1', name: 'Dallas Move', type_label: 'Move', client_name: 'Acme',
      scheduled_start: '2026-10-01T00:00:00Z', archived_at: null },
    { id: 'j2', name: 'Dallas Move', type_label: 'Move', client_name: 'Beta',
      scheduled_start: null, archived_at: null },
    { id: 'j3', name: 'Old Job', type_label: 'Project', client_name: null,
      scheduled_start: null, archived_at: '2026-01-01T00:00:00Z' },
  ]),
  downloadTeamTemplate: vi.fn(async () => {}),
  downloadTeamExport: vi.fn(async () => {}),
}));
vi.mock('../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../lib/api')>()), ...api }));
vi.mock('../components/initiatives/TeamBulkUpload', () => ({
  default: ({ jobId }: { jobId: string }) => <div data-testid="pane">{jobId}</div>,
}));

const { default: BulkInitiativePeople } = await import('./BulkInitiativePeople');

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('downloads and the upload pane wait for a job; archived jobs are not offered', async () => {
  render(<MemoryRouter><BulkInitiativePeople /></MemoryRouter>);
  await waitFor(() => expect(api.listInitiatives).toHaveBeenCalled());
  const template = screen.getByRole('button', { name: 'Template (.xlsx)' }) as HTMLButtonElement;
  expect(template.disabled).toBe(true);
  expect(screen.queryByTestId('pane')).toBeNull();
  fireEvent.focus(screen.getByPlaceholderText(/pick a job/i));
  fireEvent.change(screen.getByPlaceholderText(/pick a job/i), { target: { value: 'Dallas' } });
  expect(await screen.findByText('Move · Acme · Oct 1, 2026')).toBeTruthy();
  expect(screen.getByText('Move · Beta')).toBeTruthy();
  expect(screen.queryByText('Old Job')).toBeNull();
  fireEvent.mouseDown(screen.getByText('Move · Acme · Oct 1, 2026'));
  await waitFor(() => expect(screen.getByTestId('pane').textContent).toBe('j1'));
  fireEvent.click(screen.getByRole('button', { name: 'Template (.xlsx)' }));
  await waitFor(() => expect(api.downloadTeamTemplate).toHaveBeenCalledWith('j1', 'xlsx'));
});
```

Add to `BulkActions.test.tsx` an assertion that a card titled "Assign people to a job" links to `/bulk/initiative-people` when the user can `initiatives:change` (follow that file's existing mock of `useAuth().can`).

Note: `ComboBox` selects on **mousedown** (not click) — see memory "ComboBox selects on mousedown". Option secondary text is `ComboOption.sub`.

- [ ] **Step 2: Run to see them fail** — `npx vitest run src/lib/teamBulk.test.ts src/pages/BulkInitiativePeople.test.tsx src/pages/BulkActions.test.tsx`.

- [ ] **Step 3: Implement.**

`portal/src/lib/api.ts` (after `downloadTruckExport`):

```ts
// ── bulk assign people to a job ─────────────────────────────────────

export interface TeamBulkCandidate { id: string; label: string; detail: string }
export interface TeamBulkIssue {
  field: 'worker' | 'site' | 'role';
  kind: 'unknown' | 'ambiguous';
  value: string;
  candidates: TeamBulkCandidate[];
}
export type TeamBulkAction = 'add' | 'update' | 'unchanged' | 'attention' | 'error' | 'skipped';
export interface TeamBulkRow {
  row: number;
  worker: string | null;
  person_id: string | null; person_name: string | null;
  site_id: string | null; site_name: string | null;
  role_key: string | null; role_label: string | null;
  action: TeamBulkAction;
  errors: string[];
  issues: TeamBulkIssue[];
  diff: BulkDiff | null;
  cells: Record<string, string>;
}
export interface TeamBulkPreview {
  rows: TeamBulkRow[];
  counts: Record<TeamBulkAction, number>;
  can_commit: boolean;
}
export type TeamBulkOverrides = Record<string, Partial<Record<'worker' | 'site' | 'role', string>>>;
export interface TeamBulkPosted {
  rows: Record<string, string>[];
  row_numbers: number[];
  overrides: TeamBulkOverrides;
  skip: number[];
}
export interface TeamBulkAppliedRow {
  row: number;
  name: string | null;
  person_id: string | null;
  action: 'created' | 'updated' | 'skipped' | 'unchanged';
  diff: BulkDiff | null;
}
export interface TeamBulkCommitResult {
  created: number; updated: number; unchanged: number; skipped: number;
  rows: TeamBulkAppliedRow[];
}

const teamBulkBase = (jobId: string) => `/initiatives/${jobId}/people/bulk`;

export async function previewTeamBulkFile(
  jobId: string, file: File | Blob, filename: string,
): Promise<TeamBulkPreview> {
  const fd = new FormData();
  fd.append('file', file, filename);
  const resp = await apiFetch(`${teamBulkBase(jobId)}/preview`, { method: 'POST', body: fd });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function previewTeamBulk(jobId: string, body: TeamBulkPosted): Promise<TeamBulkPreview> {
  const resp = await apiFetch(`${teamBulkBase(jobId)}/preview`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function commitTeamBulk(
  jobId: string, body: TeamBulkPosted & { approved_updates: number[]; source: string },
): Promise<TeamBulkCommitResult> {
  const resp = await apiFetch(`${teamBulkBase(jobId)}/commit`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export function downloadTeamTemplate(jobId: string, format: 'csv' | 'xlsx'): Promise<void> {
  return downloadAttachment(`${teamBulkBase(jobId)}/template?format=${format}`, `team-template.${format}`);
}

export function downloadTeamExport(jobId: string, format: 'csv' | 'xlsx'): Promise<void> {
  return downloadAttachment(`${teamBulkBase(jobId)}/export?format=${format}`, `team-export.${format}`);
}
```

`InitiativeItem` has no `archived_at`, and `GET /initiatives` already excludes archived jobs unless asked (verify with `grep -n archived api/src/serversherpa/api/routes/initiatives.py` near line 341). So the page does NOT filter: drop the `.filter(...)` in the page, and in the page test remove the `j3` archived mock row and its `queryByText('Old Job')` assertion.

`portal/src/lib/teamBulk.ts`:

```ts
/** What each bulk-assign column accepts. Keys mirror the API's
 *  people/team_bulk.py COLUMNS — the service test pins that list, the test
 *  beside this file pins this one, and the two must agree. */
import type { BulkColumnGuide } from '../components/bulk/BulkToolPage';
import type { InitiativeItem } from './api';
import { longDate } from './format';

export const TEAM_COLUMN_GUIDE: BulkColumnGuide[] = [
  { key: 'worker', required: true, accepts: 'A worker\'s name, first and last (or preferred and last). Case does not matter. Unknown or shared names can be matched in the preview.', example: 'Marcus Reyes' },
  { key: 'site', required: false, accepts: 'The site they worked, by name, from the Reference sheet. Blank keeps an existing assignment\'s site.', example: 'Example DC West' },
  { key: 'role', required: false, accepts: 'The role they performed: lead, tech, cabling, logistics, or other (name or key). Blank keeps an existing assignment\'s role.', example: 'lead' },
];

export const TEAM_BULK_ERRORS: Record<string, string> = {
  unknown_columns: 'The file has columns that are not in the template (worker, site, role).',
  too_many_rows: 'Too many rows — the limit is 1,000 per upload.',
  file_too_large: 'File too large — the limit is 5 MB.',
  invalid_json: 'The server could not read the rows — preview again.',
  invalid_csv: 'That CSV could not be read.',
  invalid_xlsx: 'That spreadsheet could not be read.',
  unsupported_file: 'Unsupported file type — use .csv or .xlsx.',
  missing_file: 'Choose a file first.',
  invalid_row_numbers: 'The preview is out of date — upload the file again.',
  invalid_overrides: 'The preview is out of date — upload the file again.',
  invalid_skip: 'The preview is out of date — upload the file again.',
  invalid_approved: 'The preview is out of date — upload the file again.',
  rows_invalid: 'Some rows still need attention — resolve or skip them and try again.',
  initiative_archived: 'That job is archived — unarchive it first.',
  initiative_not_found: 'That job no longer exists.',
  forbidden: 'You do not have permission to bulk assign people.',
};

export function jobOptionLabel(job: InitiativeItem): string {
  return job.name;
}

/** Type · client · start date — enough to tell two same-named jobs apart. */
export function jobOptionDetail(job: Pick<InitiativeItem, 'type_label' | 'client_name' | 'scheduled_start'>): string {
  return [job.type_label, job.client_name, job.scheduled_start ? longDate(job.scheduled_start) : null]
    .filter(Boolean).join(' · ');
}
```

Check `longDate`'s output format for `2026-10-01T00:00:00Z` (date-only fields are midnight UTC — see memory "Date-only fields": use the helper the initiatives list uses for `scheduled_start`, e.g. a `parseApiDay`-based formatter, so the day does not shift). Adjust the expected string in the test to whatever that helper returns for Oct 1, 2026 as long as it shows Oct 1.

`portal/src/pages/BulkInitiativePeople.tsx`:

```tsx
/**
 * BulkInitiativePeople — /bulk/initiative-people: pick a job, then upload
 * worker / site / role rows. The shared page shell, a job picker, and the
 * TeamBulkUpload pane (per-line matching of unknown values).
 */
import { useEffect, useMemo, useState } from 'react';

import BulkToolPage from '../components/bulk/BulkToolPage';
import ComboBox, { type ComboOption } from '../components/ComboBox';
import TeamBulkUpload from '../components/initiatives/TeamBulkUpload';
import {
  downloadTeamExport, downloadTeamTemplate, listInitiatives, type InitiativeItem,
} from '../lib/api';
import { jobOptionDetail, jobOptionLabel, TEAM_COLUMN_GUIDE } from '../lib/teamBulk';

export default function BulkInitiativePeople() {
  const [jobs, setJobs] = useState<InitiativeItem[] | null>(null);
  const [jobId, setJobId] = useState('');
  const [loadError, setLoadError] = useState('');

  useEffect(() => {
    listInitiatives()
      .then(setJobs)
      .catch(() => setLoadError('Could not load jobs — refresh to try again.'));
  }, []);

  const options: ComboOption[] = useMemo(() => (jobs ?? []).map((j) => ({
    value: j.id, label: jobOptionLabel(j), sub: jobOptionDetail(j),
  })), [jobs]);

  const needJob = async (fn: (id: string) => Promise<void>) => { if (jobId) await fn(jobId); };
  const noJob = !jobId;

  return (
    <BulkToolPage
      title="Assign people to a job"
      hint={<>
        Pick the job, then download the template or its current team, fill in who worked, where, and in what role, and upload it.
        New names are added; people already on the job are updated only where you tick Update. Nobody is removed.
        Names the system cannot match can be picked from a list in the preview.
      </>}
      guide={TEAM_COLUMN_GUIDE}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: () => needJob((id) => downloadTeamTemplate(id, 'xlsx')), disabled: noJob },
        { key: 't-csv', label: 'Template (.csv)', run: () => needJob((id) => downloadTeamTemplate(id, 'csv')), disabled: noJob },
        { key: 'e-xlsx', label: 'Current team (.xlsx)', run: () => needJob((id) => downloadTeamExport(id, 'xlsx')), accent: true, disabled: noJob },
        { key: 'e-csv', label: 'Current team (.csv)', run: () => needJob((id) => downloadTeamExport(id, 'csv')), accent: true, disabled: noJob },
      ]}
      beforeDownloads={
        <div className="bulk-job-picker">
          <label htmlFor="bulk-job">Job</label>
          <ComboBox inputId="bulk-job" ariaLabel="Job" options={options} value={jobId}
                    placeholder="Pick a job…" onChange={setJobId} />
          {loadError && <p className="pf-error">{loadError}</p>}
        </div>
      }
    >
      {jobId ? <TeamBulkUpload key={jobId} jobId={jobId} /> : <p className="set-note">Pick a job to upload a team.</p>}
    </BulkToolPage>
  );
}
```

`BulkToolPage` changes (small, backward compatible): `BulkDownload` gains `disabled?: boolean` (button `disabled={!!busy || !!d.disabled}`), and `Props` gains `beforeDownloads?: ReactNode` rendered as its own `bulk-section` (eyebrow "Job") right before the Download section. `ComboOption` is `{ value, label, sub? }` — `sub` is the secondary line (check how the menu renders it and query it by text in the tests). `ComboBox` has no `inputId`/`ariaLabel` props today: add both as optional props applied to its `<input>` (`id={inputId}`, `aria-label={ariaLabel}`); every existing caller is unaffected. Task 4's per-line pickers use `ariaLabel`.

`BulkActions.tsx` `BULK_TOOLS` — append:

```ts
  {
    key: 'initiative-people', title: 'Assign people to a job',
    description: 'Pick a job and upload who worked it, where, and in what role. Add new people and update existing ones; unmatched names are picked from a list.',
    resource: 'initiatives', action: 'change', to: '/bulk/initiative-people', button: 'Open',
  },
```

`App.tsx` — import `BulkInitiativePeople` next to `BulkTrucks` and add after the trucks route:

```tsx
                <Route path="/bulk/initiative-people" element={
                  <ProtectedRoute resource="initiatives" minRank={ADMIN_RANK}><BulkInitiativePeople /></ProtectedRoute>
                } />
```

Task 3 needs a stub pane so the page compiles before Task 4: create `portal/src/components/initiatives/TeamBulkUpload.tsx` with `export default function TeamBulkUpload({ jobId }: { jobId: string }) { return <div className="bulk-import" data-job={jobId} />; }` — Task 4 replaces it.

- [ ] **Step 4: Run** the Step 2 files plus `npx tsc -b`. Expected: green.

- [ ] **Step 5: Commit**

```bash
git add portal/src/lib/api.ts portal/src/lib/teamBulk.ts portal/src/lib/teamBulk.test.ts portal/src/pages/BulkInitiativePeople.tsx portal/src/pages/BulkInitiativePeople.test.tsx portal/src/pages/BulkActions.tsx portal/src/pages/BulkActions.test.tsx portal/src/App.tsx portal/src/components/bulk/BulkToolPage.tsx portal/src/components/initiatives/TeamBulkUpload.tsx
git commit -m "feat(portal): Assign people to a job — bulk page with job picker, client calls, Bulk Actions card"
```

---

### Task 4: The upload pane — preview, per-line matching, skip, approve, apply

**Files:**
- Replace: `portal/src/components/initiatives/TeamBulkUpload.tsx`
- Create: `portal/src/components/initiatives/TeamBulkUpload.test.tsx`
- Modify: `portal/src/styles/bulk.css` (only if a class below has no rule — reuse existing `bulk-row-*`, `bulk-diff`, `bulk-actions`, `bulk-file-row`, `set-note`, `pf-error`)

**Interfaces:** consumes Task 3's client functions and types; `BulkApplySummary` from `components/bulk/BulkApplySummary`; `describeDiff` from `components/bulk/BulkUpload`; `ComboBox` and `listWorkerOptions` / `listSites`-style option loaders already used elsewhere (read `components/ComboBox.tsx` and find the site options loader with `grep -n "export async function list.*Site" portal/src/lib/api.ts`).

Behavior:
1. File input + **Preview** → `previewTeamBulkFile(jobId, file, file.name)`. Store the returned rows as the **base**: `cells` and `row_numbers` (the row numbers from the response), and reset `overrides = {}`, `skip = new Set()`, `approved = new Set()`.
2. Table columns: Row, Worker (cell text, then "→ matched name" when it differs), Site, Role, Status (chip: Add / Update / Skip (unapproved update) / No change / Needs a match / Error / Skipped), Details.
3. `attention` row Details: for each issue a `ComboBox` labeled `"Match {field} for row {n}"`. Options: the issue's candidates first (label + detail), then — only for `unknown` — the full list for that field: workers from `listWorkerOptions()` (`{person_id, display_name}` — label `display_name`, no sub), sites from the site list (non-archived), roles from the preview's known role values (fetch once with the same loader the initiative detail page uses for work types; grep `work_type` in `lib/api.ts`). Loaded lazily the first time any `attention` row renders. Picking sets `overrides[row][field] = id` and re-previews via JSON.
4. Every `attention` and `error` row has a **Skip** checkbox (`"Skip row {n}"`); toggling updates `skip` and re-previews. Skipped rows show an **Undo skip** checkbox (same label pattern, checked).
5. `update` rows: diff lines via `describeDiff` + an **Update** checkbox (`"Update row {n}"`), unchecked by default; toggling only changes local `approved` (no re-preview). "Update all" / "Skip all" buttons when there are updates, same as `BulkUpload`.
6. Re-preview (`previewTeamBulk(jobId, {rows: base.cells, row_numbers: base.rows, overrides, skip: [...skip]})`) replaces the preview; `approved` keeps only rows that are still `update`.
7. Summary line: `"{add} to add · {updating} to update · {skipping} to skip · {unchanged} unchanged · {attention} need a match · {errors} errors"` (plural-aware like `BulkUpload`).
8. **Apply** button text `"Add {n} and update {m}"`, enabled when `preview.can_commit` and (`add > 0` or `updating > 0`). Calls `commitTeamBulk(jobId, {rows, row_numbers, overrides, skip, approved_updates: [...approved], source: file.name})`. On success render `BulkApplySummary` with `entityLabel="Worker"`, `linkFor={() => \`/initiatives/${jobId}\`}` (the job detail page route — confirm with `grep -n "path=\"/initiatives/:" portal/src/App.tsx` and use the team tab path if one exists), `filename="team-bulk-summary"`, `openTo={\`/initiatives/${jobId}\`}`, `openLabel="Open the job"`, then clear file/preview. On error map through `TEAM_BULK_ERRORS` and drop the preview (force re-preview), exactly like `BulkUpload`.
9. The preview table follows the list-column-floors convention if it is a `.dir-list`; if it uses `DataTable` like `BulkUpload`, keep `DataTable` (`ariaLabel="Team preview"`, `className="bulk-preview"`) — `DataTable` already scrolls sideways.

- [ ] **Step 1: Write the failing tests** — `portal/src/components/initiatives/TeamBulkUpload.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { TeamBulkPreview, TeamBulkRow } from '../../lib/api';

function row(n: number, over: Partial<TeamBulkRow>): TeamBulkRow {
  return {
    row: n, worker: `W${n}`, person_id: null, person_name: null, site_id: null, site_name: null,
    role_key: null, role_label: null, action: 'add', errors: [], issues: [], diff: null,
    cells: { worker: `W${n}`, site: '', role: '' }, ...over,
  };
}
function preview(rows: TeamBulkRow[]): TeamBulkPreview {
  const counts = { add: 0, update: 0, unchanged: 0, attention: 0, error: 0, skipped: 0 };
  rows.forEach((r) => { counts[r.action] += 1; });
  return { rows, counts, can_commit: counts.attention === 0 && counts.error === 0 };
}

const api = vi.hoisted(() => ({
  previewTeamBulkFile: vi.fn(),
  previewTeamBulk: vi.fn(),
  commitTeamBulk: vi.fn(),
  listWorkerOptions: vi.fn(async () => [{ person_id: 'p9', display_name: 'Zed Zulu' }]),
}));
vi.mock('../../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../../lib/api')>()), ...api }));

const { default: TeamBulkUpload } = await import('./TeamBulkUpload');

beforeEach(() => {
  api.previewTeamBulkFile.mockResolvedValue(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez', worker: 'ana lopez' }),
    row(3, { action: 'attention', worker: 'Jimmy Henderson', issues: [{
      field: 'worker', kind: 'ambiguous', value: 'Jimmy Henderson',
      candidates: [{ id: 'j1', label: 'Jimmy Henderson', detail: 'j1@x.test' },
                   { id: 'j2', label: 'Jimmy Henderson', detail: 'j2@x.test' }] }] }),
    row(4, { action: 'update', person_id: 'p4', person_name: 'Ben Ng',
             diff: { site: { old: 'DC East', new: 'DC West' } } }),
  ]));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function upload() {
  render(<MemoryRouter><TeamBulkUpload jobId="job1" /></MemoryRouter>);
  const input = screen.getByLabelText(/upload a file/i) as HTMLInputElement;
  fireEvent.change(input, { target: { files: [new File(['x'], 'team.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText('Needs a match');
}

it('picking a candidate re-previews with the override and enables Apply', async () => {
  await upload();
  const apply = screen.getByRole('button', { name: /^Add 1 and update 0/ }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  api.previewTeamBulk.mockResolvedValue(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez' }),
    row(3, { action: 'add', person_id: 'j2', person_name: 'Jimmy Henderson' }),
    row(4, { action: 'update', person_id: 'p4', person_name: 'Ben Ng',
             diff: { site: { old: 'DC East', new: 'DC West' } } }),
  ]));
  const picker = screen.getByLabelText('Match worker for row 3');
  fireEvent.focus(picker);
  fireEvent.mouseDown(await screen.findByText('j2@x.test'));
  await waitFor(() => expect(api.previewTeamBulk).toHaveBeenCalledWith('job1', {
    rows: [{ worker: 'W2', site: '', role: '' }, { worker: 'W3', site: '', role: '' },
           { worker: 'W4', site: '', role: '' }],
    row_numbers: [2, 3, 4], overrides: { 3: { worker: 'j2' } }, skip: [] }));
  await waitFor(() => expect((screen.getByRole('button', { name: /^Add 2 and update 0/ }) as HTMLButtonElement).disabled).toBe(false));
});

it('skip re-previews; approve is local; apply posts everything and shows the summary', async () => {
  await upload();
  api.previewTeamBulk.mockResolvedValue(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez' }),
    row(3, { action: 'skipped' }),
    row(4, { action: 'update', person_id: 'p4', person_name: 'Ben Ng',
             diff: { site: { old: 'DC East', new: 'DC West' } } }),
  ]));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  await waitFor(() => expect(api.previewTeamBulk).toHaveBeenLastCalledWith('job1',
    expect.objectContaining({ skip: [3], overrides: {} })));
  const callsBefore = api.previewTeamBulk.mock.calls.length;
  fireEvent.click(await screen.findByLabelText('Update row 4'));
  expect(api.previewTeamBulk.mock.calls.length).toBe(callsBefore);
  api.commitTeamBulk.mockResolvedValue({
    created: 1, updated: 1, unchanged: 0, skipped: 1,
    rows: [{ row: 2, name: 'Ana Lopez', person_id: 'p1', action: 'created', diff: null },
           { row: 3, name: 'W3', person_id: null, action: 'skipped', diff: null },
           { row: 4, name: 'Ben Ng', person_id: 'p4', action: 'updated',
             diff: { site: { old: 'DC East', new: 'DC West' } } }],
  });
  fireEvent.click(screen.getByRole('button', { name: /^Add 1 and update 1/ }));
  await waitFor(() => expect(api.commitTeamBulk).toHaveBeenCalledWith('job1', expect.objectContaining({
    row_numbers: [2, 3, 4], skip: [3], approved_updates: [4], source: 'team.csv' })));
  const summary = await screen.findByRole('table', { name: /applied|summary/i });
  expect(within(summary).getByText('Ana Lopez')).toBeTruthy();
});

it('an API error is shown and forces a fresh preview', async () => {
  await upload();
  api.previewTeamBulk.mockResolvedValue(preview([
    row(2, { action: 'add', person_id: 'p1', person_name: 'Ana Lopez' }),
    row(3, { action: 'skipped' }),
    row(4, { action: 'unchanged', person_id: 'p4', person_name: 'Ben Ng' }),
  ]));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  const { ApiError } = await import('../../lib/api');
  api.commitTeamBulk.mockRejectedValue(new ApiError(422, 'rows_invalid'));
  fireEvent.click(await screen.findByRole('button', { name: /^Add 1 and update 0/ }));
  expect(await screen.findByText(/still need attention/i)).toBeTruthy();
  expect(screen.queryByText('Needs a match')).toBeNull();
});
```

Adapt to reality, not the other way round: check `ApiError`'s constructor signature, the accessible name `BulkApplySummary` gives its table (read the component; if it is not "applied"/"summary", query its heading instead), and how `ComboBox` exposes its input (`aria-label` prop name) and option detail. Keep every assertion's intent.

- [ ] **Step 2: Run to see it fail** — `npx vitest run src/components/initiatives/TeamBulkUpload.test.tsx`.

- [ ] **Step 3: Implement** `TeamBulkUpload.tsx` to the behavior list above. Keep it under ~350 lines; if the row-details rendering grows past that, split a `TeamBulkRowDetails` component into the same folder. Mirror `BulkUpload.tsx` for file input, busy/error handling, the `plural` helper (import or copy the two-line helper) and `ACTION_LABEL`-style status text.

- [ ] **Step 4: Run** the test file, then the full portal suite `npx vitest run`, `npx tsc -b`, `npm run build`. Expected: green.

- [ ] **Step 5: Commit**

```bash
git add portal/src/components/initiatives/TeamBulkUpload.tsx portal/src/components/initiatives/TeamBulkUpload.test.tsx portal/src/styles/bulk.css
git commit -m "feat(portal): team bulk upload pane — per-line matching, skip, approve, apply summary"
```

---

### Task 5: Full suites, live verification, parity sheet (controller)

- [ ] Full API suite (foreground, 600000 ms; ~22 min) and full portal suite + build.
- [ ] Live verify on the worktree stack (API 8001, portal 5175 via temporary launch entries as in memory "two-factor-auth" live-verify recipe): pick a job, download current team, upload a sheet with one unknown name, one ambiguous name (the dev DB's two Jimmy Hendersons), one site change; resolve via dropdowns, skip one, approve the update, apply; confirm the job's team table and the summary CSV. Remove the temporary launch entries afterwards.
- [ ] Sheet: Feature Parity "Bulk assign people to jobs" → Complete with a COMPLETE note; "Import jobs in bulk" → Retired with a note (V2's never worked; jobs are created in the portal); same on Gaps; To-Do #7 status → done with both notes; Summary counts recomputed.
