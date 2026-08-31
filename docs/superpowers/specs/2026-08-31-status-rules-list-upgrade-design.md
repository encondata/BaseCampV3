# Status-rules list upgrade

**Date:** 2026-08-31
**Status:** Approved design (approved inline by Jimmy; transcription of
the agreed column/facet table)
**Builds on:** the /admin/status-rules page from
`2026-08-31-scan-matching-status-rules-design.md`.

## Summary

Rebuild the Rules tab's list on the full house directory pattern
(model: `portal/src/pages/Notifications.tsx`), splitting the combined
Trigger column into **Trigger status** and **Match type**, and adding
the standard toolbar set: Filter facets, Columns show/hide, CSV export,
per-column menus (sort + column filters), drag-to-reorder columns, and
per-user persisted list state. The Executions tab is unchanged.

## Columns

| key | label | default | content |
|---|---|---|---|
| `name` | Name | on | name + description sub-line |
| `trigger_status` | Trigger status | on | vocab-colored chip |
| `match_type` | Match type | on | asset / container / person tag |
| `priority` | Priority | on | number; **default sort ascending** |
| `conditions` | Conditions | on | count |
| `actions` | Actions | on | count; summaries in the cell title |
| `runs` | Runs | on | `N · <relative last run>` / `0 · never` |
| `updated` | Updated | off | locale date |
| `enabled` | Enabled | on | the existing inline toggle switch |

Row actions (Edit / Duplicate / Delete) remain the fixed trailing cell,
outside the column system. Permission gating unchanged
(`status_rules` change/add/delete).

## Toolbar

Search + result count (existing), `FilterButton` facets for **Trigger
status**, **Match type**, **Enabled** (Enabled/Disabled),
`ColumnsButton`, `ExportButton` (CSV via the house `exportCsv` +
`CSV_COLUMNS`), `FilterSummaryChip`. List state — visible columns,
order, sort, column filters — persists via
`usePersistentListState('status-rules', …)` exactly like the other
directory pages.

## House contracts to honor

- `cellText` mirrors each cell's displayed text exactly (search/CSV
  contract); `searchText`, `sortValueFor`, `CSV_COLUMNS` per the
  Notifications.tsx pattern; `VirtualRows` for the row body;
  `EmptyClearFilters` for the filtered-empty state; grid template
  computed from shown columns' widths plus the trailing actions column.
- Load/error/mutation behavior of the current RulesTab is preserved
  (Promise.all load, 403 vs generic copy, mutation errors surfaced via
  the error state, `onCount` contract, editor modal wiring).

## Out of scope

- Executions tab changes; row click-through navigation; any API change
  (the list is client-side over the full rule set, as today).
