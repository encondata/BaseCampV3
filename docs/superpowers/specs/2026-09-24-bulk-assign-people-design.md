# Bulk assign people to a job — design

**Date:** 2026-09-24
**Branch:** `bulk-initiative-people` (worktree `.claude/worktrees/bulk-assign`)
**Parity:** To-Do #7, feature "Bulk assign people to jobs". The sibling feature "Import jobs in bulk" is retired (V2's version never worked; jobs are created in the portal).

## Goal

An admin picks one job (initiative) and uploads a spreadsheet of workers with the site they worked and the role they performed. The preview shows what will be added or changed, lets the admin fix any unknown or ambiguous worker, site or role with a dropdown on that line, and applies everything in one go with the usual per-row summary.

## Decisions (from brainstorming)

| Question | Decision |
|---|---|
| Import jobs in bulk | **Skipped / retired.** |
| Which job | **Picked on the page**, not a column. |
| Columns | **`worker`** (required), **`site`**, **`role`**. |
| People already on the job | **Add and update, never remove.** Site/role changes are updates the admin approves. People on the job but not in the sheet are untouched. |
| Unknown / ambiguous names | **Row needs attention**, resolved in the preview by a per-line dropdown (worker, site or role), or the line is skipped. No auto-creating workers. |
| Resolution mechanism | Per-row **overrides sent with the commit**; the server re-runs the preview with them and refuses anything unresolved. |

## What exists (reuse)

- Shared bulk core `api/src/serversherpa/imports/bulk.py` (`parse_upload`, `number_json_rows`, `check_columns`, `guard_cell`, `build_rows_csv/xlsx` with a Reference sheet, `BulkImportError`, `MAX_ROWS`) and `api/src/serversherpa/api/bulk_routes.py` (`require_bulk_rank`, `bulk_http_error`, `rows_from_request`).
- Template tool to copy: trucks — `api/src/serversherpa/trucks/bulk_import.py` (`_index`, `_resolve_one`, `preview_rows`, `commit_rows`, `_diff_row`), routes `api/routes/trucks.py:211-294` (declared above `/{truck_id}`).
- Worker identity: `people/bulk_import.py` — `name_keys(first, last, preferred)` (first+last and preferred+last, whitespace-squashed, casefolded) and `_worker_query()` (non-revoked `PersonRole(role="worker")`, `Person.archived_at IS NULL`).
- Team link: `InitiativePerson(initiative_id, person_id, work_type → initiative_work_type, site_worked_id → sites, rating)`, `UNIQUE(initiative_id, person_id)`. Existing add rules in `routes/initiatives.py` (`POST /{id}/people`, audit `person_add`; `PATCH /people/{assoc_id}`).
- Work types: `status_values` rows with record type `initiative_work_type` (seeded lead, tech, cabling, logistics, other); each has `key` and `label`.
- Portal: `components/bulk/BulkToolPage.tsx`, `BulkApplySummary.tsx` (`BulkSummaryRow`, `changesText`, CSV download), `pages/BulkActions.tsx` `BULK_TOOLS`, `App.tsx` bulk routes (`ProtectedRoute … minRank={ADMIN_RANK}`), `ComboBox` for pickers, `listWorkerOptions()` (`GET /workers`).

`BulkUpload.tsx` (the generic upload pane) has no per-line resolver or skip; this tool gets its own pane (`components/initiatives/TeamBulkUpload.tsx`), the way sites has `SiteBulkUpload.tsx`, reusing `BulkApplySummary` for results.

## Columns and matching

| Column | Required | Matches | Blank means |
|---|---|---|---|
| `worker` | yes | A live worker whose "first last" or "preferred last" equals the cell (whitespace-squashed, casefolded; `name_keys`) | row error `worker_required` |
| `site` | no | A non-archived site by name (casefolded) | existing assignment: leave as is; new: none |
| `role` | no | A work type by `key` or `label` (casefolded) | existing assignment: leave as is; new: none |

Per-cell outcomes: `ok`, `unknown` (no match), `ambiguous` (2+ matches; candidates returned). Unknown/ambiguous cells make the row **needs attention** until an override resolves it or the row is skipped.

Within the file: two rows that resolve to the same worker (after overrides) are both errors `duplicate_worker` — a person is on a job once.

## Row actions

- `add` — worker not on the job.
- `update` — worker on the job and the sheet sets a site or role different from the current one (blank = no change). Carries a `diff` `{site: {from, to}, role: {from, to}}` (names, not ids).
- `unchanged` — worker on the job, nothing differs.
- `attention` — at least one cell unknown/ambiguous and not overridden; carries `issues: [{field: "worker"|"site"|"role", kind: "unknown"|"ambiguous", value, candidates: [{id, label, detail}]}]`.
- `error` — `worker_required`, `duplicate_worker`, or an override that points at something invalid (`override_invalid`).
- `skipped` — the admin marked the line skip.

