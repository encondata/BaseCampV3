# Move Assets — Design

**Date:** 2026-08-25
**Status:** Approved (v2 parity verified against prod backup api/backups/backup_20260825_193157.sql, 2026-08-25)

## Goal

Recreate BaseCampV2's MoveDetail assets table on the V3 initiative Full
Details page for moves: a per-move asset roster with v2's columns and
per-move fields, per-column sort/filter, search, column picker with
persisted order, per-row edit dialog, remove, progress bar, CSV export,
and (last) the rack elevation view. Assets reach a move ONLY via a future
bulk-import script — no interactive picker, ever (user decision); the API
still exposes an attach endpoint for that script and dev seeding.

## Ground truth (from prod backup, schema unchanged since Dec 2025)

v2 table `moves_assets_list`: id, moves_id, asset_id, asset_serial_number
(denormalized), priority_wave VARCHAR(30), disposition TEXT,
source_verified BOOL, source_raw TEXT (rack), source_ru NUMERIC,
destination_verified BOOL, destination_raw TEXT, destination_ru NUMERIC,
cable_info JSONB, vendor_involved BOOL, label_info JSONB, added TIMESTAMPTZ,
last_updated TIMESTAMPTZ, raw_ft JSONB, owner TEXT, asset_status FK →
status_options. Real rack names are hierarchical strings (e.g.
`11.01.01.01A.02` or `BJ08`); RU supports decimals.

## Data model (V3)

New table `initiative_assets` (migration chained on 0018):

- `id` UUID PK; `initiative_id` UUID FK → initiatives (CASCADE);
  `asset_id` UUID FK → assets; UNIQUE (initiative_id, asset_id).
- Per-move fields (v2 parity): `priority_wave: str|None` (VARCHAR(30)),
  `disposition: str|None`, `owner: str|None`,
  `source_rack: str|None`, `source_ru: Numeric|None`,
  `source_verified: bool|None`, `destination_rack: str|None`,
  `destination_ru: Numeric|None`, `destination_verified: bool|None`,
  `cable_info: str|None` (text; holds v2's serialized JSON when imported),
  `vendor_involved: bool|None`.
- NEW beyond v2 (user requirement — rear-mounted gear etc.):
  `source_position: str|None` and `destination_position: str|None` —
  free-text mounting/position notes ("left", "right", "front", "rear", …).
- `status: str` — move-progress status key from the NEW vocabulary below;
  server default `loaded_in_system`.
- Bookkeeping per ContainerAsset: `added_by` FK people, `created_at`,
  `updated_at`.
- NOT carried yet (arrive with the bulk-import slice): `label_info`,
  `raw_ft`, denormalized serial (V3 joins to assets instead).

## Move-asset status vocabulary

New record type `move_asset_status` in the status registry
(table `initiative_assets`, column `status`, resource `initiatives`),
seeded IN PROD ORDER with v2's exact current list (label → key slug,
color preserved, sort_order = v2 process_order; RFID 10 has none — seed
it after RFID 4 with sort_order 24):

| key | label | color | sort |
|---|---|---|---|
| loaded_in_system | Loaded In System | #808080 | 1 |
| pre_stage | Pre-Stage | #caa0a0 | 2 |
| racked | Racked | #273FF5 | 3 |
| labeled | Labeled | #F5BE27 | 4 |
| pack_logistics | Pack / Logistics | #31F527 | 5 |
| in_container | In Container | #31F527 | 6 |
| on_truck | On Truck | #31F527 | 7 |
| received | Received | #31F527 | 8 |
| un_pack | Un-Pack | #31F527 | 9 |
| staged | Staged | #27F5AD | 10 |
| re_racked | Re-Racked | #31F527 | 11 |
| cabling | Cabling | #31F527 | 12 |
| qa | QA | #31F527 | 13 |
| complete | Complete | #8E27F5 | 14 |
| rfid_1_cage_exit | RFID 1 - Cage Exit | #31F527 | 20 |
| rfid_2_loading_dock | RFID 2 - Loading Dock | #29d3f5 | 21 |
| rfid_3_staging | RFID 3 - Staging | #f58b29 | 22 |
| rfid_4_into_cage | RFID 4 - Into Cage | #f5297a | 23 |
| rfid_10_dock_to_truck | RFID 10 - Dock to Truck (Auto Container Pack) | #1890ff | 24 |
| in_transit | In Transit | #F52727 | 50 |
| e_waste | e-waste | #EE27F5 | 51 |
| pending_client_handover | Pending Client Handover | #00FF00 | 96 |
| historical | Historical | #27F5F2 | 99 |
| location_collision | Location Collision | #FF0000 | 100 |

