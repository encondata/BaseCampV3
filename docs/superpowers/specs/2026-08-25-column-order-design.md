# Column Display Order — Design

**Date:** 2026-08-25
**Status:** Approved

## Goal

Users can change the display order of columns on every record list, and the
chosen order persists per page exactly like the existing column-visibility
selection — via `preferences.list_prefs[pageKey]`, saved account-wide through
the existing preferences PATCH. Two reorder surfaces: drag rows in the
Columns popover, and drag the column headers themselves.

## Persistence

`preferences.list_prefs[pageKey]` gains one field:

```jsonc
{
  "visible": ["type", "status"],
  "sortKey": "primary",
  "sortDir": 1,
  "filters": {},
  "order": ["status", "type", "client"]   // NEW — display order, may be partial
}
```

- `usePersistentListState` (portal/src/lib/columnMenu.tsx) hydrates `order`
  in the same `sanitize` pass as the other fields: non-array values are
  ignored, non-string entries and keys not in the page's `allKeys` set are
  dropped. Sanitized-empty order means "default order".
- The hook returns `colOrder: string[]` and `setColOrder(next: string[])`.
  Changes ride the existing 600 ms debounced merge-save and the
  unmount-flush; no new endpoint, no API changes.
- The lead column (`primary` on most pages) and the trailing chevron column
  are never part of `order` — they are fixed.

## Ordering logic

New pure helper in portal/src/lib/listTools.tsx:

```ts
export function applyColumnOrder(columns: ColumnDef[], order: string[]): ColumnDef[]
```

- Columns whose keys appear in `order` render in that order, first.
- Columns not mentioned in `order` (e.g. a column added to the codebase
  after the user saved an order) keep their default relative order,
  appended after the ordered ones.
- Keys in `order` with no matching column are ignored (sanitize should have
  removed them anyway).
- Empty `order` returns `columns` as-is.

Pages compute `const orderedCols = applyColumnOrder(COLUMNS, colOrder)` once
and feed `orderedCols` everywhere `COLUMNS` flows today: `visibleColumnsFor`
(header + body render order), and `ColumnsButton` (so the popover lists in
current display order). CSV export keeps its own static column list —
unchanged.

## Surface 1 — Columns popover (ColumnsButton)

`ColumnsButton` (portal/src/lib/listTools.tsx) gains two props:

```ts
order: string[];
onReorder: (next: string[]) => void;
```

- Each offered row gains a grip handle and is HTML5-draggable within the
  list. Visibility toggling (click the row) is unchanged.
- While dragging, an insertion line indicates the drop position.
- Dropping commits via `onReorder` with the **full** new order — every
  offered column key in its new sequence — so partial stored orders
  converge to complete ones as soon as the user reorders once.
- God-only columns participate normally when offered (god mode on).

## Surface 2 — header dragging

New shared hook (portal/src/lib/listTools.tsx):

```ts
export function useHeaderDrag(
  orderedCols: ColumnDef[], onReorder: (next: string[]) => void,
): (colKey: string) => HeaderDragProps
```

- Returns per-key props to spread on each `col-head` span: `draggable`,
  `onDragStart` / `onDragOver` / `onDrop` / `onDragEnd` / `onDragLeave`,
  plus indicator class names (`drag-src`, `drop-before` / `drop-after`).
- Dropping column A on column B inserts A at B's position (before/after by
  cursor half) in the full order and calls `onReorder`.
- Click-to-sort and the per-column funnel menu keep working: HTML5 drag
  only engages on actual drag movement, plain clicks are unaffected.
  The funnel button and popover are not drag handles (drag starts from the
  header span; interactions inside the open popover don't trigger drags).
- The lead column and chevron column don't get drag props and are not
  valid drop targets.

Styles: drop-indicator and drag-source affordances go in
portal/src/styles/column-menu.css, which already carries the shared
`col-head` header styling.

## Rollout

All 9 list pages get the same mechanical wiring: Sites, Assets, AssetModels,
Containers, Workers, Users, External, OrgDirectory, Initiatives.

Per page:
1. Pull `colOrder, setColOrder` from `usePersistentListState`.
2. `const orderedCols = applyColumnOrder(COLUMNS, colOrder)` and use it for
   `visibleColumnsFor` and `ColumnsButton`.
3. Pass `order={colOrder}` / `onReorder={setColOrder}` to `ColumnsButton`.
4. Spread `useHeaderDrag(...)` props on each dynamic `col-head` span.

Body cells already render from `shownCols`, so row order follows
automatically.

## Testing

Extend portal/src/lib/columnMenu.test.tsx (and/or a listTools test):
- `applyColumnOrder`: empty order, full order, partial order (unmentioned
  columns keep default relative position at the end), stale key ignored.
- `sanitize`/hydrate round-trip: stored `order` with unknown keys and
  non-string junk hydrates clean; `order` persists through the debounced
  save payload.
- `ColumnsButton`: reorder callback emits the full new order; toggling
  visibility still works with the new props.
- `useHeaderDrag`: drop before/after computes the right full order;
  fixed columns excluded.

## Out of scope

- Reordering the lead (Name) column or the chevron column.
- Per-device (localStorage) persistence — this is account-wide by design,
  same as visibility.
- CSV export column order.
