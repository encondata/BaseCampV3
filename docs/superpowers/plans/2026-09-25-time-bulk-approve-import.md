# Bulk time approval and punch import — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Approve or reject many Timesheet entries at once (ticked rows, or every pending entry the filters match), and add shifts in bulk from a spreadsheet through a seventh Bulk Actions tool, "Add time punches in bulk" (`/bulk/time`).

**Architecture:** Two new endpoints in `api/routes/time.py` (`POST /time/entries/approve`, `POST /time/entries/reject`) share the Timesheet's filter code with `GET /time/entries` and the single-row approve/reject mutation and audit code. The import is `people/time_parse.py` (pure clock/zone parsing) plus `people/time_bulk.py` (parse → match → preview → commit, mirroring `people/team_bulk.py`) behind three routes in a new `api/routes/time_bulk.py`. The commit re-runs the preview under a table lock on `time_entries`, so it is all-or-nothing and no concurrent punch can slip in an overlap. The portal gets a server-side filter row, checkboxes, a bulk bar and a header-pattern dialog on the Timesheet, and a new Bulk Actions page that copies the job-team tool's layout.

**Tech Stack:** FastAPI, SQLAlchemy async (Postgres), zoneinfo, openpyxl (via `imports/bulk.py`), React + TypeScript, vitest + Testing Library.

**Spec:** `docs/superpowers/specs/2026-09-25-time-bulk-approve-import-design.md`. It is binding. Read it once before starting; this plan resolves its open points in "Decisions this plan makes" below.

## Global Constraints

- **Worktree:** `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk` (branch `time-bulk`). Never cd to the main checkout. `.env`, `api/.venv` and `portal/node_modules` are symlinks.
- **API tests:** `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_time_bulk /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest <files> -v`
  - Run them FOREGROUND, as one continuous command with timeout 600000 ms.
  - Never background a run, never start a second pytest, and never end a turn waiting on one.
  - Reviewers use `SS_TEST_DB=serversherpa_test_time_bulk_rv`.
- **Portal:** `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/portal && npx vitest run <files>`, then `npx tsc -b`, then `npm run build`.
- **No migration.** `time_entries.source` is plain text; imported entries use `source="import"`, `status="pending"`.
- **Bulk approve and reject:**
  - Gate: `time:change`.
  - Same per-entry rules as single-row: the entry must be pending, and not the actor's own.
  - Cap: 5,000 entries per call, else 422 `too_many`.
  - One transaction, with one audit row per entry.
- **Punch import:**
  - Gate: `require_bulk_rank` + `time:add` + global.
  - Route: `/bulk/time`. Card title: "Add time punches in bulk".
  - Limit: 5,000 rows / 5 MB.
  - Columns exactly: `worker, clock_in, clock_out, break_minutes, job, site, notes`.
- **Time zone:** an explicit offset is used as written. Otherwise use the row's site timezone (the matched or picked site, else the job's site). Otherwise use `DEFAULT_TIMEZONE` America/New_York. DST: `zoneinfo` with fold=0.
- **Row errors:**
  - missing fields;
  - unreadable time;
  - out ≤ in;
  - more than 24 h;
  - future clock-in;
  - break ≥ shift, or a negative or non-number break;
  - overlap with an existing entry (open entries overlap everything after their in; rejected entries are ignored);
  - overlap with another row in the file.
- **Duplicates:** an exact repeat (same worker, same in and out to the minute) becomes the `duplicate` action and is skipped.
- **Layout:** the portal layout must match the other Bulk Actions tools exactly.
  - Preview columns: Row / Name / Matched by / Action / Details, with `bulk-row-*` tinting.
  - Pickers and Skip go inside Details.
  - Buttons: "Skip all unmatched" and "Add N shifts".
  - The page ends with `BulkApplySummary` plus its CSV.
  - Reuse the house idioms: `pf-form`, `ComboBox` (never raw selects), `DataTable`, `mini-btn`, `set-note`.
- **Copy:** user-facing strings are sentences in American English. Ruff line length 100.
- **Commits:** trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never commit `api/src/serversherpa/_dev_reload.py`.

Also implied by the spec, and binding for every task:

- **Bulk endpoints:** `POST /time/entries/approve` takes `{entry_ids}` or `{filter: {person_id?, initiative_id?, site_id?, from?, to?}}`, exactly one (else 422 `ids_or_filter`), and `?dry_run=1` returns `{count}`. Otherwise it returns `{approved, skipped: [{entry_id, person, date, reason}]}`. `POST /time/entries/reject` takes `{entry_ids, reason}`; a blank reason is 422 `reason_required`; it returns `{rejected, skipped}`.
- **Skip reasons, verbatim:** `"not found"`, `"your own entry"`, `"no longer pending"`. A filter always means pending entries only.
- **Bulk audit:** one `entity_type="time_entry"`, `action="update"` row per entry, with the single-row route's diff (approve: `status, approved_by, approved_at`; reject: `status, reject_reason`).
- **Import routes:** `GET /time/bulk/template?format=csv|xlsx`, `POST /time/bulk/preview` (multipart `file`, or JSON `{rows, row_numbers, overrides, skip}`), `POST /time/bulk/commit` (JSON, same body plus `source`). Commit returns `{summary: {added, skipped}, rows: [{row, name, entry_id, action, detail}]}`, or 422 `rows_invalid` with the offending `rows`.
- **Preview actions:** `add`, `duplicate`, `attention`, `error`, `skipped`. `can_commit` = no `attention`/`error` rows and at least one `add`.
- **Import audit:** per entry `action="import"`, `changes={"status": {"from": None, "to": "pending"}}`; one `action="bulk_import"` row, `entity_type="time_entry"`, `entity_id=None`, `changes={"added", "skipped", "source"}`.
- **Portal copy, verbatim:** "Approve all pending in this view"; "Approve 214 pending entries that match these filters?"; "More than 5,000 entries match. Narrow the filters and try again."; "Approved 212 entries. Skipped 2: your own entry (1), no longer pending (1)."; "Show skipped"; the card description "Load shifts from a spreadsheet or another timekeeping system. Workers, jobs, and sites are matched by name; review every shift before adding."; the duplicate row reads "Already there".
- **Guardrail:** `portal/src/styles/listTypography.test.ts` treats every `.time-*` selector in `time.css` as list-ish (the `.time-row-static` family prefix). Never put `font-*`, `line-height` or `min-height` on a `.time-*` selector; reuse `.audit-toolbar` (profile.css) for the date inputs' look.

## Decisions this plan makes where the spec is silent

1. **Timesheet filters.** The Timesheet today has no server-side person, job, site or date filters. It has the status pill, client-side column filters and search, and a 500-row cap. The spec's filter object needs real ones, so Task 5 adds a filter row in the Audit log's idiom (ComboBox Person / Job / Site plus From / To date inputs, `.audit-toolbar`). That row drives both `GET /time/entries`, which gains `site_id`, and the bulk filter. "Approve all pending in this view" shows only on the All and Pending pills. It is disabled, with a `set-note` saying why, while column filters or search are active, because those narrow only the loaded rows.
2. **Visibility.** The `time` resource is `visible_to={"global"}` with no row scoping. Every existing entry is therefore visible to a `time:change` holder, and "not found" means an id matches no row.
3. **The skipped `date`** is the entry's `clock_in_at` as an ISO instant (null for "not found"). The portal formats it.
4. **Dry run and the cap.** `count` excludes the actor's own entries, since it counts what would be approved. The cap counts every matched pending entry, own included. A dry run also returns 422 past the cap.
5. **The approve-all confirmation** is a modal in the report-generate header pattern (`TimeBulkDialog`), shared with the reject-reason dialog. It is not `window.confirm`.
6. **Duplicates** match any existing entry, rejected ones included, so re-uploading a file never re-adds a shift a manager rejected. The overlap rule still ignores rejected entries. Only a row with no other errors or issues becomes `duplicate`.
7. **"The job's site"** is `initiatives.site_id`. A row whose own site has no valid timezone uses the default, not the job's site. The created entry's `site_id` is the row's own site only.
8. **Worker cell kind.** A value containing `@` matches by email only. A phone-looking value (digits, spaces, `()+-.`, at least 7 digits) matches by phone and falls back to name when no phone matches. Anything else matches by name.
9. **Commit** accepts JSON only, like the job-team tool; a multipart commit is 422 `invalid_json`. Row `action` is `created` or `skipped`, which is BulkApplySummary's vocabulary; the summary keys are the spec's `added`/`skipped`. Row `detail` is the shift text, "Already there." or "Skipped.".
10. **Concurrency at commit.** The commit takes `LOCK TABLE time_entries IN SHARE ROW EXCLUSIVE MODE` before it re-runs the preview. The two options the brief offered do not work here:
    - `SELECT … FOR UPDATE` on the workers' rows cannot block a concurrent INSERT of a new overlapping entry.
    - A per-person advisory lock only helps if every clock-in path takes it too, and none do.

    The table lock conflicts with every writer's ROW EXCLUSIVE lock and with itself, and leaves reads alone.
11. **Excel serials** are read only between 20000 and 80000 (1954–2119). An integral serial is midnight.
12. **The break** must be a whole number (`30.0` is accepted) and shorter than the span, matching the existing `invalid_break` rule.
13. **Row order.** Preview rows come back problems first (attention, error, add, duplicate, skipped), and the portal lists 200 at a time.
14. **BulkApplySummary** gets `updated` and `unchanged` as optional counts, so an add-only tool shows "Applied: 1 added · 2 skipped".
15. **Shared helpers.** `renumber`, `parse_overrides(raw, fields)` and `parse_row_list` move into `imports/bulk.py`; `team_bulk` keeps its public names as thin wrappers.
16. **The import page title** is the card title, "Add time punches in bulk". Downloads are templates only.
17. **Audit labels.** `auditFormat.ts` gains `import: 'Imported'` and `time_entry: 'time entry'`, so the new audit rows read well in the Audit log.

## File map

| File | Task | Responsibility |
|---|---|---|
| `api/src/serversherpa/api/schemas.py` | 1 | `TimeBulkFilterIn`, `TimeBulkApproveIn`, `TimeBulkRejectIn` |
| `api/src/serversherpa/api/routes/time.py` | 1 | shared `_entry_conditions`, `_approve_entry`/`_reject_entry`, bulk routes, `site_id` on the list |
| `api/tests/test_time_bulk_approve_api.py` | 1 | bulk approve/reject tests |
| `api/src/serversherpa/people/time_parse.py` | 2 | zone, clock, break parsing; shift text |
| `api/tests/test_time_parse.py` | 2 | pure parsing tests |
| `api/src/serversherpa/imports/bulk.py` | 3 | `renumber`, `parse_overrides`, `parse_row_list` |
| `api/src/serversherpa/people/team_bulk.py` | 3 | wrap the moved helpers |
| `api/src/serversherpa/people/time_bulk.py` | 3, 4 | import service: parse, match, preview, template (3); commit (4) |
| `api/tests/test_bulk_core.py`, `api/tests/test_time_bulk_service.py` | 3 | helper and service tests |
| `api/src/serversherpa/api/routes/time_bulk.py`, `api/src/serversherpa/api/app.py` | 4 | `/time/bulk/*` routes |
| `api/tests/test_time_bulk_import_api.py` | 4 | route and commit tests |
| `portal/src/lib/api.ts` | 5, 7 | bulk approval client (5); import client (7) |
| `portal/src/lib/timeBulk.ts` (+ test) | 5 | source labels, filters → query, result sentences |
| `portal/src/components/time/TimeEntryEditModal.tsx` | 5 | `TIME_ERRORS` codes |
| `portal/src/pages/TimeManagement.tsx` (+ tests), `portal/src/styles/time.css` | 5, 6 | filter row (5); selection, bulk bar, result (6) |
| `portal/src/components/time/TimeBulkDialog.tsx` | 6 | reject-reason and approve-all dialog |
| `portal/src/pages/TimeManagement.bulk.test.tsx` | 6 | bulk approval tests |
| `portal/src/lib/timeImport.ts` (+ test), `portal/src/pages/BulkTime.tsx` (+ test) | 7 | guide, errors, page |
| `portal/src/components/bulk/BulkApplySummary.tsx` (+ test), `portal/src/pages/BulkActions.tsx` (+ test), `portal/src/App.tsx`, `portal/src/lib/auditFormat.ts` (+ test) | 7 | optional counts, card, route, audit labels |
| `portal/src/components/time/TimeImportUpload.tsx`, `TimeImportRowDetails.tsx` (+ test) | 7 (stub), 8 | the upload pane |

---

### Task 1: API — bulk approve and reject

**Files:**
- Modify: `api/src/serversherpa/api/schemas.py` (after `TimeEntryRejectIn`, about line 2347)
- Modify: `api/src/serversherpa/api/routes/time.py` (imports; `list_time_entries` about lines 205-229; `approve_time_entry` / `reject_time_entry` about lines 351-399)
- Test: `api/tests/test_time_bulk_approve_api.py` (create)

**Interfaces:**
- Consumes: `routes/time.py` `_err`, `_people_names`; `services/audit.audit/diff/snapshot`; `test_time_api.T0`, `test_time_api._bump_admin`, `test_assets_api.login`.
- Produces:
  - `POST /time/entries/approve` — body `TimeBulkApproveIn`, query `dry_run: bool = False` → `{"count": int}` or `{"approved": int, "skipped": list[dict]}`
  - `POST /time/entries/reject` — body `TimeBulkRejectIn` → `{"rejected": int, "skipped": list[dict]}`
  - skipped item: `{"entry_id": str, "person": str | None, "date": str | None, "reason": str}`
  - `GET /time/entries` gains `site_id: uuid.UUID | None`
  - `routes/time.py` module names: `BULK_LIMIT = 5000`, `SKIP_NOT_FOUND`, `SKIP_OWN`, `SKIP_NOT_PENDING`, `_entry_conditions(*, person_id, initiative_id, site_id, since, until) -> list`
  - error codes: `ids_or_filter`, `too_many` (extra `limit`), `reason_required`

- [ ] **Step 1: Write the failing tests** — create `api/tests/test_time_bulk_approve_api.py`:

```python
"""Bulk approve / reject on the Timesheet: ids or filter, dry run, skip
reasons, the 5,000 cap, one audit row per entry, and the time:change gate."""

import uuid
from datetime import timedelta

from sqlalchemy import func, select

from serversherpa.api.routes import time as time_routes
from serversherpa.db.models import AuditLog, Initiative, Person, Site, TimeEntry

from .test_assets_api import login
from .test_time_api import T0, _bump_admin


async def _person(db, first, last):
    p = Person(first_name=first, last_name=last)
    db.add(p)
    await db.flush()
    return p


def _entry(person, *, status="pending", day=0, initiative=None, site=None):
    start = T0 + timedelta(days=day)
    return TimeEntry(person_id=person.id, clock_in_at=start,
                     clock_out_at=start + timedelta(hours=8), status=status,
                     initiative_id=initiative.id if initiative else None,
                     site_id=site.id if site else None)


async def _audits(db, entry_id=None):
    query = select(AuditLog).where(AuditLog.entity_type == "time_entry")
    if entry_id is not None:
        query = query.where(AuditLog.entity_id == str(entry_id))
    return list(await db.scalars(query))


async def _admin(client, db, seeded_user):
    """seeded_user (alice) is staff; bump to admin and COMMIT before logging
    in, since the route runs in another session and must see the grant."""
    await _bump_admin(db, seeded_user)
    await db.commit()
    return await login(client)


async def _approved_count(db):
    return await db.scalar(select(func.count()).select_from(TimeEntry)
                           .where(TimeEntry.status == "approved"))


async def test_approve_by_ids_reports_each_skip_reason(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    pending, settled = _entry(owner), _entry(owner, status="approved", day=1)
    own = _entry(seeded_user, day=2)
    db.add_all([pending, settled, own])
    await db.commit()
    missing = uuid.uuid4()

    resp = await client.post("/time/entries/approve", headers=hdrs, json={
        "entry_ids": [str(pending.id), str(settled.id), str(own.id), str(missing)]})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["approved"] == 1
    assert {(s["entry_id"], s["person"], s["reason"]) for s in body["skipped"]} == {
        (str(settled.id), "Ow Ner", "no longer pending"),
        (str(own.id), "Alice Anderson", "your own entry"),
        (str(missing), None, "not found"),
    }
    assert next(s for s in body["skipped"] if s["reason"] == "not found")["date"] is None
    await db.refresh(pending)
    await db.refresh(own)
    assert pending.status == "approved"
    assert pending.approved_by == seeded_user.id and pending.approved_at is not None
    assert own.status == "pending"
    [row] = await _audits(db, pending.id)
    assert row.action == "update"
    assert set(row.changes) == {"status", "approved_by", "approved_at"}
    assert await _audits(db, own.id) == []


async def test_one_audit_row_per_approved_entry(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    entries = [_entry(owner, day=d) for d in range(3)]
    db.add_all(entries)
    await db.commit()

    resp = await client.post("/time/entries/approve", headers=hdrs,
                             json={"entry_ids": [str(e.id) for e in entries]})
    assert resp.json() == {"approved": 3, "skipped": []}
    audits = await _audits(db)
    assert sorted(a.entity_id for a in audits) == sorted(str(e.id) for e in entries)
    assert {a.action for a in audits} == {"update"}


async def test_approve_by_filter_reaches_pending_only(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    other = await _person(db, "Ot", "Her")
    job = Initiative(name="Move A", initiative_type="move")
    elsewhere = Initiative(name="Move B", initiative_type="move")
    db.add_all([job, elsewhere])
    await db.flush()
    hit1 = _entry(owner, initiative=job)
    hit2 = _entry(other, day=1, initiative=job)
    settled = _entry(owner, status="rejected", day=2, initiative=job)
    own = _entry(seeded_user, day=3, initiative=job)
    miss = _entry(owner, day=4, initiative=elsewhere)
    db.add_all([hit1, hit2, settled, own, miss])
    await db.commit()

    resp = await client.post("/time/entries/approve", headers=hdrs,
                             json={"filter": {"initiative_id": str(job.id)}})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["approved"] == 2
    assert [(s["entry_id"], s["reason"]) for s in body["skipped"]] == [
        (str(own.id), "your own entry")]
    statuses = dict((await db.execute(select(TimeEntry.id, TimeEntry.status))).all())
    assert statuses[hit1.id] == statuses[hit2.id] == "approved"
    assert statuses[settled.id] == "rejected"
    assert statuses[own.id] == statuses[miss.id] == "pending"


async def test_filter_by_person_site_and_clock_in_window(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    other = await _person(db, "Ot", "Her")
    dc = Site(name="DC East")
    db.add(dc)
    await db.flush()
    early = _entry(owner, day=0, site=dc)
    inside = _entry(owner, day=2, site=dc)
    no_site = _entry(owner, day=2)
    someone_else = _entry(other, day=2, site=dc)
    db.add_all([early, inside, no_site, someone_else])
    await db.commit()

    resp = await client.post("/time/entries/approve", headers=hdrs, json={"filter": {
        "person_id": str(owner.id), "site_id": str(dc.id),
        "from": (T0 + timedelta(days=1)).isoformat(),
        "to": (T0 + timedelta(days=3)).isoformat()}})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"approved": 1, "skipped": []}
    statuses = dict((await db.execute(select(TimeEntry.id, TimeEntry.status))).all())
    assert statuses[inside.id] == "approved"
    assert {statuses[e.id] for e in (early, no_site, someone_else)} == {"pending"}


async def test_dry_run_counts_and_writes_nothing(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    db.add_all([_entry(owner), _entry(owner, day=1), _entry(seeded_user, day=2)])
    await db.commit()

    resp = await client.post("/time/entries/approve?dry_run=1", headers=hdrs,
                             json={"filter": {}})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {"count": 2}
    assert await _approved_count(db) == 0
    assert await _audits(db) == []


async def test_exactly_one_of_ids_or_filter(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    for body in ({}, {"entry_ids": [], "filter": {}}):
        resp = await client.post("/time/entries/approve", headers=hdrs, json=body)
        assert resp.status_code == 422
        assert resp.json()["detail"]["code"] == "ids_or_filter"


async def test_the_5000_cap_for_ids_and_filters(client, db, seeded_user, monkeypatch):
    hdrs = await _admin(client, db, seeded_user)
    assert time_routes.BULK_LIMIT == 5000
    ids = [str(uuid.uuid4()) for _ in range(5001)]
    resp = await client.post("/time/entries/approve", headers=hdrs, json={"entry_ids": ids})
    assert resp.status_code == 422
    assert resp.json()["detail"] == {"code": "too_many", "limit": 5000}
    resp = await client.post("/time/entries/reject", headers=hdrs,
                             json={"entry_ids": ids, "reason": "no"})
    assert resp.json()["detail"]["code"] == "too_many"

    owner = await _person(db, "Ow", "Ner")
    db.add_all([_entry(owner, day=d) for d in range(3)])
    await db.commit()
    monkeypatch.setattr(time_routes, "BULK_LIMIT", 2)
    for url in ("/time/entries/approve?dry_run=1", "/time/entries/approve"):
        resp = await client.post(url, headers=hdrs, json={"filter": {}})
        assert resp.status_code == 422
        assert resp.json()["detail"] == {"code": "too_many", "limit": 2}
    assert await _approved_count(db) == 0


async def test_bulk_reject_needs_a_reason_and_applies_it_to_each(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    a, b = _entry(owner), _entry(owner, day=1)
    done = _entry(owner, status="approved", day=2)
    db.add_all([a, b, done])
    await db.commit()
    ids = [str(a.id), str(b.id), str(done.id)]

    resp = await client.post("/time/entries/reject", headers=hdrs,
                             json={"entry_ids": ids, "reason": "   "})
    assert resp.status_code == 422
    assert resp.json()["detail"]["code"] == "reason_required"

    resp = await client.post("/time/entries/reject", headers=hdrs,
                             json={"entry_ids": ids, "reason": " No show "})
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["rejected"] == 2
    assert [(s["entry_id"], s["reason"]) for s in body["skipped"]] == [
        (str(done.id), "no longer pending")]
    for e in (a, b):
        await db.refresh(e)
        assert (e.status, e.reject_reason) == ("rejected", "No show")
        [row] = await _audits(db, e.id)
        assert set(row.changes) == {"status", "reject_reason"}


async def test_bulk_routes_need_time_change(client, db, seeded_user):
    hdrs = await login(client)          # seeded_user is staff: time:view only
    for url, body in (("/time/entries/approve", {"filter": {}}),
                      ("/time/entries/reject", {"entry_ids": [], "reason": "x"})):
        resp = await client.post(url, headers=hdrs, json=body)
        assert resp.status_code == 403


async def test_entries_list_filters_by_site(client, db, seeded_user):
    hdrs = await _admin(client, db, seeded_user)
    owner = await _person(db, "Ow", "Ner")
    dc = Site(name="DC East")
    db.add(dc)
    await db.flush()
    here, there = _entry(owner, site=dc), _entry(owner, day=1)
    db.add_all([here, there])
    await db.commit()

    resp = await client.get("/time/entries", headers=hdrs, params={"site_id": str(dc.id)})
    assert resp.status_code == 200, resp.text
    assert [r["id"] for r in resp.json()] == [str(here.id)]
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_time_bulk /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest tests/test_time_bulk_approve_api.py -v`
Expected: FAIL. The bulk posts return 404 or 405, `BULK_LIMIT` is missing, and the `site_id` filter is ignored, so both rows come back.

- [ ] **Step 3: Add the request schemas** — in `api/src/serversherpa/api/schemas.py`, directly after `class TimeEntryRejectIn`:

```python
class TimeBulkFilterIn(BaseModel):
    """The Timesheet's server-side filters. `from` / `to` bound clock-in,
    inclusive at both ends — GET /time/entries' since / until."""
    person_id: uuid.UUID | None = None
    initiative_id: uuid.UUID | None = None
    site_id: uuid.UUID | None = None
    from_: datetime | None = Field(default=None, alias="from")
    to: datetime | None = None
    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class TimeBulkApproveIn(BaseModel):
    """Exactly one of `entry_ids` (the ticked rows) or `filter` (every
    pending entry the filters match); the route enforces "exactly one"."""
    entry_ids: list[uuid.UUID] | None = None
    filter: TimeBulkFilterIn | None = None
    model_config = ConfigDict(extra="forbid")


class TimeBulkRejectIn(BaseModel):
    entry_ids: list[uuid.UUID]
    reason: str
    model_config = ConfigDict(extra="forbid")
```

