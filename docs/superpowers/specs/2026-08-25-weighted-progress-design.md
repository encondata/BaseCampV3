# Weighted Move Progress — Design

**Date:** 2026-08-25
**Status:** Approved (conversational design with user; bar shows percentage only — a status donut chart is a separate upcoming slice)

## Goal

Replace the binary complete/total progress computation for move assets with
a weighted model: every `move_asset_status` vocabulary value carries an
admin-editable `progress_weight` (0–100, or null = excluded), and the
progress bar shows the average completion of the move's assets as a
percentage. The bar label is ONLY the percentage (e.g. "62%") — no
"N of M complete" text (the upcoming donut chart owns per-status counts).

## Math

progress % = round( Σ weight(status(asset)) ÷ (countable_assets × 100) × 100 )

- `countable_assets` = assets whose status has a non-null weight.
- A status with `progress_weight = null` excludes its assets from numerator
  AND denominator (parked/error states must not drag the number).
- An asset whose status key has no vocabulary row (stale data) counts with
  weight 0 in the denominator.
- Zero countable assets (or zero assets) → hide the bar, as today.

## Data model

- `status_values` gains `progress_weight: int | None` (nullable, CHECK
  0–100), migration 0021 chained on 0020. Generic column — any record type
  may use it later; only `move_asset_status` is seeded/exposed now.
- Seed weights for `move_asset_status` (linear ramp over the v2 pipeline,
  judgment calls for off-pipeline states; all admin-tunable afterward):

| key | weight | | key | weight |
|---|---|---|---|---|
| loaded_in_system | 0 | | staged | 69 |
| pre_stage | 8 | | rfid_3_staging | 65 |
| racked | 15 | | rfid_4_into_cage | 72 |
| labeled | 23 | | re_racked | 77 |
| pack_logistics | 31 | | cabling | 85 |
| rfid_1_cage_exit | 35 | | qa | 92 |
| rfid_2_loading_dock | 40 | | pending_client_handover | 95 |
| rfid_10_dock_to_truck | 44 | | complete | 100 |
| on_truck | 46 | | e_waste | 100 |
| in_transit | 50 | | historical | null (excluded) |
| received | 54 | | location_collision | null (excluded) |
| un_pack | 62 | | in_container | 38 |

  (e-waste = 100: the device's journey on this move is finished. in_container
  = 38: a mid-pipeline state — v2 process order 6, between pack_logistics
  (31) and on_truck (46) — not an off-pipeline/excluded one.)
- Downgrade drops the column.

## API

- Status-values read endpoints include `progress_weight` in each row.
- The vocabulary editor endpoints (status_values create/update) accept
  `progress_weight` with validation: int 0–100 or null → 422
  `invalid_progress_weight` otherwise. Audited like other field edits.

## Portal

- `StatusValue` type gains `progress_weight: number | null`.
- `moveAssetProgress(rows, statuses)` reimplemented per the Math section
  (signature now needs the loaded move-asset statuses); returns
  `{ pct, countable }`; bar hidden when `countable === 0`.
- Progress bar label: the percentage only ("62%"). Fill = pct.
- The vocabulary editor UI (Variables page, status editor) gains a
  "Progress weight" numeric input (0–100, clearable to null) shown ONLY
  when editing `move_asset_status` values.

## Coordination

The vocabulary-merge session (asset + move_asset_status) is spec'ing on a
separate branch; it must carry `progress_weight` onto whichever vocabulary
survives. They will be notified of this column.

## Testing

API: migration up/down; weight validation (0, 100, 101, -1, null, "abc");
weight round-trips through the editor endpoints; rows include the field.
Portal: weighted math unit tests (mixed weights, excluded statuses, stale
status key, all-excluded → countable 0, rounding); bar label shows only
the percentage.

## Out of scope

Donut/pie status chart (next slice); per-device effort weighting (e.g. RU
size multiplier); weights for other record types' UIs.
