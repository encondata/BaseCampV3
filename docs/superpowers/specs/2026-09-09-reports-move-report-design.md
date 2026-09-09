# Reports: framework, worker, and the Move Report

**Date:** 2026-09-09
**Status:** Approved design
**Branch:** `reports`, cut from `admin-controls-cleanup` (needs that branch's
`poll_workers_paused` helper and the shared `components/Switch.tsx`).

## Summary

A Reports area in the portal (own nav section after Labels) backed by a
report framework: report *definitions* (the Available tab), report *runs*
(the History tab), a standalone `report-worker` process that renders PDFs
from a registry of report modules, storage of every PDF in Spaces attached
to the initiative's Notes & Files, and a minimal in-app notification inbox
so a person can wait in the modal or ask to be notified when the PDF is
ready. The first and only report module is the **Move Report**, a full
recreation of BaseCamp V2's eight-section move report.

## Context (what already exists)

- V2 (`BaseCampV2-reference/api/reports/`) rendered load, rail, collision,
  scan-history, time-sheet and site-survey PDFs server-side with ReportLab
  (+ a PDF417 footer via `pdf417gen`), one module per report exposing
  `metadata` + `generate_pdf`, glob-discovered; the *comprehensive* Move
  Report was assembled client-side with jsPDF in `MoveDetail.jsx`. Nothing
  was stored. V3 replaces both with one server-side pipeline.
- V3 data already carries everything the move report needs:
  `asset_models.ru_size / weight_lbs / weight_kg / rail_type /
  length|width|height_in`, and `initiative_assets.source_rack / source_ru /
  source_position / destination_rack / destination_ru /
  destination_position / priority_wave`.
- Rack elevations: `portal/src/lib/initiatives.ts` `rackLayout()` +
  `portal/src/components/initiatives/RackViewModal.tsx` (`RackElevation`,
  print-safe grayscale SVG, FRONT/REAR frames, ghost blocks).
- Worker conventions: `imports/worker.py` (job table + `run_forever` +
  `start_heartbeat` + `poll_workers_paused`), Procfile.dev line per worker,
  `serversherpa <name>` Typer commands.
- Storage: `services/storage.py` (`put_object`, `presign_get`); attachments
  router + `Attachment` model (`entity_type`, `kind` in
  avatar/photo/document); `NotesFilesPanel` on `InitiativeDetail`.
- Access: `access/resources.py` registry, `require_permission(resource,
  action)`, `scope_conditions("initiatives", …)`, `AccessInfo.max_rank`,
  `Role.rank`.
- Notifications: groups/members/channels exist; the bell popover in
  `Topbar.tsx` is a placeholder; the notification worker is a placeholder.
- List UI conventions: `LabelTemplates.tsx` (ColumnMenu filters, persisted
  sort/visibility, FilterSummaryChip, EmptyClearFilters,
  `RowActionsMenu`, `pop-menu`).
- Read-only mode freezes mutating calls; workers pause on
  `pause_workers`; public `/system/status` exposes `workers_paused`.

## Scope

In: definitions + runs tables and API; `report-worker`; the Move Report
module (all eight sections); rack SVG rendering via a Node script that
reuses `RackElevation`; PDF stored in Spaces and attached to the
initiative; in-app notification inbox (table, API, bell, toast); Reports
page (Available / History tabs) and the Generate modal; permissions and
the history gate; tests; live verification.

Out (explicitly deferred): report hashing/signing and any barcode on the
PDF; email/SMS delivery; multi-initiative or combined PDFs; scheduling;
run deletion; client-anchored access to Reports; a "Generate report"
shortcut on the initiative page; other report types (scan history, time
sheets, site survey).

## Data model

Three new tables (one Alembic migration).

### `report_definitions` — the Available tab

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| name | citext | unique among non-archived rows |
| description | text default '' | |
| report_type | text | registry key; only `move_report` for now |
| options | jsonb | default section toggles, see Move Report `options` |
| is_system | bool default false | seeded rows; cannot be deleted |
| created_by | uuid fk people null | |
| archived_at | timestamptz null | soft delete |
| created_at / updated_at | timestamptz | |

