# Time Tracking Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A full timeclock/punch suite — self-service clock in/out, admin timesheet review with approve/reject and audited manual overrides, per-initiative man-hour rollups — plus a Worker full-detail page.

**Architecture:** One new `time_entries` table + a `time_entry` status vocabulary + a first-class `time` access resource (migration 0028, mirroring 0025's scans pattern). One new FastAPI router (`/time`) with self-service punch endpoints (any authenticated user, own entries only) and management endpoints gated on the `time` resource. Portal: a Time Management page under People (timeclock card + who's-on-the-clock + directory-list timesheet with approve/reject/edit modal), a WorkerDetail page, and a Time panel at the bottom of InitiativeDetail.

**Tech Stack:** Existing only — FastAPI + SQLAlchemy + Alembic (api/), React + react-router (portal/), pure-SVG charts, the shared directory-list machinery.

## Global Constraints

- **Hours only. No pay rates, no dollar amounts, no billing anywhere.** (Explicit user requirement.)
- No geofencing/GPS, no rounding rules, no overtime math in v1 (noted future work).
- House styles: statuses live in the `status_values` vocabulary; every list payload denormalizes `status_label`/`status_color`; all mutations audit via `services/audit.py` `audit()/diff()/snapshot()`; errors are `{"code": ...}` details; portal fetchers follow `listX/createX/updateX` in `portal/src/lib/api.ts`; list pages use the directory-list machinery (`lib/listTools.tsx`, `lib/columnMenu.tsx`); status chips get wrapped in `components/StatusHover.tsx`.
- Time semantics: an entry's **worked minutes = (clock_out_at − clock_in_at) in minutes − break_minutes, floored at 0**. Entries with `clock_out_at IS NULL` are "open" and count toward nothing.
- Statuses: `open` (clocked in) → `pending` (clocked out / manual, awaiting review) → `approved` | `rejected`. **Any edit that changes times/break of an `approved` entry drops it back to `pending`** (re-approval required). Approved entries are otherwise immutable-by-convention; every override records an audit diff and requires `adjust_reason`.
- The Time Management route/nav is gated on the `dashboard` resource (everyone can reach their punch clock); management sections inside the page gate on `can('time')`.
- All test suites run FOREGROUND in one continuous run with timeout 600000ms. Never background a suite.
- Dev servers already run via `.claude/launch.json`; the API auto-reloads. After the migration lands, run `api/.venv/bin/python -m alembic upgrade head` from `api/` against the dev DB.

---

### Task 1: Migration 0028 + model + vocabulary + `time` resource

