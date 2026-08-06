# Column Menus + Persistent List State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Per-task reviews ONLY for Tasks 1–2 (new mechanism); Tasks 3–6 are recipe adoptions covered by the single final review (per Jimmy's pace directive).

**Goal:** Excel-style per-column menus (sort, type-to-filter, unique-value multi-select) on all list pages, replacing toolbar facet filters; column visibility + sort + filters persist per user via `ui_prefs.list_prefs`.

**Spec:** `docs/superpowers/specs/2026-08-06-column-menus-design.md`. Branch: `column-menus` in worktree `/Volumes/Extreme SSD/Code Backups/BaseCampV3-assets`.

## Global Constraints

- Worktree symlinks (api/.venv, portal/node_modules): never modify/reinstall/`git add`; targeted adds; delete `._*` files if tools trip. API tests: `PYTHONPATH="$PWD/src" SS_TEST_DB=serversherpa_test_assets`. Portal: `cd portal && npm test && npm run build`. Commit per task, trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
- One additive API change ONLY: `UiPreferences.list_prefs: dict = {}`. No new endpoints.
- The empty state MUST show "Clear all filters" when `activeFilterCount(filters) > 0` — hard requirement.
- FilterButton usage removed from all pages (component itself deleted in Task 6 when the last consumer is gone; `passesFacets` stays if god-edit/facet helpers still import it — check).
- Persistence: debounced 600ms; page keys: `assets`, `asset_models`, `sites`, `workers`, `users`, `external`, `clients`, `partners` (OrgDirectory uses its cfg kind). Never persist query text or god-mode state. Hydrate once per mount; sanitize unknown column keys.
- Keep header-click sort cycling; ColumnMenu's sort actions set explicitly. Keep global search box, Export (exports filtered+visible rows), ?open= deep-links, god-edit wiring untouched.

---

### Task 1 (REVIEWED): API `list_prefs` + shared mechanism + tests

**Files:** api: `src/serversherpa/api/schemas.py` (UiPreferences + its update-in twin — read how theme/accent/density are declared and mirror), `tests/test_preferences.py` (extend: list_prefs round-trips through the prefs PATCH; absent key defaults {}). portal: create `src/lib/columnMenu.tsx`, `src/styles/column-menu.css`, `src/lib/columnMenu.test.tsx`; modify `src/lib/api.ts` (UiPreferences type + prefs PATCH body type), `src/lib/listTools.tsx` (export `activeFilterCount`; leave FilterButton in place until Task 6).

Shared exports (exact contract for Tasks 2–6):
```tsx
export interface ColumnFilter { text?: string; values?: string[] }
export type ColumnFilters = Record<string, ColumnFilter>;
export type CellText<T> = (row: T, colKey: string) => string;
export function passesColumnFilters<T>(row: T, filters: ColumnFilters, text: CellText<T>): boolean
export function uniqueValues<T>(rows: T[], colKey: string, text: CellText<T>): string[]   // sorted naturalCompare, '' -> '—'
export function activeFilterCount(filters: ColumnFilters): number
export function ColumnMenu<T>(props: { colKey: string; label: string; rows: T[]; text: CellText<T>;
  filter: ColumnFilter | undefined; onFilter: (colKey: string, f: ColumnFilter | null) => void;
  sortDir: 1 | -1 | null; onSort: (dir: 1 | -1) => void }): JSX.Element
export function FilterSummaryChip({ filters, onClear }: { filters: ColumnFilters; onClear: () => void })
export function EmptyClearFilters({ filters, onClear }: { filters: ColumnFilters; onClear: () => void })
export function usePersistentListState(pageKey: string, defaults: { visible: Set<string>; sortKey: string; sortDir: 1 | -1 })
  // -> { visibleCols, setVisibleCols, sortKey, sortDir, setSort, toggleSort, filters, setFilter, clearFilters }
  // hydrates from useAuth().preferences.list_prefs[pageKey]; saves via debounced updatePreferences({list_prefs: {...merged}})
```
Matching rule: a row passes a column when (no text OR text substring-matches, case-insensitive) AND (no values OR values includes the cell text, with '' matched by '—'). ColumnMenu checklist narrows by the typed text; Select all selects the narrowed set; blank filter = remove key. Menu trigger: caret button next to the header label with `filtered` class when active. Read `AuthContext` to find how preferences are exposed + how the prefs PATCH is called today (Settings page) and reuse that client path.

Tests (jsdom where needed): pure matcher/uniqueValues/count cases incl. '—' blanks; hook hydrate→change→debounced-save (mock updatePreferences, fake timers), unknown-column sanitization; menu narrowing + select-all; API test for list_prefs round-trip.

Verify both suites + build; commit `feat: column-menu mechanism + persistent list prefs`.

### Task 2 (REVIEWED): Assets adoption — the template

**Files:** `portal/src/pages/Assets.tsx`, `portal/src/lib/assets.ts` (+tests).

Replace facetGroups/facets/FilterButton with: `cellTextFor(row, colKey)` accessor in lib (reuses existing cell/search text: status→status_label, category→model.category_label, client→client_name, etc.; primary col key `'primary'` → serial+name), `usePersistentListState('assets', …)` replacing local visibleCols/sortKey/sortDir/facets state, `ColumnMenu` in every header cell (incl. primary), `FilterSummaryChip` in the toolbar, `EmptyClearFilters` in the No-matches block, filtering memo = query + `passesColumnFilters` (+ keep the default archived-hidden rule: archived rows hidden unless the archived column's filter selects them — expose `archived` as a god-agnostic pseudo-column in the accessor returning 'yes'/'no', kept OUT of COLUMNS but filterable via... NO: simpler, keep the existing behavior exactly: hidden unless a `status`-independent archived filter — implement as: archived rows hidden unless `filters.archived?.values?.includes('yes')`; add an `archived` entry to uniqueValues via a small extra ColumnMenu on the chevron column header labeled 'Archived'). Tests: accessor round-trips; archived rule.

Verify; commit `feat(portal): column menus on Assets`.

### Task 3: Makes/Models + Sites adoption (recipe, no per-task review)

Same recipe with each page's accessor (Models: aliases join for the aliases column; weight/dims cells use their formatted display text). Sites keeps map view untouched; coords column accessor uses formatCoords. Commit per page or combined `feat(portal): column menus on Makes/Models and Sites`.

### Task 4: Workers + Users + External adoption (recipe)

Workers/Users/External: swap their facet systems; person-keyed pages already have search-text helpers to reuse. Users' bespoke columns picker migrates to the shared persistent state (keep its UI if custom, but back it with usePersistentListState). Commit `feat(portal): column menus on Workers, Users, External`.

### Task 5: OrgDirectory adoption (recipe)

Config-driven: accessor + pageKey come from cfg (clients/partners). Commit `feat(portal): column menus on Clients and Partners`.

### Task 6: Cleanup + full verification

Delete FilterButton (+FacetGroup/FacetState/passesFacets IF no remaining consumers — grep first; god-edit code must not break), drop dead facet code from pages, run FULL portal suite + build + API suite. Commit `chore(portal): remove superseded facet FilterButton`.

### Task 7: Final whole-branch review (fable) → fix wave → merge to main → HMR check → memory/ledger update. Browser checklist for Jimmy: per-column menu on Assets (sort, type-filter, value checkboxes), 0-result Clear-all button, filter chip, persistence across reload AND logout/login, Columns picker changes persisting, Excel-narrowing behavior, no FilterButton anywhere.
