# Excel-Style Column Menus + Persistent List State — Design Spec

**Date:** 2026-08-06 · **Status:** Approved (in conversation; proceeding straight to code per Jimmy)
**Scope:** Per-column header menus (sort ↑↓, type-to-filter, unique-value checkbox multi-select) on all seven list pages, replacing the toolbar FilterButton; per-user persistence of column visibility, sort, and active filters via account `ui_prefs`.
**Out of scope:** column reordering/resizing, multi-column sort, server-side filtering/pagination.

## Decisions (from brainstorm)

1. **Column menus replace the toolbar FilterButton.** One filtering system. The global text-search box stays. Toolbar shows an active-filter count chip with one-click **Clear** whenever any column filter is active.
2. **Persist EVERYTHING per user per page** — visible columns, sort key+direction, column filters — in the existing `user_accounts.ui_prefs` JSONB via the existing prefs PATCH. Survives reload and logout/login.
3. **Stale-filter guardrails:** toolbar count chip; tinted funnel icon on filtered column headers; and (Jimmy, mid-design) **the zero-results empty state MUST offer a "Clear all filters" button** whenever column filters are active.
4. Unique-value lists compute client-side from loaded rows (no V3 list paginates); the checkbox list narrows live as you type in the menu's filter box (Excel behavior); Select all / Clear inside the menu.
5. Header label click keeps cycling sort (existing behavior); the menu adds explicit A→Z / Z→A actions.

## Architecture

**API (one additive field):** `UiPreferences` (schemas.py) gains `list_prefs: dict = {}` — free-form `{ [pageKey]: { visible: string[], sort: {key, dir}, filters: { [colKey]: {text?, values?} } } }`. The prefs PATCH endpoint (auth.py) already merges/validates; no new endpoint.

**Shared portal mechanism (`portal/src/lib/columnMenu.tsx` + helpers in `listTools.tsx`):**
- `ColumnFilter = { text?: string; values?: string[] }`, `ColumnFilters = Record<string, ColumnFilter>`.
- Pure: `passesColumnFilters(row, filters, accessor)` (accessor: `(row, colKey) => string` — each page supplies one, reusing its facet/search accessors); `uniqueValues(rows, colKey, accessor)` (sorted, deduped, '—' for blank); `activeFilterCount(filters)`.
- `<ColumnMenu>` popover per header: sort A→Z/Z→A (calls the page's existing toggle/set-sort), filter textbox, narrowing checkbox list, Select all/Clear, Clear column filter. Funnel/caret trigger button; tinted when that column has an active filter. Reuses `pop-wrap/pop-menu` styles from listTools.
- Toolbar `<FilterSummaryChip>` (count + Clear all) and `<EmptyClearFilters>` for the zero-results state.
- `usePersistentListState(pageKey, defaults)` hook: returns `{visibleCols, setVisibleCols, sortKey, sortDir, setSort, filters, setFilters}`; hydrates from AuthContext's loaded prefs once on mount; debounced (600ms) PATCH of `list_prefs[pageKey]` on change; ignores prefs keys for columns that no longer exist.

**Page adoption (all seven):** swap local `facets`/`FacetState`/`FilterButton` for the shared state + `ColumnMenu` in each header cell (including the primary column); provide the accessor; wire empty state; pass sort through. God-edit unaffected (menus live in the header row; god columns get menus like any other). Persisted god-only column visibility is harmless for non-god sessions (`visibleColumnsFor` gates render).

**Testing:** pure helpers + hook (jsdom) in shared tests; per-page accessor tests; existing suites stay green. Browser pass per page at the end.
