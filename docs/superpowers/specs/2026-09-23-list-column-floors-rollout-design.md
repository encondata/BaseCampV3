# List column floors — rollout to every list (design)

Jimmy accepted the initiative-detail pilot (`2026-09-23-list-column-floors-design.md`,
branch `list-column-floors`) on 2026-09-23 and asked for the same treatment on all other
lists, then a merge to main. This addendum fixes the scope, the per-list rules, and the
guardrail that keeps new lists from regressing.

## Scope

**In:** every `.dir-list` that renders a `.list-head` grid — 39 files besides the pilot
(`grep -rl 'className="list-head"' portal/src --include='*.tsx'`), and the shared
`components/DataTable.tsx` (the one sanctioned `<table>`, 23 users). Notifications' own
`.dir-list.ngd-notif-grid { overflow-x: auto }` rule is retired in favor of `list-scroll`.

**Out:** `mini-list` / `mini-row` grids (dashboard feeds, detail-panel pickers, the EnvTab
section rows). They are narrow embedded lists with `minmax()` templates already, and none has
been reported colliding; they can adopt `.mini-list.list-scroll` individually if one does.

## Rules every migrated list follows

1. **Columns are a `ColumnDef[]`.** A list that builds its template from a literal string
   (`'2.2fr 1fr 1fr 30px'`) or that has a fixed leading primary track outside its column
   registry gets a local `ColumnDef` for each track so `listGridStyle` can floor it. Trailing
   fixed tracks (actions `88px`, chevron `30px`, checkbox `36px`) stay as `trailing`.
2. **Floors.** Default: derived from the label (`columnFloor`). Explicit `min` only where the
   content needs more than the header: primary/name columns 140–200, identifiers (serial,
   EPC, IP/MAC, ids) 100–120, dates 96. Never below the derived floor (the helper enforces it).
3. **Short labels** for any header wordier than about twelve characters, using the pilot's
   vocabulary: `Src`/`Dest` for Source/Destination, `Sts` is avoided, drop filler words
   ("Vendor Involved" → "Vendor", "Last activity" → "Last"). Short labels must stay
   unambiguous next to their neighbors.
4. **Fit target.** The list's **default** column set plus its trailing tracks must have a row
   minimum no wider than the list's container at a 1512px viewport with the nav expanded:
   **1176px** for a list directly inside `.portal-page`; subtract the horizontal padding of
   every card/panel/tab body between the page and the card (an `.init-panel` costs 36 → 1140;
   `.detail-block`/tab bodies similar — read their CSS). Each list records its target in a
   comment on its column array and asserts it in a test.
5. **Wiring** (the pilot's shape, `pages/InitiativeDetail.tsx` is the reference):
   `listGridStyle(shownCols, trailing, undefined, listScale(preferences?.list_size))` spread
   on `.list-head` and `.row-main`; the same `minWidth` on each `.dir-row` (merged with the
   VirtualRows style); the card gets `list-scroll` (plus `editing` while a god-mode edit is
   on, and then no inline `minWidth`); header loops render `<ColHead>` with the page's
   `<ColumnMenu>` as children; single-line values get `cell-line` + `title` (not for `—`);
   chips untouched; page-level `overflow: visible` hacks on the card are deleted.
6. **Headers without sorting** (Variables, GroupsList, ExecutionsTab, …) still use `ColHead`;
   it renders a plain label when `onToggleSort` is absent so the long/short swap applies
   everywhere.
7. **DataTable** wraps its `<table>` in a `.data-table-scroll` block (`overflow-x: auto`);
   `th` already `nowrap`. Column `width` props keep working. No floors: a table's own
   min-content sizing is its floor.

## Guardrail

`styles/listTypography.test.ts` gains check **(h)**: every `.tsx` under `pages/` or
`components/` that renders `className="list-head"` must (1) import `listGridStyle` from
`lib/listTools`, (2) contain `list-scroll`, and (3) contain no `className="sortable"` (the
sortable button is `ColHead`'s alone). `lib/listTools.tsx` and `components/DataTable.tsx`
are exempt by name. A violation prints the file and which of the three it fails.

## Rollout order

Shared changes first (ColHead optional sort, DataTable scroll, Notifications rule), then
the pages in batches of four to eight grouped by shared stylesheet, then the components,
then the guardrail, then a browser sweep at 1512 / 1200 px over a sample of pages. Merge to
main when the sweep is clean (Jimmy: "once complete merge to main").