Seed (migration data step): one system row `Move Report`, `report_type =
move_report`, all eight sections `true`.

### `report_runs` — the History tab

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| definition_id | uuid fk report_definitions | |
| report_type | text | copied from the definition at creation |
| initiative_id | uuid fk initiatives | |
| options | jsonb | the resolved options actually used |
| status | text | `queued` → `running` → `completed` / `failed` |
| error | text null | truncated to 2000 chars |
| requested_by | uuid fk people | |
| requested_rank | int | requester's `AccessInfo.max_rank` at creation |
| notify | bool default false | write an inbox row on completion/failure |
| storage_key | text null | `reports/{initiative_id}/{run_id}.pdf` |
| attachment_id | uuid fk attachments null | the initiative file |
| filename | text null | `Move Report - {initiative name} - {YYYY-MM-DD HHMM}.pdf` |
| size_bytes | bigint null | |
| started_at / finished_at | timestamptz null | |
| created_at | timestamptz | |

Indexes: `(status, created_at)` for the worker claim; `(initiative_id)`;
`(requested_by, created_at)`.

### `notifications` — the in-app inbox

| column | type | notes |
|---|---|---|
| id | uuid pk | |
| person_id | uuid fk people | recipient |
| kind | text | e.g. `report_ready`, `report_failed` |
| title | text | |
| body | text default '' | |
| link | text null | portal path the toast/bell navigates to |
| payload | jsonb default {} | e.g. `{"run_id": …}` |
| created_at | timestamptz | |
| read_at | timestamptz null | |

Index `(person_id, read_at, created_at)`.

`serversherpa/notifications/inbox.py` exports
`async def notify(db, person_id, kind, title, *, body="", link=None,
payload=None) -> Notification`. It is the only writer. Future channels
(email etc.) fan out from this function; the table shape stays.

## Worker: `report-worker`

`serversherpa/reports/worker.py`, launched by a new Typer command
`report-worker` (with `--reload` like the others) and a Procfile.dev line
`reportsvc: api/.venv/bin/serversherpa report-worker --reload`.

`run_forever(poll_seconds=2.0)` mirrors `imports/worker.py`:

1. `install("report-worker")` logging, `start_heartbeat("report-worker",
   "worker", meta_fn=lambda: dict(pause_state))`.
2. On startup, `requeue_stale(db)`: runs in `running` whose `started_at`
   is older than `STALE_MINUTES = 15` go back to `queued` (worker crashed
   mid-run).
3. Loop: `poll_workers_paused(maker, check_state)` → sleep+continue while
   paused (heartbeat meta `paused: true`, Processes page shows Paused).
   Otherwise `run_once(maker)`; sleep when it found nothing.
4. `run_once`: claim ONE queued run with `SELECT … FOR UPDATE SKIP LOCKED
   ORDER BY created_at LIMIT 1`, set `running` + `started_at`, commit.
   Then, in its own `try`, execute the run under
   `asyncio.wait_for(…, RUN_TIMEOUT_SECONDS = 300)`. Any exception
   (including timeout) → `failed`, `error` = message truncated,
   `finished_at`. A DB blip during the claim itself is swallowed and
   logged once (same posture as the pause check) — the loop never dies.
5. Executing a run: `module = REGISTRY[run.report_type]`;
   `result = await module.build(db, run)` → `ReportResult(pdf: bytes,
   filename: str)`; `put_object(storage_key, pdf, "application/pdf")`;
   insert `Attachment(entity_type="initiative", entity_id=initiative_id,
   kind="document", storage_key, filename, content_type, size_bytes,
   uploaded_by=run.requested_by)`; update run `completed`, `attachment_id`,
   `filename`, `size_bytes`, `finished_at`; commit.
6. If `run.notify`: `notify(requested_by, "report_ready", f"{definition
   name} is ready", body=initiative name, link=f"/reports?tab=history&run=
   {run.id}", payload={"run_id"})`; on failure `report_failed` with the
   error as body. (`notify` is re-read from the row at the end so a
   "notify me" click during the run counts.)
7. If the initiative is archived or missing when the run starts, fail with
   `initiative_unavailable`.

