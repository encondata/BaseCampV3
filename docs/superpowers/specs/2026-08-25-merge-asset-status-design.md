# Merge `move_asset_status` into the `asset` status vocabulary

**Date:** 2026-08-25
**Status:** approved
**Branch:** `claude/merge-asset-status` (cut from `feature/initiatives`)

## Goal

One `asset` status vocabulary serves both `assets.status` (Assets
directory) and `initiative_assets.status` (initiative detail assets
list, rack view). The `move_asset_status` record type disappears from
the database, the API registry, and the portal.

## Background

Migration 0019 seeded a separate `move_asset_status` vocabulary (24
workflow values imported verbatim from V2's process order) alongside the
existing `asset` vocabulary (5 lifecycle values from 0014). Both tables
reference `status_values` through composite FKs on a
`status_record_type` column that is `GENERATED ALWAYS AS (<record
type>) STORED`. The split means the Variables page shows two asset
vocabularies and the two pages draw from different lists.

`in_transit` exists in both vocabularies and is the only key collision.

Migration 0021 (weighted move progress, landed 2026-08-25) added
`progress_weight` to `status_values` — nullable int, CHECK 0–100, seeded
for all 24 `move_asset_status` keys. Null is load-bearing: a null-weight
status excludes the asset from the progress calculation entirely, while
0 counts it at zero (`moveAssetProgress` in `portal/src/lib/
initiatives.ts` maps weights by status key). The merge must carry these
weights forward unchanged, and it renames no keys, so the portal's
by-key weight mapping is unaffected.

## Decisions (user-approved)

- **Surviving record type:** `asset`.
- **`in_transit` collision:** the merged row keeps move's look — label
  `In Transit`, color `#f52727`. It keeps its current `sort_order` 2
  until reordered by hand.
- **Sort order of migrated rows:** `0` (the schema's "unset" default —
  `sort_order` is `NOT NULL`, so literal NULL is off the table without
  a schema change nobody wants). The user will assign real orders later
  via the Variables page.
- **Progress weights:** migrated rows keep their seeded
  `progress_weight` verbatim (including the two explicit nulls). The
  merged `in_transit` takes move's weight 50. The five original `asset`
  lifecycle values keep their null weight — an asset parked on a
  general lifecycle status is excluded from move progress (confirmed
  2026-08-26), tunable later in the weight editor.
- **One list everywhere (confirmed 2026-08-26):** all merged statuses,
  lifecycle values included, are selectable on both the Assets page and
  move rosters. No write guard distinguishing workflow from lifecycle
  keys; odd picks are a data-hygiene matter.

## Migration `0022_merge_asset_status`

(Revises 0021, the progress-weight migration.) Upgrade, in order (all
inside the migration's transaction):

1. `INSERT INTO status_values (record_type='asset', key, label,
   description, color, sort_order=0, is_active, progress_weight)`
   selected from the `move_asset_status` rows, excluding `in_transit`.
2. `UPDATE` the `asset`/`in_transit` row: label `In Transit`, color
   `#f52727`, `progress_weight` 50.
3. Rebuild `initiative_assets.status_record_type`: drop FK
   `initiative_assets_status_fkey`, drop the generated column, re-add it
   as `GENERATED ALWAYS AS ('asset') STORED`, re-add the composite FK to
   `status_values(record_type, key)`.
4. `DELETE FROM status_values WHERE record_type='move_asset_status'`
   (now unreferenced).

Downgrade reverses: re-insert `move_asset_status` rows from the `asset`
rows whose keys are in the migrated set (sort orders restored from the
0019/0020 literals, `progress_weight` copied back), restore the
`in_transit` row's old label/color/weight (`In transit`, `#0f7c86`,
weight null), rebuild the generated column back to
`'move_asset_status'`, delete the migrated `asset` rows.

The migrated-key set is a literal list in the migration file (the 0019
seed keys as amended by 0020), not a runtime query — downgrade must not
guess which `asset` rows came from the merge.

## API changes

- **`status/registry.py`:** remove the `move_asset_status` entry.
  Usage counting for `asset` must span two tables, so `StatusRecordType`
  replaces its single `table`/`column` pair with a list of sources
  (`sources: list[tuple[table, column]]`; `array` stays a per-record-type
  flag since no array column is multi-source). `_usage_counts` in
  `routes/status_values.py` sums counts across sources. All other record
  types become single-element source lists.
- **`routes/initiatives.py`:** the two `move_asset_status` references
  (status-options lookup ~line 615, asset-status write validation
  ~line 743) switch to `'asset'`.
- **Tests:** `test_initiative_assets_api.py` (and any other test seeding
  `move_asset_status`) seed/assert against `asset`. A registry/usage
  test covers the multi-source count (an asset row and an
  initiative-asset row with the same status count as 2).

## Portal changes

- **`lib/api.ts`:** delete `listMoveAssetStatuses`;
  `InitiativeDetail.tsx` calls the existing asset-statuses fetch
  (`/status-values?record_type=asset`). Rack view and status chips are
  prop-fed and follow automatically.
- **Assets page:** no code change; its status options/filters now
  include the workflow values by construction.
- **Variables page:** the list itself is data-driven and needs no
  change, but the progress-weight editor is gated on
  `record_type === 'move_asset_status'` in `StatusEditModal.tsx`
  (~lines 98, 213) and `lib/variables.ts` (~lines 89, 176, 196 — form
  state and the patch builder that deliberately never touches
  `progress_weight` for other record types). All three gates switch to
  `'asset'`, so the weight field renders when editing ANY asset status,
  lifecycle values included (that is how the user tunes them later).
  `variables.test.ts` fixtures and the "never touches progress_weight
  for a non-move row" test update to match; `initiatives.test.ts`
  status fixtures switch `record_type` to `'asset'`. Comment-only
  references (`initiatives.ts` ~333, `InitiativeDetail.tsx` ~353,
  `db/models.py` ~370) get reworded in passing.
- **Move progress bar:** no code change. `moveAssetProgress` maps by
  status key; no keys are renamed, and the statuses passed to it now
  come from the `asset` fetch with `progress_weight` intact. (The
  weight *editor* changes are under Variables page above.)

## Error handling

- Migration is idempotent-enough by construction (single transaction);
  a collision on re-run is impossible because upgrade deletes the source
  rows.
- API write validation behavior is unchanged in shape — unknown statuses
  still 422 — only the record type consulted changes.

## Testing

- API: alembic upgrade/downgrade round-trip on a scratch DB; updated
  route tests; new multi-source usage-count test.
- Portal: `npm test` and `npx tsc -b` from `portal/`; existing
  InitiativeDetail/RackView tests updated where they stub
  `listMoveAssetStatuses`.

## Out of scope

- Renumbering the merged list (user does this later in Variables).
- Making `sort_order` nullable.
- The disposition vocabulary (free text today, unchanged).