- [ ] **Step 4: Shared filter and mutation helpers** — in `api/src/serversherpa/api/routes/time.py`:

Add `TimeBulkApproveIn, TimeBulkFilterIn, TimeBulkRejectIn` to the `serversherpa.api.schemas` import (alphabetical, inside the existing parenthesized list).

Directly after `def _can_clock(...)`, add:

```python
# ── shared by the list, the single-row and the bulk routes ──────────

# Bulk approve / reject (the Timesheet's checkboxes and "Approve all
# pending in this view"): the single-row rules, one entry at a time, with
# a skipped entry reported under one of these reasons.
BULK_LIMIT = 5000
SKIP_NOT_FOUND = "not found"
SKIP_OWN = "your own entry"
SKIP_NOT_PENDING = "no longer pending"


def _entry_conditions(
    *, person_id: uuid.UUID | None = None, initiative_id: uuid.UUID | None = None,
    site_id: uuid.UUID | None = None, since: datetime | None = None,
    until: datetime | None = None,
) -> list:
    """The Timesheet's filter semantics, shared by GET /time/entries and the
    bulk-approve filter: exact person / job / site, and a clock-in window
    inclusive at both ends."""
    conds = []
    if person_id is not None:
        conds.append(TimeEntry.person_id == person_id)
    if initiative_id is not None:
        conds.append(TimeEntry.initiative_id == initiative_id)
    if site_id is not None:
        conds.append(TimeEntry.site_id == site_id)
    if since is not None:
        conds.append(TimeEntry.clock_in_at >= since)
    if until is not None:
        conds.append(TimeEntry.clock_in_at <= until)
    return conds


def _approve_entry(db: DbSession, entry: TimeEntry, actor_id: uuid.UUID,
                   now: datetime) -> None:
    """Approve one pending entry and add its audit row; the caller commits."""
    fields = ["status", "approved_by", "approved_at"]
    before = snapshot(entry, fields)
    entry.status = "approved"
    entry.approved_by = actor_id
    entry.approved_at = now
    entry.updated_at = now
    audit(db, actor_id=actor_id, entity_type="time_entry", entity_id=str(entry.id),
          action="update", changes=diff(before, snapshot(entry, fields)))


def _reject_entry(db: DbSession, entry: TimeEntry, actor_id: uuid.UUID,
                  reason: str, now: datetime) -> None:
    """Reject one pending entry and add its audit row; the caller commits."""
    fields = ["status", "reject_reason"]
    before = snapshot(entry, fields)
    entry.status = "rejected"
    entry.reject_reason = reason
    entry.updated_at = now
    audit(db, actor_id=actor_id, entity_type="time_entry", entity_id=str(entry.id),
          action="update", changes=diff(before, snapshot(entry, fields)))


async def _bulk_targets(
    db: DbSession, *, entry_ids: list[uuid.UUID] | None,
    flt: TimeBulkFilterIn | None, lock: bool,
) -> tuple[list[TimeEntry], list[uuid.UUID]]:
    """(entries, ids that matched no row). With ids: every named entry,
    whatever its status, so the caller can say why one was skipped. With a
    filter: pending entries only. Rows are locked FOR UPDATE, in id order so
    two bulk runs cannot deadlock, before any status is read, so a
    concurrent single-row action cannot race the run. A dry run only counts
    and takes no lock. `time` is visible to global actors only
    (access/resources.py) and has no row scoping, so every existing entry is
    visible to a time:change holder; an id matching no row is the one
    "not found" case."""
    if flt is not None:
        query = (select(TimeEntry)
                 .where(TimeEntry.status == "pending", *_entry_conditions(
                     person_id=flt.person_id, initiative_id=flt.initiative_id,
                     site_id=flt.site_id, since=flt.from_, until=flt.to))
                 .limit(BULK_LIMIT + 1))
        ids: list[uuid.UUID] = []
    else:
        ids = list(dict.fromkeys(entry_ids or []))
        if len(ids) > BULK_LIMIT:
            raise _err(422, "too_many", limit=BULK_LIMIT)
        if not ids:
            return [], []
        query = select(TimeEntry).where(TimeEntry.id.in_(ids))
    query = query.order_by(TimeEntry.id).execution_options(populate_existing=True)
    if lock:
        query = query.with_for_update()
    entries = list(await db.scalars(query))
    if len(entries) > BULK_LIMIT:
        raise _err(422, "too_many", limit=BULK_LIMIT)
    found = {e.id for e in entries}
    return entries, [i for i in ids if i not in found]


async def _partition(
    db: DbSession, entries: list[TimeEntry], missing: list[uuid.UUID],
    actor_id: uuid.UUID,
) -> tuple[list[TimeEntry], list[dict]]:
    """(entries to act on, skipped) — the single-row routes' checks, in
    their order: the actor's own entry first, then anything not pending."""
    ready: list[TimeEntry] = []
    held: list[tuple[TimeEntry, str]] = []
    for e in entries:
        if e.person_id == actor_id:
            held.append((e, SKIP_OWN))
        elif e.status != "pending":
            held.append((e, SKIP_NOT_PENDING))
        else:
            ready.append(e)
    names = await _people_names(db, {e.person_id for e, _ in held})
    skipped = [{"entry_id": str(e.id), "person": names.get(e.person_id),
                "date": e.clock_in_at.isoformat(), "reason": reason}
               for e, reason in held]
    skipped += [{"entry_id": str(i), "person": None, "date": None,
                 "reason": SKIP_NOT_FOUND} for i in missing]
    return ready, skipped
```

- [ ] **Step 5: The list uses the shared filter and gains `site_id`** — replace the whole `list_time_entries` function with:

```python
@router.get("/entries", response_model=list[TimeEntryItem])
async def list_time_entries(
    db: DbSession,
    actor: AuthContext = require_permission("time", "view"),
    person_id: uuid.UUID | None = None,
    initiative_id: uuid.UUID | None = None,
    site_id: uuid.UUID | None = None,
    status: str | None = None,
    since: datetime | None = None,
    until: datetime | None = None,
    limit: int = Query(500, ge=1, le=1000),
    offset: int = Query(0, ge=0),
) -> list[TimeEntryItem]:
    query = (select(TimeEntry)
             .where(*_entry_conditions(person_id=person_id, initiative_id=initiative_id,
                                       site_id=site_id, since=since, until=until))
             .order_by(TimeEntry.clock_in_at.desc(), TimeEntry.id.desc())
             .offset(offset).limit(limit))
    if status is not None:
        query = query.where(TimeEntry.status == status)
    entries = list(await db.scalars(query))
    return await _items(db, entries)
```

- [ ] **Step 6: The bulk routes** — insert directly after `create_time_entry`, before `update_time_entry`:

```python
@router.post("/entries/approve")
async def bulk_approve_time_entries(
    body: TimeBulkApproveIn, db: DbSession,
    actor: AuthContext = require_permission("time", "change"),
    dry_run: bool = False,
) -> dict:
    """Approve many pending entries in one transaction: the ticked ids, or
    every pending entry the Timesheet's filters match (which reaches rows
    the list has not loaded). `?dry_run=1` counts what would be approved
    and writes nothing."""
    if (body.entry_ids is None) == (body.filter is None):
        raise _err(422, "ids_or_filter")
    entries, missing = await _bulk_targets(
        db, entry_ids=body.entry_ids, flt=body.filter, lock=not dry_run)
    ready, skipped = await _partition(db, entries, missing, actor.person.id)
    if dry_run:
        return {"count": len(ready)}
    now = datetime.now(UTC)
    for entry in ready:
        _approve_entry(db, entry, actor.person.id, now)
    await db.commit()
    return {"approved": len(ready), "skipped": skipped}


@router.post("/entries/reject")
async def bulk_reject_time_entries(
    body: TimeBulkRejectIn, db: DbSession,
    actor: AuthContext = require_permission("time", "change"),
) -> dict:
    """Reject the ticked entries with one reason, in one transaction."""
    reason = body.reason.strip()
    if not reason:
        raise _err(422, "reason_required")
    entries, missing = await _bulk_targets(db, entry_ids=body.entry_ids, flt=None, lock=True)
    ready, skipped = await _partition(db, entries, missing, actor.person.id)
    now = datetime.now(UTC)
    for entry in ready:
        _reject_entry(db, entry, actor.person.id, reason, now)
    await db.commit()
    return {"rejected": len(ready), "skipped": skipped}
```

- [ ] **Step 7: The single-row routes reuse the mutations** — in `approve_time_entry`, replace everything from `fields = ["status", "approved_by", "approved_at"]` through the `audit(...)` call with:

```python
    _approve_entry(db, entry, actor.person.id, datetime.now(UTC))
```

In `reject_time_entry`, replace everything from `fields = ["status", "reject_reason"]` through the `audit(...)` call with:

```python
    _reject_entry(db, entry, actor.person.id, body.reason, datetime.now(UTC))
```

Both keep their 404 / `cannot_target_self` / `not_pending` checks, `await db.commit()` and `return await _to_item(db, entry)`.

- [ ] **Step 8: Run the new tests and the existing time tests**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_time_bulk /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest tests/test_time_bulk_approve_api.py tests/test_time_api.py tests/test_time_stats_api.py tests/test_kiosk_timeclock_api.py -v`
Expected: all PASS.

Then: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/api && /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/ruff check src/serversherpa/api/routes/time.py src/serversherpa/api/schemas.py tests/test_time_bulk_approve_api.py`
Expected: `All checks passed!`

- [ ] **Step 9: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk
git add api/src/serversherpa/api/schemas.py api/src/serversherpa/api/routes/time.py api/tests/test_time_bulk_approve_api.py
git commit -F - <<'EOF'
feat(api): bulk approve and reject time entries — ids or Timesheet filter, dry run, 5,000 cap

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: API — reading clock times (`people/time_parse.py`)

**Files:**
- Create: `api/src/serversherpa/people/time_parse.py`
- Test: `api/tests/test_time_parse.py` (create)

**Interfaces:**
- Consumes: `services/timezone.DEFAULT_TIMEZONE`.
- Produces (all pure, no DB):
  - `zone_for(name: str | None) -> ZoneInfo`: the named IANA zone, or `DEFAULT_TIMEZONE` when the name is blank or unknown
  - `parse_clock(text: str, zone: ZoneInfo) -> datetime | None`: an aware UTC datetime, or `None` when the text cannot be read
  - `parse_break(text: str) -> int | None`: blank → 0; `None` when negative or not a whole number
  - `clock_text(at: datetime, zone: ZoneInfo) -> str`, e.g. `"Sep 23, 10:00 PM EDT"`
  - `shift_text(start: datetime, end: datetime, zone: ZoneInfo) -> str`, e.g. `"Sep 24, 7:00 AM – 3:30 PM PDT"`

- [ ] **Step 1: Write the failing tests** — create `api/tests/test_time_parse.py`:

```python
"""people/time_parse: reading clock cells, zones, DST, and the shift text."""
from datetime import UTC, datetime
from zoneinfo import ZoneInfo

import pytest

from serversherpa.people import time_parse as tp

NY = ZoneInfo("America/New_York")
LA = ZoneInfo("America/Los_Angeles")
SEVEN_AM_EDT = datetime(2026, 9, 24, 11, 0, tzinfo=UTC)


@pytest.mark.parametrize("text", [
    "9/24/2026 7:00 AM", "9/24/2026 7:00:00 AM", "09/24/2026 07:00", "9/24/2026 7:00am",
    "9/24/2026 7:00 a.m.", "9/24/26 7:00 AM", "2026-09-24 07:00", "2026-09-24T07:00",
    "2026-09-24 7:00", "2026-09-24 07:00:00", "2026-09-24 7:00 AM", "  9/24/2026   7:00 AM ",
    "46289.291666666664",
])
def test_wall_clock_formats_read_in_the_given_zone(text):
    assert tp.parse_clock(text, NY) == SEVEN_AM_EDT


def test_the_zone_moves_a_wall_clock_time():
    assert tp.parse_clock("9/24/2026 7:00 AM", LA) == datetime(2026, 9, 24, 14, 0, tzinfo=UTC)
    assert tp.parse_clock("9/24/2026 3:30 PM", NY) == datetime(2026, 9, 24, 19, 30, tzinfo=UTC)


@pytest.mark.parametrize(("text", "expected"), [
    ("2026-09-24T07:00:00-07:00", datetime(2026, 9, 24, 14, 0, tzinfo=UTC)),
    ("2026-09-24T14:00:00Z", datetime(2026, 9, 24, 14, 0, tzinfo=UTC)),
    ("2026-09-24 07:00-05:00", datetime(2026, 9, 24, 12, 0, tzinfo=UTC)),
])
def test_an_explicit_offset_is_taken_as_written(text, expected):
    assert tp.parse_clock(text, LA) == expected          # the zone is not used


def test_excel_serials():
    assert tp.parse_clock("46289.291666666664", NY) == SEVEN_AM_EDT
    assert tp.parse_clock("46289", NY) == datetime(2026, 9, 24, 4, 0, tzinfo=UTC)   # midnight


@pytest.mark.parametrize("text", [
    "", "   ", "someday", "9/24/2026", "2026-09-24", "7:00 AM", "13/45/2026 7:00",
    "12", "99999", "2026-09-24T25:00",
])
def test_unreadable_cells_are_none(text):
    assert tp.parse_clock(text, NY) is None


def test_daylight_saving_gaps_and_repeats_resolve_with_fold_0():
    # spring forward: 2:30 AM never happens on Mar 8, 2026 — read with the
    # offset in force before the change (EST)
    assert tp.parse_clock("2026-03-08 02:30", NY) == datetime(2026, 3, 8, 7, 30, tzinfo=UTC)
    # fall back: 1:30 AM happens twice on Nov 1, 2026 — the first (EDT) one
    assert tp.parse_clock("2026-11-01 01:30", NY) == datetime(2026, 11, 1, 5, 30, tzinfo=UTC)


def test_zone_for_falls_back_to_the_house_default():
    assert tp.zone_for("America/Chicago").key == "America/Chicago"
    assert tp.zone_for(" America/Chicago ").key == "America/Chicago"
    for bad in (None, "", "  ", "Mars/Base", "../etc/passwd"):
        assert tp.zone_for(bad).key == "America/New_York"


@pytest.mark.parametrize(("text", "minutes"), [
    ("", 0), ("  ", 0), ("0", 0), ("30", 30), ("30.0", 30),
    ("-5", None), ("abc", None), ("7.5", None),
])
def test_parse_break(text, minutes):
    assert tp.parse_break(text) == minutes


def test_shift_and_clock_text():
    utc = lambda *a: datetime(*a, tzinfo=UTC)  # noqa: E731
    assert tp.shift_text(utc(2026, 9, 24, 14), utc(2026, 9, 24, 22, 30), LA) \
        == "Sep 24, 7:00 AM – 3:30 PM PDT"
    assert tp.shift_text(utc(2026, 9, 25, 2), utc(2026, 9, 25, 10), NY) \
        == "Sep 24, 10:00 PM – Sep 25, 6:00 AM EDT"
    assert tp.shift_text(utc(2026, 11, 1, 5, 30), utc(2026, 11, 1, 14), NY) \
        == "Nov 1, 1:30 AM EDT – 9:00 AM EST"
    assert tp.shift_text(utc(2026, 9, 24, 4), utc(2026, 9, 24, 16), NY) \
        == "Sep 24, 12:00 AM – 12:00 PM EDT"
    assert tp.clock_text(utc(2026, 9, 24, 2), NY) == "Sep 23, 10:00 PM EDT"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_time_bulk /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest tests/test_time_parse.py -v`
Expected: FAIL with `ImportError: cannot import name 'time_parse'`.

- [ ] **Step 3: Implement** — create `api/src/serversherpa/people/time_parse.py`:

```python
"""Reading clock times out of an uploaded timesheet (Bulk Actions › Add time
punches in bulk).

A cell with an explicit UTC offset (ISO 8601 `2026-09-24T07:00:00-07:00`, or
a trailing `Z`) is taken as written. Anything else is a wall-clock time in
the zone the caller passes: the row's site, else the job's site, else the
house default (services/timezone.DEFAULT_TIMEZONE). Daylight-saving gaps and
repeats resolve by zoneinfo's standard rule, fold=0. A time in the
spring-forward gap reads with the offset in force before the change, and a
time in the repeated fall-back hour reads as its first occurrence.

Excel: openpyxl hands a date-formatted cell over as a datetime, which the
bulk core turns into `2026-09-24 07:00:00`. An unformatted date cell is a
serial day count since 1899-12-30; it is read only between 1954 and 2119,
so a stray small number is never taken for a date."""

import re
from datetime import UTC, datetime, timedelta
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from serversherpa.services.timezone import DEFAULT_TIMEZONE

EXCEL_EPOCH = datetime(1899, 12, 30)
EXCEL_SERIAL_MIN = 20000     # 1954-10-03
EXCEL_SERIAL_MAX = 80000     # 2119-01-10

_SERIAL = re.compile(r"^\d+(\.\d+)?$")
_ISO = re.compile(r"^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}")
_AMPM = re.compile(r"\s*([ap])\.?m\.?$", re.IGNORECASE)
_BREAK = re.compile(r"^\d+(\.0+)?$")
_NAIVE_FORMATS = (
    "%m/%d/%Y %I:%M %p", "%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y %H:%M", "%m/%d/%Y %H:%M:%S",
    "%m/%d/%y %I:%M %p", "%m/%d/%y %H:%M",
    "%Y-%m-%d %I:%M %p", "%Y-%m-%d %H:%M", "%Y-%m-%d %H:%M:%S",
)


def zone_for(name: str | None) -> ZoneInfo:
    """The named IANA zone, or the house default when the name is blank or
    not a zone this server knows (sites.timezone is free text)."""
    if name and name.strip():
        try:
            return ZoneInfo(name.strip())
        except (ZoneInfoNotFoundError, ValueError):
            pass
    return ZoneInfo(DEFAULT_TIMEZONE)


def parse_clock(text: str, zone: ZoneInfo) -> datetime | None:
    """One clock_in / clock_out cell as an aware UTC datetime, or None when
    it is not a date and time this import reads. A date alone, or a time
    alone, is not enough."""
    raw = " ".join((text or "").split())
    if not raw:
        return None
    if _SERIAL.match(raw):
        return _serial(float(raw), zone)
    parsed = _iso(raw) or _naive(raw)
    if parsed is None:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=zone)          # fold=0
    return parsed.astimezone(UTC)


def _serial(value: float, zone: ZoneInfo) -> datetime | None:
    if not EXCEL_SERIAL_MIN <= value <= EXCEL_SERIAL_MAX:
        return None
    naive = EXCEL_EPOCH + timedelta(seconds=round(value * 86400))
    return naive.replace(tzinfo=zone).astimezone(UTC)


def _iso(raw: str) -> datetime | None:
    if not _ISO.match(raw):
        return None
    try:
        return datetime.fromisoformat(raw)
    except ValueError:
        return None


def _naive(raw: str) -> datetime | None:
    text = _AMPM.sub(lambda m: f" {m.group(1).upper()}M", raw)
    for fmt in _NAIVE_FORMATS:
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            continue
    return None


def parse_break(text: str) -> int | None:
    """Break minutes: blank is 0; None when negative or not a whole number."""
    raw = (text or "").strip()
    if not raw:
        return 0
    if not _BREAK.match(raw):
        return None
    return int(float(raw))


def _day(local: datetime) -> str:
    return f"{local:%b} {local.day}"


def _time(local: datetime) -> str:
    return f"{(local.hour % 12) or 12}:{local:%M} {'AM' if local.hour < 12 else 'PM'}"


def clock_text(at: datetime, zone: ZoneInfo) -> str:
    """'Sep 23, 10:00 PM EDT' — one instant on `zone`'s wall clock."""
    local = at.astimezone(zone)
    return f"{_day(local)}, {_time(local)} {local.tzname()}"


def shift_text(start: datetime, end: datetime, zone: ZoneInfo) -> str:
    """'Sep 24, 7:00 AM – 3:30 PM PDT'. The end repeats the day when the
    shift crosses midnight, and each end carries its own abbreviation when a
    daylight-saving change falls inside the shift."""
    a, b = start.astimezone(zone), end.astimezone(zone)
    left = f"{_day(a)}, {_time(a)}"
    if a.tzname() != b.tzname():
        left += f" {a.tzname()}"
    right = f"{_time(b)} {b.tzname()}"
    if b.date() != a.date():
        right = f"{_day(b)}, {right}"
    return f"{left} – {right}"
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_time_bulk /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest tests/test_time_parse.py -v`
Expected: all PASS. Then `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/ruff check src/serversherpa/people/time_parse.py tests/test_time_parse.py` from `api/` → `All checks passed!`

- [ ] **Step 5: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk
git add api/src/serversherpa/people/time_parse.py api/tests/test_time_parse.py
git commit -F - <<'EOF'
feat(api): read timesheet clock cells — formats, Excel serials, offsets, site zones, DST fold=0

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: API — punch import service: match, read, check, preview, template

**Files:**
- Modify: `api/src/serversherpa/imports/bulk.py` (add three helpers)
- Modify: `api/src/serversherpa/people/team_bulk.py` (`number_posted_rows`, `parse_overrides`, `parse_row_list` become thin wrappers)
- Create: `api/src/serversherpa/people/time_bulk.py`
- Test: `api/tests/test_bulk_core.py` (append), `api/tests/test_time_bulk_service.py` (create)

**Interfaces:**
- Consumes: Task 2's `time_parse.zone_for`, `parse_clock`, `parse_break`, `clock_text`, `shift_text`; `people/bulk_import._worker_query`, `name_keys`, `normalize_phone`; `services/timezone.stored_day`.
- Produces:
  - `imports/bulk.renumber(numbered, row_numbers) -> list[tuple[int, dict]]`: raises `invalid_row_numbers`
  - `imports/bulk.parse_overrides(raw, fields: tuple[str, ...]) -> dict[int, dict[str, str]]`: raises `invalid_overrides`
  - `imports/bulk.parse_row_list(raw, code) -> set[int]`
  - `time_bulk.COLUMNS`, `SHEET = "Time"`, `FIELDS = ("worker", "job", "site")`, `MAX_ROWS = 5000`, `MAX_BYTES = 5 * 1024 * 1024`, `SAMPLE_ROWS`, `ACTION_ORDER`
  - `time_bulk.number_json_rows(rows)`, `number_posted_rows(rows, row_numbers)`, `parse_upload(filename, content)`, `parse_overrides(raw)`, `parse_row_list(raw, code)`
  - `async time_bulk.preview_rows(db, numbered, *, overrides=None, skip=None, now=None) -> {"rows": [...], "counts": {attention, error, add, duplicate, skipped}, "can_commit": bool}`
  - preview row keys: `row, name, person_id, person_name, matched_by ("email"|"phone"|"name"|"your pick"|None), job_id, job_name, site_id, site_name, zone (IANA key), clock_in_at, clock_out_at (UTC ISO strings), break_minutes, minutes (worked, net of break), shift, notes, action, errors, issues, detail, cells`
  - issue: `{"field": "worker"|"job"|"site", "kind": "unknown"|"ambiguous", "value": str, "candidates": [{"id", "label", "detail"}]}`
  - `time_bulk.build_template_csv() -> str`, `async build_template_xlsx(db) -> bytes` (sheets `Time`, `Reference` with blocks `Workers`, `Jobs`, `Sites`)

- [ ] **Step 1: Write the failing core-helper test** — append to `api/tests/test_bulk_core.py`:

```python
def test_renumber_overrides_and_row_lists_are_shared_helpers():
    rows = bulk.number_json_rows([{"name": "a"}, {"name": "b"}], COLS)
    assert [n for n, _ in bulk.renumber(rows, [5, 9])] == [5, 9]
    assert bulk.renumber(rows, None) == rows
    for bad in ([5], [5, 5], ["5", 9], [True, 9], "x"):
        with pytest.raises(bulk.BulkImportError) as info:
            bulk.renumber(rows, bad)
        assert info.value.code == "invalid_row_numbers"
    assert bulk.parse_overrides({"3": {"job": "j1"}}, ("worker", "job")) == {3: {"job": "j1"}}
    assert bulk.parse_overrides(None, ("worker",)) == {}
    for bad in ([], {"x": {}}, {"3": {"site": "s1"}}, {"3": {"job": 7}}, {"3": {"job": ""}}):
        with pytest.raises(bulk.BulkImportError) as info:
            bulk.parse_overrides(bad, ("worker", "job"))
        assert info.value.code == "invalid_overrides"
    assert bulk.parse_row_list([2, 3], "invalid_skip") == {2, 3}
    assert bulk.parse_row_list(None, "invalid_skip") == set()
    with pytest.raises(bulk.BulkImportError) as info:
        bulk.parse_row_list([True], "invalid_skip")
    assert info.value.code == "invalid_skip"
```

