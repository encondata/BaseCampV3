# Bulk trucks import — design

Third Bulk Actions tool: add or update trucks from a spreadsheet, on the pattern
of the sites (`2026-09-22-bulk-sites-import-design.md`) and workers
(`2026-09-22-bulk-workers-import-design.md`) tools. Closes the parity sheet's
"Import trucks in bulk" row (Gaps tab row 14). Jimmy asked for the flow to be
derived from the last two importers and for the open decisions to be made
here (2026-09-22).

Decisions taken in this spec: rows match an existing truck **by name only**;
matched rows are **updated or skipped per row, default skip** (the workers
pattern); the template carries **every editable truck field** including the
three tracking sub-fields and the container list; and, because this is the
third near-identical page, the portal's **page shell and upload pane are
extracted into shared components** that sites, workers, and trucks all use.

## What exists

- `trucks` (migration 0049): `name` CITEXT NOT NULL with **no unique index**,
  `driver_name`, `co_driver_name`, `team_drive` bool default false,
  `contact_info` NOT NULL default "", `status` (vocabulary `status_values`
  record_type `truck`: created, active, in_transit, at_destination, inactive,
  historical), `load_number`, `seal_id` (24 chars max), `tracking_type` JSONB
  (portal convention: keys `type`, `update_type`, `tracker_id`, all strings),
  `initiative_id`, `start_site_id`, `end_site_id`, `archived_at`. Containers
  ride on `truck_containers` (truck_id, container_id).
- `routes/trucks.py`: `_check_refs`, `create_truck`, `update_truck` (container
  ids REPLACE the link set), audit `entity_type="truck"` with actions `create`
  / `update`; `GET /map` is declared above `/{truck_id}`.
- Initiatives have no archive column; sites and containers do.
- Shared pieces from the workers work: `imports/bulk.py` (parse, cell,
  guard_cell, numbering, csv/xlsx builders with Reference blocks),
  `api/bulk_routes.py` (`require_bulk_rank`, `bulk_http_error`,
  `rows_from_request`), `components/bulk/BulkApplySummary.tsx`.