**Files:**
- Create: `api/migrations/versions/0028_time_entries.py`
- Modify: `api/src/serversherpa/db/models.py` (append `TimeEntry` model after `InitiativeAsset`)
- Modify: `api/src/serversherpa/status/registry.py` (append record type)
- Modify: `api/src/serversherpa/access/resources.py` (append resource — copy the `scans` entry's shape, id `time`, label `Time`, routes `("/people/time",)`)
- Test: `api/tests/test_time_model.py`

**Interfaces:**
- Produces: table `time_entries` with columns exactly: `id uuid pk default gen_random_uuid()`, `person_id uuid FK people NOT NULL`, `initiative_id uuid FK initiatives NULL`, `site_id uuid FK sites NULL`, `clock_in_at timestamptz NOT NULL`, `clock_out_at timestamptz NULL`, `break_minutes int NOT NULL default 0`, `status text NOT NULL default 'open'` (+ generated `status_record_type = 'time_entry'` and composite FK to status_values, per 0026's pattern), `source text NOT NULL default 'punch'`, `notes text NOT NULL default ''`, `adjusted boolean NOT NULL default false`, `adjust_reason text NULL`, `created_by uuid FK people NULL`, `approved_by uuid FK people NULL`, `approved_at timestamptz NULL`, `reject_reason text NULL`, `created_at/updated_at timestamptz NOT NULL default now()`.
- Indexes: `(person_id, clock_in_at DESC)`, `(initiative_id)`, `(status)`, and **partial unique** `one_open_entry_per_person` on `(person_id) WHERE clock_out_at IS NULL`.
- Vocabulary seeds (record_type `time_entry`): `open` "On the clock" `#258bcd` 1 · `pending` "Pending review" `#a36207` 2 · `approved` "Approved" `#178a4c` 3 · `rejected` "Rejected" `#c03540` 4.
- Role grants for resource `time` (same INSERT pattern as 0025's SCAN_GRANTS): developer/founder/super_admin FULL(view,add,change,delete); admin view,add,change,delete; staff view.
- SQLAlchemy model class `TimeEntry` (attrs named exactly as the columns).
- Registry entry: `StatusRecordType("time_entry", "Time entry", sources=(("time_entries", "status"),), resource="time")`.

**Steps:**
- [ ] Write `api/tests/test_time_model.py`: (1) insert a TimeEntry with defaults and read back status `open`, source `punch`, break 0; (2) the partial unique index rejects a second open entry for the same person (IntegrityError) but allows one after the first gets `clock_out_at`; (3) the four vocab values exist for record_type `time_entry`; (4) role_permissions has `('admin','time','change')` and `('staff','time','view')`. Follow `api/tests/test_scans_model.py` fixtures/style.
- [ ] Run `cd api && .venv/bin/python -m pytest tests/test_time_model.py -q` — expect FAIL (table missing).
- [ ] Write the migration (copy 0025's structure: seeds constant, create_table, generated status_record_type column + composite FK per 0026, indexes, grants loop, full downgrade). Then the model + registry + resources entries.
- [ ] `cd api && .venv/bin/python -m alembic upgrade head` (dev DB) — expect "Running upgrade 0027 -> 0028".
- [ ] Run `pytest tests/test_time_model.py -q` — expect PASS.
- [ ] Run the FULL api suite foreground: `.venv/bin/python -m pytest -q` timeout 600000 — expect all pass.
- [ ] `git add -A && git commit -m "feat(api): time_entries table, time_entry vocabulary, time resource (migration 0028)"`

---

### Task 2: `/time` API router + tests

**Files:**
- Create: `api/src/serversherpa/api/routes/time.py`
- Modify: `api/src/serversherpa/api/schemas.py` (append time schemas)
- Modify: `api/src/serversherpa/api/app.py` (import + `app.include_router(time.router)`)
- Modify: `api/src/serversherpa/api/routes/status_provenance.py` (`ENTITY_RESOURCE["time_entry"] = "time"`)
- Test: `api/tests/test_time_api.py`

**Interfaces (produces — the portal consumes these verbatim):**

Schemas (all denormalized names resolved server-side like scans.py does):
```python
class TimeEntryItem(BaseModel):
    id: uuid.UUID
    person_id: uuid.UUID
    person_name: str
    initiative_id: uuid.UUID | None
    initiative_name: str | None
    site_id: uuid.UUID | None
    site_name: str | None
    clock_in_at: datetime
    clock_out_at: datetime | None
    break_minutes: int
    minutes: int          # worked minutes per Global Constraints; 0 while open
    status: str
    status_label: str
    status_color: str
    source: str           # punch | manual
    notes: str
    adjusted: bool
    adjust_reason: str | None
    approved_by: uuid.UUID | None
    approved_by_name: str | None
    approved_at: datetime | None
    reject_reason: str | None
    created_at: datetime
    updated_at: datetime

class TimeSummaryPerson(BaseModel):
    person_id: uuid.UUID
    person_name: str
    approved_minutes: int
    pending_minutes: int
    entry_count: int
    last_entry_at: datetime | None

class TimeSummaryOut(BaseModel):
    approved_minutes: int
    pending_minutes: int
    open_count: int
    people: list[TimeSummaryPerson]

class PunchOption(BaseModel):
    id: uuid.UUID
    name: str
```

Endpoints (router prefix `/time`, tags `["time"]`):
| Method + path | Gate | Behavior |
|---|---|---|
| `POST /time/clock-in` body `{initiative_id?, site_id?, notes?}` | CurrentUser | creates open entry for **actor.person.id**; 409 `already_clocked_in` if an open entry exists; validates FKs (404 `initiative_not_found` / `site_not_found`); audits action `clock_in`, entity_type `time_entry`; returns TimeEntryItem |
| `POST /time/clock-out` body `{notes?, break_minutes?}` | CurrentUser | closes the actor's open entry (`clock_out_at=now`, status→`pending`, merges notes, sets break_minutes if given, 422 `invalid_break` if negative or ≥ worked span); 409 `not_clocked_in` if none; audits `clock_out` with `{"status": {"from": "open", "to": "pending"}}` in changes; returns TimeEntryItem |
| `GET /time/me?limit=` | CurrentUser | `{open: TimeEntryItem \| None, entries: list[TimeEntryItem]}` — actor's entries newest-first, limit default 20 max 100 |
| `GET /time/punch-options` | CurrentUser | `{initiatives: list[PunchOption], sites: list[PunchOption]}` — non-archived initiatives with status in (planned, scheduled, in_progress, on_hold) ordered by name; non-archived sites ordered by name |
| `GET /time/entries?person_id&initiative_id&status&since&until&limit&offset` | `time:view` | list newest-first by clock_in_at; limit default 500 max 1000, offset 0 |
| `POST /time/entries` body `{person_id, clock_in_at, clock_out_at, initiative_id?, site_id?, break_minutes?, notes?}` | `time:add` | manual entry: requires clock_out_at > clock_in_at (422 `invalid_range`), status `pending`, source `manual`, created_by=actor; audits `create` |
| `PATCH /time/entries/{id}` body any of `{clock_in_at, clock_out_at, break_minutes, initiative_id, site_id, notes, adjust_reason}` | `time:change` | edits; **if clock_in_at/clock_out_at/break_minutes change: `adjust_reason` required (422 `adjust_reason_required`), sets `adjusted=true`, and an `approved` entry drops to `pending` (clearing approved_by/at)**; cannot set clock_out on an entry to before clock_in (422 `invalid_range`); audits `update` with diff; returns TimeEntryItem |
| `POST /time/entries/{id}/approve` | `time:change` | `pending`→`approved` (409 `not_pending` otherwise), sets approved_by/approved_at; audits `update` with status diff |
| `POST /time/entries/{id}/reject` body `{reason}` (min_length 1) | `time:change` | `pending`→`rejected` (409 `not_pending`), stores reject_reason; audits `update` with status diff |
| `GET /time/active` | `time:view` | all open entries, oldest first, as TimeEntryItem list |
| `GET /time/summary?initiative_id=` | `initiatives:view` | TimeSummaryOut across CLOSED entries of that initiative — approved_minutes from `approved`, pending_minutes from `pending`, open_count = open entries pointing at it; people sorted by approved+pending desc |

- Audit rows: `entity_type="time_entry"`, `entity_id=str(entry.id)`. Status transitions always appear in changes as `{"status": {"from": ..., "to": ...}}` so StatusHover provenance works.
- `minutes` computed with `max(0, int((out - in).total_seconds() // 60) - break_minutes)`.

**Steps:**
- [ ] Write `api/tests/test_time_api.py` (follow test_scans_api.py's login/make_login):
  clock-in → open + double-clock-in 409; clock-out → pending with minutes math (freeze times by inserting entries directly where needed); clock-out with break_minutes deducted; /time/me returns open + history; manual create validates range; PATCH times without adjust_reason → 422, with reason → adjusted=true; PATCH approved entry times → back to pending; approve/reject transitions + 409 not_pending; reject requires reason; /time/entries filters (person_id, status, since/until); /time/summary per-initiative math (approved vs pending separated, open counted in open_count); gates: worker role can clock in/out and read /time/me but gets 403 on /time/entries and /approve; staff can view but 403 on approve; provenance endpoint accepts entity_type=time_entry after an approve (returns source edit).
- [ ] Run `pytest tests/test_time_api.py -q` — expect FAIL (404s).
- [ ] Implement `routes/time.py` + schemas + app wiring + provenance mapping. Denormalize names with one query per lookup set (copy `_people_names`/`_site_names` helper style from routes/scans.py; add `_initiative_names`).
- [ ] Run `pytest tests/test_time_api.py -q` — expect PASS.
- [ ] FULL api suite foreground, timeout 600000 — all pass.
- [ ] Commit: `feat(api): /time router — punch, timesheets, approvals, per-initiative summary`

---

### Task 3: Portal fetchers + nav/route/crumbs + page shell

**Files:**
- Modify: `portal/src/lib/api.ts` (append time section)
- Create: `portal/src/lib/timeFormat.ts`
- Create: `portal/src/pages/TimeManagement.tsx` (shell this task; full UI next task)
- Modify: `portal/src/layout/navSections.tsx` (People section, after External: `{ to: '/people/time', label: 'Time Management', resource: 'dashboard', icon: clock svg }` — clock icon: circle cx12 cy12 r9 + path "M12 7v5l3.5 2")
- Modify: `portal/src/App.tsx` (route `/people/time` → `<ProtectedRoute resource="dashboard"><TimeManagement /></ProtectedRoute>`)
- Modify: `portal/src/components/Topbar.tsx` (CRUMBS `'/people/time': ['People', 'Time Management']`; PAGES `{ label: 'Time Management', to: '/people/time' }`)
- Test: `portal/src/lib/timeFormat.test.ts`

**Interfaces (produces):**
```ts
// api.ts — mirror Task 2 wire shapes field-for-field
export interface TimeEntryItem { id: string; person_id: string; person_name: string;
  initiative_id: string | null; initiative_name: string | null;
  site_id: string | null; site_name: string | null;
  clock_in_at: string; clock_out_at: string | null;
  break_minutes: number; minutes: number;
  status: string; status_label: string; status_color: string;
  source: string; notes: string; adjusted: boolean; adjust_reason: string | null;
  approved_by: string | null; approved_by_name: string | null;
  approved_at: string | null; reject_reason: string | null;
  created_at: string; updated_at: string }
export interface TimeSummaryPerson { person_id: string; person_name: string;
  approved_minutes: number; pending_minutes: number; entry_count: number;
  last_entry_at: string | null }
export interface TimeSummaryOut { approved_minutes: number; pending_minutes: number;
  open_count: number; people: TimeSummaryPerson[] }
export interface PunchOption { id: string; name: string }
export async function clockIn(body: { initiative_id?: string; site_id?: string; notes?: string }): Promise<TimeEntryItem>
export async function clockOut(body: { notes?: string; break_minutes?: number }): Promise<TimeEntryItem>
export async function getMyTime(limit?: number): Promise<{ open: TimeEntryItem | null; entries: TimeEntryItem[] }>
export async function getPunchOptions(): Promise<{ initiatives: PunchOption[]; sites: PunchOption[] }>
export async function listTimeEntries(q: { person_id?: string; initiative_id?: string; status?: string; since?: string; until?: string; limit?: number; offset?: number }): Promise<TimeEntryItem[]>
export async function createTimeEntry(body: Record<string, unknown>): Promise<TimeEntryItem>
export async function updateTimeEntry(id: string, body: Record<string, unknown>): Promise<TimeEntryItem>
export async function approveTimeEntry(id: string): Promise<TimeEntryItem>
export async function rejectTimeEntry(id: string, reason: string): Promise<TimeEntryItem>
export async function listActiveTimeEntries(): Promise<TimeEntryItem[]>
export async function getTimeSummary(initiativeId: string): Promise<TimeSummaryOut>
```
```ts
// timeFormat.ts
export function formatMinutes(min: number): string   // 0 → "0m"; 45 → "45m"; 60 → "1h"; 765 → "12h 45m"
export function elapsedSince(iso: string): number    // whole minutes since iso, floor 0
```
- TimeManagement shell: portal-page + eyebrow "People" + title "Time Management" + hint; renders `<TimeclockPanel />` placeholder text this task only.

**Steps:**
- [ ] Write `timeFormat.test.ts` (vitest, node env like godmode.test.ts) covering 0/45/60/765/1440 and elapsedSince with a fixed Date.now mock.
- [ ] `npm test -- --run src/lib/timeFormat.test.ts` — FAIL.
- [ ] Implement timeFormat.ts, api.ts additions, nav/route/crumbs, page shell.
- [ ] Tests pass; `npx tsc --noEmit` clean; FULL portal suite `npm test -- --run` + `npm run build` foreground — all pass.
- [ ] Commit: `feat(portal): time fetchers, Time Management nav/route/shell`

---

### Task 4: Time Management page UI

**Files:**
- Modify: `portal/src/pages/TimeManagement.tsx` (full page)
- Create: `portal/src/components/time/TimeEntryEditModal.tsx`
- Create: `portal/src/styles/time.css`
- Test: `portal/src/components/time/TimeEntryEditModal.test.tsx` (render test: reason required when times change — vitest + testing-library, mirror SiteEditModal.test.tsx's setup)

**Layout (top to bottom), using can('time') = `useAuth().can('time')`:**
1. **Timeclock card** (`.time-clock-card`, everyone): if `open` entry → live elapsed (tick every 30s + on mount, `formatMinutes(elapsedSince(open.clock_in_at))`), initiative/site names, notes input + optional break-minutes number input + solid **Clock out** button. Else → ComboBox "Initiative (optional)" from getPunchOptions().initiatives, ComboBox "Site (optional)", notes input, solid **Clock in** button. Errors surface via the page's pf-error convention. After any punch, refresh `getMyTime` and (if admin) the active list.
2. **My recent entries** (everyone): compact list of `getMyTime().entries` first 8 — date, in→out, duration, initiative, status chip wrapped in `<StatusHover entityType="time_entry" entityId={e.id} status={e.status}>`.
3. **On the clock now** (can('time')): rows from listActiveTimeEntries() — person, since (time), elapsed, initiative; if elapsed > 720 minutes render a `.chip tag` "12h+ — missed punch?" flag.
4. **Timesheet** (can('time')): directory-list with the full machinery (usePersistentListState key `time_entries`, ColumnsButton, ColumnMenu per column, search box, FilterSummaryChip, ExportButton → csv `time-entries`, VirtualRows). Columns: Person(1.2fr, default), Date(0.9fr default = clock_in date), Clock in(0.8fr default, HH:MM), Clock out(0.8fr default), Duration(0.7fr default, formatMinutes), Break(0.6fr), Initiative(1.1fr default), Site(1fr), Source(0.7fr), Adjusted(0.7fr, "Yes" + amber dot when true), Status(1fr default, chip + StatusHover), Approved by(1fr), Notes(1.2fr). Default sort: Date desc (sort timestamp columns by real instant — copy MoveDashboard's `Date.parse` branch). Toolbar extras: segmented status pills All/Open/Pending/Approved/Rejected (client-side filter), **+ Add entry** button (can('time','add')) opening the modal in create mode. Row actions (can('time','change')): Approve + Reject (Reject prompts for reason via the modal's reject mode or `prompt()`-free inline mini-form — use the modal) + Edit.
5. **TimeEntryEditModal**: modal-card form (datetime-local inputs for in/out, break number, initiative ComboBox, site ComboBox, notes textarea, and a Reason field that is required + highlighted whenever times/break differ from the original on an existing entry). Create mode additionally has a person ComboBox fed by `listWorkerOptions()` (exists in api.ts). Save → createTimeEntry/updateTimeEntry; approve/reject buttons in the modal footer for pending entries.

**Steps:**
- [ ] Write the modal render test (reason input appears/required when changing clock_out; submit blocked without it) — run, FAIL.
- [ ] Build modal + page + styles (`time.css`: `.time-clock-card` uses `.dash-kpi`-like surface tokens; grid rows echo `.dash-scan-row`).
- [ ] Test passes; `npx tsc --noEmit`; FULL portal suite + build foreground — pass.
- [ ] Commit: `feat(portal): Time Management page — punch clock, live roster, timesheet approvals`

---

### Task 5: Worker full-detail page

**Files:**
- Create: `portal/src/pages/WorkerDetail.tsx`
- Modify: `portal/src/App.tsx` (route `/people/workers/:personId` → `<ProtectedRoute resource="workers"><WorkerDetail /></ProtectedRoute>`, ABOVE no conflicts — path param route)
- Modify: `portal/src/pages/Workers.tsx` (row detail gains a `Full Details ↗` link — copy the `.idet-back`-style link/button Sites' SiteRowDetail `detail-actions` uses, `Link to={'/people/workers/' + w.person_id}`)
- Modify: `portal/src/components/Topbar.tsx` (no crumb needed — dynamic route falls back like /sites/:id does; verify and mirror whatever Sites does for its detail crumb)

**Content (mirror AssetDetail.tsx's chrome — idet-back link "← Workers", idet-header, init-panel cards):**
- Header: person name, trade · level hint, worker status chip wrapped in StatusHover (`entityType="worker" entityId={person_id} status={w.status}`), LevelBadge if the Workers page exports one (check `portal/src/pages/Workers.tsx` — reuse or inline the `.lvl-badge` markup).
- Panel "Profile": kv — Trade, Level (+title), Partner (or "Direct"), Status note, Added.
- Panel "Certifications": fetch `listWorkerCerts(personId)` if a fetcher exists in api.ts (check; the API route is `GET /workers/{person_id}/certifications`; add the fetcher if missing: `listWorkerCertifications(personId): Promise<CertItem[]>` with `CertItem {id, name, issuer, issued_on, expires_on}`); rows name · issuer · expires (red text when expired). Empty state "No certifications recorded."
- Panel "Recent time entries" (can('time')): `listTimeEntries({person_id, limit: 15})` — date, in→out, duration, initiative, status chip + StatusHover; link "Time Management →" to /people/time.
- Data source: `listWorkers()` then find by person_id (no single-worker GET exists — the list is the projection, matching how MoveAssetDetail loads from the roster list). Missing → "Worker not found" dir-empty.

**Steps:**
- [ ] Build page + route + Workers-list link.
- [ ] `npx tsc --noEmit`; FULL portal suite + build foreground — pass.
- [ ] Commit: `feat(portal): worker full-detail page + list link`

---

### Task 6: InitiativeDetail time panel

**Files:**
- Modify: `portal/src/pages/InitiativeDetail.tsx` (new bottom section, after the last existing panel)
- Modify: `portal/src/styles/initiatives.css` (`.idet-time-*` styles)

**Content (renders for every initiative type, gated on nothing extra — /time/summary is initiatives:view):**
- `init-panel` titled "Time tracking" at the PAGE BOTTOM. Loads `getTimeSummary(initiative.id)` lazily on mount.
- Stat row (reuse `.stat-strip`/`.stat-tile` pattern from access.css or dash-kpi styling already imported? InitiativeDetail imports initiatives.css only — add minimal `.idet-time-stats` grid): **Approved hours** (formatMinutes), **Pending hours**, **People** (people.length), **On the clock now** (open_count).
- Per-person table (plain rows, `.idet-time-row` grid): Person · Approved · Pending · Entries · Last activity (relativeTime). Sorted as the API returns. Empty state: "No time recorded against this initiative yet."
- Footer link "Time Management →" to `/people/time` shown when `can('time')`.

**Steps:**
- [ ] Add section + styles; handle summary fetch failure silently (panel shows empty state).
- [ ] `npx tsc --noEmit`; FULL portal suite + build foreground — pass.
- [ ] Commit: `feat(portal): per-initiative man-hours panel on initiative detail`

---

### Task 7: Final verification (run by the orchestrator, not a subagent)

- [ ] Browser pass on http://localhost:5173 (sign-in per project memory): punch in with initiative selected → timer runs → punch out → entry pending; approve + reject + edit-with-reason flows; timesheet filters/sort/columns/CSV; status-chip hover shows provenance; Worker Full Details link + page; InitiativeDetail bottom panel shows the hours; dark theme + ~900px width spot-checks.
- [ ] FULL api suite + FULL portal suite + build, foreground.
- [ ] Commit any fixes; report.