- [ ] **Step 2: Move the helpers into the core** — append to `api/src/serversherpa/imports/bulk.py`:

```python
def renumber(numbered: list[tuple[int, dict]], row_numbers: Any) -> list[tuple[int, dict]]:
    """JSON rows re-posted after a file preview carry the spreadsheet line
    numbers the preview assigned, so overrides / skips keyed by those numbers
    still line up. None keeps the JSON numbering (from 1)."""
    if row_numbers is None:
        return numbered
    if (not isinstance(row_numbers, list) or len(row_numbers) != len(numbered)
            or not all(isinstance(n, int) and not isinstance(n, bool) for n in row_numbers)
            or len(set(row_numbers)) != len(row_numbers)):
        raise BulkImportError("invalid_row_numbers")
    return [(n, row) for n, (_, row) in zip(row_numbers, numbered, strict=True)]


def parse_overrides(raw: Any, fields: tuple[str, ...]) -> dict[int, dict[str, str]]:
    """`{"<row>": {"<field>": "<picked id>"}}` → {row: {field: id}}; only the
    importer's own `fields`, each a non-empty string."""
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
                or not all(f in fields and isinstance(v, str) and v for f, v in picks.items())):
            raise BulkImportError("invalid_overrides")
        out[row] = dict(picks)
    return out


def parse_row_list(raw: Any, code: str) -> set[int]:
    """A list of row numbers (skips, approvals); `code` names the error."""
    if raw is None:
        return set()
    if not isinstance(raw, list) or not all(
            isinstance(n, int) and not isinstance(n, bool) for n in raw):
        raise BulkImportError(code)
    return set(raw)
```

Then in `api/src/serversherpa/people/team_bulk.py`, replace the bodies of `number_posted_rows`, `parse_overrides` and `parse_row_list` (keep their docstrings, names and signatures):

```python
def number_posted_rows(rows: Any, row_numbers: Any) -> list[tuple[int, dict]]:
    """JSON rows re-posted after a file preview carry the spreadsheet line
    numbers the preview assigned, so overrides / skips / approvals keyed by
    those numbers still line up."""
    return core.renumber(number_json_rows(rows), row_numbers)


def parse_overrides(raw: Any) -> dict[int, dict[str, str]]:
    return core.parse_overrides(raw, FIELDS)


def parse_row_list(raw: Any, code: str) -> set[int]:
    return core.parse_row_list(raw, code)
```

- [ ] **Step 3: Run the core and job-team tests**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_time_bulk /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest tests/test_bulk_core.py tests/test_team_bulk_service.py tests/test_team_bulk_api.py -v`
Expected: all PASS.

- [ ] **Step 4: Write the failing service tests** — create `api/tests/test_time_bulk_service.py`:

```python
"""Add time punches in bulk (no HTTP): matching, time zones, row errors,
overlaps, duplicates, the preview listing and the template."""
import io
import uuid
from datetime import UTC, datetime

import openpyxl
import pytest
from sqlalchemy import func

from serversherpa.db.models import Initiative, Person, PersonRole, Site, TimeEntry
from serversherpa.imports.bulk import BulkImportError
from serversherpa.people import time_bulk as tb

NOW = datetime(2026, 9, 25, 12, 0, tzinfo=UTC)


async def worker(db, first, last, *, email=None, phone=None, preferred=None,
                 role="worker", archived=False):
    p = Person(first_name=first, last_name=last, email=email, phone=phone,
               preferred_name=preferred, archived_at=func.now() if archived else None)
    db.add(p)
    await db.flush()
    db.add(PersonRole(person_id=p.id, role=role))
    await db.commit()
    return p


async def site(db, name, *, code=None, tz=None, archived=False):
    s = Site(name=name, code=code, timezone=tz, archived_at=func.now() if archived else None)
    db.add(s)
    await db.commit()
    return s


async def job(db, name, *, site_=None, archived=False):
    j = Initiative(name=name, initiative_type="move", site_id=site_.id if site_ else None,
                   archived_at=func.now() if archived else None)
    db.add(j)
    await db.commit()
    return j


def shift(worker="Ana Lopez", clock_in="2026-09-24 07:00", clock_out="2026-09-24 15:30",
          **cells):
    return {"worker": worker, "clock_in": clock_in, "clock_out": clock_out, **cells}


async def preview(db, rows, now=NOW, **kw):
    return await tb.preview_rows(db, tb.number_json_rows(rows), now=now, **kw)


def by_row(result):
    return {r["row"]: r for r in result["rows"]}


# ── shape ───────────────────────────────────────────────────────────

def test_columns_limits_and_template_round_trip():
    assert tb.COLUMNS == ["worker", "clock_in", "clock_out", "break_minutes", "job", "site",
                          "notes"]
    assert (tb.MAX_ROWS, tb.MAX_BYTES) == (5000, 5 * 1024 * 1024)
    parsed = tb.parse_upload("t.csv", tb.build_template_csv().encode())
    assert [n for n, _ in parsed] == [2, 3]
    assert [r for _, r in parsed] == tb.SAMPLE_ROWS
    assert len(tb.number_json_rows([{"worker": "x"}] * 5000)) == 5000
    with pytest.raises(BulkImportError) as info:
        tb.number_json_rows([{"worker": "x"}] * 5001)
    assert (info.value.code, info.value.extra) == ("too_many_rows", {"limit": 5000})