Registry: `serversherpa/reports/registry.py` — `REGISTRY: dict[str,
ReportModule] = {"move_report": move_report}`; a `ReportModule` protocol
with `report_type`, `default_options()`, `validate_options(dict) -> dict`
(unknown keys rejected, missing keys defaulted) and `build(db, run)`.
Explicit, not glob-discovered.

## The Move Report module

`serversherpa/reports/move_report/` with four pure steps, each its own
file with its own tests:

- `gather.py` — `async gather(db, initiative_id) -> MoveData`: the
  initiative (+ client, origin/destination sites), every non-archived
  `InitiativeAsset` joined to `Asset` and `AssetModel`, ordered by
  `asset.name`. Plain dataclasses out; no ORM objects leave this file.
- `compute.py` — the three V2 calculations, ported and typed:
  - **load**: per asset `ru = model.ru_size or 1`, `weight_lbs =
    model.weight_lbs or (model.weight_kg * 2.20462) or 0`; totals
    (`total_assets`, `total_ru`, `total_weight_lbs`, `total_weight_kg`),
    and a per make/model breakdown (`count`, `ru_size`, `total_ru`,
    `weight_per_unit`, `total_weight_lbs/kg`, dimensions `L×W×H in`)
    sorted by make, model.
  - **rails**: per make/model `count` + `rail_type` (`N/A` when null);
    `rail_summary` = counts per rail type, descending.
  - **collisions** (destination side only, like V2): for assets with both
    `destination_rack` and `destination_ru`, `base = floor(ru)`, `slot =
    round((ru - base) * 10)`, `occupied = {base … base + ru_size - 1}`.
    Pairwise within a rack: RU overlap → `ru_overlap`; same base + same
    non-zero slot with no overlap → `slot_conflict`; both →
    `ru_and_slot_conflict`. Output: collision list (rack, type,
    overlapping RUs, asset A/B name+serial+make/model+RU+size),
    `collision_count`, `assets_checked`, `assets_flagged`.
- `racks.py` — `render_rack_svgs(rows, side) -> list[RackSvg]`: groups
  rows by rack name on that side (skips rows with no rack or no RU), calls
  the Node renderer once per rack (see below), returns `(rack_name, svg)`
  sorted by rack name.
- `render.py` — Jinja2 template `templates/move_report.html` + CSS →
  WeasyPrint → PDF bytes. Letter portrait; running header with the
  initiative name; running footer `Generated {timestamp} by {person} ·
  Page X of Y`.

