# List Column Floors Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every `.dir-list` in the portal (39 files besides the pilot) and the shared `DataTable` get the pilot's column floors, adaptive headers, value truncation, and sideways scroll; a guardrail keeps new lists from regressing.

**Architecture:** No new mechanisms. Each list is rewired onto the shared primitives the pilot built in `lib/listTools.tsx` (`ColumnDef.min/short`, `listGridStyle`, `listScale`, `ColHead`) and `styles/directory.css` (`.dir-list.list-scroll`, `.cell-line`). Two small shared changes come first (`ColHead` without sorting, `DataTable` scroll wrapper). Spec: `docs/superpowers/specs/2026-09-23-list-column-floors-rollout-design.md`; pilot spec `…/2026-09-23-list-column-floors-design.md`; reference wiring `portal/src/pages/InitiativeDetail.tsx`.

**Tech Stack:** React 18 + TypeScript, Vitest + Testing Library (jsdom), plain CSS.

## Global Constraints

- **Fit target:** a list's default column set plus trailing tracks has a row minimum ≤ its container width at a 1512px viewport with the nav expanded: **1176px** directly inside `.portal-page`; subtract the horizontal padding of every card/panel/tab body between the page and the card (e.g. `.init-panel` 18px a side → 1140). Record the target in a comment on the column array and assert it in a test.
- **Floors:** derived by default (`columnFloor`); explicit `min` only for primary/name (140–200), identifiers (100–120), dates (96). `listGridStyle` gap stays the default 12; pass `listScale(preferences?.list_size)` as the fourth argument.
- **Short labels:** any header wordier than ~12 characters gets a `short` (`Src`/`Dest`, drop filler words); short labels stay unambiguous beside their neighbors.
- **Wiring shape (the pilot's):** `listGridStyle` result spread on `.list-head` and `.row-main`; the same `minWidth` on each `.dir-row` (merged with the VirtualRows `vp.style`); the card carries `list-scroll` (+ `editing` while a god-mode edit is on, with no inline `minWidth` then); header loops render `<ColHead>` with the page's `<ColumnMenu>` as children; single-line values carry `cell-line` + `title` (not for `—`); chips untouched; page-level `overflow: visible` card hacks deleted.
- The list-typography guardrail (`portal/src/styles/listTypography.test.ts`) stays green throughout: no typography on list selectors outside `directory.css`, no raw `<table>`, no inline font props, no page co-class rule on a `mini-row`/`mini-list-head` declaring display/padding/gap/border/min-height.
- American English. Commit messages end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Work in the worktree `.claude/worktrees/list-floors` on branch `list-column-floors`. Commands run from its `portal/` directory. Test: `npx vitest run <files>`; type check: `npx tsc -b`.

---

## Migration recipe (every batch task follows this; read it in full before starting)

Reference: `git show 16a9e046 fd73b84a 72e34cde -- src/pages/InitiativeDetail.tsx src/lib/initiatives.ts` shows the pilot page being migrated. The shared exports (all from `src/lib/listTools.tsx`):

```ts
export interface ColumnDef { key; label; width; default; godOnly?; short?: string; min?: number }
export function columnFloor(col: ColumnDef): number
export function listGridStyle(cols: ColumnDef[], trailing?: string[], gap?: number, scale?: number):
  { gridTemplateColumns: string; minWidth: number }
export function listScale(listSize: string | undefined): number
export function ColHead(props: { col: ColumnDef; sortDir?: 1 | -1 | null; onToggleSort?: () => void;
  className?: string; dragProps?: HeaderDragProps; children?: ReactNode }): JSX.Element
```

For each list in the task:

**R1. Columns become a `ColumnDef[]` if they are not one.** A literal template such as
`` `2.2fr ${shownCols.map((c) => c.width).join(' ')} 30px` `` has a leading primary track outside the
registry: declare `const PRIMARY_COL: ColumnDef = { key: 'primary', label: 'Name', width: '2.2fr', default: true, min: 180 };`
(use the header's real label) and build the grid from `[PRIMARY_COL, ...shownCols]`. A list with no registry at
all (`'1fr 1fr 120px'` and hand-written header spans) gets a local `const COLUMNS: ColumnDef[] = […]` mirroring its
header labels in order, with fixed px widths kept as written (`width: '120px'`). Trailing fixed tracks (actions,
chevron, checkbox) go in `trailing`.

**R2. Floors and short labels** per the Global Constraints. Write the fit target as a comment above the array:
`// Fit: default columns + trailing ≤ <N>px (<container> at a 1512px window, nav expanded).`

**R3. Grid.** Replace the inline template with

```ts
const listGridScale = listScale(preferences?.list_size);   // preferences from useAuth(); once per component
const grid = listGridStyle(shownCols, trailing, undefined, listGridScale);
const rowStyle = { gridTemplateColumns: grid.gridTemplateColumns, minWidth: editing ? undefined : grid.minWidth };
```

(`editing` is the list's god-mode edit flag when it has one; otherwise `minWidth: grid.minWidth`.) Apply
`style={rowStyle}` to `.list-head` and `.row-main`; on the `.dir-row` wrapper use
`style={{ ...vp?.style, minWidth: rowStyle.minWidth }}` (VirtualRows) or `style={{ minWidth: rowStyle.minWidth }}`
(plain rows). Components that do not call `useAuth()` may accept the scale as a prop or call `useAuth()` themselves
— follow whatever the component already does for preferences; if it has no access to preferences, omit the fourth
argument (scale 1) and say so in the report.

**R4. Card.** `className="dir-list <existing classes> list-scroll"` plus `` ${editing ? ' editing' : ''} `` when
the list has a god-mode edit toggle. Delete any page CSS rule that sets `overflow: visible` on that card (and its
corner re-rounding companions) — search the page's stylesheet for the card's class.

**R5. Headers.** Replace each header cell

```tsx
<span key={c.key} className={`col-head ${drag.dropClass(c.key)}`} {...drag.dragProps(c.key)}>
  <button type="button" className="sortable" onClick={() => toggleSort(c.key)}>{c.label} {caret(c.key)}</button>
  <ColumnMenu … />
</span>
```

with

```tsx
<ColHead key={c.key} col={c} sortDir={sortKey === c.key ? sortDir : null}
         onToggleSort={() => toggleSort(c.key)} className={drag.dropClass(c.key)}
         dragProps={drag.dragProps(c.key)}>
  <ColumnMenu … />
</ColHead>
```

Headers without sorting: `<ColHead key={c.key} col={c} />`. Headers with a fixed primary column outside the loop:
`<ColHead col={PRIMARY_COL} sortDir={…} onToggleSort={…} />`. Delete the page's now-unused `caret` helper. Keep any
extra header class (centered columns, etc.) by passing it in `className` joined with the drop class:
`[drag.dropClass(c.key), extra].filter(Boolean).join(' ')`.

**R6. Values.** In the cell renderer, single-line text values (`cell-top`, `mono`, plain spans of names/ids/dates)
get `cell-line` and `title={titleFor(text)}` with `const titleFor = (t: string) => (t === '—' ? undefined : t);`
declared once per file. `.pn` name/sub pairs already ellipsize (`.cell-primary .pn b/span`); chips already truncate;
inputs and buttons other than link-style text buttons are left alone.

**R7. Tests.** If the page/component has a test file, add one test using its existing render + row-finding helpers:

```tsx
it('<list name>: column floors, shared template + minimum, sideways-scroll card', async () => {
  renderPage();                                   // the file's existing render helper
  const row = await <rowFinder>();                // e.g. (await screen.findByText('…')).closest('.dir-row')
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);   // or the list's first track
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(<fit target>);
});
```

If it has no test file, export the column array and add `<Page>.columns.test.ts` next to it:

```ts
import { describe, expect, it } from 'vitest';
import { listGridStyle } from '../lib/listTools';
import { COLUMNS } from './<Page>';
describe('<Page> columns', () => {
  it('default columns fit the <container> at a 14-inch window', () => {
    const defaults = COLUMNS.filter((c) => c.default);
    expect(listGridStyle(defaults, [<trailing>]).minWidth).toBeLessThanOrEqual(<fit target>);
  });
});
```

(If exporting from a page module drags heavy imports into a unit test, put the array in the page's existing `lib/`
helper module instead, as `lib/initiatives.ts` does for the pilot.)

**R8. Run** the batch's test files + `src/styles/listTypography.test.ts`, then `npx tsc -b`, then commit the batch
as one commit.

---

### Task 1: Shared — `ColHead` without sorting, `DataTable` scroll wrapper

**Files:**
- Modify: `portal/src/lib/listTools.tsx` (`ColHead`, ~line 199)
- Modify: `portal/src/components/DataTable.tsx`
- Modify: `portal/src/styles/directory.css` (`.data-table` block, ~line 663)
- Test: `portal/src/lib/listTools.test.tsx`, `portal/src/components/DataTable.test.tsx`

**Interfaces:**
- Produces: `ColHead` accepts `sortDir?` and `onToggleSort?`; without `onToggleSort` it renders `<span className="col-label">{label} {caret}</span>` (no button) — same swap behavior. `DataTable` renders `<div className="data-table-scroll"><table …/></div>`.

- [ ] **Step 1: Failing tests**

`listTools.test.tsx`, inside `describe('ColHead / useFitLabel', …)`:

```tsx
  it('renders a plain label (no button) when the header is not sortable', () => {
    const col: ColumnDef = { key: 'n', label: 'Name', width: '1fr', default: true };
    const { container } = render(<ColHead col={col} />);
    expect(container.querySelector('button')).toBeNull();
    const label = container.querySelector('.col-head .col-label') as HTMLElement;
    expect(label.textContent?.trim()).toBe('Name');
  });
```

`DataTable.test.tsx` (extend the existing file; read its render helper first):

```tsx
  it('wraps the table in a sideways-scroll block', () => {
    const { container } = render(<DataTable columns={[{ key: 'a', label: 'A' }]} rows={[{ key: '1', cells: ['x'] }]} />);
    const wrap = container.querySelector('.data-table-scroll') as HTMLElement;
    expect(wrap).not.toBeNull();
    expect(wrap.querySelector('table.data-table')).not.toBeNull();
  });
```

- [ ] **Step 2: Run** `npx vitest run src/lib/listTools.test.tsx src/components/DataTable.test.tsx` → both new tests FAIL.

- [ ] **Step 3: Implement**

`ColHead`:

```tsx
export function ColHead({ col, sortDir = null, onToggleSort, className, dragProps, children }: {
  col: ColumnDef;
  sortDir?: 1 | -1 | null;
  /** Absent for a header that does not sort: the label renders as a plain span. */
  onToggleSort?: () => void;
  className?: string;
  dragProps?: HeaderDragProps;
  children?: ReactNode;
}): JSX.Element {
  const { cellRef, measureRef, label } = useFitLabel(col.label, col.short);
  const caret = sortDir
    ? <span className="caret">{sortDir === 1 ? '▲' : '▼'}</span> : null;
  const title = label === col.label ? undefined : col.label;
  return (
    <span ref={cellRef} className={`col-head${className ? ` ${className}` : ''}`} {...dragProps}>
      {onToggleSort ? (
        <button type="button" className="sortable" onClick={onToggleSort} title={title}>
          {label} {caret}
        </button>
      ) : (
        <span className="col-label" title={title}>{label} {caret}</span>
      )}
      {col.short && (
        <span ref={measureRef} className="col-head-measure" aria-hidden="true">
          {col.label} {caret}
        </span>
      )}
      {children}
    </span>
  );
}
```

`column-menu.css`: extend the nowrap rule to the plain label: `.dir-list.list-scroll .list-head .col-head .sortable, .dir-list.list-scroll .list-head .col-head .col-label { white-space: nowrap; }` and add `.list-head .col-head .col-label { min-width: 0; }` next to the `.sortable { min-width: 0 }` rule.

`DataTable.tsx`: wrap the returned `<table>` in `<div className="data-table-scroll">…</div>`.

`directory.css`, above `.data-table { width: 100%; … }`:

```css
/* The table's own min-content sizing is its floor; below it the wrapper
 * scrolls sideways instead of the table overflowing its card/modal. */
.data-table-scroll { overflow-x: auto; overflow-y: hidden; max-width: 100%; }
```

- [ ] **Step 4: Run** the two test files + `src/styles/listTypography.test.ts` + `src/pages/InitiativeDetail.test.tsx` → PASS. `npx tsc -b` clean.

- [ ] **Step 5: Commit** `feat(portal): ColHead renders a plain label for unsortable headers; DataTable scrolls sideways below its min-content width`

---

### Task 2: Directory pages — Sites, Workers, Users, OrgDirectory

**Files:** `portal/src/pages/Sites.tsx`, `Workers.tsx`, `Users.tsx`, `OrgDirectory.tsx`; their stylesheets (`styles/sites.css`, `settings.css`, `profile.css`) only if a card overflow hack exists; tests `Users.test.tsx`, `OrgDirectory.test.tsx`; new `Sites.columns.test.ts` / `Workers.columns.test.ts` if those pages have no test file.

**Notes:** Sites builds `` `2.2fr ${shownCols…} 30px` `` with a fixed primary "Name" header outside the loop (R1 primary column, `min: 180`, the primary header's own sort key `'primary'`). OrgDirectory has no `ColumnDef[]` (R1 local registry). Fit target 1176 for all four (page-level lists).

- [ ] Follow the Migration recipe R1–R8 for each file.
- [ ] Commit: `feat(portal): column floors + sideways scroll on Sites, Workers, Users, OrgDirectory`

---

### Task 3: Asset pages — Assets, AssetModels, Containers, Warehouse

**Files:** `portal/src/pages/Assets.tsx`, `AssetModels.tsx`, `Containers.tsx`, `Warehouse.tsx` (two grids: containers + stock); stylesheets `assets.css`, `containers.css`, `warehouse.css` for overflow hacks; tests `Assets.test.tsx`, `AssetModels.test.tsx`, `Containers.test.tsx`, `Warehouse.test.tsx`.

**Notes:** Assets and Containers have god-mode edit toggles (R3/R4 `editing`). Warehouse's lists sit inside panels — read `warehouse.css` for the panel padding and compute the fit target (record it). Fit target 1176 for Assets/AssetModels/Containers.

- [ ] Follow the Migration recipe R1–R8 for each file.
- [ ] Commit: `feat(portal): column floors + sideways scroll on Assets, Asset Models, Containers, Warehouse`

---

### Task 4: Initiative and report pages — Initiatives, StakeholderDetail, MoveDashboard, Reports

**Files:** `portal/src/pages/Initiatives.tsx` (tree rows: keep `--depth` and the tree toggle; the primary cell is `cell-primary`), `StakeholderDetail.tsx` (three grids — initiatives, sites, contacts — each gets its own `listGridStyle`; lists sit in detail panels, compute the target from `initiatives.css`/`profile.css` padding), `MoveDashboard.tsx` (no `ColumnDef[]`: R1 local registry; the list sits in a dashboard panel — read `dashboard.css`), `Reports.tsx`; tests exist for all four.

- [ ] Follow the Migration recipe R1–R8 for each file.
- [ ] Commit: `feat(portal): column floors + sideways scroll on Initiatives, Stakeholder detail, Move dashboard, Reports`

---

### Task 5: Trucks, External, Time Management, Notifications, Audit

**Files:** `portal/src/pages/Trucks.tsx`, `External.tsx`, `TimeManagement.tsx`, `Notifications.tsx`, `Audit.tsx`; `styles/directory.css` (delete the `.dir-list.ngd-notif-grid { overflow-x: auto; }` rule and its comment; Notifications' card uses `list-scroll` instead and drops the `ngd-notif-grid` class only if nothing else styles it — grep `notifications.css` first); tests `Trucks.test.tsx`, `TimeManagement.test.tsx`, `Notifications.test.tsx`; new `External.columns.test.ts`, `Audit.columns.test.ts`.

**Notes:** Notifications has `minmax()` floors in its column widths already — convert them to `min` on the ColumnDef and plain `fr` widths so `listGridStyle` owns the floors. Fit target 1176 for all five.

- [ ] Follow the Migration recipe R1–R8 for each file.
- [ ] Commit: `feat(portal): column floors + sideways scroll on Trucks, External, Time Management, Notifications, Audit`

---

### Task 6: Hardware and system pages — FixedReaders, KioskDevices, Routers, LabelTemplates, Variables, DevDatabase, GroupsList

**Files:** `portal/src/pages/FixedReaders.tsx`, `KioskDevices.tsx`, `Routers.tsx`, `LabelTemplates.tsx`, `Variables.tsx` (four grids, no sorting → `<ColHead col={c} />`), `DevDatabase.tsx` (two grids, no sorting), `me/GroupsList.tsx` (hand-written header spans, no registry → R1 local `COLUMNS`); stylesheets `hardware.css`, `labels.css`, `access.css`, `system.css` for overflow hacks; tests exist for FixedReaders, KioskDevices, Routers, LabelTemplates, DevDatabase; GroupsList is rendered by `Profile.test.tsx` or `NotificationGroupDetail.test.tsx` — check which and add the assertion there, else a columns test.

**Notes:** Variables' lists and DevDatabase's lists live in tab bodies (`settings.css`/`system.css` padding) — compute targets.

- [ ] Follow the Migration recipe R1–R8 for each file.
- [ ] Commit: `feat(portal): column floors + sideways scroll on hardware, label template, variables, database, and groups lists`

---

### Task 7: Components — scans, surveys, label lists

**Files:** `portal/src/components/scans/ProcessedScansTab.tsx`, `scans/RawScansTab.tsx`, `sites/RawSurveyList.tsx`, `sites/SiteSurveyList.tsx`, `labels/PrintAssetList.tsx`, `labels/PrintContainerList.tsx`, `labels/ContainerPickList.tsx` (hand-written headers → R1), `labels/LabelRunsList.tsx` (hand-written headers → R1); each component's test file if present (`ls` the directory), else the page test that mounts it (`AssetDetail.test.tsx` for scans tabs? — check `grep -rl ProcessedScansTab src/pages`), else a columns test.

**Notes:** These components render inside page tabs/cards; the scans tabs sit in the asset/initiative detail pages, the survey lists in the site detail page, the label lists in `/labels/print` — compute each target from the surrounding CSS and record it. Components that lack `useAuth()` follow R3's note.

- [ ] Follow the Migration recipe R1–R8 for each file.
- [ ] Commit: `feat(portal): column floors + sideways scroll on scan, survey, and label list components`

---

### Task 8: Components — status rules, report history, labels tab, activity, members, DB testing

**Files:** `portal/src/components/statusRules/ExecutionsTab.tsx` (two grids, no sorting), `statusRules/RulesTab.tsx`, `reports/HistoryTab.tsx` (hand-written), `variables/LabelsTab.tsx` (two grids, no registry), `ActivityHistory.tsx`, `access/MembersTab.tsx`, `dev/DbTestingTab.tsx` (no registry); tests: `StatusRules.test.tsx`, `Reports.test.tsx`, `Settings.test.tsx`/`Access.test.tsx`, `DevDatabase.test.tsx`, or component tests where they exist.

- [ ] Follow the Migration recipe R1–R8 for each file.
- [ ] Commit: `feat(portal): column floors + sideways scroll on status-rule, history, label, activity, member, and DB-testing lists`

---

### Task 9: Guardrail check (h)

**Files:** `portal/src/styles/listTypography.test.ts` (header comment + a new `it('(h) …')` in the `describe`), `portal/src/styles/listTypography.allow.json` only if a deliberate exception is needed (with a reason).

- [ ] **Step 1:** Add to the header comment: `(h) every .tsx under pages/ or components/ that renders className="list-head" imports listGridStyle from lib/listTools, contains "list-scroll", and contains no className="sortable" (the sortable button is ColHead's alone); lib/listTools.tsx and components/DataTable.tsx are exempt.`
- [ ] **Step 2:** Implement, using the file's existing `walk()` and file-reading helpers:

```ts
  it('(h) every list-head list uses listGridStyle, list-scroll, and ColHead', () => {
    const files = [...walk(join(SRC, 'pages'), /\.tsx$/), ...walk(join(SRC, 'components'), /\.tsx$/)]
      .filter((f) => !/\.test\.tsx$/.test(f) && !/components\/DataTable\.tsx$/.test(f));
    const failures: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      if (!src.includes('className="list-head"')) continue;
      const missing = [
        !/\blistGridStyle\b/.test(src) && 'listGridStyle import/use',
        !src.includes('list-scroll') && 'list-scroll class',
        src.includes('className="sortable"') && 'raw className="sortable" (use ColHead)',
      ].filter(Boolean);
      if (missing.length) failures.push(`${rel(f)}: ${missing.join(', ')}`);
    }
    expect(failures, failures.join('\n')).toEqual([]);
  });
```

(Adapt `SRC`, `join`, `rel` to the helper names the file already uses — read it first.)

- [ ] **Step 3:** Run `npx vitest run src/styles/listTypography.test.ts` → PASS with no failures (every list migrated in Tasks 2–8). If it lists a file, that file was missed: fix it in this task and say so.
- [ ] **Step 4:** Commit `test(portal): guardrail (h) — every list-head list uses listGridStyle, list-scroll, and ColHead`

---

### Task 10: Browser sweep (main session)

Dev stack from the worktree on ports 8001/5175 (already running). For each of: Sites, Assets, Containers, Initiatives, Trucks, Users, Notifications, Warehouse, a Stakeholder detail, Scans tab on an asset — at 1512×982 with the nav expanded confirm `card.scrollWidth === card.clientWidth` for the default columns; at 1200×900 confirm the card scrolls and short labels appear; open one column menu on a scrolled card; hover one long value. Fix anything found as a fix task before the final review.