async def test_template_xlsx_lists_workers_jobs_and_sites(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    await job(db, "Move A")
    await site(db, "DC East")
    wb = openpyxl.load_workbook(io.BytesIO(await tb.build_template_xlsx(db)))
    assert wb.sheetnames == ["Time", "Reference"]
    assert [c.value for c in wb["Time"][1]] == tb.COLUMNS
    ref = {c.value for c in wb["Reference"]["A"] if c.value}
    assert {"Workers", "Jobs", "Sites", "Ana Lopez", "Move A", "DC East"} <= ref


# ── matching ────────────────────────────────────────────────────────

async def test_worker_matches_by_email_then_phone_then_name(db, seeded_user):
    ana = await worker(db, "Ana", "Lopez", email="ana@x.test", phone="555-123-4567",
                       preferred="Annie")
    rows = by_row(await preview(db, [
        shift(worker="ANA@X.TEST"),
        shift(worker="(555) 123-4567", clock_in="2026-09-23 07:00", clock_out="2026-09-23 15:00"),
        shift(worker="ana  lopez", clock_in="2026-09-22 07:00", clock_out="2026-09-22 15:00"),
        shift(worker="Annie Lopez", clock_in="2026-09-21 07:00", clock_out="2026-09-21 15:00"),
    ]))
    assert [(rows[n]["person_id"], rows[n]["matched_by"]) for n in (1, 2, 3, 4)] == [
        (str(ana.id), "email"), (str(ana.id), "phone"), (str(ana.id), "name"),
        (str(ana.id), "name")]
    assert rows[1]["name"] == rows[1]["person_name"] == "Ana Lopez"
    assert all(rows[n]["action"] == "add" for n in (1, 2, 3, 4))


async def test_unknown_and_ambiguous_values_need_attention(db, seeded_user):
    j1 = await worker(db, "Jo", "Park", email="j1@x.test")
    j2 = await worker(db, "Jo", "Park", email="j2@x.test")
    m1 = await job(db, "Dallas Move")
    m2 = await job(db, "Dallas Move")
    res = await preview(db, [
        shift(worker="Jo Park", job="dallas move", site="Nowhere DC"),
        shift(worker="nobody@x.test"),
    ])
    rows = by_row(res)
    assert rows[1]["action"] == "attention"
    assert {(i["field"], i["kind"]) for i in rows[1]["issues"]} == {
        ("worker", "ambiguous"), ("job", "ambiguous"), ("site", "unknown")}
    worker_issue = next(i for i in rows[1]["issues"] if i["field"] == "worker")
    assert {(c["id"], c["detail"]) for c in worker_issue["candidates"]} == {
        (str(j1.id), "j1@x.test"), (str(j2.id), "j2@x.test")}
    job_issue = next(i for i in rows[1]["issues"] if i["field"] == "job")
    assert {c["id"] for c in job_issue["candidates"]} == {str(m1.id), str(m2.id)}
    assert rows[2]["issues"] == [{"field": "worker", "kind": "unknown",
                                  "value": "nobody@x.test", "candidates": []}]
    assert rows[2]["name"] == "nobody@x.test"
    assert res["can_commit"] is False


async def test_archived_and_non_worker_records_do_not_match(db, seeded_user):
    await worker(db, "Old", "Timer", archived=True)
    await worker(db, "Sam", "Staff", role="staff")
    await job(db, "Closed Move", archived=True)
    await site(db, "Closed DC", archived=True)
    rows = by_row(await preview(db, [
        shift(worker="Old Timer"),
        shift(worker="Sam Staff", job="Closed Move", site="Closed DC"),
    ]))
    assert [(i["field"], i["kind"]) for i in rows[1]["issues"]] == [("worker", "unknown")]
    assert {(i["field"], i["kind"]) for i in rows[2]["issues"]} == {
        ("worker", "unknown"), ("job", "unknown"), ("site", "unknown")}


async def test_site_matches_by_name_or_code(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    west = await site(db, "Example DC West", code="DCW")
    rows = by_row(await preview(db, [
        shift(site="dcw"),
        shift(site="example dc west", clock_in="2026-09-23 07:00", clock_out="2026-09-23 15:00"),
    ]))
    assert rows[1]["site_id"] == rows[2]["site_id"] == str(west.id)
    assert rows[1]["site_name"] == "Example DC West"


async def test_picks_resolve_rows_and_skips_skip_them(db, seeded_user):
    j1 = await worker(db, "Jo", "Park")
    await worker(db, "Jo", "Park")
    move = await job(db, "Move A")
    west = await site(db, "DC West", tz="America/Los_Angeles")
    rows = by_row(await preview(
        db,
        [shift(worker="Jo Park", job="Mystery", site="Somewhere"), shift(worker="Nobody"),
         shift(worker="Jo Park")],
        overrides={1: {"worker": str(j1.id), "job": str(move.id), "site": str(west.id)},
                   3: {"worker": str(uuid.uuid4())}},
        skip={2}))
    assert rows[1]["action"] == "add" and rows[1]["matched_by"] == "your pick"
    assert (rows[1]["person_id"], rows[1]["job_id"], rows[1]["site_id"]) == (
        str(j1.id), str(move.id), str(west.id))
    assert rows[1]["zone"] == "America/Los_Angeles"          # the picked site's zone
    assert rows[2]["action"] == "skipped"
    assert rows[3]["action"] == "error"
    assert rows[3]["errors"] == ["The chosen worker no longer exists. Pick again."]


# ── times ───────────────────────────────────────────────────────────

async def test_zone_is_the_site_then_the_jobs_site_then_the_default(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    await site(db, "DC West", tz="America/Los_Angeles")
    chi = await site(db, "DC Central", tz="America/Chicago")
    await site(db, "DC Nowhere", tz="Mars/Base")
    await job(db, "Chicago Move", site_=chi)
    rows = by_row(await preview(db, [
        shift(site="DC West"),
        shift(job="Chicago Move", clock_in="2026-09-23 07:00", clock_out="2026-09-23 15:00"),
        shift(clock_in="2026-09-22 07:00", clock_out="2026-09-22 15:00"),
        shift(site="DC Nowhere", clock_in="2026-09-21 07:00", clock_out="2026-09-21 15:00"),
        shift(site="DC West", clock_in="2026-09-20T07:00:00-06:00",
              clock_out="2026-09-20T15:00:00-06:00"),
    ]))
    assert [rows[n]["action"] for n in range(1, 6)] == ["add"] * 5
    assert rows[1]["clock_in_at"] == "2026-09-24T14:00:00+00:00"
    assert rows[1]["zone"] == "America/Los_Angeles"
    assert rows[1]["shift"] == "Sep 24, 7:00 AM – 3:30 PM PDT"
    assert rows[1]["minutes"] == 510
    assert rows[2]["clock_in_at"] == "2026-09-23T12:00:00+00:00"
    assert rows[2]["zone"] == "America/Chicago"
    assert rows[3]["clock_in_at"] == "2026-09-22T11:00:00+00:00"
    assert rows[3]["zone"] == "America/New_York"
    assert rows[4]["clock_in_at"] == "2026-09-21T11:00:00+00:00"     # bad zone → default
    assert rows[5]["clock_in_at"] == "2026-09-20T13:00:00+00:00"     # offset as written


async def test_excel_serials_and_us_dates_read_alike(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    [row] = (await preview(db, [shift(clock_in="46289.291666666664",
                                      clock_out="9/24/2026 3:30 PM",
                                      break_minutes="30")]))["rows"]
    assert row["clock_in_at"] == "2026-09-24T11:00:00+00:00"
    assert row["clock_out_at"] == "2026-09-24T19:30:00+00:00"
    assert (row["break_minutes"], row["minutes"]) == (30, 480)


async def test_dst_fall_back_reads_the_first_occurrence(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    [row] = (await preview(db, [shift(clock_in="2026-11-01 01:30", clock_out="2026-11-01 09:00")],
                           now=datetime(2026, 11, 2, tzinfo=UTC)))["rows"]
    assert row["clock_in_at"] == "2026-11-01T05:30:00+00:00"
    assert row["shift"] == "Nov 1, 1:30 AM EDT – 9:00 AM EST"
    assert row["minutes"] == 510


@pytest.mark.parametrize(("cells", "message"), [
    ({"worker": ""}, "Worker is required."),
    ({"clock_in": ""}, "Clock-in is required."),
    ({"clock_out": ""}, "Clock-out is required."),
    ({"clock_in": "someday"}, "Clock-in 'someday' is not a date and time this import can read."),
    ({"clock_out": "9/24/2026"},
     "Clock-out '9/24/2026' is not a date and time this import can read."),
    ({"clock_out": "2026-09-24 07:00"}, "Clock-out must be after clock-in."),
    ({"clock_out": "2026-09-25 07:01"}, "The shift is longer than 24 hours."),
    ({"clock_in": "2026-09-25 13:00", "clock_out": "2026-09-25 18:00"},
     "Clock-in is in the future."),
    ({"break_minutes": "abc"}, "The break must be a whole number of minutes, 0 or more."),
    ({"break_minutes": "-5"}, "The break must be a whole number of minutes, 0 or more."),
    ({"break_minutes": "510"}, "The break is as long as the shift or longer."),
])
async def test_row_errors_are_sentences(db, seeded_user, cells, message):
    await worker(db, "Ana", "Lopez")
    [row] = (await preview(db, [shift(**cells)]))["rows"]
    assert row["action"] == "error"
    assert message in row["errors"]


# ── overlaps and duplicates ─────────────────────────────────────────

def utc(day, hour, minute=0, second=0):
    return datetime(2026, 9, day, hour, minute, second, tzinfo=UTC)


async def test_overlaps_with_existing_time(db, seeded_user):
    ana = await worker(db, "Ana", "Lopez")
    cy = await worker(db, "Cy", "Park")
    dee = await worker(db, "Dee", "Moss")
    ben = await worker(db, "Ben", "Ng")
    db.add_all([
        # 6:00–8:00 AM EDT on Sep 24
        TimeEntry(person_id=ana.id, clock_in_at=utc(24, 10), clock_out_at=utc(24, 12),
                  status="approved"),
        TimeEntry(person_id=cy.id, clock_in_at=utc(24, 11), clock_out_at=utc(24, 19),
                  status="rejected"),
        # still open since Sep 23, 10:00 PM EDT
        TimeEntry(person_id=dee.id, clock_in_at=utc(24, 2), status="open"),
        # ends at 7:00 AM EDT, exactly when the imported shift starts
        TimeEntry(person_id=ben.id, clock_in_at=utc(24, 7), clock_out_at=utc(24, 11),
                  status="pending"),
    ])
    await db.commit()
    rows = by_row(await preview(db, [shift(worker=w) for w in (
        "Ana Lopez", "Cy Park", "Dee Moss", "Ben Ng")]))
    assert rows[1]["action"] == "error"
    assert rows[1]["errors"] == [
        "Overlaps Ana Lopez's existing entry on Sep 24, 6:00 AM – 8:00 AM EDT."]
    assert rows[2]["action"] == "add"                  # rejected time is ignored
    assert rows[3]["errors"] == [
        "Overlaps Dee Moss's open entry that started Sep 23, 10:00 PM EDT."]
    assert rows[4]["action"] == "add"                  # touching is not overlapping


async def test_an_exact_repeat_is_already_there(db, seeded_user):
    ana = await worker(db, "Ana", "Lopez")
    ben = await worker(db, "Ben", "Ng")
    db.add_all([
        TimeEntry(person_id=ana.id, clock_in_at=utc(24, 11, 0, 40),
                  clock_out_at=utc(24, 19, 30, 5), status="approved"),
        TimeEntry(person_id=ben.id, clock_in_at=utc(24, 11), clock_out_at=utc(24, 19, 30),
                  status="rejected"),
    ])
    await db.commit()
    res = await preview(db, [shift(), shift(worker="Ben Ng")])
    assert [r["action"] for r in res["rows"]] == ["duplicate", "duplicate"]
    assert res["rows"][0]["detail"] == "Already there."
    assert res["counts"]["duplicate"] == 2
    assert res["can_commit"] is False                 # nothing is left to add


async def test_overlaps_within_the_file(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    await worker(db, "Ben", "Ng")
    rows = by_row(await preview(db, [
        shift(),
        shift(clock_in="2026-09-24 15:00", clock_out="2026-09-24 20:00"),
        shift(worker="Ben Ng"),
        shift(clock_in="2026-09-24 15:30", clock_out="2026-09-24 18:00"),
    ], skip={4}))
    assert rows[1]["errors"] == ["Overlaps row 2 in this file."]
    assert rows[2]["errors"] == ["Overlaps row 1 in this file."]
    assert rows[3]["action"] == "add"
    assert rows[4]["action"] == "skipped"


async def test_counts_order_and_can_commit(db, seeded_user):
    await worker(db, "Ana", "Lopez")
    res = await preview(db, [
        shift(), shift(worker="Nobody"), shift(worker=""),
        shift(clock_in="2026-09-23 07:00", clock_out="2026-09-23 15:00"),
    ], skip={4})
    assert [r["row"] for r in res["rows"]] == [2, 3, 1, 4]
    assert res["counts"] == {"attention": 1, "error": 1, "add": 1, "duplicate": 0,
                             "skipped": 1}
    assert res["can_commit"] is False
    ok = await preview(db, [shift(), shift(worker="Nobody")], skip={2})
    assert ok["can_commit"] is True
```

- [ ] **Step 5: Run them to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_time_bulk /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest tests/test_time_bulk_service.py -v`
Expected: FAIL with `ImportError: cannot import name 'time_bulk'`.

- [ ] **Step 6: Implement** — create `api/src/serversherpa/people/time_bulk.py`:

```python
"""Add time punches in bulk: parse (via imports/bulk) → match worker / job /
site → read the times → preview with per-row overrides and skips → commit.

One row is one shift. Workers match live workers (an active `worker` grant,
not archived) the way the workers tool matches people: an email wins, then
a phone number (digits only), then a name via people/bulk_import.name_keys.
Jobs match non-archived initiatives by name, and sites match non-archived
sites by name or code, case-insensitively. Unknown or ambiguous values leave
the row in `attention` with candidates, until the admin picks one (an
override) or skips the row.

Times are read by people/time_parse in the row's zone: the matched or picked
site's timezone, else the job's site's, else DEFAULT_TIMEZONE. A shift that
overlaps the worker's existing time is an error. An open entry overlaps
everything after its clock-in, and rejected entries are ignored. A shift
that overlaps another row of the file is an error too. An exact repeat of an
existing entry (same worker, same clock-in and clock-out to the minute, any
status) is `duplicate` and is skipped on commit. Imported shifts are added
as pending, source "import"."""

import re
import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from serversherpa.db.models import Initiative, Person, Site, TimeEntry
from serversherpa.imports import bulk as core
from serversherpa.people import time_parse as tp
from serversherpa.people.bulk_import import _worker_query, name_keys, normalize_phone
from serversherpa.services.timezone import stored_day

COLUMNS = ["worker", "clock_in", "clock_out", "break_minutes", "job", "site", "notes"]
SHEET = "Time"
FIELDS = ("worker", "job", "site")
MAX_ROWS = 5000
MAX_BYTES = 5 * 1024 * 1024
MAX_SHIFT = timedelta(hours=24)
# The preview lists problems first.
ACTION_ORDER = ("attention", "error", "add", "duplicate", "skipped")
SAMPLE_ROWS: list[dict] = [
    {"worker": "Marcus Reyes", "clock_in": "9/24/2026 7:00 AM",
     "clock_out": "9/24/2026 3:30 PM", "break_minutes": "30", "job": "Example Move",
     "site": "Example DC West", "notes": "Sample row — replace me"},
    {"worker": "dana.whitfield@example.com", "clock_in": "2026-09-24T22:00:00-05:00",
     "clock_out": "2026-09-25T06:00:00-05:00", "break_minutes": "", "job": "", "site": "",
     "notes": ""},
]
_PHONEISH = re.compile(r"^[\d\s()+.\-]+$")


# ── parsing ─────────────────────────────────────────────────────────

def number_json_rows(rows: Any) -> list[tuple[int, dict]]:
    return core.number_json_rows(rows, COLUMNS, max_rows=MAX_ROWS)


def number_posted_rows(rows: Any, row_numbers: Any) -> list[tuple[int, dict]]:
    return core.renumber(number_json_rows(rows), row_numbers)


def parse_upload(filename: str, content: bytes) -> list[tuple[int, dict]]:
    return core.parse_upload(filename, content, COLUMNS, SHEET,
                             max_rows=MAX_ROWS, max_bytes=MAX_BYTES)


def parse_overrides(raw: Any) -> dict[int, dict[str, str]]:
    return core.parse_overrides(raw, FIELDS)


def parse_row_list(raw: Any, code: str) -> set[int]:
    return core.parse_row_list(raw, code)


# ── reference data ──────────────────────────────────────────────────

def _squash(value: str) -> str:
    return " ".join((value or "").split()).casefold()


def _worker_label(p: Person) -> str:
    return f"{p.first_name} {p.last_name}"


def _index(index: dict, key: str, obj) -> None:
    if key:
        index.setdefault(key, []).append(obj)


async def _reference(db: AsyncSession) -> dict:
    workers = list({p.id: p for p, _ in (await db.execute(_worker_query())).all()}.values())
    email: dict[str, list[Person]] = {}
    phone: dict[str, list[Person]] = {}
    name: dict[str, list[Person]] = {}
    for p in workers:
        _index(email, (p.email or "").casefold(), p)
        _index(phone, normalize_phone(p.phone or ""), p)
        for key in name_keys(p.first_name, p.last_name, p.preferred_name or ""):
            _index(name, key, p)
    jobs = list(await db.scalars(
        select(Initiative).where(Initiative.archived_at.is_(None)).order_by(Initiative.name)))
    job_index: dict[str, list[Initiative]] = {}
    for j in jobs:
        _index(job_index, _squash(j.name), j)
    sites = list(await db.scalars(
        select(Site).where(Site.archived_at.is_(None)).order_by(Site.name)))
    site_index: dict[str, list[Site]] = {}
    for s in sites:
        for key in {_squash(s.name), _squash(s.code or "")}:
            _index(site_index, key, s)
    return {
        "email": email, "phone": phone, "name": name, "job": job_index, "site": site_index,
        "by_id": {"worker": {str(p.id): p for p in workers},
                  "job": {str(j.id): j for j in jobs},
                  "site": {str(s.id): s for s in sites}},
        # every site, archived too: a job's site can be archived and still
        # say which wall clock the job worked on
        "zones": dict((await db.execute(select(Site.id, Site.timezone))).all()),
    }


def _candidate(field: str, obj) -> dict:
    if field == "worker":
        return {"id": str(obj.id), "label": _worker_label(obj),
                "detail": obj.email or obj.phone or ""}
    if field == "job":
        day = stored_day(obj.scheduled_start) if obj.scheduled_start else None
        return {"id": str(obj.id), "label": obj.name,
                "detail": f"Starts {day:%b} {day.day}, {day.year}" if day else ""}
    return {"id": str(obj.id), "label": obj.name, "detail": obj.code or ""}


def _matches(ref: dict, field: str, cell: str) -> tuple[list, str]:
    """Every record this cell names, and how it matched. A worker cell with
    an @ is an email; a phone-looking one matches by phone and falls back to
    name when no phone matches; anything else is a name."""
    value = cell.strip()
    if field != "worker":
        return ref[field].get(_squash(value), []), "name"
    if "@" in value:
        return ref["email"].get(value.casefold(), []), "email"
    key = normalize_phone(value) if _PHONEISH.match(value) else ""
    if key and ref["phone"].get(key):
        return ref["phone"][key], "phone"
    return ref["name"].get(_squash(value), []), "name"


def _resolve(ref: dict, field: str, cell: str, picked: str | None,
             issues: list[dict], errors: list[str]) -> tuple[Any, str | None]:
    """(record, matched_by). The admin's pick wins; otherwise exactly one
    match. Unknown or ambiguous → an issue with candidates; a pick that
    points at nothing → an error. (None, None) when blank or unresolved."""
    if picked:
        obj = ref["by_id"][field].get(picked)
        if obj is None:
            errors.append(f"The chosen {field} no longer exists. Pick again.")
            return None, None
        return obj, "your pick"
    if not cell:
        return None, None
    found, how = _matches(ref, field, cell)
    unique = list({m.id: m for m in found}.values())
    if len(unique) == 1:
        return unique[0], how
    issues.append({"field": field, "kind": "ambiguous" if unique else "unknown",
                   "value": cell, "candidates": [_candidate(field, m) for m in unique]})
    return None, None


def _zone(ref: dict, site: Site | None, job: Initiative | None) -> ZoneInfo:
    """The row's wall clock: its own site's zone; with no site, the job's
    site's; otherwise (or when that zone is blank or unknown) the default."""
    if site is not None:
        return tp.zone_for(site.timezone)
    if job is not None and job.site_id is not None:
        return tp.zone_for(ref["zones"].get(job.site_id))
    return tp.zone_for(None)


# ── times ───────────────────────────────────────────────────────────

def _read_times(cells: dict, zone: ZoneInfo, now: datetime, errors: list[str],
                ) -> tuple[datetime | None, datetime | None, int | None]:
    """(clock-in, clock-out, break). The two times come back only when they
    form a usable span (clock-out after clock-in, at most 24 hours); each
    problem is appended to `errors` as a sentence."""
    times: dict[str, datetime | None] = {}
    for key, label in (("clock_in", "Clock-in"), ("clock_out", "Clock-out")):
        raw = cells[key]
        times[key] = None
        if not raw:
            errors.append(f"{label} is required.")
            continue
        times[key] = tp.parse_clock(raw, zone)
        if times[key] is None:
            errors.append(f"{label} '{raw}' is not a date and time this import can read.")
    start, end = times["clock_in"], times["clock_out"]
    brk = tp.parse_break(cells["break_minutes"])
    if brk is None:
        errors.append("The break must be a whole number of minutes, 0 or more.")
    if start is not None and start > now:
        errors.append("Clock-in is in the future.")
    if start is None or end is None:
        return None, None, brk
    if end <= start:
        errors.append("Clock-out must be after clock-in.")
        return None, None, brk
    if end - start > MAX_SHIFT:
        errors.append("The shift is longer than 24 hours.")
        return None, None, brk
    if brk is not None and brk >= int((end - start).total_seconds() // 60):
        errors.append("The break is as long as the shift or longer.")
    return start, end, brk


def _minute(at: datetime) -> datetime:
    return at.astimezone(UTC).replace(second=0, microsecond=0)


def _same_shift(e: TimeEntry, start: datetime, end: datetime) -> bool:
    return (e.clock_out_at is not None and _minute(e.clock_in_at) == _minute(start)
            and _minute(e.clock_out_at) == _minute(end))


async def _check_existing(db: AsyncSession, rows: list[dict],
                          spans: dict[int, tuple[datetime, datetime, ZoneInfo]]) -> None:
    """Against the database: an exact repeat becomes `duplicate` (and leaves
    `spans`, so it cannot clash with another row); anything else that meets
    the worker's non-rejected time is an error naming that entry."""
    if not spans:
        return
    by_row = {r["row"]: r for r in rows}
    people = {uuid.UUID(by_row[n]["person_id"]) for n in spans}
    lo = min(s for s, _, _ in spans.values())
    hi = max(e for _, e, _ in spans.values())
    existing: dict[str, list[TimeEntry]] = {}
    for e in await db.scalars(
            select(TimeEntry).where(
                TimeEntry.person_id.in_(people), TimeEntry.clock_in_at < hi,
                or_(TimeEntry.clock_out_at.is_(None), TimeEntry.clock_out_at > lo))
            .order_by(TimeEntry.clock_in_at)):
        existing.setdefault(str(e.person_id), []).append(e)
    for n in list(spans):
        row = by_row[n]
        start, end, zone = spans[n]
        mine = existing.get(row["person_id"], [])
        if not row["errors"] and not row["issues"] and any(
                _same_shift(e, start, end) for e in mine):
            row["action"] = "duplicate"
            row["detail"] = "Already there."
            del spans[n]
            continue
        who = row["person_name"]
        for e in mine:
            if e.status == "rejected":
                continue
            if e.clock_out_at is None:
                if e.clock_in_at < end:
                    row["errors"].append(f"Overlaps {who}'s open entry that started "
                                         f"{tp.clock_text(e.clock_in_at, zone)}.")
            elif e.clock_in_at < end and start < e.clock_out_at:
                row["errors"].append(f"Overlaps {who}'s existing entry on "
                                     f"{tp.shift_text(e.clock_in_at, e.clock_out_at, zone)}.")


def _check_file(rows: list[dict], spans: dict[int, tuple[datetime, datetime, ZoneInfo]]) -> None:
    """Within the file: two of one worker's rows whose spans overlap are
    both errors, each naming the other."""
    by_row = {r["row"]: r for r in rows}
    groups: dict[str, list[int]] = {}
    for n in spans:
        groups.setdefault(by_row[n]["person_id"], []).append(n)
    for ns in groups.values():
        ns.sort(key=lambda n: spans[n][0])
        for i, a in enumerate(ns):
            for b in ns[i + 1:]:
                if spans[b][0] >= spans[a][1]:
                    break
                by_row[a]["errors"].append(f"Overlaps row {b} in this file.")
                by_row[b]["errors"].append(f"Overlaps row {a} in this file.")


# ── preview ─────────────────────────────────────────────────────────

def _blank_row(n: int, cells: dict) -> dict:
    return {"row": n, "name": cells["worker"] or None, "person_id": None,
            "person_name": None, "matched_by": None, "job_id": None, "job_name": None,
            "site_id": None, "site_name": None, "zone": None, "clock_in_at": None,
            "clock_out_at": None, "break_minutes": None, "minutes": None, "shift": None,
            "notes": cells["notes"], "action": None, "errors": [], "issues": [],
            "detail": None, "cells": cells}


async def preview_rows(db: AsyncSession, numbered: list[tuple[int, dict]], *,
                       overrides: dict[int, dict[str, str]] | None = None,
                       skip: set[int] | None = None, now: datetime | None = None) -> dict:
    """The preview: every row with its action, problems first. `now` is
    injectable so tests can pin what "in the future" means."""
    ref = await _reference(db)
    overrides = overrides or {}
    skip = skip or set()
    now = now or datetime.now(UTC)
    out: list[dict] = []
    spans: dict[int, tuple[datetime, datetime, ZoneInfo]] = {}
    for n, cells in numbered:
        row = _blank_row(n, cells)
        out.append(row)
        if n in skip:
            row["action"] = "skipped"
            continue
        picks = overrides.get(n, {})
        errors, issues = row["errors"], row["issues"]
        if not cells["worker"] and not picks.get("worker"):
            errors.append("Worker is required.")
            person, how = None, None
        else:
            person, how = _resolve(ref, "worker", cells["worker"], picks.get("worker"),
                                   issues, errors)
        job, _ = _resolve(ref, "job", cells["job"], picks.get("job"), issues, errors)
        site, _ = _resolve(ref, "site", cells["site"], picks.get("site"), issues, errors)
        zone = _zone(ref, site, job)
        start, end, brk = _read_times(cells, zone, now, errors)
        row.update(zone=zone.key, break_minutes=brk, matched_by=how,
                   job_id=str(job.id) if job else None, job_name=job.name if job else None,
                   site_id=str(site.id) if site else None,
                   site_name=site.name if site else None)
        if person is not None:
            row.update(person_id=str(person.id), person_name=_worker_label(person),
                       name=_worker_label(person))
        if start is not None and end is not None:
            span = int((end - start).total_seconds() // 60)
            row.update(clock_in_at=start.isoformat(), clock_out_at=end.isoformat(),
                       shift=tp.shift_text(start, end, zone),
                       minutes=max(0, span - (brk or 0)))
            if person is not None:
                spans[n] = (start, end, zone)
    await _check_existing(db, out, spans)
    _check_file(out, spans)
    counts = dict.fromkeys(ACTION_ORDER, 0)
    for row in out:
        if row["action"] is None:
            row["action"] = ("error" if row["errors"]
                             else "attention" if row["issues"] else "add")
        counts[row["action"]] += 1
    out.sort(key=lambda r: (ACTION_ORDER.index(r["action"]), r["row"]))
    return {"rows": out, "counts": counts,
            "can_commit": counts["add"] > 0 and counts["attention"] == 0
            and counts["error"] == 0}


# ── template ────────────────────────────────────────────────────────

def build_template_csv() -> str:
    return core.build_rows_csv(SAMPLE_ROWS, COLUMNS)


async def build_template_xlsx(db: AsyncSession) -> bytes:
    workers = [_worker_label(p) for p, _ in (await db.execute(_worker_query())).all()]
    jobs = list(await db.scalars(select(Initiative.name).where(
        Initiative.archived_at.is_(None)).order_by(Initiative.name)))
    sites = list(await db.scalars(select(Site.name).where(
        Site.archived_at.is_(None)).order_by(Site.name)))
    return core.build_rows_xlsx(SAMPLE_ROWS, COLUMNS, SHEET, [
        ("Workers", workers), ("Jobs", jobs), ("Sites", sites)])
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_time_bulk /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest tests/test_time_bulk_service.py tests/test_time_parse.py tests/test_bulk_core.py tests/test_team_bulk_service.py tests/test_team_bulk_api.py -v`
Expected: all PASS. Then from `api/`: `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/ruff check src/serversherpa/people src/serversherpa/imports/bulk.py tests/test_time_bulk_service.py tests/test_bulk_core.py` → `All checks passed!`

- [ ] **Step 8: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk
git add api/src/serversherpa/imports/bulk.py api/src/serversherpa/people/team_bulk.py api/src/serversherpa/people/time_bulk.py api/tests/test_bulk_core.py api/tests/test_time_bulk_service.py
git commit -F - <<'EOF'
feat(api): time punch import service — worker/job/site matching, site time zones, row errors, overlaps, duplicates, template

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: API — import routes and the all-or-nothing commit

**Files:**
- Modify: `api/src/serversherpa/people/time_bulk.py` (add `commit_rows`)
- Create: `api/src/serversherpa/api/routes/time_bulk.py`
- Modify: `api/src/serversherpa/api/app.py` (import and `include_router`)
- Test: `api/tests/test_time_bulk_import_api.py` (create)

**Interfaces:**
- Consumes: Task 3's `time_bulk.preview_rows`, `parse_upload`, `number_posted_rows`, `parse_overrides`, `parse_row_list`, `build_template_csv`, `build_template_xlsx`; `api/bulk_routes.require_bulk_rank`, `bulk_http_error`; `test_time_bulk_service.worker`.
- Produces:
  - `async time_bulk.commit_rows(db, actor_id, numbered, *, overrides, skip, source_label, now=None) -> {"summary": {"added": int, "skipped": int}, "rows": [{"row", "name", "entry_id", "action": "created"|"skipped", "detail"}]}`; raises `BulkImportError("rows_invalid", rows=[attention/error rows])`
  - `GET /time/bulk/template?format=csv|xlsx` (filenames `time-template.csv` / `time-template.xlsx`; else 422 `unknown_format`)
  - `POST /time/bulk/preview` → the Task 3 preview
  - `POST /time/bulk/commit` (JSON only, else 422 `invalid_json`) → the commit result, or 422 `rows_invalid`

- [ ] **Step 1: Write the failing tests** — create `api/tests/test_time_bulk_import_api.py`:

```python
"""Add time punches in bulk — the /time/bulk routes: gates, template,
preview, the all-or-nothing commit, and the overlap re-check at commit."""
import io
from datetime import UTC, datetime

import openpyxl
import pytest
from sqlalchemy import select, text

from serversherpa.db.models import AuditLog, Person, PersonRole, TimeEntry

from .test_assets_api import login, make_login
from .test_time_bulk_service import worker

BASE = "/time/bulk"
HEADER = "worker,clock_in,clock_out,break_minutes,job,site,notes"


@pytest.fixture
async def admin(db):
    person = Person(first_name="Ada", last_name="Admin", email="ada@test.example.com")
    db.add(person)
    await db.flush()
    db.add(PersonRole(person_id=person.id, role="admin"))
    await db.commit()
    return person


@pytest.fixture
async def admin_hdrs(db, client, admin):
    return await make_login(db, client, admin, "ada@test.example.com")


def csv_file(*lines: str) -> dict:
    body = "\n".join([HEADER, *lines]) + "\n"
    return {"file": ("time.csv", body.encode(), "text/csv")}


def two_days() -> dict:
    return {"rows": [
        {"worker": "Ana Lopez", "clock_in": "6/1/2026 7:00 AM", "clock_out": "6/1/2026 3:30 PM"},
        {"worker": "Ana Lopez", "clock_in": "6/2/2026 7:00 AM", "clock_out": "6/2/2026 3:30 PM"},
    ]}


async def imported(db) -> list[TimeEntry]:
    return list(await db.scalars(select(TimeEntry).where(TimeEntry.source == "import")))


async def test_rank_and_time_add_are_both_required(client, db, seeded_user, admin_hdrs):
    staff = await login(client)

    async def statuses(hdrs):
        return [
            (await client.get(f"{BASE}/template?format=csv", headers=hdrs)).status_code,
            (await client.post(f"{BASE}/preview", headers=hdrs,
                               json={"rows": [{"worker": "X"}]})).status_code,
            (await client.post(f"{BASE}/commit", headers=hdrs,
                               json={"rows": [{"worker": "X"}]})).status_code,
        ]

    assert await statuses(staff) == [403, 403, 403]
    # time:add alone is not enough — bulk import needs admin rank
    await db.execute(text("INSERT INTO role_permissions (role, resource, action) "
                          "VALUES ('staff', 'time', 'add')"))
    await db.commit()
    assert await statuses(staff) == [403, 403, 403]
    # and admin rank without time:add is not enough either
    await db.execute(text("DELETE FROM role_permissions "
                          "WHERE role = 'admin' AND resource = 'time' AND action = 'add'"))
    await db.commit()
    assert await statuses(admin_hdrs) == [403, 403, 403]


async def test_template_formats(client, db, seeded_user, admin_hdrs):
    await worker(db, "Ana", "Lopez")
    resp = await client.get(f"{BASE}/template?format=csv", headers=admin_hdrs)
    assert resp.status_code == 200
    assert resp.headers["content-disposition"] == 'attachment; filename="time-template.csv"'
    assert resp.text.splitlines()[0] == HEADER
    xlsx = await client.get(f"{BASE}/template?format=xlsx", headers=admin_hdrs)
    assert xlsx.headers["content-disposition"] == 'attachment; filename="time-template.xlsx"'
    wb = openpyxl.load_workbook(io.BytesIO(xlsx.content))
    assert wb.sheetnames == ["Time", "Reference"]
    assert "Ana Lopez" in [c.value for c in wb["Reference"]["A"]]
    assert (await client.get(f"{BASE}/template?format=pdf", headers=admin_hdrs)).status_code == 422


async def test_file_preview_then_json_commit_adds_pending_import_entries(
        client, db, seeded_user, admin, admin_hdrs):
    ana = await worker(db, "Ana", "Lopez")
    resp = await client.post(f"{BASE}/preview", headers=admin_hdrs, files=csv_file(
        "Ana Lopez,6/1/2026 7:00 AM,6/1/2026 3:30 PM,30,,,first day",
        "Nobody Here,6/1/2026 7:00 AM,6/1/2026 3:30 PM,,,,"))
    assert resp.status_code == 200, resp.text
    rows = sorted(resp.json()["rows"], key=lambda r: r["row"])
    assert [(r["row"], r["action"]) for r in rows] == [(2, "add"), (3, "attention")]
    body = {"rows": [r["cells"] for r in rows], "row_numbers": [2, 3], "skip": [3],
            "overrides": {}}
    again = await client.post(f"{BASE}/preview", headers=admin_hdrs, json=body)
    assert again.json()["can_commit"] is True

    done = await client.post(f"{BASE}/commit", headers=admin_hdrs,
                             json={**body, "source": "time.csv"})
    assert done.status_code == 200, done.text
    out = done.json()
    assert out["summary"] == {"added": 1, "skipped": 1}
    [entry] = await imported(db)
    assert [(r["row"], r["action"], r["entry_id"]) for r in out["rows"]] == [
        (2, "created", str(entry.id)), (3, "skipped", None)]
    assert out["rows"][0]["detail"] == "Jun 1, 7:00 AM – 3:30 PM EDT"
    assert (entry.person_id, entry.status, entry.source) == (ana.id, "pending", "import")
    assert (entry.break_minutes, entry.notes, entry.adjusted) == (30, "first day", False)
    assert entry.created_by == admin.id
    assert entry.clock_in_at == datetime(2026, 6, 1, 11, 0, tzinfo=UTC)
    audits = list(await db.scalars(select(AuditLog).where(
        AuditLog.entity_type == "time_entry")))
    assert sorted(a.action for a in audits) == ["bulk_import", "import"]
    per_entry = next(a for a in audits if a.action == "import")
    assert per_entry.entity_id == str(entry.id)
    assert per_entry.changes == {"status": {"from": None, "to": "pending"}}
    summary = next(a for a in audits if a.action == "bulk_import")
    assert summary.entity_id is None
    assert summary.changes == {"added": 1, "skipped": 1, "source": "time.csv"}


async def test_commit_is_all_or_nothing(client, db, seeded_user, admin_hdrs):
    await worker(db, "Ana", "Lopez")
    body = two_days()
    body["rows"][1]["clock_out"] = "6/2/2026 7:00 AM"
    resp = await client.post(f"{BASE}/commit", headers=admin_hdrs, json=body)
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "rows_invalid"
    assert [(r["row"], r["errors"]) for r in detail["rows"]] == [
        (2, ["Clock-out must be after clock-in."])]
    assert await imported(db) == []


async def test_commit_rechecks_overlaps_and_refuses_the_run(client, db, seeded_user, admin_hdrs):
    ana = await worker(db, "Ana", "Lopez")
    body = two_days()
    assert (await client.post(f"{BASE}/preview", headers=admin_hdrs,
                              json=body)).json()["can_commit"] is True
    # a kiosk punch lands between the preview and the commit
    db.add(TimeEntry(person_id=ana.id, clock_in_at=datetime(2026, 6, 2, 12, 0, tzinfo=UTC),
                     clock_out_at=datetime(2026, 6, 2, 14, 0, tzinfo=UTC),
                     status="pending", source="kiosk"))
    await db.commit()
    resp = await client.post(f"{BASE}/commit", headers=admin_hdrs, json=body)
    assert resp.status_code == 422
    detail = resp.json()["detail"]
    assert detail["code"] == "rows_invalid"
    assert [r["row"] for r in detail["rows"]] == [2]
    assert detail["rows"][0]["errors"] == [
        "Overlaps Ana Lopez's existing entry on Jun 2, 8:00 AM – 10:00 AM EDT."]
    assert await imported(db) == []


async def test_an_exact_repeat_is_skipped_as_already_there(client, db, seeded_user, admin_hdrs):
    ana = await worker(db, "Ana", "Lopez")
    db.add(TimeEntry(person_id=ana.id, clock_in_at=datetime(2026, 6, 1, 11, 0, tzinfo=UTC),
                     clock_out_at=datetime(2026, 6, 1, 19, 30, tzinfo=UTC), status="approved"))
    await db.commit()
    resp = await client.post(f"{BASE}/commit", headers=admin_hdrs, json=two_days())
    assert resp.status_code == 200, resp.text
    out = resp.json()
    assert out["summary"] == {"added": 1, "skipped": 1}
    assert (out["rows"][0]["row"], out["rows"][0]["action"], out["rows"][0]["detail"]) == (
        1, "skipped", "Already there.")
    assert len(await imported(db)) == 1


async def test_bad_bodies_are_422(client, db, seeded_user, admin_hdrs):
    for body, code in (
        ({"rows": [{"worker": "X"}], "row_numbers": [1, 2]}, "invalid_row_numbers"),
        ({"rows": [{"worker": "X"}], "overrides": {"1": {"role": "x"}}}, "invalid_overrides"),
        ({"rows": [{"worker": "X"}], "skip": "all"}, "invalid_skip"),
        ({"rows": [{"shift": "X"}]}, "unknown_columns"),
    ):
        resp = await client.post(f"{BASE}/preview", headers=admin_hdrs, json=body)
        assert resp.status_code == 422 and resp.json()["detail"]["code"] == code, body
    resp = await client.post(f"{BASE}/commit", headers=admin_hdrs, files=csv_file(
        "Ana Lopez,6/1/2026 7:00 AM,6/1/2026 3:30 PM,,,,"))
    assert resp.status_code == 422 and resp.json()["detail"]["code"] == "invalid_json"
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_time_bulk /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest tests/test_time_bulk_import_api.py -v`
Expected: FAIL. `/time/bulk/*` returns 404 and `commit_rows` does not exist.

- [ ] **Step 3: The commit** — in `api/src/serversherpa/people/time_bulk.py`:
  - Change the SQLAlchemy import to `from sqlalchemy import or_, select, text`.
  - Add `from serversherpa.imports.bulk import BulkImportError` and `from serversherpa.services.audit import audit`.
  - Add, between the preview and template sections:

```python
# ── commit ──────────────────────────────────────────────────────────

async def commit_rows(db: AsyncSession, actor_id: uuid.UUID,
                      numbered: list[tuple[int, dict]], *,
                      overrides: dict[int, dict[str, str]], skip: set[int],
                      source_label: str, now: datetime | None = None) -> dict:
    """All-or-nothing. First takes a SHARE ROW EXCLUSIVE lock on
    time_entries. That lock conflicts with the ROW EXCLUSIVE lock every
    INSERT / UPDATE takes (a kiosk clock-in, a clock-out, an edit, an
    approval) and with itself. So no other write to time_entries can commit
    between the overlap re-check below and this commit, and two imports run
    one after the other; plain reads are not blocked. A row lock would not
    do: SELECT … FOR UPDATE on the workers' entries cannot stop a concurrent
    INSERT of a new, overlapping one.

    Then it re-runs the preview with the same picks and skips, and refuses
    (rows_invalid, nothing written) unless the result can be committed. This
    is where a shift punched at a kiosk since the preview becomes an overlap
    error naming its row. Each `add` row becomes one pending `import` entry
    with its own audit row, plus one bulk_import summary row."""
    await db.execute(text("LOCK TABLE time_entries IN SHARE ROW EXCLUSIVE MODE"))
    preview = await preview_rows(db, numbered, overrides=overrides, skip=skip, now=now)
    if not preview["can_commit"]:
        await db.rollback()
        raise BulkImportError("rows_invalid", rows=[
            r for r in preview["rows"] if r["action"] in ("attention", "error")])
    applied: list[dict] = []
    added = skipped = 0
    for r in sorted(preview["rows"], key=lambda r: r["row"]):
        if r["action"] != "add":
            skipped += 1
            applied.append({"row": r["row"], "name": r["name"], "entry_id": None,
                            "action": "skipped", "detail": r["detail"] or "Skipped."})
            continue
        entry_id = uuid.uuid4()
        db.add(TimeEntry(
            id=entry_id, person_id=uuid.UUID(r["person_id"]),
            initiative_id=uuid.UUID(r["job_id"]) if r["job_id"] else None,
            site_id=uuid.UUID(r["site_id"]) if r["site_id"] else None,
            clock_in_at=datetime.fromisoformat(r["clock_in_at"]),
            clock_out_at=datetime.fromisoformat(r["clock_out_at"]),
            break_minutes=r["break_minutes"], notes=r["notes"], status="pending",
            source="import", created_by=actor_id, adjusted=False))
        audit(db, actor_id=actor_id, entity_type="time_entry", entity_id=str(entry_id),
              action="import", changes={"status": {"from": None, "to": "pending"}})
        added += 1
        applied.append({"row": r["row"], "name": r["name"], "entry_id": str(entry_id),
                        "action": "created", "detail": r["shift"]})
    audit(db, actor_id=actor_id, entity_type="time_entry", entity_id=None,
          action="bulk_import",
          changes={"added": added, "skipped": skipped, "source": source_label})
    await db.commit()
    return {"summary": {"added": added, "skipped": skipped}, "rows": applied}
```

- [ ] **Step 4: The routes** — create `api/src/serversherpa/api/routes/time_bulk.py`:

```python
"""Bulk Actions › Add time punches in bulk: template, preview, commit.
Admin rank and up (require_bulk_rank, which also requires a global actor)
plus time:add. The work lives in people/time_bulk.py."""

from fastapi import APIRouter, HTTPException, Request, Response

from serversherpa.api.bulk_routes import bulk_http_error, require_bulk_rank
from serversherpa.api.deps import AuthContext, DbSession, require_permission
from serversherpa.imports.bulk import BulkImportError
from serversherpa.people import time_bulk

router = APIRouter(prefix="/time/bulk", tags=["time"])

_XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"


def _err(status: int, code: str, **extra) -> HTTPException:
    return HTTPException(status_code=status, detail={"code": code, **extra})


def _attachment(filename: str) -> dict[str, str]:
    return {"Content-Disposition": f'attachment; filename="{filename}"'}


async def _body(request: Request) -> tuple[list, dict, set, dict]:
    """(numbered rows, overrides, skip, raw body). Multipart is the first
    file preview, with no picks yet. JSON is a re-preview or the commit,
    re-posting the preview's cells with the spreadsheet row numbers."""
    try:
        if request.headers.get("content-type", "").startswith("multipart/"):
            form = await request.form()
            upload = form.get("file")
            if upload is None or isinstance(upload, str):
                raise BulkImportError("missing_file")
            numbered = time_bulk.parse_upload(upload.filename or "", await upload.read())
            return numbered, {}, set(), {}
        body = await request.json()
        if not isinstance(body, dict):
            raise BulkImportError("invalid_json")
        numbered = time_bulk.number_posted_rows(body.get("rows"), body.get("row_numbers"))
        overrides = time_bulk.parse_overrides(body.get("overrides"))
        skip = time_bulk.parse_row_list(body.get("skip"), "invalid_skip")
        return numbered, overrides, skip, body
    except BulkImportError as exc:
        raise bulk_http_error(exc) from None
    except ValueError:
        raise _err(422, "invalid_json") from None


@router.get("/template")
async def time_bulk_template(
    db: DbSession, format: str = "csv",
    actor: AuthContext = require_permission("time", "add"),
):
    require_bulk_rank(actor)
    if format == "csv":
        return Response(time_bulk.build_template_csv(), media_type="text/csv",
                        headers=_attachment("time-template.csv"))
    if format == "xlsx":
        return Response(await time_bulk.build_template_xlsx(db), media_type=_XLSX,
                        headers=_attachment("time-template.xlsx"))
    raise _err(422, "unknown_format")


@router.post("/preview")
async def time_bulk_preview(
    request: Request, db: DbSession,
    actor: AuthContext = require_permission("time", "add"),
) -> dict:
    require_bulk_rank(actor)
    numbered, overrides, skip, _ = await _body(request)
    return await time_bulk.preview_rows(db, numbered, overrides=overrides, skip=skip)


@router.post("/commit")
async def time_bulk_commit(
    request: Request, db: DbSession,
    actor: AuthContext = require_permission("time", "add"),
) -> dict:
    require_bulk_rank(actor)
    if not request.headers.get("content-type", "").startswith("application/json"):
        raise _err(422, "invalid_json")
    numbered, overrides, skip, body = await _body(request)
    try:
        return await time_bulk.commit_rows(
            db, actor.person.id, numbered, overrides=overrides, skip=skip,
            source_label=str(body.get("source") or "upload"))
    except BulkImportError as exc:
        raise bulk_http_error(exc) from None
```

In `api/src/serversherpa/api/app.py`:
  - Add `time_bulk as time_bulk_routes,` to the `from serversherpa.api.routes import (...)` tuple, right after `time as time_routes,`.
  - Add `app.include_router(time_bulk_routes.router)` right after `app.include_router(time_routes.router)`.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/api && PYTHONPATH=src SS_TEST_DB=serversherpa_test_time_bulk /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest tests/test_time_bulk_import_api.py tests/test_time_bulk_service.py tests/test_time_bulk_approve_api.py tests/test_time_api.py -v`
Expected: all PASS. Then from `api/`: `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/ruff check src/serversherpa/api/routes/time_bulk.py src/serversherpa/api/app.py src/serversherpa/people/time_bulk.py tests/test_time_bulk_import_api.py` → `All checks passed!`

- [ ] **Step 6: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk
git add api/src/serversherpa/people/time_bulk.py api/src/serversherpa/api/routes/time_bulk.py api/src/serversherpa/api/app.py api/tests/test_time_bulk_import_api.py
git commit -F - <<'EOF'
feat(api): /time/bulk template, preview and all-or-nothing commit — table lock, overlap re-check, audits

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Portal — Timesheet server-side filters, bulk client, helpers

**Files:**
- Modify: `portal/src/lib/api.ts` (time section, about lines 2649-2785)
- Create: `portal/src/lib/timeBulk.ts`, `portal/src/lib/timeBulk.test.ts`
- Modify: `portal/src/components/time/TimeEntryEditModal.tsx` (`TIME_ERRORS`)
- Modify: `portal/src/pages/TimeManagement.tsx`, `portal/src/styles/time.css`
- Test: `portal/src/pages/TimeManagement.test.tsx` (extend)

**Interfaces:**
- Consumes: Task 1's endpoints.
- Produces:
  - `lib/api.ts`: `listTimeEntries(q)` accepts `site_id?`
  - `lib/api.ts` types: `TimeBulkFilter { person_id?, initiative_id?, site_id?, from?, to? }`, `TimeBulkSkip { entry_id: string; person: string | null; date: string | null; reason: string }`, `TimeBulkApproveResult { approved; skipped }`, `TimeBulkRejectResult { rejected; skipped }`, `TimeBulkTarget = { entry_ids: string[] } | { filter: TimeBulkFilter }`
  - `lib/api.ts` calls: `bulkApproveTimeEntries(target): Promise<TimeBulkApproveResult>`, `countBulkApproveTimeEntries(target): Promise<number>`, `bulkRejectTimeEntries(entryIds: string[], reason: string): Promise<TimeBulkRejectResult>`
  - `lib/timeBulk.ts`: `TIME_SOURCE_LABEL`, `timeSourceLabel(source)`, `TimesheetFilter`, `NO_FILTER`, `hasFilter(f)`, `dayStartIso(day)`, `dayEndIso(day)`, `bulkFilter(f): TimeBulkFilter`, `listQuery(status, f)`, `entriesText(n)`, `skipSummary(skipped)`, `bulkResultText(verb, done, skipped)`, `approveAllQuestion(n)`
  - `TIME_ERRORS` codes `too_many`, `reason_required`, `ids_or_filter`
  - `TimeManagement.tsx` state: `serverFilter: TimesheetFilter`, `setServerFilter`

- [ ] **Step 1: Write the failing helper tests** — create `portal/src/lib/timeBulk.test.ts`:

```ts
import { expect, it } from 'vitest';

import {
  approveAllQuestion, bulkFilter, bulkResultText, dayEndIso, dayStartIso, entriesText, hasFilter,
  listQuery, NO_FILTER, timeSourceLabel,
} from './timeBulk';

it('labels every time source, Import included', () => {
  expect(timeSourceLabel('import')).toBe('Import');
  expect(timeSourceLabel('kiosk')).toBe('Kiosk');
  expect(timeSourceLabel('manual')).toBe('Manual');
  expect(timeSourceLabel('punch')).toBe('Punch');
  expect(timeSourceLabel('api')).toBe('Api');
});

it('turns the filters into the list query and the bulk filter', () => {
  const f = { ...NO_FILTER, person_id: 'p1', from: '2026-09-01', to: '2026-09-15' };
  expect(hasFilter(NO_FILTER)).toBe(false);
  expect(hasFilter(f)).toBe(true);
  expect(dayStartIso('2026-09-01')).toBe(new Date(2026, 8, 1).toISOString());
  expect(dayEndIso('2026-09-15')).toBe(new Date(2026, 8, 15, 23, 59, 59, 999).toISOString());
  expect(dayStartIso('')).toBeUndefined();
  expect(bulkFilter(f)).toEqual({
    person_id: 'p1', from: dayStartIso('2026-09-01'), to: dayEndIso('2026-09-15'),
  });
  expect(bulkFilter(NO_FILTER)).toEqual({});
  expect(listQuery('pending', f)).toEqual({
    status: 'pending', person_id: 'p1', since: dayStartIso('2026-09-01'),
    until: dayEndIso('2026-09-15'),
  });
  expect(listQuery('all', NO_FILTER)).toEqual({});
});

it('writes the result and question sentences', () => {
  const skip = (reason: string) => ({ entry_id: 'x', person: null, date: null, reason });
  expect(entriesText(1)).toBe('1 entry');
  expect(entriesText(5000)).toBe('5,000 entries');
  expect(bulkResultText('Approved', 212, [skip('your own entry'), skip('no longer pending')]))
    .toBe('Approved 212 entries. Skipped 2: your own entry (1), no longer pending (1).');
  expect(bulkResultText('Rejected', 1, [])).toBe('Rejected 1 entry.');
  expect(bulkResultText('Approved', 3,
    [skip('not found'), skip('no longer pending'), skip('no longer pending')]))
    .toBe('Approved 3 entries. Skipped 3: no longer pending (2), not found (1).');
  expect(approveAllQuestion(214)).toBe('Approve 214 pending entries that match these filters?');
  expect(approveAllQuestion(1)).toBe('Approve 1 pending entry that matches these filters?');
  expect(approveAllQuestion(5000)).toBe('Approve 5,000 pending entries that match these filters?');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/portal && npx vitest run src/lib/timeBulk.test.ts`
Expected: FAIL. The module `./timeBulk` is not found.

- [ ] **Step 3: The client** — in `portal/src/lib/api.ts`:
  - In `listTimeEntries`, change the parameter type's first line to `person_id?: string; initiative_id?: string; site_id?: string; status?: string;`.
  - Directly after `rejectTimeEntry`, add:

```ts
/** The Timesheet's server-side filters as the bulk-approve API takes them
 *  (`from` / `to` bound clock-in, inclusive, as ISO instants). */
export interface TimeBulkFilter {
  person_id?: string; initiative_id?: string; site_id?: string; from?: string; to?: string;
}
export interface TimeBulkSkip {
  entry_id: string; person: string | null;
  /** The entry's clock-in instant; null when the id matched nothing. */
  date: string | null;
  reason: string;
}
export interface TimeBulkApproveResult { approved: number; skipped: TimeBulkSkip[] }
export interface TimeBulkRejectResult { rejected: number; skipped: TimeBulkSkip[] }
export type TimeBulkTarget = { entry_ids: string[] } | { filter: TimeBulkFilter };

export async function bulkApproveTimeEntries(target: TimeBulkTarget): Promise<TimeBulkApproveResult> {
  const resp = await apiFetch('/time/entries/approve', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

/** Dry run: how many entries an approve would approve (own entries left out). */
export async function countBulkApproveTimeEntries(target: TimeBulkTarget): Promise<number> {
  const resp = await apiFetch('/time/entries/approve?dry_run=1', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(target),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return ((await resp.json()) as { count: number }).count;
}

export async function bulkRejectTimeEntries(
  entryIds: string[], reason: string,
): Promise<TimeBulkRejectResult> {
  const resp = await apiFetch('/time/entries/reject', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ entry_ids: entryIds, reason }),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}
```

- [ ] **Step 4: The helpers** — create `portal/src/lib/timeBulk.ts`:

```ts
/**
 * Timesheet bulk approval helpers (pages/TimeManagement.tsx): the source
 * labels, the server-side filters and how they become GET /time/entries
 * params and the bulk-approve filter, and the result sentences.
 */
import type { TimeBulkFilter, TimeBulkSkip } from './api';

export const TIME_SOURCE_LABEL: Record<string, string> = {
  punch: 'Punch', kiosk: 'Kiosk', manual: 'Manual', import: 'Import',
};

export function timeSourceLabel(source: string): string {
  return TIME_SOURCE_LABEL[source] ?? source.charAt(0).toUpperCase() + source.slice(1);
}

/** The Timesheet's server-side filters; '' means "any". `from` / `to` are
 *  YYYY-MM-DD days from the date inputs, read in the viewer's time zone. */
export interface TimesheetFilter {
  person_id: string; initiative_id: string; site_id: string; from: string; to: string;
}

export const NO_FILTER: TimesheetFilter = {
  person_id: '', initiative_id: '', site_id: '', from: '', to: '',
};

export function hasFilter(f: TimesheetFilter): boolean {
  return Object.values(f).some((v) => v !== '');
}

/** Local midnight at the start of `day`, as an ISO instant. */
export function dayStartIso(day: string): string | undefined {
  return day ? new Date(`${day}T00:00:00`).toISOString() : undefined;
}

/** The last millisecond of `day`, local time, as an ISO instant. */
export function dayEndIso(day: string): string | undefined {
  return day ? new Date(`${day}T23:59:59.999`).toISOString() : undefined;
}

/** The filters as the bulk-approve API's `filter` object, blanks left out. */
export function bulkFilter(f: TimesheetFilter): TimeBulkFilter {
  const out: TimeBulkFilter = {};
  if (f.person_id) out.person_id = f.person_id;
  if (f.initiative_id) out.initiative_id = f.initiative_id;
  if (f.site_id) out.site_id = f.site_id;
  const from = dayStartIso(f.from);
  if (from) out.from = from;
  const to = dayEndIso(f.to);
  if (to) out.to = to;
  return out;
}

/** GET /time/entries params for a status pill plus the filters. */
export function listQuery(status: string, f: TimesheetFilter) {
  const b = bulkFilter(f);
  return {
    ...(status === 'all' ? {} : { status }),
    person_id: b.person_id, initiative_id: b.initiative_id, site_id: b.site_id,
    since: b.from, until: b.to,
  };
}

const num = (n: number) => n.toLocaleString('en-US');

export const entriesText = (n: number) => `${num(n)} ${n === 1 ? 'entry' : 'entries'}`;

/** "your own entry (1), no longer pending (1)" — most frequent first, ties in first-seen order. */
export function skipSummary(skipped: TimeBulkSkip[]): string {
  const counts = new Map<string, number>();
  for (const s of skipped) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
  return [...counts.entries()]
    .map(([reason, n], i) => ({ reason, n, i }))
    .sort((a, b) => b.n - a.n || a.i - b.i)
    .map(({ reason, n }) => `${reason} (${num(n)})`)
    .join(', ');
}

/** "Approved 212 entries. Skipped 2: your own entry (1), no longer pending (1)." */
export function bulkResultText(
  verb: 'Approved' | 'Rejected', done: number, skipped: TimeBulkSkip[],
): string {
  const head = `${verb} ${entriesText(done)}.`;
  return skipped.length ? `${head} Skipped ${num(skipped.length)}: ${skipSummary(skipped)}.` : head;
}

/** "Approve 214 pending entries that match these filters?" */
export function approveAllQuestion(n: number): string {
  return `Approve ${num(n)} pending ${n === 1 ? 'entry that matches' : 'entries that match'} these filters?`;
}
```

- [ ] **Step 5: Run the helper test** — `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/portal && npx vitest run src/lib/timeBulk.test.ts` → PASS.

- [ ] **Step 6: Error copy** — in `portal/src/components/time/TimeEntryEditModal.tsx`, add three entries to `TIME_ERRORS` (after `time_entry_not_found`):

```ts
  too_many: 'More than 5,000 entries match. Narrow the filters and try again.',
  reason_required: 'Enter a reason for rejecting.',
  ids_or_filter: 'Something went wrong. Refresh the page and try again.',
```

- [ ] **Step 7: Write the failing page test** — in `portal/src/pages/TimeManagement.test.tsx`:
  - Add `fireEvent` to the `@testing-library/react` import, and add `import { dayStartIso } from '../lib/timeBulk';`.
  - Add `listInitiatives: vi.fn(),` to the hoisted `api` object.
  - In `beforeEach`, add `api.listInitiatives.mockResolvedValue([]);`.
  - Append:

```tsx
it('timesheet filters: a person and a From day refetch the list server-side, Clear filters resets', async () => {
  api.listWorkerOptions.mockResolvedValue([{ person_id: 'p7', display_name: 'Wes Worker' }]);
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  expect(api.listTimeEntries).toHaveBeenLastCalledWith({});

  fireEvent.focus(screen.getByLabelText('Person', { selector: 'input' }));
  fireEvent.mouseDown(await screen.findByText('Wes Worker'));
  await waitFor(() => expect(api.listTimeEntries).toHaveBeenLastCalledWith({ person_id: 'p7' }));

  fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-09-01' } });
  await waitFor(() => expect(api.listTimeEntries).toHaveBeenLastCalledWith({
    person_id: 'p7', since: dayStartIso('2026-09-01'),
  }));

  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  await waitFor(() => expect(api.listTimeEntries).toHaveBeenLastCalledWith({}));
});
```

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/portal && npx vitest run src/pages/TimeManagement.test.tsx`
Expected: the new test FAILS, because there is no "Person" input. The existing tests still PASS.

- [ ] **Step 8: The filter row** — in `portal/src/pages/TimeManagement.tsx`:

8a. Change the React import to `useEffect, useMemo, useRef, useState, type CSSProperties`. Add `listInitiatives,` to the `../lib/api` import (alphabetical). Add:

```tsx
import {
  hasFilter, listQuery, NO_FILTER, timeSourceLabel, type TimesheetFilter,
} from '../lib/timeBulk';
```

8b. In `timeEntryCellText`, change `case 'source': return e.source;` to `case 'source': return timeSourceLabel(e.source);`. In `cellFor`'s `case 'source'`, change the `text` line to `const text = timeSourceLabel(e.source);`.

8c. Directly after `const [statusPill, setStatusPill] = useState('all');`, add:

```tsx
  // Server-side filters (person / job / site / clock-in days). Declared up
  // here with statusPill for the same reason: the load effect's deps read it.
  // They also scope "Approve all pending in this view".
  const [serverFilter, setServerFilter] = useState<TimesheetFilter>(NO_FILTER);
  const [jobOptions, setJobOptions] = useState<PunchOption[]>([]);
  const listSeq = useRef(0);
```

8d. Replace `loadTimesheet` with a version that takes the filters and ignores a stale response:

```tsx
  // A specific status pill filters server-side (refetch on pill change) so
  // the 500-row cap applies per-status instead of truncating the whole
  // timesheet before the pill even gets a look; 'All' fetches unfiltered
  // and relies on the client-side pill/column/search filtering below. The
  // person / job / site / day filters always apply server-side. A newer
  // load wins over an older one that answers late.
  const loadTimesheet = async (status: string, scope: TimesheetFilter) => {
    const mine = ++listSeq.current;
    try {
      const rows = await listTimeEntries(listQuery(status, scope));
      if (mine !== listSeq.current) return;
      setTimesheet(rows);
      setTimesheetError('');
    } catch (err) {
      if (mine !== listSeq.current) return;
      setTimesheet([]);
      setTimesheetError(err instanceof ApiError && err.status === 403
        ? 'You do not have permission to view the timesheet.' : 'Failed to load time entries.');
    }
  };
```

8e. Replace the timesheet load effect and the workers effect with:

```tsx
  useEffect(() => {
    if (!canView) return;
    void loadTimesheet(statusPill, serverFilter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canView, statusPill, serverFilter]);

  // The Person filter needs the worker list too, not only Add entry.
  useEffect(() => {
    if (!canView && !canAdd) return;
    void listWorkerOptions().then(setWorkers).catch(() => {});
  }, [canView, canAdd]);

  // Job filter: every non-archived job (punch options only carry open
  // ones); falls back to the punch options when the list cannot load.
  useEffect(() => {
    if (!canView) return;
    listInitiatives()
      .then((all) => setJobOptions(all.filter((j) => !j.archived_at)
        .map((j) => ({ id: j.id, name: j.name }))))
      .catch(() => setJobOptions([]));
  }, [canView]);
```

In `refreshAll`, change `await loadTimesheet(statusPill);` to `await loadTimesheet(statusPill, serverFilter);`.

8f. Directly after the closing `</div>` of the Timesheet's first `<div className="dir-toolbar">` (the pills / search / Columns / Export / Add entry row), add:

```tsx
          <div className="dir-toolbar audit-toolbar time-filters" role="group"
               aria-label="Timesheet filters">
            <div className="time-filter-pick">
              <ComboBox ariaLabel="Person" placeholder="Any person…" clearable
                        value={serverFilter.person_id}
                        options={workers.map((w) => ({ value: w.person_id, label: w.display_name }))}
                        onChange={(v) => setServerFilter((f) => ({ ...f, person_id: v }))} />
            </div>
            <div className="time-filter-pick">
              <ComboBox ariaLabel="Job" placeholder="Any job…" clearable
                        value={serverFilter.initiative_id}
                        options={(jobOptions.length ? jobOptions : punchOptions.initiatives)
                          .map((j) => ({ value: j.id, label: j.name }))}
                        onChange={(v) => setServerFilter((f) => ({ ...f, initiative_id: v }))} />
            </div>
            <div className="time-filter-pick">
              <ComboBox ariaLabel="Site" placeholder="Any site…" clearable
                        value={serverFilter.site_id}
                        options={punchOptions.sites.map((s) => ({ value: s.id, label: s.name }))}
                        onChange={(v) => setServerFilter((f) => ({ ...f, site_id: v }))} />
            </div>
            <input type="date" aria-label="From date" value={serverFilter.from}
                   onChange={(e) => setServerFilter((f) => ({ ...f, from: e.target.value }))} />
            <input type="date" aria-label="To date" value={serverFilter.to}
                   onChange={(e) => setServerFilter((f) => ({ ...f, to: e.target.value }))} />
            {hasFilter(serverFilter) && (
              <button type="button" className="mini-btn" onClick={() => setServerFilter(NO_FILTER)}>
                Clear filters
              </button>
            )}
          </div>
```

8g. In `portal/src/styles/time.css`, under "4. Timesheet", add (layout only; the date inputs take their look from `.audit-toolbar` in profile.css, which this page already imports):

```css
/* Server-side filter row (Person / Job / Site / From / To): the Audit log's
   toolbar idiom (.audit-toolbar in profile.css). Layout only here — any
   typography on a .time-* selector trips the list guardrail. */
.time-filter-pick { min-width: 190px; }
```

- [ ] **Step 9: Run the tests, tsc and the guardrail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/portal && npx vitest run src/pages/TimeManagement.test.tsx src/lib/timeBulk.test.ts src/components/time src/styles/listTypography.test.ts && npx tsc -b`
Expected: all PASS and tsc clean.

- [ ] **Step 10: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk
git add portal/src/lib/api.ts portal/src/lib/timeBulk.ts portal/src/lib/timeBulk.test.ts portal/src/components/time/TimeEntryEditModal.tsx portal/src/pages/TimeManagement.tsx portal/src/pages/TimeManagement.test.tsx portal/src/styles/time.css
git commit -F - <<'EOF'
feat(portal): Timesheet person/job/site/day filters server-side; bulk approval client; Import source label

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Portal — Timesheet checkboxes, bulk bar, dialog and result

**Files:**
- Create: `portal/src/components/time/TimeBulkDialog.tsx`
- Modify: `portal/src/pages/TimeManagement.tsx`, `portal/src/styles/time.css`
- Test: `portal/src/pages/TimeManagement.bulk.test.tsx` (create); `portal/src/pages/TimeManagement.test.tsx` (one assertion)

**Interfaces:**
- Consumes: Task 5's `bulkApproveTimeEntries`, `countBulkApproveTimeEntries`, `bulkRejectTimeEntries`, `TimeBulkSkip`, `bulkFilter`, `bulkResultText`, `approveAllQuestion`, `entriesText`, `serverFilter`, `mapTimeError`; `activeFilterCount` from `lib/columnMenu`.
- Produces: `TimeBulkDialog` with props `{ mode: 'reject' | 'approve-all'; count: number; busy: boolean; error: string; onCancel(): void; onConfirm(reason: string): void }`. The accessible names the tests rely on:
  - checkboxes: "Select all pending entries shown", "Select {person}, {date}"
  - buttons: "Approve selected", "Reject selected", "Approve all pending in this view", "Show skipped" / "Hide skipped"
  - dialog: `role="dialog"`; the table is "Skipped entries"

- [ ] **Step 1: Write the failing tests** — create `portal/src/pages/TimeManagement.bulk.test.tsx`:

```tsx
// @vitest-environment jsdom
/**
 * /time — Timesheet bulk approval: checkboxes on pending rows only, select
 * all (with the indeterminate state), Approve / Reject selected, "Approve
 * all pending in this view" (dry run, then confirm), the result note and
 * its Show skipped list, and the time:change gate. The harness mirrors
 * TimeManagement.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { TimeEntryItem, UiPreferences } from '../lib/api';

const auth = vi.hoisted(() => ({ can: (_r: string, _a?: string): boolean => true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: true, sound: 'chime' },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  getMyTime: vi.fn(),
  getPunchOptions: vi.fn(),
  listActiveTimeEntries: vi.fn(),
  listTimeEntries: vi.fn(),
  listWorkerOptions: vi.fn(),
  listInitiatives: vi.fn(),
  bulkApproveTimeEntries: vi.fn(),
  countBulkApproveTimeEntries: vi.fn(),
  bulkRejectTimeEntries: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

function entry(over: Partial<TimeEntryItem>): TimeEntryItem {
  return {
    id: 'e1', person_id: 'p1', person_name: 'Alice Tech',
    initiative_id: null, initiative_name: null, site_id: null, site_name: null,
    clock_in_at: '2026-09-01T13:00:00Z', clock_out_at: '2026-09-01T21:00:00Z',
    break_minutes: 30, minutes: 450,
    status: 'pending', status_label: 'Pending', status_color: '#a36207',
    source: 'kiosk', notes: '', adjusted: false, adjust_reason: null,
    approved_by: null, approved_by_name: null, approved_at: null, reject_reason: null,
    created_at: '2026-09-01T13:00:00Z', updated_at: '2026-09-01T21:00:00Z',
    ...over,
  };
}

const ALICE = entry({ id: 'e1', person_name: 'Alice Tech' });
const CY = entry({
  id: 'e3', person_id: 'p3', person_name: 'Cy Pending',
  clock_in_at: '2026-09-02T13:00:00Z', clock_out_at: '2026-09-02T21:00:00Z',
});
const BOB = entry({
  id: 'e2', person_id: 'p2', person_name: 'Bob Builder',
  status: 'approved', status_label: 'Approved', status_color: '#178a4c',
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.getMyTime.mockResolvedValue({ open: null, entries: [] });
  api.getPunchOptions.mockResolvedValue({ initiatives: [], sites: [] });
  api.listActiveTimeEntries.mockResolvedValue([]);
  api.listTimeEntries.mockResolvedValue([ALICE, BOB, CY]);
  api.listWorkerOptions.mockResolvedValue([]);
  api.listInitiatives.mockResolvedValue([]);
});

afterEach(cleanup);

const { default: TimeManagement } = await import('./TimeManagement');

const rowOf = (name: string) => screen.getByText(name).closest('.dir-row') as HTMLElement;
const selectAll = () =>
  screen.getByRole('checkbox', { name: 'Select all pending entries shown' }) as HTMLInputElement;

it('only pending rows get a checkbox; the header selects every pending row shown', async () => {
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  expect(within(rowOf('Alice Tech')).getByRole('checkbox', { name: /^Select Alice Tech, / }))
    .toBeTruthy();
  expect(within(rowOf('Bob Builder')).queryByRole('checkbox')).toBeNull();

  fireEvent.click(within(rowOf('Alice Tech')).getByRole('checkbox'));
  expect(selectAll().indeterminate).toBe(true);
  expect(screen.getByText('1 selected')).toBeTruthy();

  fireEvent.click(selectAll());
  expect(selectAll().checked).toBe(true);
  expect(selectAll().indeterminate).toBe(false);
  expect(screen.getByText('2 selected')).toBeTruthy();

  fireEvent.click(selectAll());
  expect(screen.queryByText(/^\d+ selected$/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve selected' })).toBeNull();
});

it('Approve selected sends the ids, reports the result, refreshes and clears the selection', async () => {
  api.bulkApproveTimeEntries.mockResolvedValue({
    approved: 1,
    skipped: [{ entry_id: 'e3', person: 'Cy Pending', date: '2026-09-02T13:00:00Z',
                reason: 'no longer pending' }],
  });
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  fireEvent.click(selectAll());
  fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));

  await waitFor(() => expect(api.bulkApproveTimeEntries).toHaveBeenCalledWith({ entry_ids: ['e1', 'e3'] }));
  expect(await screen.findByText('Approved 1 entry. Skipped 1: no longer pending (1).')).toBeTruthy();
  await waitFor(() => expect(api.listTimeEntries).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('2 selected')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Show skipped' }));
  const table = screen.getByRole('table', { name: 'Skipped entries' });
  expect(within(table).getByText('Cy Pending')).toBeTruthy();
  expect(within(table).getByText('no longer pending')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Hide skipped' }));
  expect(screen.queryByRole('table', { name: 'Skipped entries' })).toBeNull();
});

it('Reject selected asks for one reason in a dialog and sends it with every id', async () => {
  api.bulkRejectTimeEntries.mockResolvedValue({ rejected: 1, skipped: [] });
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  fireEvent.click(within(rowOf('Alice Tech')).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Reject selected' }));

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Timesheet')).toBeTruthy();
  expect(within(dialog).getByRole('heading', { name: 'Reject 1 entry' })).toBeTruthy();
  const submit = within(dialog).getByRole('button', { name: 'Reject 1 entry' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(within(dialog).getByLabelText(/rejection reason/i), { target: { value: ' No show ' } });
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);

  await waitFor(() => expect(api.bulkRejectTimeEntries).toHaveBeenCalledWith(['e1'], 'No show'));
  expect(await screen.findByText('Rejected 1 entry.')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Approve all pending in this view counts with a dry run, confirms, then sends the filter', async () => {
  api.countBulkApproveTimeEntries.mockResolvedValue(214);
  api.bulkApproveTimeEntries.mockResolvedValue({ approved: 214, skipped: [] });
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  fireEvent.click(screen.getByRole('button', { name: 'Approve all pending in this view' }));

  await waitFor(() => expect(api.countBulkApproveTimeEntries).toHaveBeenCalledWith({ filter: {} }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Approve 214 pending entries that match these filters?')).toBeTruthy();
  expect(api.bulkApproveTimeEntries).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve 214 entries' }));

  await waitFor(() => expect(api.bulkApproveTimeEntries).toHaveBeenCalledWith({ filter: {} }));
  expect(await screen.findByText('Approved 214 entries.')).toBeTruthy();
});

it('more than 5,000 matches says to narrow the filters', async () => {
  const { ApiError } = await import('../lib/api');
  api.countBulkApproveTimeEntries.mockRejectedValue(new ApiError(422, 'too_many'));
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  fireEvent.click(screen.getByRole('button', { name: 'Approve all pending in this view' }));
  expect(await screen.findByText('More than 5,000 entries match. Narrow the filters and try again.'))
    .toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('search text disables Approve all, since search only narrows the loaded rows', async () => {
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  fireEvent.change(screen.getByPlaceholderText('Filter entries…'), { target: { value: 'alice' } });
  const btn = screen.getByRole('button', { name: 'Approve all pending in this view' }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(screen.getByText(/Column filters and search narrow only the loaded rows/)).toBeTruthy();
});

it('Approve all is not offered on the Approved pill', async () => {
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  api.listTimeEntries.mockResolvedValue([BOB]);
  fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
  await waitFor(() => expect(api.listTimeEntries).toHaveBeenLastCalledWith({ status: 'approved' }));
  expect(screen.queryByRole('button', { name: 'Approve all pending in this view' })).toBeNull();
});

it('without time:change there are no checkboxes and no bulk buttons', async () => {
  auth.can = (resource, action) => resource === 'time' && action === undefined;
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Approve all pending in this view' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve selected' })).toBeNull();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/portal && npx vitest run src/pages/TimeManagement.bulk.test.tsx`
Expected: FAIL, because no checkbox named "Select all pending entries shown" is found.

- [ ] **Step 3: The dialog** — create `portal/src/components/time/TimeBulkDialog.tsx`:

```tsx
/**
 * TimeBulkDialog — the Timesheet's two bulk confirmations, in the report
 * Generate modal's header pattern (eyebrow, title, one-line description).
 * "Reject selected" asks for the one reason every selected entry gets;
 * "Approve all pending in this view" confirms the dry-run count before the
 * filter is sent. The page owns the API calls; this is only the form.
 */
import { useState, type FormEvent } from 'react';

import { approveAllQuestion, entriesText } from '../../lib/timeBulk';

interface Props {
  mode: 'reject' | 'approve-all';
  count: number;
  busy: boolean;
  error: string;
  onCancel(): void;
  onConfirm(reason: string): void;
}

export default function TimeBulkDialog({ mode, count, busy, error, onCancel, onConfirm }: Props) {
  const [reason, setReason] = useState('');
  const rejecting = mode === 'reject';
  const action = rejecting ? `Reject ${entriesText(count)}` : `Approve ${entriesText(count)}`;
  const blocked = busy || (rejecting && !reason.trim());

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!blocked) onConfirm(reason.trim());
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onCancel(); }}>
      <div className="modal-card reports-modal-card rgm-card time-bulk-card" role="dialog"
           aria-modal="true" aria-labelledby="time-bulk-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Timesheet</div>
            <h3 id="time-bulk-title">{rejecting ? action : 'Approve pending entries'}</h3>
            <p className="page-hint">
              {rejecting ? 'One reason is saved on every selected entry.' : approveAllQuestion(count)}
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onCancel} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={submit}>
          <div className="modal-body">
            {rejecting ? (
              <div className="pf-form">
                <div className="full">
                  <label htmlFor="time-bulk-reason">Rejection reason *</label>
                  <input id="time-bulk-reason" value={reason} disabled={busy} autoFocus
                         onChange={(e) => setReason(e.target.value)} />
                </div>
              </div>
            ) : (
              <p className="set-note">
                The count leaves out your own entries, which you cannot approve. Anything approved
                or rejected in the meantime is skipped.
              </p>
            )}
            {error && <p className="pf-error">{error}</p>}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={blocked}>
              {busy ? 'Working…' : action}
            </button>
            <button className="mini-btn" type="button" onClick={onCancel} disabled={busy}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Wire it into the Timesheet** — in `portal/src/pages/TimeManagement.tsx`:

4a. Update the file's header comment. Item 4 becomes "Timesheet — `can('time')`; server-side person / job / site / day filters, the directory-list of entries with approve/reject/edit, and (with `time:change`) checkboxes on pending rows plus bulk Approve / Reject / Approve all pending in this view." Then add imports:

```tsx
import DataTable from '../components/DataTable';
import TimeBulkDialog from '../components/time/TimeBulkDialog';
```

Add to the `../lib/api` import: `bulkApproveTimeEntries, bulkRejectTimeEntries, countBulkApproveTimeEntries,` and `type TimeBulkSkip,`. Add `activeFilterCount,` to the `../lib/columnMenu` import. Extend the `../lib/timeBulk` import to `bulkFilter, bulkResultText, hasFilter, listQuery, NO_FILTER, timeSourceLabel, type TimesheetFilter`.

4b. Directly after `DEFAULT_VISIBLE`, add:

```tsx
// The leading selection checkbox (time:change only): a fixed track outside
// the column registry, folded into a ColumnDef so listGridStyle's minWidth
// counts it (PrintAssetList.tsx's CHECKBOX_COL).
const CHECKBOX_COL: ColumnDef = { key: 'select', label: '', width: '32px', default: true };
```

4c. Directly after `const [actionError, setActionError] = useState('');`, add:

```tsx
  // ── bulk approval (time:change) ──
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [dialog, setDialog] = useState<{ mode: 'reject' | 'approve-all'; count: number } | null>(null);
  const [dialogError, setDialogError] = useState('');
  const [bulkResult, setBulkResult] = useState<{ text: string; skipped: TimeBulkSkip[] } | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const headerBoxRef = useRef<HTMLInputElement>(null);
```

4d. Replace the `grid` line with:

```tsx
  const grid = listGridStyle(canChange ? [CHECKBOX_COL, ...shownCols] : shownCols,
    canChange ? ['88px'] : [], undefined, listGridScale);
```

4e. Directly after the `visibleEntries` `useMemo`, add:

```tsx
  // A reload drops ids that are no longer loaded and pending (approved
  // elsewhere, filtered away), so the count never includes a row that
  // cannot be acted on.
  useEffect(() => {
    const pending = new Set((timesheet ?? []).filter((e) => e.status === 'pending').map((e) => e.id));
    setSelected((prev) => {
      const next = new Set([...prev].filter((id) => pending.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [timesheet]);

  const pendingShown = useMemo(
    () => visibleEntries.filter((e) => e.status === 'pending').map((e) => e.id), [visibleEntries]);
  const selectedShown = pendingShown.filter((id) => selected.has(id)).length;
  const allSelected = pendingShown.length > 0 && selectedShown === pendingShown.length;
  const someSelected = selectedShown > 0 && !allSelected;
  useEffect(() => {
    if (headerBoxRef.current) headerBoxRef.current.indeterminate = someSelected;
  }, [someSelected]);
  const toggleOne = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    return next;
  });
  // Print Labels' rule: select-all REPLACES the selection with the pending
  // rows shown; unchecking it clears the selection.
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(pendingShown));

  // Column filters and search narrow only the LOADED rows; the approve-all
  // filter cannot carry them, so the button waits until they are cleared.
  const clientNarrowed = query.trim() !== '' || activeFilterCount(filters) > 0;
  const showApproveAll = canChange && (statusPill === 'all' || statusPill === 'pending')
    && !!timesheet && (timesheet.some((e) => e.status === 'pending') || timesheet.length === 500);

  const finishBulk = async (text: string, skipped: TimeBulkSkip[]) => {
    setDialog(null);
    setBulkResult({ text, skipped });
    setShowSkipped(false);
    setSelected(new Set());
    await refreshAll();
  };

  const approveSelected = async () => {
    setBulkBusy(true);
    setActionError('');
    try {
      const res = await bulkApproveTimeEntries({ entry_ids: [...selected].sort() });
      await finishBulk(bulkResultText('Approved', res.approved, res.skipped), res.skipped);
    } catch (err) {
      setActionError(mapTimeError(err, 'Could not approve. Try again.'));
    } finally {
      setBulkBusy(false);
    }
  };

  const startApproveAll = async () => {
    setBulkBusy(true);
    setActionError('');
    try {
      const count = await countBulkApproveTimeEntries({ filter: bulkFilter(serverFilter) });
      if (count === 0) {
        setBulkResult({ text: 'No pending entries that you can approve match these filters.', skipped: [] });
      } else {
        setDialogError('');
        setDialog({ mode: 'approve-all', count });
      }
    } catch (err) {
      setActionError(mapTimeError(err, 'Could not count the pending entries. Try again.'));
    } finally {
      setBulkBusy(false);
    }
  };

  const confirmDialog = async (reason: string) => {
    if (!dialog) return;
    setBulkBusy(true);
    setDialogError('');
    try {
      if (dialog.mode === 'reject') {
        const res = await bulkRejectTimeEntries([...selected].sort(), reason);
        await finishBulk(bulkResultText('Rejected', res.rejected, res.skipped), res.skipped);
      } else {
        const res = await bulkApproveTimeEntries({ filter: bulkFilter(serverFilter) });
        await finishBulk(bulkResultText('Approved', res.approved, res.skipped), res.skipped);
      }
    } catch (err) {
      setDialogError(mapTimeError(err, 'That did not work. Try again.'));
    } finally {
      setBulkBusy(false);
    }
  };
```

4f. Directly after the Task 5 filter row (`</div>` of `time-filters`), add the bulk bar:

```tsx
          {canChange && (selected.size > 0 || showApproveAll) && (
            <div className="dir-toolbar time-bulk-bar" role="group" aria-label="Bulk actions">
              {selected.size > 0 && (
                <>
                  <span className="chip tag">{selected.size} selected</span>
                  <button type="button" className="btn-solid" disabled={bulkBusy}
                          onClick={() => void approveSelected()}>
                    Approve selected
                  </button>
                  <button type="button" className="mini-btn" disabled={bulkBusy}
                          onClick={() => { setDialogError(''); setDialog({ mode: 'reject', count: selected.size }); }}>
                    Reject selected
                  </button>
                </>
              )}
              {showApproveAll && (
                <div className="toolbar-right">
                  <button type="button" className="mini-btn" disabled={bulkBusy || clientNarrowed}
                          aria-describedby={clientNarrowed ? 'time-approve-all-note' : undefined}
                          onClick={() => void startApproveAll()}>
                    Approve all pending in this view
                  </button>
                </div>
              )}
            </div>
          )}
          {showApproveAll && clientNarrowed && (
            <p id="time-approve-all-note" className="set-note">
              Column filters and search narrow only the loaded rows. Clear them to approve everything
              that matches the filters above.
            </p>
          )}
```

4g. Directly after the `actionError` block (`{!timesheetError && actionError && (...)}`), add the result line and its skipped list:

```tsx
          {bulkResult && (
            <div className="time-bulk-result">
              <p className="set-note">{bulkResult.text}</p>
              {bulkResult.skipped.length > 0 && (
                <button type="button" className="mini-btn sm" aria-expanded={showSkipped}
                        onClick={() => setShowSkipped((s) => !s)}>
                  {showSkipped ? 'Hide skipped' : 'Show skipped'}
                </button>
              )}
              <button type="button" className="mini-btn sm" onClick={() => setBulkResult(null)}>
                Dismiss
              </button>
            </div>
          )}
          {bulkResult && showSkipped && (
            <DataTable
              ariaLabel="Skipped entries"
              columns={[
                { key: 'person', label: 'Person' },
                { key: 'date', label: 'Date', mono: true },
                { key: 'reason', label: 'Reason' },
              ]}
              rows={bulkResult.skipped.map((s, i) => ({
                key: `${s.entry_id}-${i}`,
                cells: [s.person ?? '—', s.date ? fmtDate(s.date) : '—', s.reason],
              }))}
            />
          )}
```

4h. In the list header, directly after `<div className="list-head" style={rowStyle}>`, add:

```tsx
                {canChange && (
                  <span className="col-head">
                    <input type="checkbox" ref={headerBoxRef} checked={allSelected}
                           disabled={pendingShown.length === 0}
                           aria-label="Select all pending entries shown" onChange={toggleAll} />
                  </span>
                )}
```

4i. In each row, directly after `<div className="row-main time-row-static" style={rowStyle}>`, add:

```tsx
                      {canChange && (
                        <div className="cell">
                          {e.status === 'pending' && (
                            <input type="checkbox" checked={selected.has(e.id)}
                                   aria-label={`Select ${e.person_name}, ${fmtDate(e.clock_in_at)}`}
                                   onChange={() => toggleOne(e.id)} />
                          )}
                        </div>
                      )}
```

4j. Directly before the closing `</div>` of `portal-page` (after the `TimeEntryEditModal` block), add:

```tsx
      {dialog && (
        <TimeBulkDialog mode={dialog.mode} count={dialog.count} busy={bulkBusy} error={dialogError}
                        onCancel={() => setDialog(null)} onConfirm={(reason) => void confirmDialog(reason)} />
      )}
```

4k. In `portal/src/styles/time.css`, under "4. Timesheet", add (layout and width only; see the guardrail note in Global Constraints):

```css
/* Bulk approval: the bar under the filters, the result line, and the
   dialog's width (sized to a one-field form). */
.time-bulk-bar { margin-top: 0; }
.time-bulk-result { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-bottom: 12px; }
.time-bulk-result .set-note { margin: 0; }
.modal-card.reports-modal-card.rgm-card.time-bulk-card { width: min(560px, 96vw); max-width: 96vw; }
```

4l. The leading checkbox track changes the start of the grid template, so update the existing floors assertion in `portal/src/pages/TimeManagement.test.tsx` ("timesheet: column floors, shared template + minimum, sideways-scroll card"). Replace:

```tsx
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
```

with:

```tsx
  // time:change adds the 32px selection track in front of the columns
  expect(head.style.gridTemplateColumns).toMatch(/^32px minmax\(\d+px, [\d.]+fr\)/);
```

- [ ] **Step 5: Run the tests, tsc and the guardrail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/portal && npx vitest run src/pages/TimeManagement.bulk.test.tsx src/pages/TimeManagement.test.tsx src/styles/listTypography.test.ts && npx tsc -b`
Expected: all PASS. With 4l applied, the existing "column floors", "trigger-sized" and "no trigger without can(time, change)" tests pass: the checkbox track is leading, 32px, present only with `time:change`, and the default columns plus both fixed tracks still fit `LIST_FIT.page` (about 948px against 1172px).

- [ ] **Step 6: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk
git add portal/src/components/time/TimeBulkDialog.tsx portal/src/pages/TimeManagement.tsx portal/src/pages/TimeManagement.bulk.test.tsx portal/src/pages/TimeManagement.test.tsx portal/src/styles/time.css
git commit -F - <<'EOF'
feat(portal): Timesheet bulk approval — pending-row checkboxes, Approve/Reject selected, Approve all pending in this view

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Portal — import page, client, card, route

**Files:**
- Modify: `portal/src/lib/api.ts` (after the "bulk assign people to a job" block, about line 1499)
- Create: `portal/src/lib/timeImport.ts`, `portal/src/lib/timeImport.test.ts`
- Create: `portal/src/pages/BulkTime.tsx`, `portal/src/pages/BulkTime.test.tsx`
- Create (stub, replaced in Task 8): `portal/src/components/time/TimeImportUpload.tsx`
- Modify: `portal/src/components/bulk/BulkApplySummary.tsx` (+ `BulkApplySummary.test.tsx`)
- Modify: `portal/src/pages/BulkActions.tsx` (+ `BulkActions.test.tsx`), `portal/src/App.tsx`
- Modify: `portal/src/lib/auditFormat.ts` (+ `auditFormat.test.ts`)

**Interfaces:**
- Consumes: Task 4's `/time/bulk/*` routes; `TeamBulkCandidate` from `lib/api.ts`; `BulkToolPage` (`limitNote`), `BulkColumnGuide`.
- Produces:
  - `lib/api.ts` types: `TimeImportField = 'worker' | 'job' | 'site'`, `TimeImportIssue`, `TimeImportAction = 'add' | 'duplicate' | 'attention' | 'error' | 'skipped'`, `TimeImportRow`, `TimeImportPreview`, `TimeImportOverrides`, `TimeImportPosted`, `TimeImportAppliedRow`, `TimeImportCommitResult`
  - `lib/api.ts` calls: `previewTimeImportFile(file, filename)`, `previewTimeImport(body)`, `commitTimeImport(body & { source })`, `downloadTimeImportTemplate(format)`
  - `lib/timeImport.ts`: `TIME_COLUMN_GUIDE`, `TIME_IMPORT_ERRORS`, `TIME_IMPORT_LIMIT_NOTE`
  - `BulkSummaryResult.updated` and `.unchanged` become optional
  - route `/bulk/time`; `BULK_TOOLS` entry `key: 'time'`

- [ ] **Step 1: Write the failing tests.**

Create `portal/src/lib/timeImport.test.ts`:

```ts
import { expect, it } from 'vitest';

import { TIME_COLUMN_GUIDE, TIME_IMPORT_ERRORS, TIME_IMPORT_LIMIT_NOTE } from './timeImport';

it('the column guide lists exactly the API columns, in order', () => {
  expect(TIME_COLUMN_GUIDE.map((c) => c.key)).toEqual(
    ['worker', 'clock_in', 'clock_out', 'break_minutes', 'job', 'site', 'notes']);
  expect(TIME_COLUMN_GUIDE.filter((c) => c.required).map((c) => c.key))
    .toEqual(['worker', 'clock_in', 'clock_out']);
});

it('every error the routes send has a sentence', () => {
  for (const code of ['unknown_columns', 'too_many_rows', 'file_too_large', 'invalid_json',
    'invalid_csv', 'invalid_xlsx', 'unsupported_file', 'missing_file', 'invalid_row_numbers',
    'invalid_overrides', 'invalid_skip', 'rows_invalid', 'forbidden']) {
    expect(TIME_IMPORT_ERRORS[code], code).toMatch(/\.$/);
  }
  expect(TIME_IMPORT_LIMIT_NOTE).toBe('Uploads are limited to 5,000 rows and 5 MB. Split larger files before uploading.');
});
```

Create `portal/src/pages/BulkTime.test.tsx`:

```tsx
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ downloadTimeImportTemplate: vi.fn(async () => {}) }));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
vi.mock('../components/time/TimeImportUpload', () => ({
  default: () => <div data-testid="pane" />,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });
const { default: BulkTime } = await import('./BulkTime');

it('lays out like the other bulk tools: hint, Columns, Download (templates only), Upload', async () => {
  render(<MemoryRouter><BulkTime /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Add time punches in bulk' })).toBeTruthy();
  const sections = screen.getAllByText(/^(Columns|Download|Upload)$/, { selector: '.eyebrow-sm' });
  expect(sections.map((s) => s.textContent)).toEqual(['Columns', 'Download', 'Upload']);
  for (const key of ['worker', 'clock_in', 'clock_out', 'break_minutes', 'job', 'site', 'notes']) {
    expect(screen.getByText(key)).toBeTruthy();
  }
  expect(screen.getAllByRole('button', { name: /^Template \(\.(xlsx|csv)\)$/ })).toHaveLength(2);
  expect(screen.queryByRole('button', { name: /^Current/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Template (.csv)' }));
  await waitFor(() => expect(api.downloadTimeImportTemplate).toHaveBeenCalledWith('csv'));
  expect(screen.getByText('Uploads are limited to 5,000 rows and 5 MB. Split larger files before uploading.')).toBeTruthy();
  expect(screen.getByTestId('pane')).toBeTruthy();
});
```

Append to `portal/src/components/bulk/BulkApplySummary.test.tsx`:

```tsx
it('an add-only result lists only the counts it has', () => {
  render(<MemoryRouter>
    <BulkApplySummary result={{ created: 2, skipped: 1, rows: [] }} entityLabel="Worker"
      filename="time-bulk-summary" linkFor={() => null} openTo="/people/time"
      openLabel="Open Time Management" />
  </MemoryRouter>);
  expect(screen.getByText('Applied: 2 added · 1 skipped')).toBeTruthy();
});
```

In `portal/src/pages/BulkActions.test.tsx`:
  - Add `canTime: true,` to `authMock`.
  - In the `can` mock, add `: resource === 'time' ? authMock.canTime` before the final `: true`.
  - Add `authMock.canTime = true;` to `afterEach`.
  - Add `authMock.canTime = false;` to the "renders the empty state until tools are added" test.
  - Change the `toHaveLength(6)` count of "Open" buttons to `toHaveLength(7)`. Run `grep -n "toHaveLength(6)" portal/src/pages/BulkActions.test.tsx` first and update every count of "Open" buttons it finds.
  - Append:

```tsx
it('lists the time punches card only for time:add', () => {
  authMock.denied.add('time:add');
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.queryByText('Add time punches in bulk')).toBeNull();
  cleanup();
  authMock.denied.clear();
  render(<MemoryRouter><BulkActions /></MemoryRouter>);
  expect(screen.getByText('Add time punches in bulk')).toBeTruthy();
  expect(screen.getByText('Load shifts from a spreadsheet or another timekeeping system. Workers, jobs, and sites are matched by name; review every shift before adding.')).toBeTruthy();
});
```

In `portal/src/lib/auditFormat.test.ts`, change the import to `import { actionLabel, entityHref, ENTITY_LABELS, targetLabel } from './auditFormat';` and append:

```ts
it('names the time import audit rows', () => {
  expect(actionLabel({ action: 'import', entity_type: 'time_entry', entity_id: 'x', changes: {} }))
    .toBe('Imported');
  expect(ENTITY_LABELS.time_entry).toBe('time entry');
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/portal && npx vitest run src/lib/timeImport.test.ts src/pages/BulkTime.test.tsx src/components/bulk/BulkApplySummary.test.tsx src/pages/BulkActions.test.tsx src/lib/auditFormat.test.ts`
Expected: FAIL. The modules are missing, the counts read "2 added · undefined updated …", the card is absent, and the label is "import".

- [ ] **Step 3: The client** — in `portal/src/lib/api.ts`, after `downloadTeamExport`, add:

```ts
// ── bulk time punches (/bulk/time) ──────────────────────────────────

export type TimeImportField = 'worker' | 'job' | 'site';
export interface TimeImportIssue {
  field: TimeImportField;
  kind: 'unknown' | 'ambiguous';
  value: string;
  candidates: TeamBulkCandidate[];
}
export type TimeImportAction = 'add' | 'duplicate' | 'attention' | 'error' | 'skipped';
export interface TimeImportRow {
  row: number;
  /** The matched worker's name, else the uploaded worker cell. */
  name: string | null;
  person_id: string | null; person_name: string | null;
  matched_by: 'email' | 'phone' | 'name' | 'your pick' | null;
  job_id: string | null; job_name: string | null;
  site_id: string | null; site_name: string | null;
  /** The IANA zone the times were read in. */
  zone: string | null;
  clock_in_at: string | null; clock_out_at: string | null;
  break_minutes: number | null;
  /** Worked minutes, net of break. */
  minutes: number | null;
  /** e.g. "Sep 24, 7:00 AM – 3:30 PM PDT". */
  shift: string | null;
  notes: string;
  action: TimeImportAction;
  errors: string[];
  issues: TimeImportIssue[];
  detail: string | null;
  cells: Record<string, string>;
}
export interface TimeImportPreview {
  rows: TimeImportRow[];
  counts: Record<TimeImportAction, number>;
  can_commit: boolean;
}
export type TimeImportOverrides = Record<string, Partial<Record<TimeImportField, string>>>;
export interface TimeImportPosted {
  rows: Record<string, string>[];
  row_numbers: number[];
  overrides: TimeImportOverrides;
  skip: number[];
}
export interface TimeImportAppliedRow {
  row: number;
  name: string | null;
  entry_id: string | null;
  action: 'created' | 'skipped';
  /** The shift for an added row; "Already there." or "Skipped." otherwise. */
  detail: string | null;
}
export interface TimeImportCommitResult {
  summary: { added: number; skipped: number };
  rows: TimeImportAppliedRow[];
}

export async function previewTimeImportFile(file: File | Blob, filename: string): Promise<TimeImportPreview> {
  const fd = new FormData();
  fd.append('file', file, filename);
  const resp = await apiFetch('/time/bulk/preview', { method: 'POST', body: fd });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function previewTimeImport(body: TimeImportPosted): Promise<TimeImportPreview> {
  const resp = await apiFetch('/time/bulk/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export async function commitTimeImport(
  body: TimeImportPosted & { source: string },
): Promise<TimeImportCommitResult> {
  const resp = await apiFetch('/time/bulk/commit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!resp.ok) throw await errorFrom(resp);
  return resp.json();
}

export function downloadTimeImportTemplate(format: 'csv' | 'xlsx'): Promise<void> {
  return downloadAttachment(`/time/bulk/template?format=${format}`, `time-template.${format}`);
}
```

- [ ] **Step 4: Guide, errors, page, stub pane.**

Create `portal/src/lib/timeImport.ts`:

```ts
/** What each Add-time-punches column accepts. Keys mirror the API's
 *  people/time_bulk.py COLUMNS; the service test pins that list, the test
 *  beside this file pins this one, and the two must agree. */
import type { BulkColumnGuide } from '../components/bulk/BulkToolPage';

export const TIME_COLUMN_GUIDE: BulkColumnGuide[] = [
  { key: 'worker', required: true, accepts: 'The worker\'s email, phone, or full name. Email wins, then phone, then name. Unknown or shared values can be matched in the preview.', example: 'Marcus Reyes' },
  { key: 'clock_in', required: true, accepts: 'A date and time, such as 9/24/2026 7:00 AM or 2026-09-24 07:00, an Excel date-time cell, or ISO 8601 with an offset. Without an offset it is read in the row\'s site time zone.', example: '9/24/2026 7:00 AM' },
  { key: 'clock_out', required: true, accepts: 'The same formats as clock_in. It must be after clock_in, and a shift can be at most 24 hours.', example: '9/24/2026 3:30 PM' },
  { key: 'break_minutes', required: false, accepts: 'A whole number of minutes, 0 or more, shorter than the shift. Blank means 0.', example: '30' },
  { key: 'job', required: false, accepts: 'An existing job, by name. Case does not matter.', example: 'Example Move' },
  { key: 'site', required: false, accepts: 'An existing site, by name or code. Its time zone reads the times; when blank, the job\'s site is used, then Eastern time.', example: 'Example DC West' },
  { key: 'notes', required: false, accepts: 'Free text.', example: '' },
];

export const TIME_IMPORT_ERRORS: Record<string, string> = {
  unknown_columns: 'The file has columns that are not in the template (worker, clock_in, clock_out, break_minutes, job, site, notes).',
  too_many_rows: 'Too many rows. The limit is 5,000 per upload.',
  file_too_large: 'File too large. The limit is 5 MB.',
  invalid_json: 'The server could not read the rows. Preview again.',
  invalid_csv: 'That CSV could not be read.',
  invalid_xlsx: 'That spreadsheet could not be read.',
  unsupported_file: 'Unsupported file type. Use .csv or .xlsx.',
  missing_file: 'Choose a file first.',
  invalid_row_numbers: 'The preview is out of date. Upload the file again.',
  invalid_overrides: 'The preview is out of date. Upload the file again.',
  invalid_skip: 'The preview is out of date. Upload the file again.',
  rows_invalid: 'Some rows need attention, or a shift now overlaps time added since the preview. Preview again, then resolve or skip those rows.',
  forbidden: 'You do not have permission to add time in bulk.',
};

export const TIME_IMPORT_LIMIT_NOTE = 'Uploads are limited to 5,000 rows and 5 MB. Split larger files before uploading.';
```

Create `portal/src/pages/BulkTime.tsx`:

```tsx
/**
 * BulkTime — /bulk/time, "Add time punches in bulk": the shared page shell
 * (hint, Columns, Download, Upload) with TimeImportUpload as the upload
 * pane. Template downloads only: this tool adds shifts, and never exports
 * or updates existing time.
 */
import BulkToolPage from '../components/bulk/BulkToolPage';
import TimeImportUpload from '../components/time/TimeImportUpload';
import { downloadTimeImportTemplate } from '../lib/api';
import { TIME_COLUMN_GUIDE, TIME_IMPORT_LIMIT_NOTE } from '../lib/timeImport';

export default function BulkTime() {
  return (
    <BulkToolPage
      title="Add time punches in bulk"
      hint={<>
        Download the template, fill in one row per shift, upload it, and review every shift before adding.
        Workers match by email, phone, or name; jobs and sites match by name and must already exist. Values that do not match can be picked in the preview.
        A time without an offset is read in the row&apos;s site time zone (or the job&apos;s site&apos;s), and in Eastern time when neither has one.
        Shifts are added as pending, for approval on the Timesheet. A shift that is already there is skipped.
      </>}
      guide={TIME_COLUMN_GUIDE}
      limitNote={TIME_IMPORT_LIMIT_NOTE}
      downloads={[
        { key: 't-xlsx', label: 'Template (.xlsx)', run: () => downloadTimeImportTemplate('xlsx') },
        { key: 't-csv', label: 'Template (.csv)', run: () => downloadTimeImportTemplate('csv') },
      ]}
    >
      <TimeImportUpload />
    </BulkToolPage>
  );
}
```

Create the stub `portal/src/components/time/TimeImportUpload.tsx` (Task 8 replaces the whole file):

```tsx
/** The upload → preview → apply pane of "Add time punches in bulk" (built in the next task). */
export default function TimeImportUpload() {
  return <div className="bulk-import" />;
}
```

- [ ] **Step 5: Summary counts, card, route, audit labels.**

In `portal/src/components/bulk/BulkApplySummary.tsx`:
  - In `BulkSummaryResult`, make `updated?: number;` optional, with the comment `/** Absent for tools that only add (time punches). */`. Make `unchanged?: number;` optional, with the comment `/** Absent for tools that only add. */`.
  - Replace the `counts` array with:

```tsx
  const counts = [
    ...(result.created !== undefined ? [`${result.created} added`] : []),
    ...(result.updated !== undefined ? [`${result.updated} updated`] : []),
    ...(result.skipped !== undefined ? [`${result.skipped} skipped`] : []),
    ...(result.unchanged !== undefined ? [`${result.unchanged} unchanged`] : []),
  ].join(' · ');
```

In `portal/src/pages/BulkActions.tsx`, add this entry to `BULK_TOOLS` directly after the `assets` entry:

```tsx
  {
    key: 'time', title: 'Add time punches in bulk',
    description: 'Load shifts from a spreadsheet or another timekeeping system. Workers, jobs, and sites are matched by name; review every shift before adding.',
    resource: 'time', action: 'add', to: '/bulk/time', button: 'Open',
  },
```

In `portal/src/App.tsx`, add `import BulkTime from './pages/BulkTime';` after the `BulkSites` import. After the `/bulk/assets` route, add:

```tsx
                <Route path="/bulk/time" element={
                  <ProtectedRoute resource="time" minRank={ADMIN_RANK}><BulkTime /></ProtectedRoute>
                } />
```

In `portal/src/lib/auditFormat.ts`, add `import: 'Imported',` to `ACTION_LABELS` (after `bulk_import`) and `time_entry: 'time entry',` to `ENTITY_LABELS` (after `device`).

- [ ] **Step 6: Run the tests, tsc, build**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/portal && npx vitest run src/lib/timeImport.test.ts src/pages/BulkTime.test.tsx src/components/bulk src/pages/BulkActions.test.tsx src/lib/auditFormat.test.ts src/components/assets src/components/initiatives && npx tsc -b && npm run build`
Expected: all PASS, tsc clean, build OK. The asset and job-team panes still compile against the loosened `BulkSummaryResult`.

- [ ] **Step 7: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk
git add portal/src/lib/api.ts portal/src/lib/timeImport.ts portal/src/lib/timeImport.test.ts portal/src/pages/BulkTime.tsx portal/src/pages/BulkTime.test.tsx portal/src/components/time/TimeImportUpload.tsx portal/src/components/bulk/BulkApplySummary.tsx portal/src/components/bulk/BulkApplySummary.test.tsx portal/src/pages/BulkActions.tsx portal/src/pages/BulkActions.test.tsx portal/src/App.tsx portal/src/lib/auditFormat.ts portal/src/lib/auditFormat.test.ts
git commit -F - <<'EOF'
feat(portal): Add time punches in bulk — page, client, Bulk Actions card, route

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Portal — the upload pane (per-line matching, Skip all unmatched, Add N shifts, summary)

**Files:**
- Replace: `portal/src/components/time/TimeImportUpload.tsx`
- Create: `portal/src/components/time/TimeImportRowDetails.tsx`
- Test: `portal/src/components/time/TimeImportUpload.test.tsx` (create)

**Interfaces:**
- Consumes: Task 7's `previewTimeImportFile`, `previewTimeImport`, `commitTimeImport`, `TimeImport*` types, `TIME_IMPORT_ERRORS`; `listWorkerOptions`, `listInitiatives`, `listSites`; `jobOptionDetail` (`lib/teamBulk`); `formatMinutes` (`lib/timeFormat`); `BulkApplySummary` (optional counts, `pageSize`, `extraColumn`).
- Produces: `TimeImportUpload` (no props) and `TimeImportRowDetails`. The accessible names the tests rely on:
  - the file input is labeled "Upload a file (.csv or .xlsx)"
  - buttons: "Preview", "Add N shifts" / "Add 1 shift", "Skip all unmatched", "Show N more"
  - per line: "Match {field} for row {n}", "Skip row {n}", "Clear picks for row {n}"
  - tables: "Time preview", and "Apply summary" from BulkApplySummary

- [ ] **Step 1: Write the failing tests** — create `portal/src/components/time/TimeImportUpload.test.tsx`:

```tsx
// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { TimeImportPreview, TimeImportRow } from '../../lib/api';

function row(n: number, over: Partial<TimeImportRow>): TimeImportRow {
  return {
    row: n, name: `W${n}`, person_id: null, person_name: null, matched_by: null,
    job_id: null, job_name: null, site_id: null, site_name: null, zone: 'America/New_York',
    clock_in_at: '2026-09-24T11:00:00+00:00', clock_out_at: '2026-09-24T19:30:00+00:00',
    break_minutes: 30, minutes: 480, shift: 'Sep 24, 7:00 AM – 3:30 PM EDT', notes: '',
    action: 'add', errors: [], issues: [], detail: null,
    cells: { worker: `W${n}`, clock_in: '9/24/2026 7:00 AM', clock_out: '9/24/2026 3:30 PM',
             break_minutes: '30', job: '', site: '', notes: '' },
    ...over,
  };
}
const cells = (n: number) => row(n, {}).cells;
function preview(rows: TimeImportRow[]): TimeImportPreview {
  const counts = { add: 0, duplicate: 0, attention: 0, error: 0, skipped: 0 };
  rows.forEach((r) => { counts[r.action] += 1; });
  return { rows, counts, can_commit: counts.add > 0 && counts.attention === 0 && counts.error === 0 };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const api = vi.hoisted(() => ({
  previewTimeImportFile: vi.fn(),
  previewTimeImport: vi.fn(),
  commitTimeImport: vi.fn(),
  listWorkerOptions: vi.fn(async () => [{ person_id: 'p9', display_name: 'Zed Zulu' }]),
  listSites: vi.fn(async () => []),
  listInitiatives: vi.fn(async () => [
    { id: 'm1', name: 'Dallas Move', type_label: 'Move', client_name: 'Acme',
      scheduled_start: null, archived_at: null },
    { id: 'm9', name: 'Old Job', type_label: 'Project', client_name: null,
      scheduled_start: null, archived_at: '2026-01-01T00:00:00Z' },
  ] as never),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { default: TimeImportUpload } = await import('./TimeImportUpload');

const ANA = { person_id: 'p1', person_name: 'Ana Lopez', matched_by: 'email' as const };

beforeEach(() => {
  api.previewTimeImportFile.mockResolvedValue(preview([
    row(2, ANA),
    row(3, { action: 'attention', issues: [{
      field: 'worker', kind: 'ambiguous', value: 'Jo Park',
      candidates: [{ id: 'j1', label: 'Jo Park', detail: 'j1@x.test' },
                   { id: 'j2', label: 'Jo Park', detail: 'j2@x.test' }] }] }),
    row(4, { action: 'duplicate', detail: 'Already there.' }),
  ]));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

async function upload(waitFor = 'Needs a match') {
  render(<MemoryRouter><TimeImportUpload /></MemoryRouter>);
  fireEvent.change(screen.getByLabelText('Upload a file (.csv or .xlsx)'),
    { target: { files: [new File(['x'], 'time.csv')] } });
  fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
  await screen.findByText(waitFor);
}
const addButton = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;
const trOf = (n: string) => within(screen.getByRole('table', { name: 'Time preview' }))
  .getByText(n, { selector: 'td' }).closest('tr') as HTMLElement;

it('the preview uses the shared Row / Name / Matched by / Action / Details columns and row tints', async () => {
  await upload();
  const table = screen.getByRole('table', { name: 'Time preview' });
  expect(within(table).getAllByRole('columnheader').map((h) => h.textContent))
    .toEqual(['Row', 'Name', 'Matched by', 'Action', 'Details']);
  expect(trOf('2').className).toContain('bulk-row-create');
  expect(within(trOf('2')).getByText('email')).toBeTruthy();
  expect(within(trOf('2')).getByText('Sep 24, 7:00 AM – 3:30 PM EDT · 8h (30m break)')).toBeTruthy();
  expect(trOf('3').className).toContain('bulk-row-error');
  expect(within(trOf('3')).getByText('“Jo Park” matches 2 workers — pick one.')).toBeTruthy();
  expect(within(trOf('4')).getByText('Already there')).toBeTruthy();
  expect(trOf('4').className).toContain('bulk-row-unchanged');
  expect(screen.getByText('1 to add · 1 already there · 0 to skip · 1 needs a match · 0 errors')).toBeTruthy();
  expect(addButton('Add 1 shift').disabled).toBe(true);
});

it('picking a candidate re-previews with the override and enables Add N shifts', async () => {
  await upload();
  api.previewTimeImport.mockResolvedValue(preview([
    row(2, ANA),
    row(3, { person_id: 'j2', person_name: 'Jo Park', matched_by: 'your pick' }),
    row(4, { action: 'duplicate', detail: 'Already there.' }),
  ]));
  fireEvent.focus(screen.getByLabelText('Match worker for row 3'));
  fireEvent.mouseDown(await screen.findByText('j2@x.test'));
  await waitFor(() => expect(api.previewTimeImport).toHaveBeenCalledWith({
    rows: [cells(2), cells(3), cells(4)], row_numbers: [2, 3, 4],
    overrides: { 3: { worker: 'j2' } }, skip: [] }));
  await waitFor(() => expect(addButton('Add 2 shifts').disabled).toBe(false));
  expect(within(trOf('3')).getByText('your pick')).toBeTruthy();
});

it('Skip all unmatched skips every attention and error row in one re-preview', async () => {
  api.previewTimeImportFile.mockResolvedValue(preview([
    row(2, ANA),
    row(3, { action: 'attention', issues: [{ field: 'job', kind: 'unknown', value: 'Mystery', candidates: [] }] }),
    row(4, { action: 'error', errors: ['Clock-in is in the future.'] }),
  ]));
  api.previewTimeImport.mockResolvedValue(preview([
    row(2, ANA), row(3, { action: 'skipped' }), row(4, { action: 'skipped' }),
  ]));
  await upload();
  fireEvent.click(screen.getByRole('button', { name: 'Skip all unmatched' }));
  await waitFor(() => expect(api.previewTimeImport).toHaveBeenCalledWith(
    expect.objectContaining({ skip: [3, 4], overrides: {} })));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Skip all unmatched' })).toBeNull());
  expect(addButton('Add 1 shift').disabled).toBe(false);
});

it('an unknown job lists every non-archived job, loaded once and lazily', async () => {
  api.previewTimeImportFile.mockResolvedValue(preview([
    row(2, { action: 'attention', issues: [{ field: 'job', kind: 'unknown', value: 'Mystery', candidates: [] }] }),
    row(3, { action: 'attention', issues: [{ field: 'job', kind: 'unknown', value: 'Other', candidates: [] }] }),
  ]));
  await upload();
  await waitFor(() => expect(api.listInitiatives).toHaveBeenCalledTimes(1));
  expect(screen.getByText('No job matches “Mystery” — pick one.')).toBeTruthy();
  fireEvent.focus(screen.getByLabelText('Match job for row 2'));
  expect(await screen.findByText('Dallas Move')).toBeTruthy();
  expect(screen.queryByText('Old Job')).toBeNull();
});

it('apply posts the base rows with the file name and shows the per-row summary', async () => {
  await upload();
  api.previewTimeImport.mockResolvedValue(preview([
    row(2, ANA), row(3, { action: 'skipped' }), row(4, { action: 'duplicate', detail: 'Already there.' }),
  ]));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  await waitFor(() => expect(addButton('Add 1 shift').disabled).toBe(false));
  api.commitTimeImport.mockResolvedValue({
    summary: { added: 1, skipped: 2 },
    rows: [
      { row: 2, name: 'Ana Lopez', entry_id: 't1', action: 'created', detail: 'Sep 24, 7:00 AM – 3:30 PM EDT' },
      { row: 3, name: 'W3', entry_id: null, action: 'skipped', detail: 'Skipped.' },
      { row: 4, name: 'W4', entry_id: null, action: 'skipped', detail: 'Already there.' },
    ],
  });
  fireEvent.click(addButton('Add 1 shift'));
  await waitFor(() => expect(api.commitTimeImport).toHaveBeenCalledWith({
    rows: [cells(2), cells(3), cells(4)], row_numbers: [2, 3, 4], overrides: {}, skip: [3],
    source: 'time.csv' }));
  expect(await screen.findByText('Applied: 1 added · 2 skipped')).toBeTruthy();
  const summary = screen.getByRole('table', { name: 'Apply summary' });
  expect(within(summary).getByText('Sep 24, 7:00 AM – 3:30 PM EDT')).toBeTruthy();
  expect(within(summary).getByText('Already there.')).toBeTruthy();
  expect(screen.queryByRole('table', { name: 'Time preview' })).toBeNull();
});

it('a refused commit explains why and drops the stale preview', async () => {
  api.previewTimeImportFile.mockResolvedValue(preview([row(2, ANA)]));
  const { ApiError } = await import('../../lib/api');
  api.commitTimeImport.mockRejectedValue(new ApiError(422, 'rows_invalid'));
  await upload('Ana Lopez');
  fireEvent.click(addButton('Add 1 shift'));
  expect(await screen.findByText(/a shift now overlaps time added since the preview/)).toBeTruthy();
  expect(screen.queryByRole('table', { name: 'Time preview' })).toBeNull();
});

it('lists 200 rows at a time', async () => {
  api.previewTimeImportFile.mockResolvedValue(preview(Array.from({ length: 450 }, (_, i) =>
    row(i + 2, { person_id: `p${i}`, person_name: `Worker ${i}`, matched_by: 'name' }))));
  await upload('Worker 0');
  const table = screen.getByRole('table', { name: 'Time preview' });
  expect(within(table).queryByText('202', { selector: 'td' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Show 200 more' }));
  expect(within(table).getByText('202', { selector: 'td' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Show 50 more' }));
  expect(within(table).getByText('451', { selector: 'td' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Add 450 shifts' })).toBeTruthy();
});

it('the newest re-preview wins when responses arrive out of order', async () => {
  await upload();
  const first = deferred<TimeImportPreview>();
  const second = deferred<TimeImportPreview>();
  api.previewTimeImport.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  fireEvent.click(screen.getByLabelText('Skip row 3'));
  const still = preview([row(2, ANA), row(3, { action: 'attention', issues: [{
    field: 'worker', kind: 'unknown', value: 'Jo Park', candidates: [] }] })]);
  await act(async () => { second.resolve(still); });
  await act(async () => { first.resolve(preview([row(2, ANA), row(3, { action: 'skipped' })])); });
  expect(screen.getByText('Needs a match')).toBeTruthy();
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/portal && npx vitest run src/components/time/TimeImportUpload.test.tsx`
Expected: FAIL. The stub renders no file input, so the "Upload a file" label is not found.

- [ ] **Step 3: The row details** — create `portal/src/components/time/TimeImportRowDetails.tsx`:

```tsx
/**
 * TimeImportRowDetails — the Details cell of one TimeImportUpload preview
 * line, in TeamBulkRowDetails' markup. It holds the row's error sentences
 * as .pf-error spans, then one .bulk-diff block with:
 *   - an add's shift, length, job and site lines, or "Already there" for a duplicate;
 *   - a portaled match dropdown per unresolved worker / job / site
 *     (candidates first, then, for an unknown value, the whole list);
 *   - the Skip box, and Clear picks.
 * Pure rendering; the pane owns overrides and skips, and re-previews.
 */
import { useId } from 'react';

import type { TimeImportField, TimeImportIssue, TimeImportRow } from '../../lib/api';
import { formatMinutes } from '../../lib/timeFormat';
import ComboBox, { type ComboOption } from '../ComboBox';

export type TimeFieldOptions = Partial<Record<TimeImportField, ComboOption[]>>;
/** Fields whose full list failed to load; their dropdowns say so, and reopening retries. */
export type TimeFieldFailed = Partial<Record<TimeImportField, boolean>>;

/** The issue's candidates, then (unknown values only) the rest of the field's list. */
export function matchOptions(issue: TimeImportIssue, all: TimeFieldOptions): ComboOption[] {
  const picks = issue.candidates.map((c) => ({ value: c.id, label: c.label, sub: c.detail || null }));
  if (issue.kind !== 'unknown') return picks;
  const seen = new Set(picks.map((p) => p.value));
  return [...picks, ...(all[issue.field] ?? []).filter((o) => !seen.has(o.value))];
}

function issueText(issue: TimeImportIssue): string {
  return issue.kind === 'ambiguous'
    ? `“${issue.value}” matches ${issue.candidates.length} ${issue.field}s — pick one.`
    : `No ${issue.field} matches “${issue.value}” — pick one.`;
}

/** "Sep 24, 7:00 AM – 3:30 PM EDT · 8h (30m break)" */
export function shiftLine(row: TimeImportRow): string {
  if (!row.shift) return '';
  const length = row.minutes === null ? '' : ` · ${formatMinutes(row.minutes)}`;
  const brk = row.break_minutes ? ` (${formatMinutes(row.break_minutes)} break)` : '';
  return `${row.shift}${length}${brk}`;
}

interface Props {
  row: TimeImportRow;
  options: TimeFieldOptions;
  failed: TimeFieldFailed;
  picked: Partial<Record<TimeImportField, string>>;
  skipped: boolean;
  disabled: boolean;
  onPick(field: TimeImportField, id: string): void;
  onOpenField(field: TimeImportField): void;
  onClearPicks(): void;
  onToggleSkip(): void;
}

export default function TimeImportRowDetails({
  row, options, failed, picked, skipped, disabled, onPick, onOpenField, onClearPicks, onToggleSkip,
}: Props) {
  const n = row.row;
  const canSkip = row.action === 'attention' || row.action === 'error' || row.action === 'skipped';
  const hasPicks = Object.keys(picked).length > 0;
  const skipHintId = useId();
  return (
    <>
      {row.action !== 'skipped' && row.errors.map((e, i) => (
        <span key={`${i}-${e}`} className="pf-error">{e}</span>
      ))}
      <div className="bulk-diff">
        {(row.action === 'add' || row.action === 'duplicate') && row.shift && <span>{shiftLine(row)}</span>}
        {row.action === 'add' && (
          <>
            <span>Job: {row.job_name || '—'}</span>
            <span>Site: {row.site_name || '—'}</span>
          </>
        )}
        {row.action === 'duplicate' && <span>Already there. Skipped when you add.</span>}
        {row.action !== 'skipped' && row.issues.map((issue) => (
          <div key={issue.field} className="bulk-file-row">
            <span>{issueText(issue)}</span>
            <ComboBox
              portal
              ariaLabel={`Match ${issue.field} for row ${n}`}
              options={matchOptions(issue, options)}
              value={picked[issue.field] ?? ''}
              placeholder={`Pick a ${issue.field}…`}
              disabled={disabled}
              onChange={(id) => { if (id) onPick(issue.field, id); }}
              onOpen={issue.kind === 'unknown' ? () => onOpenField(issue.field) : undefined}
            />
            {issue.kind === 'unknown' && failed[issue.field] && (
              <span className="set-note">Could not load the list. Reopen to retry.</span>
            )}
          </div>
        ))}
        {canSkip && (
          <>
            <label>
              <input type="checkbox" aria-label={`Skip row ${n}`} checked={skipped}
                     aria-describedby={skipped ? skipHintId : undefined}
                     disabled={disabled} onChange={onToggleSkip} />
              {' '}Skip
            </label>
            {skipped && <span id={skipHintId}>Skipped. Uncheck to undo.</span>}
          </>
        )}
        {hasPicks && row.action !== 'skipped' && (
          <button type="button" className="mini-btn" disabled={disabled}
                  aria-label={`Clear picks for row ${n}`} onClick={onClearPicks}>
            Clear picks
          </button>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 4: The pane** — replace `portal/src/components/time/TimeImportUpload.tsx` entirely:

```tsx
/**
 * TimeImportUpload — the upload → preview → apply pane of "Add time punches
 * in bulk", laid out exactly like TeamBulkUpload:
 *   - the file row;
 *   - Preview, "Add N shifts" and "Skip all unmatched";
 *   - the summary line;
 *   - a Row / Name / Matched by / Action / Details preview with bulk-row-* tints.
 * Preview parses the file once, and its cells and spreadsheet row numbers
 * become the base that every later JSON re-preview and the commit post.
 * Unknown or ambiguous workers, jobs and sites are matched per line
 * (overrides), lines can be skipped, and Apply shows the server's per-row
 * summary. The API lists problem rows first; the table shows 200 at a time.
 */
import { useEffect, useRef, useState } from 'react';

import {
  ApiError, commitTimeImport, listInitiatives, listSites, listWorkerOptions,
  previewTimeImport, previewTimeImportFile,
  type TimeImportAction, type TimeImportCommitResult, type TimeImportField,
  type TimeImportOverrides, type TimeImportPreview,
} from '../../lib/api';
import { jobOptionDetail } from '../../lib/teamBulk';
import { TIME_IMPORT_ERRORS } from '../../lib/timeImport';
import BulkApplySummary from '../bulk/BulkApplySummary';
import type { ComboOption } from '../ComboBox';
import DataTable from '../DataTable';
import TimeImportRowDetails, { type TimeFieldFailed, type TimeFieldOptions } from './TimeImportRowDetails';

const PAGE = 200;

const ACTION_LABEL: Record<TimeImportAction, string> = {
  add: 'Add', duplicate: 'Already there', attention: 'Needs a match', error: 'Error', skipped: 'Skipped',
};

/** bulk.css tints the Action column by these (an attention row blocks Add, so it reads as an error). */
const ROW_CLASS: Record<TimeImportAction, string> = {
  add: 'create', duplicate: 'unchanged', attention: 'error', error: 'error', skipped: 'skipped',
};

const LOADERS: Record<TimeImportField, () => Promise<ComboOption[]>> = {
  worker: async () => (await listWorkerOptions())
    .map((w) => ({ value: w.person_id, label: w.display_name })),
  job: async () => (await listInitiatives()).filter((j) => !j.archived_at)
    .map((j) => ({ value: j.id, label: j.name, sub: jobOptionDetail(j) || null })),
  site: async () => (await listSites()).filter((s) => !s.archived_at)
    .map((s) => ({ value: s.id, label: s.name })),
};

const num = (n: number) => n.toLocaleString('en-US');
const plural = (n: number, word: string) => `${num(n)} ${n === 1 ? word : `${word}s`}`;
const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);

/** Uploaded cell, then "→ matched" when the match reads differently. */
function matched(cell: string | undefined, name: string | null) {
  const text = cell?.trim() || '—';
  return name && name !== cell ? <>{text} → <b>{name}</b></> : text;
}

interface Base { cells: Record<string, string>[]; rows: number[] }

export default function TimeImportUpload() {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [base, setBase] = useState<Base | null>(null);
  const [preview, setPreview] = useState<TimeImportPreview | null>(null);
  const [overrides, setOverrides] = useState<TimeImportOverrides>({});
  const [skip, setSkip] = useState<Set<number>>(new Set());
  const [result, setResult] = useState<TimeImportCommitResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(0);
  const [error, setError] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [options, setOptions] = useState<TimeFieldOptions>({});
  const [failed, setFailed] = useState<TimeFieldFailed>({});
  const loading = useRef(new Set<TimeImportField>());
  const seq = useRef(0);

  const mapError = (err: unknown): string =>
    err instanceof ApiError
      ? (TIME_IMPORT_ERRORS[err.code] ?? 'That did not work. Try again.')
      : 'Network error.';

  // The full worker / job / site lists back the dropdowns of UNKNOWN values
  // only, fetched once per field the first time one shows up. A failed load
  // clears the field's flag, so reopening its dropdown retries.
  const loadField = (field: TimeImportField) => {
    if (loading.current.has(field)) return;
    loading.current.add(field);
    setFailed((prev) => ({ ...prev, [field]: false }));
    LOADERS[field]()
      .then((list) => setOptions((prev) => ({ ...prev, [field]: list })))
      .catch(() => {
        loading.current.delete(field);
        setFailed((prev) => ({ ...prev, [field]: true }));
      });
  };

  useEffect(() => {
    for (const r of preview?.rows ?? []) {
      for (const issue of r.issues) {
        if (issue.kind === 'unknown') loadField(issue.field);
      }
    }
  }, [preview]);   // loadField only touches a ref and state setters

  const resetPicks = () => {
    setOverrides({});
    setSkip(new Set());
    setShown(PAGE);
  };

  const runPreview = async () => {
    if (!file) return;
    const mine = ++seq.current;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      const next = await previewTimeImportFile(file, file.name);
      if (mine !== seq.current) return;
      setBase({ cells: next.rows.map((r) => r.cells), rows: next.rows.map((r) => r.row) });
      resetPicks();
      setPreview(next);
    } catch (err) {
      if (mine !== seq.current) return;
      setPreview(null);
      setError(mapError(err));
    } finally {
      setBusy(false);
    }
  };

  /** JSON re-preview with the accumulated picks and skips; a newer request wins. */
  const rerun = async (nextOverrides: TimeImportOverrides, nextSkip: Set<number>) => {
    if (!base) return;
    setOverrides(nextOverrides);
    setSkip(nextSkip);
    const mine = ++seq.current;
    setPending((p) => p + 1);
    setError('');
    try {
      const next = await previewTimeImport({
        rows: base.cells, row_numbers: base.rows, overrides: nextOverrides, skip: sorted(nextSkip),
      });
      if (mine === seq.current) setPreview(next);
    } catch (err) {
      if (mine === seq.current) {
        setPreview(null);
        setError(mapError(err));
      }
    } finally {
      setPending((p) => p - 1);
    }
  };

  const pick = (n: number, field: TimeImportField, id: string) =>
    void rerun({ ...overrides, [n]: { ...overrides[n], [field]: id } }, skip);
  const clearPicks = (n: number) => {
    const next = { ...overrides };
    delete next[n];
    void rerun(next, skip);
  };
  const toggleSkip = (n: number) => {
    const next = new Set(skip);
    if (next.has(n)) next.delete(n);
    else next.add(n);
    void rerun(overrides, next);
  };

  const rows = preview?.rows ?? [];
  const count = (a: TimeImportAction) => preview?.counts[a] ?? 0;
  const unmatched = rows.filter((r) => r.action === 'attention' || r.action === 'error');
  const skipUnmatched = () => void rerun(overrides, new Set([...skip, ...unmatched.map((r) => r.row)]));
  const adds = count('add');
  const attention = count('attention');
  const canApply = !!preview && preview.can_commit && pending === 0 && adds > 0;

  const runApply = async () => {
    if (!preview || !base || !file) return;
    setBusy(true);
    setError('');
    try {
      const applied = await commitTimeImport({
        rows: base.cells, row_numbers: base.rows, overrides, skip: sorted(skip), source: file.name,
      });
      setPreview(null);
      setBase(null);
      setFile(null);
      resetPicks();
      if (fileRef.current) fileRef.current.value = '';
      setResult(applied);
    } catch (err) {
      setError(mapError(err));
      setPreview(null);   // stale after a refused commit: force a fresh preview
    } finally {
      setBusy(false);
    }
  };

  const inputId = 'time-bulk-file';

  return (
    <div className="bulk-import">
      <div className="bulk-file-row">
        <label htmlFor={inputId}>Upload a file (.csv or .xlsx)</label>
        <input
          id={inputId}
          ref={fileRef}
          type="file"
          accept=".csv,.xlsx"
          disabled={busy || pending > 0}
          onChange={(e) => {
            seq.current += 1;          // an in-flight preview of the old file is now stale
            setFile(e.target.files?.[0] ?? null);
            setPreview(null);
            setBase(null);
            resetPicks();
            setResult(null);
            setError('');
          }}
        />
      </div>

      <div className="bulk-actions">
        <button className="btn-solid" type="button" disabled={busy || !file}
                onClick={() => void runPreview()}>
          {busy ? 'Working…' : 'Preview'}
        </button>
        <button className="btn-solid" type="button" disabled={busy || !canApply}
                onClick={() => void runApply()}>
          {`Add ${plural(adds, 'shift')}`}
        </button>
        {unmatched.length > 0 && (
          <button className="mini-btn" type="button" disabled={busy} onClick={skipUnmatched}>
            Skip all unmatched
          </button>
        )}
      </div>

      {error && <p className="pf-error">{error}</p>}

      {result && (
        <BulkApplySummary
          result={{
            created: result.summary.added, skipped: result.summary.skipped,
            rows: result.rows.map((r) => ({ ...r, diff: null })),
          }}
          entityLabel="Worker"
          linkFor={() => null}
          filename="time-bulk-summary"
          openTo="/people/time"
          openLabel="Open Time Management"
          pageSize={PAGE}
          extraColumn={{ label: 'Shift', value: (r) => r.detail ?? '' }}
        />
      )}

      {preview && (
        <>
          <p className="set-note">
            {`${num(adds)} to add · ${num(count('duplicate'))} already there · ${num(count('skipped'))} to skip · `
              + `${num(attention)} ${attention === 1 ? 'needs' : 'need'} a match · ${plural(count('error'), 'error')}`}
          </p>
          <DataTable
            ariaLabel="Time preview"
            className="bulk-preview"
            columns={[
              { key: 'row', label: 'Row', width: '64px', mono: true },
              { key: 'name', label: 'Name' },
              { key: 'matched_by', label: 'Matched by' },
              { key: 'action', label: 'Action' },
              { key: 'details', label: 'Details' },
            ]}
            rows={rows.slice(0, shown).map((r) => ({
              key: String(r.row),
              className: `bulk-row-${ROW_CLASS[r.action]}`,
              cells: [
                r.row,
                matched(r.cells.worker, r.person_name),
                r.matched_by ?? '—',
                ACTION_LABEL[r.action],
                <TimeImportRowDetails
                  key="details"
                  row={r}
                  options={options}
                  failed={failed}
                  picked={overrides[r.row] ?? {}}
                  skipped={skip.has(r.row)}
                  disabled={busy}
                  onPick={(field, id) => pick(r.row, field, id)}
                  onOpenField={loadField}
                  onClearPicks={() => clearPicks(r.row)}
                  onToggleSkip={() => toggleSkip(r.row)}
                />,
              ],
            }))}
          />
          {rows.length > shown && (
            <div className="bulk-actions">
              <button className="mini-btn" type="button" onClick={() => setShown((s) => s + PAGE)}>
                {`Show ${Math.min(PAGE, rows.length - shown)} more`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Run the tests, the full portal suite, tsc and build**

Run: `cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/portal && npx vitest run src/components/time src/pages/BulkTime.test.tsx && npx vitest run && npx tsc -b && npm run build`
Expected: all PASS, tsc clean, build OK.

- [ ] **Step 6: Commit**

```bash
cd /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk
git add portal/src/components/time/TimeImportUpload.tsx portal/src/components/time/TimeImportRowDetails.tsx portal/src/components/time/TimeImportUpload.test.tsx
git commit -F - <<'EOF'
feat(portal): time punch upload pane — per-line matching, Skip all unmatched, Add N shifts, apply summary

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 9 (controller): full suites, live verification, parity

- [ ] Full API suite, FOREGROUND, in three chunks so each run fits the 10-minute tool timeout. The whole suite takes about 17 minutes, so never background it. From `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/api`, run each chunk as one command with timeout 600000 ms:
  - `PYTHONPATH=src SS_TEST_DB=serversherpa_test_time_bulk /Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/pytest $(ls tests/test_*.py | sort | sed -n '1,80p') -q`
  - the same with `sed -n '81,160p'`
  - the same with `sed -n '161,$p'`

  If a chunk nears the timeout, split it in two. Expected: all pass. Treat a failure as pre-existing only after the same test file fails on main in a temporary worktree (`git worktree add` of `main`); never revert files to check. Then run `/Users/jrh1812/Developer/BaseCampV3/api/.venv/bin/ruff check src tests` → `All checks passed!`
- [ ] Portal: `cd …/time-bulk/portal && npx vitest run && npx tsc -b && npm run build`, all green.
- [ ] Kiosk type check, because it compiles shared portal code. If `kiosk/node_modules` is missing, `ln -s /Users/jrh1812/Developer/BaseCampV3/kiosk/node_modules /Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/time-bulk/kiosk/node_modules`. Then run `cd …/time-bulk/kiosk && npx tsc -b`; it should be clean.
- [ ] Whole-branch review (superpowers:requesting-code-review) against the spec and this plan's Decisions list before live verification.
- [ ] Live stack from this worktree. Another session may own 8000/5173, so use 8001/5175 and start both detached (the desktop app reaps `preview_start` servers):
  - `mkdir -p …/time-bulk/.devlogs`
  - `cd …/time-bulk && nohup api/.venv/bin/python -m uvicorn --factory serversherpa.api.app:create_app --app-dir api/src --host 0.0.0.0 --port 8001 > .devlogs/api-8001.log 2>&1 &`
  - `cd …/time-bulk && VITE_API_URL=http://localhost:8001 nohup npm --prefix portal run dev -- --port 5175 --strictPort > .devlogs/portal-5175.log 2>&1 &`

  Sign in as claude-dev@test.example.com. No migration is needed, because the dev DB schema is unchanged.
- [ ] `/bulk` shows the "Add time punches in bulk" card with its description. Open `/bulk/time` and `/bulk/initiative-people` side by side and compare their outlines: the same sections (hint, Columns, Download, Upload), the same preview headers, the same button row and the same summary.
- [ ] Import a small CSV with the DataTransfer file-injection recipe (memory: bulk sites import):
  - one good row for a real dev worker, with a site that has a timezone;
  - one row with an unknown worker, which you pick in the preview;
  - one row repeating an existing entry, which reads "Already there".

  Check the shift text shows the site's zone abbreviation. Click "Add 2 shifts" and check the summary and its CSV download.
- [ ] `/people/time`:
  - The new rows are Pending, and the Source column (enable it in Columns) reads "Import".
  - Filter by the job, then "Approve all pending in this view". The dry-run count shows in the dialog; confirm it, and the note reads "Approved N entries." (with "Skipped …: your own entry (…)" if claude-dev's own entries matched). Show skipped lists them.
  - Tick one pending row, then Reject selected with a reason, and check the row shows the reason.
  - Type in search and check "Approve all" disables, with its note.
- [ ] Stop both servers (`kill` the two nohup PIDs). Record for Jimmy the dev-DB rows this created: the imported entries and the approvals and rejections.
- [ ] Parity: tell Jimmy that To-Do #17 ("Add bulk approval and bulk punch import") is ready to mark done. The workbook (`docs/BaseCamp-V2-to-V3-Feature-Parity.xlsx`) is untracked in the main checkout, so do not edit it from this worktree.
- [ ] Finish with superpowers:finishing-a-development-branch.

---

## Self-review (run while writing; fixes are already applied above)

**Spec coverage:**

| Spec item | Where it lands |
|---|---|
| Checkboxes on pending rows, select all, indeterminate | Task 6 |
| Approve selected / Reject selected with a reason dialog in the header pattern | Task 6 |
| Approve all pending in this view with a dry run, the confirmation text, and sending the filter | Tasks 5 and 6 |
| `time:change` gating in the UI | Task 6 |
| The result note, Show skipped, refresh and clear | Task 6 |
| The API: ids or filter, dry run, rules, visibility, one transaction, per-entry audit, the 5,000 cap, `FOR UPDATE` | Task 1 |
| Filter reuse | Task 1 (`_entry_conditions`) |
| Import access, card and route | Tasks 4 and 7 |
| Page layout, downloads (templates only) and limit | Task 7 |
| Columns, matching (email → phone → name), job and site matching | Task 3 |
| Time zone rules, DST fold=0 and the preview shift text | Tasks 2 and 3 |
| Row outcomes, error sentences, overlap rules, duplicates | Task 3 |
| Re-preview with overrides / skip / row_numbers, and `can_commit` | Tasks 3 and 8 |
| The three endpoints and the commit shape | Task 4 |
| Apply: pending "import" entries, per-entry audit, `bulk_import`, the locked re-check, all-or-nothing | Task 4 |
| No migration; the "Import" source label | Task 5 |
| Listed tests | the tasks' own test files |
| Live check | Task 9 |

**Placeholder scan:** every code step carries its code. The one stub, `TimeImportUpload` in Task 7, is replaced whole in Task 8.

**Type consistency:** these names agree across tasks:
- `TimesheetFilter`, `NO_FILTER`, `bulkFilter`, `listQuery`;
- `TimeBulkSkip`, `bulkApproveTimeEntries`, `countBulkApproveTimeEntries`, `bulkRejectTimeEntries`;
- `TimeImportRow` and friends, `previewTimeImport(File)`, `commitTimeImport`;
- `TIME_IMPORT_ERRORS`, `TIME_COLUMN_GUIDE`, `TIME_IMPORT_LIMIT_NOTE`;
- on the API side, `preview_rows(..., now=)` and `commit_rows(..., source_label=)`.

The API row keys (`matched_by`, `shift`, `minutes`, `detail`, `cells`) match the TypeScript `TimeImportRow`. The commit row `action` values `created` / `skipped` fit `BulkSummaryRow`.
