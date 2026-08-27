# List virtualization — design

**Date:** 2026-08-27
**Status:** approved (designed in conversation; scope chosen by user: all standard lists)
**Driver:** real `raw_scans` volume is expected upwards of 100k rows; the standard list renders every visible row to the DOM (100k rows ≈ 800k+ nodes — unusable), and per-keystroke search rebuilds row haystacks.

## Decisions

- **Library:** `@tanstack/react-virtual` (v3, headless, ~3 KB). Markup, CSS, column menus, sorting, export, persistence are untouched — only the row-render loop changes.
- **Shared primitive:** `VirtualRows<T>` in `portal/src/lib/virtualRows.tsx`, used by every standard list. Render-prop signature `renderRow(row, virtualProps?)` where `virtualProps` (ref/style/data-index) is spread onto the page's own `.dir-row` div — **no wrapper element**, so `.dir-row:last-child` border CSS and row semantics keep working.
- **Threshold:** below **300 rows** `VirtualRows` renders the plain full list (keeps ⌘F find-in-page for small lists); above it, virtualized with dynamic row measurement (`measureElement`/ResizeObserver), which also tracks the row-expansion height animation.
- **Scroll container:** lists scroll inside `.portal-main` (not the window) → `useVirtualizer` with `getScrollElement: el.closest('.portal-main')` and a mount-time `scrollMargin` computed from the list's offset inside the scroller.
- **Search memoization:** `useSearchHaystacks(rows, searchTextFn)` in `lib/listTools.tsx` — builds the lowercase haystack once per rows array; the filter memo does map lookups instead of rebuilding 100k strings per keystroke.
- **Deep-link focus needs no change:** `useRecordFocus` pre-fills the search box so the target filters to the top; it never scrolls to a DOM node.
- **API:** add `GZipMiddleware` (the 100k `/scans/raw` payload is ~40 MB raw, a few MB gzipped). Measure endpoint latency at 100k; optimize serialization only if measured slow (> ~2 s server time), as a follow-up.
- **Dev data:** seed `raw_scans` to 100k rows to verify at real scale.

## Rollout surfaces (all use the same recipe)

`RawScansTab`, `ProcessedScansTab`, `Assets`, `Containers`, `Sites`, `AssetModels`, `Initiatives`, `InitiativeDetail` (assets list), `Users`, `Workers`, `External`, `OrgDirectory`.

Out of scope: `Audit`, `ProcessLogs` (server-paged), `Variables`, `DevDatabase`, `MembersTab` (non-standard/facet lists); sort-key precomputation (sorting 100k on click is a one-off ~100–300 ms, acceptable); find-in-page shim for virtualized lists.

## Known trade-offs

- ⌘F only finds rendered rows once a list crosses the 300-row threshold (the filter box is the intended search path).
- The bottom-most *rendered* row (not necessarily the true last row) drops its border via `:last-child` — cosmetically invisible in practice since overscan rows sit offscreen.