- V2's importer took `truck_name, driver_name, co_driver_name, team_drive,
  contact_info, load_number, seal_id` plus a default move, and always inserted.

## Columns

Fifteen columns, in template order. Only `name` is required.

| Column | Accepts | On create when blank |
|---|---|---|
| name | text, required; matches an existing truck by name (case does not matter) | |
| status | a truck status key | `created` |
| driver_name | text | |
| co_driver_name | text | |
| team_drive | yes / no (also true / false / 1 / 0) | no |
| contact_info | text | empty |
| load_number | text | |
| seal_id | text, up to 24 characters | |
| tracking_type | text → `tracking_type.type` | |
| tracking_update_type | text → `tracking_type.update_type` | |
| tracker_id | text → `tracking_type.tracker_id` | |
| initiative | an existing initiative's name | |
| start_site | an existing site's name | |
| end_site | an existing site's name | |
| containers | existing container names separated by `;` | |

The xlsx template has a `Trucks` sheet with two sample rows and a `Reference`
sheet listing valid statuses, initiative names, and site names. Container
names are not listed (there can be hundreds).

## Matching

`trucks/bulk_import.py` loads every non-archived truck once, indexed by
casefolded name. Per row, after validation: no hit → `create`; one hit →
match; more than one live truck with that name → error `multiple existing
trucks named '…'`. Two upload rows with the same name are both errors; two
rows resolving to the same existing truck are both errors. Archived trucks
never match. `matched_by` is `"name"` or `None`.

## Validation

All row errors, never silent fixes:

- `name` required
- `status` must be a key in the truck vocabulary
- `team_drive`, when given, must be one of yes/no/true/false/1/0 (any case)
- `seal_id` at most 24 characters
- `initiative` must name exactly one initiative; `start_site` / `end_site`
  exactly one non-archived site; each name in `containers` exactly one
  non-archived container. Unknown → `unknown initiative '…'`; several →
  `ambiguous initiative '…'` (same wording for site and container).

## Preview and diff

Preview row: `row, name, action (create | update | unchanged | error),
matched_by, matched_name, errors[], diff, truck_id, cells, data`; top level
`{rows, can_commit}`. `cells` are the uploaded cells before defaults; `data`
carries the resolved reference names (canonical spelling) and the parsed
`team_drive` boolean. Blank cells mean "no change" on updates; `status`,
`team_drive`, and `contact_info` take their defaults only on creates, tracked
out of band. Diff keys are the column names: text and status columns as
`{old, new}`; `team_drive` as `{old: bool, new: bool}`; tracking columns
compared against the JSON key (`{old: "gps", new: "cell"}`); reference
columns as `{old: current name or null, new: name}`; `containers` as
`{add: [names], remove: [names]}`, a full replace like the edit modal. A
matched row with an empty diff is `unchanged`.

## Commit

`commit_rows(db, actor_id, numbered, *, approved_updates, source_label)`
re-runs the preview on the original cells; any error row or an empty payload
raises `BulkImportError("rows_invalid", rows=…)` and nothing is written. In
one transaction: creates insert the truck with `created_by` and its container
links; approved updates apply the diff (tracking keys merged into the JSON,
container links added and removed); unapproved updates are `skipped` with the
diff they would have applied; unchanged rows write nothing. One audit row
`entity_type="truck"`, `action="bulk_import"`, changes `{created, updated,
skipped, unchanged, source}`, plus a per-truck `create` / `update` audit row
in the same shape the single-record endpoints write. Response:
`{created, updated, skipped, unchanged, rows: [{row, name, truck_id, action,
diff}]}`.

Export: every non-archived truck ordered by name, in template shape
(`team_drive` as yes/no, reference names, containers `; `-joined, tracking
sub-fields split out), formula-guarded. Re-uploading an export previews all
`unchanged`.

## API

In `routes/trucks.py`, declared above `GET /{truck_id}` next to `/map`:

- `GET /trucks/bulk-import/template?format=csv|xlsx` → `trucks-template.*`
- `GET /trucks/bulk-import/export?format=csv|xlsx` → `trucks-export.*`
- `POST /trucks/bulk-import/preview` (multipart `file` or JSON `{rows}`)
- `POST /trucks/bulk-import/commit` (`{rows, approved_updates: [truck_id],
  source}`)

All four: `require_permission("trucks", "add")` plus `require_bulk_rank`;
commit also requires `trucks:change`. Whole-payload failures → 422 `{code}`.

## Portal

Shared extraction, then the tool:

- `components/bulk/BulkToolPage.tsx` — the page shell every bulk tool uses:
  eyebrow "Bulk Actions", title, hint, Columns table (Column / Required /
  Accepts / Example), Download buttons (label, handler, accent flag), the
  1,000-row / 5 MB note, and an Upload section that renders `children`.
  `BulkSites`, `BulkWorkers`, and the new `BulkTrucks` become configuration
  plus a `BulkToolPage`. Existing page tests pass unchanged.
- `components/bulk/BulkUpload.tsx` — the upload → preview → apply pane for
  tools with per-row update-or-skip (workers, trucks), parameterized by a
  config: `idPrefix` (file input id `${idPrefix}-bulk-file`), `noun` /
  `nounPlural` ("worker" / "workers"), `newLabel` ("new worker"), the error
  map, `preview(file, name)`, `commit(rows, approved, source)`, `idOf(row)`,
  and the summary props (`entityLabel`, `linkFor`, `filename`, `openTo`,
  `openLabel`). `WorkerBulkUpload` becomes a thin wrapper over it so its
  tests pass unchanged; `TruckBulkUpload` is the second wrapper. Diff rows
  whose change carries `add` / `remove` arrays render as `+name` / `−name`.
  `changesText` in `BulkApplySummary` does the same for any such field, not
  only `clients`. `SiteBulkUpload` keeps its approve-all gating and is not
  moved onto the pane.
- `lib/truckBulk.ts` — `TRUCK_COLUMN_GUIDE` (15 keys, `name` required),
  `TRUCK_BULK_ERRORS` (same ten codes as workers).
- `lib/api.ts` — `TruckBulkRowResult` (`truck_id`), `TruckBulkPreview`,
  `TruckBulkAppliedRow`, `TruckBulkCommitResult`, `previewTruckBulk`,
  `commitTruckBulk`, `downloadTruckTemplate`, `downloadTruckExport`.
- `/bulk/trucks` — "Add or update trucks in bulk", route gated
  `resource="trucks"` and `minRank=ADMIN_RANK`; third Bulk Actions card
  ("Add or update trucks in bulk", resource `trucks`, action `add`); the
  Trucks list toolbar gets "Bulk import…" for `can('trucks','add') &&
  maxRank >= ADMIN_RANK`. Summary rows link to `/logistics/trucks/<id>`
  (confirm the detail route in `App.tsx` and use whatever it is).

## Out of scope

Location updates (`truck_updates`) from a spreadsheet; archiving through the
upload; matching by load number or seal; container creation from unknown
names; moving `SiteBulkUpload` onto the shared pane; the container importer.

## Testing

- Service: columns pinned; `parse_bool`; template round trip with the three
  Reference blocks; export shape and round trip (all unchanged, including a
  truck with containers and tracking); required name; unknown status; bad
  team_drive; seal too long; unknown and ambiguous initiative / site /
  container; duplicate names in the upload; multiple live trucks with one
  name; archived trucks ignored; create defaults; update diff for every
  column kind including containers add/remove and tracking keys; blank cells
  never clear on update; commit creates truck + links + audit; approved
  update applies tracking merge and container replace; skipped writes
  nothing; all-or-nothing.
- Routes: staff forbidden on all four; template and export formats and
  filenames; preview via JSON and file; commit end to end with an approved
  and a skipped row; commit refused without `trucks:change`.
- Portal: guide keys and error codes; `BulkUpload` via the existing
  WorkerBulkUpload tests plus a TruckBulkUpload test (labels, containers
  diff rendering, truck ids in the commit payload); BulkToolPage via the
  three page tests; Bulk Actions card gating; Trucks toolbar button; whole
  suite, `tsc --noEmit`, build.
- Live: export the dev trucks, re-upload unchanged; a four-row file with a
  renamed driver and container swap on an existing truck, a new truck, and
  an unchanged row; approve one, apply, check the summary and the detail
  page; revert.