Admin-editable like every other vocabulary. V3 has no per-value
"list_in_dropdown" flag — all values appear in the edit dialog; unwanted
ones can be retired via the vocabulary editor. Progress counts key ==
`complete` only (v2 rule).

## API (routes/initiatives.py, `initiatives` resource, audited)

- `GET /initiatives/{id}/assets` → rows ordered priority_wave (NULLS
  LAST, natural client re-sort allowed) then asset serial. Each row: all
  join fields + `status_label`/`status_color` + embedded `asset` summary
  (id, legacy_id, serial_number, name, rfid_tag, model make/model labels,
  location_detail, client_name, own status key/label/color, has_rails,
  model ru_size). No pagination this slice (matches V3 list conventions;
  flagged for revisit at real move sizes).
- `POST /initiatives/{id}/assets` body `{asset_ids: [...]}` — attach;
  validates ids exist (422 `assets_not_found` listing offenders), 409
  `assets_already_on_initiative` listing ids already attached (nothing
  partially applied), audits, returns fresh rows. For the future bulk importer + dev seeding; 422
  `not_a_move` when the initiative isn't a move.
- `PATCH /initiatives/assets/{assoc_id}` — whitelist (v2 parity + new
  fields): priority_wave, disposition, owner, source_rack, source_ru,
  source_verified, source_position, destination_rack, destination_ru,
  destination_verified, destination_position, cable_info,
  vendor_involved, status. Empty string → NULL for nullable text; RU
  coerced to Decimal (422 `invalid_ru` on non-numeric); status validated
  against the vocabulary (422 `unknown_status`). Bumps updated_at; audits
  with before/after diff.
- `DELETE /initiatives/assets/{assoc_id}` — detach + audit.
- Tests per the repo's API-test conventions for all four + validation
  cases.

## Portal (Assets section on InitiativeDetail, moves only)

Non-move initiatives keep the placeholder panel. For moves:

- **Progress bar** above the table: "N of M complete" + percent fill
  (counts status key `complete`); hidden when no assets.
- **Table** on the shared list machinery: ColumnMenu per column
  (sort + Excel-style filter), search box, ColumnsButton with visibility
  + drag order persisted under list key `initiative_assets`, CSV export.
  Default columns (v2): Asset ID (asset legacy_id), Asset Name, Serial,
  Make/Model, Status (move status chip), Source Rack, Source RU,
  Destination Rack, Destination RU. Optional: Wave, Disposition, Owner,
  Source Verified, Source Position, Destination Verified, Destination
  Position, Cable Info, Vendor Involved, Asset Status (the asset's own),
  RFID Tag, Location, Client, Added, Updated.
- **Row actions** (canChange): Edit dialog (modal shell) with move
  status ComboBox, wave, disposition, owner, source rack / RU /
  position / verified, destination rack / RU / position / verified,
  cable info, vendor involved; Save → PATCH → refetch. Remove with the
  run() pattern. No add UI.
- Empty state: "No assets on this move yet — assets arrive via bulk
  import."

## Rack view (in scope, built LAST)

v2-style modal opened by clicking a non-empty Source/Destination rack
cell: SVG rack elevation (54 RU tall, RU 1 at bottom), showing every
asset on THIS move whose source_rack/destination_rack (matching the
clicked side) equals the clicked rack name, positioned by RU
(decimal-aware), block height = asset model ru_size (default 1),
labeled with name/serial; verified blocks filled with the accent,
unverified outlined. The asset's source/destination position note is
shown on the block when present. Close on scrim/Esc.

## Out of scope (later slices)

Bulk import script (the only attach path for real use), label_info /
raw_ft columns, XLSX export, scan/RFID history integration, bulk status
update endpoint, server-side pagination, v2's inline row accordion.

## Error handling

API errors use the codebase's `_err` code pattern; portal maps codes via
a MOVE_ASSET_ERRORS map with friendly messages, per-section inline
errors, busy-disable during mutations.

## Testing

API: pytest coverage for the four endpoints + validation (not_a_move,
duplicate attach, invalid_ru, unknown_status, cascade on initiative
delete, vocabulary registration). Portal: helpers-level tests only where
pure logic exists (progress computation, rack-view placement math);
pages stay thin per repo convention. Live browser verification with
dev-seeded rows.