`options` (all booleans, the definition's defaults are `true`):

| key | section | content |
|---|---|---|
| summary | Summary | move info (name, type, status, client, scheduled dates), origin and destination site cards (name, address), load summary (totals), collision summary (count / flagged) |
| assets_by_source | Asset List — By Source | table Serial, Name, Make, Model, Src Rack, Src RU, Dest Rack, Dest RU, Wave; sorted by source rack, source RU |
| assets_by_destination | Asset List — By Destination | same columns; sorted by destination rack, destination RU |
| size_weight | Size and Weight Report | totals + per-model table Make/Model, Count, RU Size, Total RU, Weight, Dimensions |
| rail_usage | Rail Usage Report | rail summary table + per-model table Make/Model, Count, Rail Type, RU Size |
| collisions | Collision Report | table Rack, Type, Overlapping RUs, Asset A, Asset B; "No collisions" when empty |
| source_racks | Source Rack Elevations | one page per source rack: SVG + "Assets in rack" table Name, Serial, RU, Wave |
| destination_racks | Destination Rack Elevations | same for destination racks |

A section whose toggle is off is skipped at the compute/gather stage (no
rack rendering when both rack sections are off), not hidden in the
template. When every asset list would be empty the PDF still renders with
"No assets on this move" in the summary.

## Rack renderer (Node)

- Extract `RackElevation` (+ its geometry helpers and the `.rack-svg`
  print styles as an inline `<style>`) from `RackViewModal.tsx` into
  `portal/src/components/initiatives/RackElevation.tsx`. The modal keeps
  rendering it exactly as before.
- New `portal/src/reports/renderRack.tsx`: reads JSON `{rackName, side,
  rows: InitiativeAssetRow[]}` from stdin, runs `rackLayout` +
  `ghostBlocksFor`, renders `<RackElevation>` (FRONT and, when needed,
  REAR) with `react-dom/server` `renderToStaticMarkup`, writes SVG markup
  to stdout, exits 0. Any error → message on stderr, exit 1.
- Build: a Vite library build target (`npm run build:rack-renderer`,
  invoked by `npm run build`) emitting a single self-contained
  `portal/dist-node/render-rack.js` (React and ReactDOMServer bundled, no
  externals).
- Worker side: `serversherpa/reports/rack_renderer.py` —
  `render(rows, rack_name, side) -> str` spawns `node <script>` via
  `asyncio.create_subprocess_exec` with a `RACK_RENDER_TIMEOUT_SECONDS =
  30` timeout. Script path from settings `report_rack_renderer`
  (default `<repo>/portal/dist-node/render-rack.js`, resolved relative to
  the API package's repo root); node binary from `report_node_bin`
  (default `node`). Missing script, non-zero exit or timeout raise
  `RackRendererUnavailable` → the run fails with
  `rack renderer unavailable: …` (never a PDF with silently missing
  sections).
- One `vitest` for the renderer entry (fixture rows → SVG contains the
  expected block labels and RU numbers) and one for `RackElevation` in
  isolation; the Python side tests use a fake renderer.

## API

New router `api/routes/reports.py` (prefix `/reports`) and resource
`Resource("reports", "Reports", routes=("/reports",),
visible_to=frozenset({"global"}))`. Default grants in
`access/defaults.py`: `developer`, `founder`, `super_admin` FULL (via
`_ALL`); `admin` FULL; `staff` `("view", "add")` (can generate, cannot
edit/clone/delete definitions); no grant for client/vendor/worker/external
roles.

Definitions:
- `GET /reports/definitions` — `reports:view`; non-archived; fields id,
  name, description, report_type, options, is_system, updated_at.
- `POST /reports/definitions/{id}/clone` — `reports:add`; copies name +
  " (copy)", description, options; 201.
- `PATCH /reports/definitions/{id}` — `reports:change`; name,
  description, options (validated by the module); system rows editable.
  409 `name_in_use` on duplicate name.
- `DELETE /reports/definitions/{id}` — `reports:delete`; soft delete; 409
  `system_definition` on `is_system`.
All writes audited (`entity_type="report_definition"`).

Runs:
- `POST /reports/runs` `{definition_id, initiative_id, options, notify}` —
  `reports:add`; initiative must satisfy `scope_conditions("initiatives",
  …)` and not be archived (404 otherwise); `options` validated; stores
  `requested_rank = actor.access.max_rank` (server-side only); 201 with the
  run. Audited.
- `GET /reports/runs?status=&report_type=&initiative_id=&limit=&cursor=`
  — `reports:view`; **gate in SQL**: `(requested_by = actor) OR
  (requested_rank <= actor.max_rank)` AND initiative passes the actor's
  initiative scope. Newest first. Includes requester name, initiative
  name, definition name.
- `GET /reports/runs/{id}` — same gate; used for polling.
- `GET /reports/runs/{id}/download` — same gate; 409 `not_ready` unless
  completed; returns `{url}` from `presign_get(storage_key,
  download_filename=filename)`.
- `PATCH /reports/runs/{id}` `{notify: bool}` — requester only (403
  otherwise); allowed in any status (a completed run just doesn't notify
  again).

Inbox (on the existing notifications router):
- `GET /notifications/inbox?unread_only=` → `{unread_count, items[50]}`
  newest first.
- `POST /notifications/inbox/{id}/read` (own rows only, 404 otherwise) and
  `POST /notifications/inbox/read-all` → 204.

Read-only mode: all the POST/PATCH/DELETE routes above freeze like any
other write; no allowlist entries.

## Portal

**Navigation:** new section `Reports` after `Labels` in
`layout/navSections.tsx`, one item `Reports` → `/reports`, resource
`reports`. Route `/reports` wrapped in `ProtectedRoute resource="reports"`.
Command palette picks it up from the nav table.

**`pages/Reports.tsx`** — two tabs (`?tab=available|history`, default
available), each a standard list (ColumnMenu filters, sortable headers,
persisted visible/sort/order state under its own storage key,
FilterSummaryChip, EmptyClearFilters):

- *Available*: columns Name, Type, Description, Sections (count of
  `true` options), Updated, System badge. Far-right `RowActionsMenu`:
  Generate, Edit (`reports:change`), Clone (`reports:add`), Delete
  (`reports:delete`, hidden on system rows, confirm dialog). Edit modal:
  name, description, the eight Switch rows for defaults.
- *History*: columns Report, Initiative (link to `/initiatives/:id`),
  Requested by, Requested at, Status (badge; duration once finished), Size.
  Row actions: Download (completed → fetch presigned URL, open), View
  error (failed → dialog with the error text). Polls every 3 s while any
  listed run is queued/running, then stops. `?run=<id>` (from a
  notification link) highlights that row.

**Generate modal** (`components/reports/GenerateReportModal.tsx`), one
dialog, three states driven by local state then by the polled run:

1. *Pick initiative*: search box (name/client), type filter (select over
   the initiative types the list returns), radio list sorted by status
   group — `in_progress`, `scheduled`, `planned` first (in that order),
   then `on_hold`, then `completed` and `cancelled` (the seeded
   `status_values` keys for `record_type=initiative`), name ascending
   within a group; archived initiatives excluded; each row shows
   name, client, type, status chip, scheduled start–end. Next is disabled
   until one is selected.
2. *Sections*: eight rows (title + one-line description, mirroring V2's
   copy) using the shared `Switch`, defaults from the definition; Select
   all / Deselect all; Generate disabled when none are on. Generate POSTs
   the run and moves to state 3.
3. *Progress*: status line ("Queued" / "Generating…" with elapsed time),
   polling `GET /reports/runs/{id}` every 2 s. Buttons: **Notify me when
   it's ready** (PATCH notify=true, close, toast "We'll let you know when
   it's ready"), **Close** (run keeps going, no notification). When
   `workers_paused` is true in `useSystemStatus()` the line reads
   "Paused for maintenance — will resume automatically". On `completed`:
   Download button (presigned URL) + "Also saved to the initiative's
   Files" link. On `failed`: the error + **Try again** (new run, same
   options).

**Bell + toast:**
- `lib/notifications.ts` + `NotificationsProvider` (mounted inside
  AuthProvider, portal-only): polls the inbox every 30 s and on
  `visibilitychange`; exposes `{unread_count, items, markRead,
  markAllRead, refresh}`.
- Topbar bell: unread badge; popover lists the latest items (title, body,
  relative time), click → mark read + navigate to `link`; "Mark all read".
- `components/ToastHost.tsx` in the shell: when a poll returns unread
  items whose ids were not seen before (after the first poll), show a
  toast per item (max 3 stacked, auto-dismiss 10 s) with the title, body,
  and an action button — for `report_ready` it is **Download** (fetches
  the presigned URL for `payload.run_id`); otherwise **Open** (navigate to
  `link`). Any click marks the item read. Generic: no report-specific
  code outside the action mapping.

**Initiative page:** no change — the PDF appears in the Notes & Files
panel as a document attachment uploaded by the requester.

## Permissions and the history gate

- Page and API gated on the new `reports` resource (global anchor only).
- `requested_rank` is captured server-side at run creation from the
  resolver, never from the client, and never updated.
- History (`GET /reports/runs`, `/runs/{id}`, `/download`) returns a run
  only when `requested_by == actor` OR `requested_rank <= actor.max_rank`,
  AND the initiative passes the actor's initiative scope. This is a SQL
  predicate on the list query, not post-filtering, so pagination stays
  correct.
- Attachments: the PDF is a normal initiative attachment, so anyone who
  can see the initiative's files can download it there. That is
  intentional (the initiative's Files are the shareable copy); the rank
  gate protects the History tab's "who generated what" view.

## Error handling

- Worker never exits on a bad run; each run runs inside its own `try`;
  claim-query DB errors are swallowed and logged once per outage.
- Stale `running` runs are re-queued on worker start (`STALE_MINUTES`).
- `RUN_TIMEOUT_SECONDS = 300` per run; `RACK_RENDER_TIMEOUT_SECONDS = 30`
  per rack.
- Rack renderer failure with rack sections requested → run `failed`
  (`rack renderer unavailable: …`).
- Spaces upload failure → run `failed`; Try again re-queues.
- Initiative archived/missing at run time → `failed`
  (`initiative_unavailable`).
- Pause-workers pauses this worker like the other three; the modal reads
  `workers_paused` from the public status and says so.
- Portal poll failures are transient: keep polling (same idiom as
  `ImportMoveAssets`).

## Dependencies and setup

- API: `weasyprint>=62`, `jinja2>=3.1` added to `api/pyproject.toml`.
  WeasyPrint needs Pango/Cairo/GDK-PixBuf on the host: `dev-up.sh` and
  README get the `brew install pango` / apt line.
- Portal: `build:rack-renderer` Vite lib target; `npm run build` runs it.
  `react-dom/server` is already available via react-dom.
- Settings: `report_rack_renderer`, `report_node_bin`.
- Procfile.dev: `reportsvc` line. Processes page shows `report-worker`.

## Testing

- **API** (`tests/test_reports_api.py`, `tests/test_notifications_inbox.py`):
  definitions list/clone/patch/delete + system guard + duplicate name;
  run create (scope 404, archived 404, options validation 422, rank
  captured); history gate — lower-rank viewer sees nothing from a
  higher-rank requester, own runs always visible, client-scoped
  initiatives filtered; download 409 before completion and presigned
  after; notify PATCH requester-only; inbox list/unread count/read/read-all
  own-rows-only.
- **Compute** (`tests/test_move_report_compute.py`): fixtures pinning V2
  semantics — load totals with kg fallback and null model; rail summary
  ordering and `N/A`; collisions: plain overlap, partial overlap from
  multi-RU device, slot conflict at same base RU, both, different racks
  never collide, rows without rack/RU ignored.
- **Render** (`tests/test_move_report_render.py`): template renders with
  each section toggled off (heading absent) and on; one WeasyPrint smoke
  test producing a PDF (`%PDF` magic, page count ≥ 1) with a fake rack
  SVG.
- **Rack renderer**: `portal/src/reports/renderRack.test.tsx` (fixture →
  SVG with labels/RU numbers; REAR frame only with rear positions);
  `RackElevation.test.tsx` moved/kept with the extraction; Python
  `tests/test_rack_renderer.py` covers subprocess error/timeout mapping
  with a stub script.
- **Worker** (`tests/test_report_worker.py`, scan-worker style with a
  fake module): claim → completed with attachment row + storage key;
  notification row only when `notify`; failure path sets `failed` +
  error; timeout → failed; stale re-queue; pause idles; claim DB blip
  survives.
- **Portal**: `Reports.test.tsx` (tabs, list, row actions by permission,
  system-row delete hidden, history polling stops when idle),
  `GenerateReportModal.test.tsx` (sort order, type filter, section
  defaults, select/deselect all, progress → download, notify-me path,
  failure → try again, paused message), `NotificationsProvider` +
  `ToastHost.test.tsx` (new unread → toast, click marks read, download
  action), Topbar bell badge, `reportsNav.test.tsx` like `labelsNav`.
- **Live verification** (final plan task): run the full stack via
  Procfile.dev, generate a Move Report for a seeded initiative with all
  sections, open the PDF, confirm the initiative's Files shows it, the
  History row, the notify-me toast, and the Paused state under
  pause-workers.

## Build order (for the plan)

1. Migration + models + inbox `notify()` + inbox API.
2. Report definitions API + seed.
3. Runs API + history gate.
4. Move report gather/compute (pure) with tests.
5. Rack extraction + Node renderer + Python subprocess wrapper.
6. Template + WeasyPrint render.
7. Worker + CLI + Procfile + stale re-queue.
8. Portal: nav + Reports page + Available tab + Edit/Clone/Delete.
9. Portal: Generate modal + History tab.
10. Portal: NotificationsProvider + bell + ToastHost.
11. Live verification.
