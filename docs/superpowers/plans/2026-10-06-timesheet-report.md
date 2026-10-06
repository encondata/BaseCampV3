# Timesheet report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `timesheet` report type (Excel/PDF) on the reports framework: date range + Person/Job/Site filters, statuses, day and punch views, summary, verification flags; generated from Reports or straight from the Timesheet screen.

**Architecture:** New package `api/src/serversherpa/reports/timesheet/` (gather → xlsx | Jinja/WeasyPrint pdf), registered in the report registry, seeded by migration 0090; small route/worker changes for a no-initiative, time:view-gated report; portal options step in the Generate modal plus a launcher on the Timesheet screen.

**Tech Stack:** FastAPI, SQLAlchemy async, openpyxl, WeasyPrint, Jinja2, pdf417gen; React + TypeScript, vitest.

Spec (binding: options, data rules, flags, layouts, copy, permissions): `docs/superpowers/specs/2026-10-06-timesheet-report-design.md`. Reference implementation to copy patterns from: `api/src/serversherpa/reports/move_scan_history/` (module, `xlsx.py`, `pdf.py`, `barcode.py`, `timefmt.py`, `templates/move_scan_history.html`), migration `api/migrations/versions/0054_move_scan_history.py`, portal `components/reports/MoveScanHistoryOptions.tsx` + `lib/moveScanHistory.ts`.

## Global Constraints

- `report_type = "timesheet"`; system definition name `Timesheet`; description `Hours worked by person and job over a date range, with a day view, every punch and verification flags, as Excel or PDF.`
- Run options keys exactly: `from`, `to` (`YYYY-MM-DD`, from ≤ to, span ≤ 366 days), `person_id`, `site_id` (uuid strings, optional), `statuses` (non-empty subset of `approved`,`pending`,`rejected`,`open`), `views` (non-empty subset of `day`,`punch`), `format` (`xlsx`|`pdf`). Job filter = `report_runs.initiative_id`.
- Definition options: `default_format` (`xlsx`), `default_views` (`["day","punch"]`), `default_statuses` (`["approved","pending"]`). Run keys win, then definition, then these.
- Flags, exact labels: `Adjusted`, `Manual entry`, `Over 10 h` (worked ≥ 600), `Over 16 h` (worked ≥ 960, replaces Over 10 h), `Overlap`, `Still clocked in`.
- Day/time zone: entry's site `timezone` when set, else `services.timezone.report_timezone()`; clock times print `HH:MM ZZZ` (24-hour, zone abbreviation); worked prints `Hh MMm`; Excel adds decimal `Hours` (2 places).
- Totals = approved + pending closed entries only. Max 20,000 matching entries → error code `too_many_entries`.
- Day status: shared status label (`Approved`/`Pending`/`Rejected`/`On the clock`) else `Mixed`. Sort: date, person (natural, `natural_key`), clock-in.
- Permissions: timesheet runs and preview also need `time:view` → 403 `time_view_required`; history list/get/download hide timesheet runs from people without `time:view` (get/download → 404 `run_not_found`).
- Migration number `0090`, `down_revision = "0089"`.
- Portal copy verbatim from the spec's Portal section. Reuse idioms (OptionsGrid/PreviewCard/OptionGroup/ChoiceCard, ComboBox, pf-form, mini-btn, btn-solid, Switch). No native `<select>` for data lists; no `localeCompare`/bare `.sort()` (natural sort guardrail); no new `*-head` CSS selectors; list typography guardrail must pass.
- American English. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `git stash`. Never commit `api/src/serversherpa/_dev_reload.py`. Never write to the dev DB.
- API tests from `api/`: `PYTHONPATH=$PWD/src SS_TEST_DB=serversherpa_test_timesheet DYLD_FALLBACK_LIBRARY_PATH=/opt/homebrew/lib .venv/bin/pytest -q <files>` (foreground, long timeout; WeasyPrint needs the DYLD var on macOS). Portal from `portal/`: `npx vitest run <files>`, full `npx vitest run`, `npx tsc -b`, `npm run build`.

---