`can_commit` is true when no row is `attention` or `error`.

## API

All under the job in `routes/initiatives.py` (four path segments, so they cannot collide with `/{initiative_id}` or `/{initiative_id}/people`). Every route: `require_bulk_rank(actor)` + `require_permission("initiatives", "change")`; the job must exist and not be archived (`initiative_not_found` 404 / `initiative_archived` 409).

| Method / path | Body | Returns |
|---|---|---|
| `GET /initiatives/{id}/people/bulk/template?format=csv\|xlsx` | – | sample rows; xlsx Reference sheet "Workers", "Sites", "Roles" |
| `GET /initiatives/{id}/people/bulk/export?format=csv\|xlsx` | – | the current team in template shape (worker = display "first last", site name, role label) |
| `POST /initiatives/{id}/people/bulk/preview` | multipart `file` or JSON `{rows}`, optional JSON `{overrides, skip}` | `{rows: [...], can_commit, counts}` |
| `POST /initiatives/{id}/people/bulk/commit` | JSON `{rows, overrides, skip, approved_updates, source}` | `{added, updated, unchanged, skipped, rows: [{row, worker, person_id, action, diff}]}` |

`overrides`: `{"<row>": {"worker": "<person_id>", "site": "<site_id>", "role": "<work_type key>"}}` — any subset of fields. `skip`: list of row numbers. `approved_updates`: list of row numbers; unapproved updates are left unchanged and reported as skipped.

Commit re-runs preview with the overrides and skips; `rows_invalid` 422 if anything is still `attention`/`error`. Writes are one transaction: insert `InitiativePerson` for adds (the unique constraint is the backstop — a race raises `rows_invalid` with `duplicate_worker`), update `site_worked_id`/`work_type` for approved updates, `updated_at = now()`. Audit: `person_add` / `person_update` per row (entity `initiative`, same shape as the single-person routes) plus one `bulk_import` summary row with the source filename and counts.

## Portal

- **Bulk Actions card:** "Assign people to a job" → `/bulk/initiative-people`, `resource: "initiatives"`, `action: "change"`.
- **Page** `pages/BulkInitiativePeople.tsx` on `BulkToolPage`: column guide (three columns), a **job picker** (ComboBox over active initiatives; option shows name plus type, client and scheduled dates so duplicates are distinguishable); downloads (template xlsx/csv, current team xlsx/csv) disabled until a job is picked; the upload pane below.
- **Pane** `components/initiatives/TeamBulkUpload.tsx`: file drop → preview table (row, worker, site, role, action chip, changes). An `attention` row shows a ComboBox per problem cell — ambiguous candidates listed first, then all workers / sites / roles — and a "Skip" toggle. Choosing re-runs preview with the accumulated overrides (debounced); rows turn `add`/`update`/`unchanged`. Updates have approve checkboxes, unchecked by default like the shared `BulkUpload` pane. **Apply** enabled when `can_commit`. Then `BulkApplySummary` (entity "Worker", link to the job's Team tab, summary CSV).
- API client functions in `lib/api.ts`: `previewTeamBulk`, `commitTeamBulk`, `downloadTeamTemplate`, `downloadTeamExport`; types `TeamBulkRow`, `TeamBulkPreview`, `TeamBulkCommitResult`.
- Modal/list conventions: no modal needed; the preview table follows the list-column-floors pattern (`listGridStyle`, `list-scroll`).

## Testing

- **Service** (`api/tests/test_initiative_people_bulk_service.py`): add; update with diff; unchanged; blank site/role = no change on existing; unknown and ambiguous worker/site/role → `attention` with candidates; preferred-name match; archived worker not matched; revoked worker role not matched; override resolves a row; bad override → `override_invalid`; duplicate worker in file (also via override); skip; unapproved update left alone; commit refuses unresolved rows; all-or-nothing (a failing row writes nothing); audit rows.
- **API** (`api/tests/test_initiative_people_bulk_api.py`): rank + permission gates; archived / unknown job; template and export both formats (export round-trips as all `unchanged`); preview via file and via JSON; commit with overrides.
- **Portal:** `BulkInitiativePeople.test.tsx` (downloads disabled until a job is picked; picker shows disambiguating detail), `TeamBulkUpload.test.tsx` (attention row dropdown → re-preview → apply; skip; update approval), `BulkActions.test.tsx` (new card).

## Out of scope

Removing people not in the sheet; rating column; creating workers; multiple jobs per file; the retired jobs importer.
