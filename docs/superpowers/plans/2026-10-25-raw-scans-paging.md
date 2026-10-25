# Raw Scans Paging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scans › Raw scans opens instantly at 100k+ rows: server-side keyset paging, sorting, filtering, search, facets and export, with a reusable portal paged-list hook.

**Architecture:** Three new `scans:view` endpoints beside the unchanged `GET /scans/raw`; migration 0108 indexes; a shared `usePagedList` hook plus an async values source for `ColumnMenu`; the Raw scans tab switched over with the same columns and menus.

**Tech Stack:** FastAPI, SQLAlchemy async, Postgres, pytest; React + TypeScript, vitest.

**Spec:** `docs/superpowers/specs/2026-10-25-raw-scans-paging-design.md` — binding.

## Global Constraints

- `GET /scans/raw` behavior unchanged (other callers).
- New endpoints `GET /scans/raw/page`, `/scans/raw/facets`, `/scans/raw/export`, all `scans:view`; declared before any `/raw/{id}`-style route.
- Page response `{rows, next_cursor, total}`; `limit` default 100, max 500; default sort `scanned` `desc`; keyset by sort expression then `id`; opaque cursor; bad cursor/sort/filters → 422.
- `filters` = the portal's `ColumnFilters` JSON (`{colKey: {text?, values?}}`), values are displayed text, `—` = empty — saved filters keep working.
- Search covers: scanned value, scan type label, status label, device, operator name, site name, location, source.
- Facets: distinct displayed values with counts, most frequent first, cap 500, excluding the column's own filter, optional `search`.
- Scanned column: From/To date range (`since`/`until`) instead of text/value filtering; Ingested: sort only.
- Natural sort for text (`natural()` helper); migration **0108** (head is 0107 — check every worktree and the dev DB before numbering).
- First page under 300 ms on dev's 100k rows.
- Portal: `usePersistentListState` keys/prefs unchanged; stale responses dropped; rows kept visible while reloading; `VirtualRows` stays; house list idioms and guardrails (list typography, natural sort, list-head rule (h)).
- Never commit `api/src/serversherpa/_dev_reload.py`. Never `git stash`. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. American English.

## How to run things (worktree `.claude/worktrees/raw-scans-paging`)

- API tests, foreground only, long timeout: `cd api && PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_rawpage DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/pytest -q <files>`; alembic commands must set `SS_DATABASE_URL` to the test DB.
- Portal: `cd portal && npx vitest run <files>`; before committing: full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: API — paged, faceted and exported raw scans

**Files:** modify `api/src/serversherpa/api/routes/scans.py`, `api/src/serversherpa/api/schemas.py`; create a query module (e.g. `api/src/serversherpa/scans/raw_query.py`) shared by page/facets/export, `api/migrations/versions/0108_raw_scans_paging_indexes.py`, `api/tests/test_raw_scans_paging.py` (+ migration test following the repo's migration-test pattern).

**Produces:** the three endpoints and response shapes exactly as the spec says.

- [ ] Step 1: failing tests per the spec's API testing paragraph (seed a few hundred rows with ties; a 100k-row timing test may be marked slow/skipped by default but must exist and pass when run).
- [ ] Step 2: run; confirm failure. Step 3: implement (EXPLAIN the default and per-column sorts; add indexes accordingly). Step 4: run the new tests plus `tests/test_scans*.py` and migration tests; ruff clean. Step 5: commit `feat(scans): server-side paged, faceted and exported raw scans (migration 0108)`.

### Task 2: Portal — `usePagedList` hook and async ColumnMenu values

**Files:** create `portal/src/lib/usePagedList.ts` (+ test); modify `portal/src/lib/columnMenu.tsx` (optional async values source; existing callers unchanged) (+ test); `portal/src/lib/api.ts` (typed calls for the three endpoints, export as an authenticated blob download).

**Consumes:** Task 1's endpoints. **Produces:** `usePagedList({fetchPage, deps…}) → {rows, total, loading, error, loadMore, reload}` and the ColumnMenu async source prop — document the exact signatures in the report for Task 3.

- [ ] Step 1: failing tests (page 1 on sort/filter/search/date change, search debounce, stale-response drop, loadMore appends and stops at null cursor, rows kept while reloading, error state; ColumnMenu shows async values with counts, loading state, still works sync).
- [ ] Step 2–4: implement; full vitest, tsc, build. Step 5: commit `feat(portal): paged list hook and server-backed column menu values`.

### Task 3: Portal — Raw scans tab on the paged endpoints

**Files:** modify `portal/src/components/scans/RawScansTab.tsx` (+ its test), `portal/src/lib/scans.ts` if needed.

**Consumes:** Task 2's hook and ColumnMenu source; Task 1's endpoints.

- [ ] Step 1: failing tests (first page shown, result count from total, scroll loads more, sort/filter/search call the API with the right params, column menus from facets, Scanned date range, export calls the export endpoint, saved prefs restored).
- [ ] Step 2–4: implement; full vitest, tsc, build. Step 5: commit `feat(portal): Raw scans loads in pages from the server`.