### Task 1: gather — query, local days, flags, rollups

**Files:** Create `api/src/serversherpa/reports/timesheet/__init__.py` (empty placeholder docstring for now, real module in Task 2), `api/src/serversherpa/reports/timesheet/gather.py`; Test `api/tests/test_timesheet_gather.py`.

**Produces (exact names):**
- `MAX_ENTRIES = 20_000`; `FLAG_ADJUSTED = "Adjusted"`, `FLAG_MANUAL = "Manual entry"`, `FLAG_OVER_10 = "Over 10 h"`, `FLAG_OVER_16 = "Over 16 h"`, `FLAG_OVERLAP = "Overlap"`, `FLAG_OPEN = "Still clocked in"`; `CLOSED_COUNTED = ("approved", "pending")`.
- `class TimesheetTooLarge(Exception)` with `code = "too_many_entries"`.
- `@dataclass(frozen=True) TimesheetFilters(from_day: date, to_day: date, person_id: UUID | None, initiative_id: UUID | None, site_id: UUID | None, statuses: tuple[str, ...])`.
- `@dataclass EntryRow(id, person_id, person_name, initiative_id, job_name: str | None, site_name: str | None, tz_name: str, local_day: date, clock_in: datetime (aware, local), clock_out: datetime | None (local), break_minutes: int, worked_minutes: int, status: str, status_label: str, source: str, approved_by_name: str | None, adjusted: bool, adjust_reason: str | None, notes: str | None, flags: list[str])`.
- `@dataclass DayRow(day: date, person_id, person_name, entries: int, first_in: datetime, last_out: datetime | None, worked_minutes: int, status_label: str, flags: list[str])` (worked sums all its entries' worked minutes; flags = ordered union).
- `@dataclass PersonTotal(person_id, person_name, days: int, entries: int, approved_minutes: int, pending_minutes: int, flagged: int)`; `@dataclass JobTotal(initiative_id, job_name: str, people: int, entries: int, approved_minutes: int, pending_minutes: int)` (`"No job"` for none); totals `total_minutes` property = approved + pending on both.
- `@dataclass TimesheetData(filters, person_label: str, job_label: str, site_label: str, entries: list[EntryRow], days: list[DayRow], by_person: list[PersonTotal], by_job: list[JobTotal], approved_minutes: int, pending_minutes: int, people: int, day_count: int, flagged_entries: int, default_tz: str)`.
- Pure helpers (unit-testable without the DB): `flags_for(entries: list[EntryRow], now: datetime) -> None` (fills `.flags` in the spec's order: Adjusted, Manual entry, Over 10/16 h, Overlap, Still clocked in), `day_rows(entries) -> list[DayRow]`, `rollups(entries) -> tuple[list[PersonTotal], list[JobTotal], int, int]`.
- `async def gather(db: AsyncSession, filters: TimesheetFilters, *, now: datetime | None = None, limit: int = MAX_ENTRIES) -> TimesheetData`: query `TimeEntry` with person/initiative/site/status filters and a UTC window of `[from_day - 1 day, to_day + 2 days)` on `clock_in_at`, then keep entries whose local day (site tz or default) is within `[from_day, to_day]`; count first and raise `TimesheetTooLarge` when over `limit`; names via `Person.display_name`, `Initiative.name`, `Site.name`, approver display name; labels "Everyone"/"All jobs"/"All sites" when unfiltered; worked via `services.timeclock.worked_minutes`.

- [ ] Step 1: tests first — pure helpers (each flag; Over 16 h replaces Over 10 h; overlap incl. an open entry; day row status Mixed vs shared; union of flags; rollups exclude rejected/open from minutes but count entries; "No job" bucket; sort order natural by person name e.g. "Ann 2" before "Ann 10") and DB-backed `gather` (seed people/sites/initiatives/time entries in the test DB: an entry at 01:30 UTC lands on the previous local day in America/New_York; a site in America/Los_Angeles uses its own zone; inclusive range edges; each filter; statuses; `TimesheetTooLarge` with `limit=2`). Look at existing time tests (`api/tests/test_time*.py`) and conftest fixtures for how to create people/entries.
- [ ] Step 2: run → FAIL. Step 3: implement. Step 4: run → PASS.
- [ ] Step 5: commit `feat(reports): timesheet gather — local days, verification flags, rollups`.

---

### Task 2: module, Excel, PDF, registry, migration 0090

**Files:** `reports/timesheet/__init__.py` (module), `reports/timesheet/xlsx.py`, `reports/timesheet/pdf.py`, `reports/timesheet/templates/timesheet.html`, `reports/registry.py`, `api/migrations/versions/0090_timesheet_report.py`; Tests `api/tests/test_timesheet_report.py`, `api/tests/test_timesheet_seed.py`.

**Produces:** module `report_type = "timesheet"`, `default_options() -> {"default_format": "xlsx", "default_views": ["day", "punch"], "default_statuses": ["approved", "pending"]}`, `validate_options(options) -> dict` (definition-level; `OptionsError` with readable problems), `validate_run_options(options) -> dict` (checks `from`/`to` present and valid, span, uuids, subsets non-empty, format; keeps only known keys, no defaults filled except nothing), `parse_run(run, definition_options) -> tuple[TimesheetFilters, list[str] views, str fmt]`, `async build(db, run) -> ReportResult` (filename per spec; reuses `move_scan_history` `XLSX_MIME`, `pdf417_data_uri`, `render_pdf`, `cssstr`, `_FILENAME_UNSAFE_RE`-style stripping). `xlsx.build_workbook(data, views, generated_at) -> bytes` (sheets Summary / By day / Punches per spec, frozen headers, bold, autofit ≤ 40, decimal Hours number format `0.00`). `pdf.render_html(data, views, *, generated_at, tracking_id) -> str` + `render_pdf`. Migration copies 0054's constants/`CAST(:options AS jsonb)`/`ON CONFLICT … DO NOTHING` pattern with `DEFAULT_OPTIONS` = the default_options JSON.

- [ ] Step 1: tests first — validate_run_options (missing dates, from > to, 367-day span, bad uuid, empty statuses/views, unknown status, bad format → OptionsError listing problems; good input passes through without extra keys); parse_run merge order (run > definition > defaults); xlsx (sheet names per views, Summary title and KPI values, By day and Punches headers verbatim from the spec, a decimal Hours cell is numeric, flags joined with ", "); PDF (render_html contains the section headings for the chosen views and the tracking id; `render_pdf` returns bytes starting `%PDF` — needs the DYLD var); build filename with person and job; seed test executes the migration constants (copy `test_move_scan_history_seed.py`).
- [ ] Step 2–4: fail → implement → pass. Register in `registry()`.
- [ ] Step 5: commit `feat(reports): timesheet report — Excel and PDF, seeded system definition (migration 0090)`.

---

### Task 3: routes and worker

**Files:** `api/src/serversherpa/api/routes/reports.py`, `api/src/serversherpa/api/schemas.py` (preview schema), `api/src/serversherpa/reports/worker.py`; Tests `api/tests/test_timesheet_routes.py` (and extend the worker test file used for scan history if that's the pattern).

**Produces:**
- `create_run`: a `timesheet` run may have `initiative_id = None`; when `report_type == "timesheet"` and `not actor.access.can("time", "view")` → 403 `time_view_required` (before validation). When an initiative is given it must pass the existing scope/archive check.
- `GET /reports/timesheet/preview` (`reports:view` + time:view check) query params `from`, `to`, `person_id`, `initiative_id`, `site_id`, `statuses` (comma-separated) → `TimesheetPreviewOut{entries: int, people: int, days: int, approved_minutes: int, pending_minutes: int, flagged_entries: int, too_many: bool}`; validates like `validate_run_options` (422 `bad_options` with problems); `too_many` true instead of raising. Declare it before any `/{id}` routes that could shadow it.
- History: `_visible_runs` (list), get, and download exclude/404 `timesheet` runs when the actor lacks `time:view`.
- Worker: `TimesheetTooLarge` → `run.error = "too_many_entries"` (add an except clause or a shared `.code` mapping, keeping existing behavior); inbox body for a timesheet = `"{from} to {to}"` + ` · {person}` / ` · {job}` when filtered (look up names).

- [ ] Step 1: tests first (no-initiative run accepted; job run attaches to the initiative's Files via the existing worker path — assert `attachment_id` set after processing; 403 without time:view for run and preview; preview numbers on seeded data and `too_many` with a monkeypatched small `MAX_ENTRIES`; history hiding and download 404 for a reports-only user; worker error code and inbox body). Step 2–4. Run also `tests/test_reports*.py` and `tests/test_move_scan_history*.py` to prove nothing regressed.
- [ ] Step 5: commit `feat(reports): timesheet runs without a job, preview endpoint, time:view gating`.

---

### Task 4: portal — Generate modal options step, Reports labels, Edit branch

**Files:** `portal/src/lib/api.ts` (types + `getTimesheetPreview(params)`), `portal/src/lib/timesheetReport.ts` (+ test), `portal/src/components/reports/TimesheetOptions.tsx` (+ test), `portal/src/components/reports/GenerateReportModal.tsx` (+ test), `portal/src/components/reports/EditDefinitionModal.tsx` (+ test), `portal/src/pages/Reports.tsx` (TYPE_LABELS).

**Produces:**
- `lib/timesheetReport.ts`: `type TimesheetStatus = 'approved'|'pending'|'rejected'|'open'`, `type TimesheetView = 'day'|'punch'`, `quickRange(kind: 'this_week'|'last_week'|'this_month'|'last_month', today: Date): { from: string; to: string }` (local dates, weeks Monday–Sunday, This month = 1st → today), `timesheetDefaults(definition)`, `buildTimesheetRunOptions({from,to,personId,siteId,statuses,views,format})` (omits empty person/site), `timesheetOptionsValid(...)`.
- `TimesheetOptions({ definition, onBack?, onGenerate, initial? })` where `initial?: Partial<{ from; to; personId; initiativeId; siteId; statuses }>`; posts `{ initiative_id: jobId || null, options, notify }`. Layout and copy per spec; preview via `getTimesheetPreview` debounced 400 ms (ignore stale responses); Generate disabled per spec and when `too_many`.
- `GenerateReportModal`: `isTimesheet` skips the pick step (opens straight on the options step; Back from options closes or is hidden — choose the cleanest within the existing step machinery and say which) and accepts an optional `timesheetInitial` prop passed through to `TimesheetOptions`.
- `EditDefinitionModal`: timesheet branch editing the three defaults (format ChoiceCards, views and statuses checkbox ChoiceCards).
- Reports `TYPE_LABELS.timesheet = 'Timesheet'`.

- [ ] Step 1: tests first (quickRange edges incl. a Sunday and month starts; defaults; payload; options component renders defaults, quick picks set dates, toggling chips updates the preview call, Generate disabled cases, too_many message; modal opens Timesheet straight on options; Edit saves defaults). Step 2–4 (full suite + tsc + build). Step 5: commit `feat(portal): Timesheet report options in the Generate modal`.

---

### Task 5: portal — launch from the Timesheet screen

**Files:** `portal/src/pages/TimeManagement.tsx` (+ its test).

- A **Timesheet report** `mini-btn` in the Timesheet toolbar next to Export, shown when `can('reports','add') && can('time','view')`. On click: load report definitions (`listReportDefinitions`), find the live `timesheet` definition (if none, show `pf-error` `The Timesheet report isn't set up. Ask an administrator.`), open `GenerateReportModal` with it and `timesheetInitial` from the screen's current filters: person, job, site, From/To dates (empty → This month via `quickRange`), status pill (All → all four statuses; Open → `open`; Pending/Approved/Rejected → that one).
- [ ] Tests first (button visibility by permission; prefill mapping for each pill and for empty dates; modal opens on the timesheet options). Step 2–4 (full suite + tsc + build). Step 5: commit `feat(portal): Timesheet report button on the Timesheet screen`.
