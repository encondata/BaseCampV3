# Status-Rules List Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the /admin/status-rules Rules tab on the full house directory pattern — Trigger split into two columns, plus filters, column options, drag-reorder, CSV export, and persisted list state.

**Architecture:** `RulesTab.tsx` is rebuilt to mirror `portal/src/pages/Notifications.tsx` (the canonical directory list) while keeping its existing load/error/mutation/editor-modal behavior. Pure accessors move to `portal/src/lib/statusRules.ts` where dependency-free. No API changes.

**Spec:** `docs/superpowers/specs/2026-08-31-status-rules-list-upgrade-design.md` — read it first; its column table and toolbar list are binding.

**Tech Stack:** React + existing house list libs (`lib/columnMenu.tsx`, `lib/listTools.tsx`, `lib/virtualRows.tsx`). No new dependencies.

## Global Constraints

- **Run all suites FOREGROUND, one continuous run, timeout 600000ms. Never background a suite.**
- Portal tests: `npm --prefix portal test -- --run <file>`; full check `npm --prefix portal test -- --run` + `npm --prefix portal run build`.
- **The model file is `portal/src/pages/Notifications.tsx` — read it in full before writing any code**, along with `portal/src/lib/columnMenu.tsx` (`usePersistentListState`, `ColumnMenu`, `FilterSummaryChip`) and `portal/src/lib/listTools.tsx` (`ColumnDef`, `FilterButton`, `ColumnsButton`, `ExportButton`, `exportCsv`, `useReorderDrag`, `EmptyClearFilters`). Mirror their usage exactly; do not re-implement any of it.
- `cellText` must mirror each cell's displayed text exactly (house search/CSV contract).
- Page key for persisted state: `'status-rules'`. Default sort: `priority` ascending.
- Preserve the current RulesTab behaviors verbatim: `Promise.all([listStatusRules(), getStatusRuleSchema(), getStatusRuleExecStats()])` load; 403 vs generic error copy; mutation errors caught and surfaced via the error state (toggle/duplicate/remove); `onCount(rules.length)` after load / `onCount(null)` on error; editor-modal wiring (`editing: StatusRule | 'new' | null`); permission gates (`can('status_rules', 'add'|'change'|'delete')`).
- Never commit `api/src/serversherpa/_dev_reload.py`.

## File Structure

| File | Responsibility |
|---|---|
| `portal/src/components/statusRules/RulesTab.tsx` | Rebuild: full directory list |
| `portal/src/lib/statusRules.ts` | Modify: +pure accessors used by list + tests |
| `portal/src/lib/statusRules.test.ts` | Modify: accessor tests |
| `portal/src/pages/StatusRules.test.tsx` | Modify: update + extend page tests |

---

### Task 1: Rebuild RulesTab on the directory pattern

**Files:**
- Modify: `portal/src/components/statusRules/RulesTab.tsx`
- Modify: `portal/src/lib/statusRules.ts`, `portal/src/lib/statusRules.test.ts`
- Modify: `portal/src/pages/StatusRules.test.tsx`

**Interfaces:**
- Consumes (unchanged, from `lib/api.ts`): `StatusRule`, `StatusRuleSchema`, `StatusRuleExecStat`, `listStatusRules`, `getStatusRuleSchema`, `getStatusRuleExecStats`, `toggleStatusRule`, `createStatusRule`, `deleteStatusRule`; `RuleEditorModal` as wired today; `optionLabel`/`summarizeAction` from `lib/statusRules.ts`.
- Produces in `lib/statusRules.ts` (pure, no component imports):

```ts
export interface RuleRowContext {
  schema: StatusRuleSchema | null;
  stats: Map<string, StatusRuleExecStat>;   // keyed by rule_id
}
export function ruleCellText(rule: StatusRule, key: string, ctx: RuleRowContext): string
export function ruleSearchText(rule: StatusRule, ctx: RuleRowContext): string
export function ruleSortValue(rule: StatusRule, key: string, ctx: RuleRowContext): string | number
export function lastRunLabel(iso: string | null | undefined): string   // 'never' | locale date-time
```

- [ ] **Step 1: Write the failing accessor tests** (append to `portal/src/lib/statusRules.test.ts`, reusing its existing `SCHEMA` fixture and adding a minimal rule fixture):

```ts
import {
  lastRunLabel, ruleCellText, ruleSearchText, ruleSortValue,
} from './statusRules';
import type { StatusRule, StatusRuleExecStat } from './api';

const RULE: StatusRule = {
  id: 'r1', name: 'Cage exit', description: 'Clears location',
  trigger_status: 'rfid_4_into_cage', trigger_match_type: 'asset',
  priority: 9, enabled: true,
  conditions: [{ field: 'scan.device_id', operator: 'equals', value: 'dock-1' }],
  actions: [{ action_type: 'set_asset_status', params: { status: 'rfid_4_into_cage' } }],
  created_at: '2026-08-30T12:00:00Z', updated_at: '2026-08-31T09:00:00Z',
};
const STATS = new Map<string, StatusRuleExecStat>([['r1', {
  rule_id: 'r1', run_count: 4, met_count: 3,
  last_run_at: '2026-08-31T10:00:00Z', avg_duration_ms: 5,
}]]);
const CTX = { schema: SCHEMA, stats: STATS };

describe('rule list accessors', () => {
  it('resolves trigger/match labels from the schema', () => {
    expect(ruleCellText(RULE, 'trigger_status', CTX)).toBe('Into cage');
    expect(ruleCellText(RULE, 'match_type', CTX)).toBe('Asset');
  });
  it('renders counts, runs, and enabled text', () => {
    expect(ruleCellText(RULE, 'conditions', CTX)).toBe('1');
    expect(ruleCellText(RULE, 'actions', CTX)).toBe('1');
    expect(ruleCellText(RULE, 'runs', CTX)).toMatch(/^4 · /);
    expect(ruleCellText(RULE, 'enabled', CTX)).toBe('Enabled');
    expect(ruleCellText({ ...RULE, enabled: false }, 'enabled', CTX)).toBe('Disabled');
  });
  it('runs shows never without stats', () => {
    expect(ruleCellText(RULE, 'runs', { schema: SCHEMA, stats: new Map() }))
      .toBe('0 · never');
  });
  it('searchText covers name, description, and resolved labels', () => {
    const hay = ruleSearchText(RULE, CTX).toLowerCase();
    for (const bit of ['cage exit', 'clears location', 'into cage', 'asset']) {
      expect(hay).toContain(bit);
    }
  });
  it('sortValue is numeric for priority/counts/runs', () => {
    expect(ruleSortValue(RULE, 'priority', CTX)).toBe(9);
    expect(ruleSortValue(RULE, 'runs', CTX)).toBe(4);
    expect(ruleSortValue(RULE, 'conditions', CTX)).toBe(1);
  });
  it('lastRunLabel', () => {
    expect(lastRunLabel(null)).toBe('never');
    expect(lastRunLabel('2026-08-31T10:00:00Z')).not.toBe('never');
  });
});
```

Note: the existing `SCHEMA` fixture's trigger option is `{ value: 'rfid_4_into_cage', label: 'Into cage' }` and match type `{ value: 'asset', label: 'Asset' }` — if the current fixture differs, extend it rather than weakening assertions.

- [ ] **Step 2: Run to verify failure**

Run: `npm --prefix portal test -- --run src/lib/statusRules.test.ts`
Expected: FAIL — accessors not exported.

- [ ] **Step 3: Implement the accessors** in `portal/src/lib/statusRules.ts`:

```ts
export interface RuleRowContext {
  schema: StatusRuleSchema | null;
  stats: Map<string, StatusRuleExecStat>;
}

export function lastRunLabel(iso: string | null | undefined): string {
  if (!iso) return 'never';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? 'never' : d.toLocaleString();
}

/** Must mirror the rendered cell text exactly (search/CSV contract). */
export function ruleCellText(
  rule: StatusRule, key: string, ctx: RuleRowContext,
): string {
  const stat = ctx.stats.get(rule.id);
  switch (key) {
    case 'name': return rule.name;
    case 'trigger_status':
      return optionLabel(ctx.schema?.trigger_statuses, rule.trigger_status);
    case 'match_type':
      return optionLabel(ctx.schema?.match_types, rule.trigger_match_type);
    case 'priority': return String(rule.priority);
    case 'conditions': return String(rule.conditions.length);
    case 'actions': return String(rule.actions.length);
    case 'runs':
      return `${stat?.run_count ?? 0} · ${lastRunLabel(stat?.last_run_at)}`;
    case 'updated': return new Date(rule.updated_at).toLocaleString();
    case 'enabled': return rule.enabled ? 'Enabled' : 'Disabled';
    default: return '';
  }
}

export function ruleSearchText(rule: StatusRule, ctx: RuleRowContext): string {
  return [
    rule.name, rule.description,
    ruleCellText(rule, 'trigger_status', ctx),
    ruleCellText(rule, 'match_type', ctx),
  ].join(' ');
}

export function ruleSortValue(
  rule: StatusRule, key: string, ctx: RuleRowContext,
): string | number {
  const stat = ctx.stats.get(rule.id);
  switch (key) {
    case 'priority': return rule.priority;
    case 'conditions': return rule.conditions.length;
    case 'actions': return rule.actions.length;
    case 'runs': return stat?.run_count ?? 0;
    case 'updated': return rule.updated_at;
    case 'enabled': return rule.enabled ? 1 : 0;
    default: return ruleCellText(rule, key, ctx).toLowerCase();
  }
}
```

Adjust `optionLabel`'s argument handling if its current signature requires non-undefined options (pass `?? []`). Run Step 1's tests to green before proceeding.

- [ ] **Step 4: Rebuild `RulesTab.tsx`** on the Notifications.tsx skeleton. Structural requirements (all mirrored from Notifications.tsx — same hooks, same class names, same ordering):

1. Column defs:
   ```ts
   const COLUMNS: ColumnDef[] = [
     { key: 'name', label: 'Name', width: 'minmax(220px, 1.6fr)', default: true },
     { key: 'trigger_status', label: 'Trigger status', width: 'minmax(140px, 1fr)', default: true },
     { key: 'match_type', label: 'Match type', width: '110px', default: true },
     { key: 'priority', label: 'Priority', width: '90px', default: true },
     { key: 'conditions', label: 'Conditions', width: '100px', default: true },
     { key: 'actions', label: 'Actions', width: '90px', default: true },
     { key: 'runs', label: 'Runs', width: 'minmax(140px, 1fr)', default: true },
     { key: 'updated', label: 'Updated', width: 'minmax(150px, 1fr)', default: false },
     { key: 'enabled', label: 'Enabled', width: '90px', default: true },
   ];
   ```
   (Match `ColumnDef`'s actual field names from `lib/listTools.tsx`; widths are grid-template tokens like the other pages'. Trailing fixed actions column stays outside `COLUMNS`, appended to the grid template the way Notifications appends its chevron column — wide enough for the three `.mini-btn`s.)
2. `usePersistentListState('status-rules', { visible: DEFAULT_VISIBLE, sortKey: 'priority', sortDir: 'asc' }, ALL_COLUMN_KEYS)` — copy the exact call shape/return usage from Notifications.tsx, including column order + column filters if the hook carries them.
3. Toolbar: `.dir-toolbar` with the search input, `.result-count`, `FilterButton`, `FilterSummaryChip`, `ColumnsButton`, `ExportButton`, then `+ New rule` (gated `can('status_rules','add')`). Facets for `FilterButton` (mirror Notifications' facet config shape exactly):
   - `trigger_status`: options from `schema.trigger_statuses` (label as display, value matched against `rule.trigger_status`)
   - `match_type`: options from `schema.match_types`
   - `enabled`: two options, Enabled/Disabled
4. Filtering pipeline: search over `ruleSearchText` + facet filters + per-column `ColumnMenu` filters, then sort by `ruleSortValue` with `sortKey`/`sortDir` (numeric-aware compare like Notifications), memoized.
5. CSV: `CSV_COLUMNS` covering every column key (using `ruleCellText`) plus `description`; `ExportButton`/`exportCsv` wired like Notifications (filename `status-rules`).
6. Rows via `VirtualRows`: `.dir-row > .row-main > .cell` per visible column, rendering:
   - name: `.cell-top` name + `.cell-sub` description
   - trigger_status: `.chip` with the vocab color (existing chip rendering carried over)
   - match_type: `.chip tag`
   - actions: count with `title` = the summarized action list (existing `summarizeAction` join carried over)
   - runs / priority / conditions / updated: text per `ruleCellText`
   - enabled: the existing `.switch` checkbox (gated on `canChange`, calling the existing `toggle`)
   - trailing actions cell: existing Edit/Duplicate/Delete buttons.
   Cell text for non-widget cells MUST come from `ruleCellText` so the contract holds.
7. Header row: `.list-head` with `ColumnMenu` per column + `.sortable` caret button, drag reorder via `useReorderDrag` — copied from Notifications.
8. Empty states: `.dir-empty` "No rules yet — create the first one." vs filtered-empty with `EmptyClearFilters`.
9. Keep, verbatim from the current file: the load function (incl. 403 copy), `msgFor` + mutation error handling, `onCount` calls, modal wiring, `duplicate`/`remove` handlers.

- [ ] **Step 5: Update the page tests.** In `portal/src/pages/StatusRules.test.tsx`: existing tests must still pass (rows render sorted by priority, +New gating both ways, toggle→reload, load-error banner, mutation-failure surfacing) — update selectors where markup changed (e.g. rows are `.dir-row` now). Add, with full bodies:

```ts
// 1. splits trigger into two cells: within the first row, separate
//    elements contain the trigger-status label ('Into cage') and the
//    match-type label ('Asset') — assert both via within(row).
// 2. search filters by resolved trigger label: type 'into cage' into
//    the search box; only matching rules remain; result-count updates.
// 3. columns button hides a column: open ColumnsButton, uncheck
//    'Priority', assert the Priority header is gone (mirror however
//    Notifications.test.tsx or another page test drives ColumnsButton —
//    if none does, drive the persisted-state hook via its mocked
//    preferences instead and assert the header set).
```

Mock `updatePreferences`/`preferences.list_prefs` exactly as the existing test file already does (the AuthContext mock already carries `list_prefs: {}`).

- [ ] **Step 6: Run the touched files, then the full suite + build**

Run: `npm --prefix portal test -- --run src/lib/statusRules.test.ts src/pages/StatusRules.test.tsx src/components/statusRules/RuleEditorModal.test.tsx src/components/statusRules/ExecutionsTab.test.tsx`
Expected: all pass.
Then: `npm --prefix portal test -- --run && npm --prefix portal run build`
Expected: full suite green, build clean.

- [ ] **Step 7: Commit**

```bash
git add portal/src/components/statusRules/RulesTab.tsx portal/src/lib/statusRules.ts portal/src/lib/statusRules.test.ts portal/src/pages/StatusRules.test.tsx
git commit -m "feat(portal): status-rules list — full directory pattern, trigger split into two columns"
```

---

### Task 2: Browser verification

**Files:** none (fix in place if issues surface).

- [ ] **Step 1:** Open `http://localhost:5173/admin/status-rules` in the browser pane (dev servers per `.claude/launch.json`; the portal server is often already running — navigate, don't restart). Sign-in: claude-dev@test.example.com / wt-verify-2026 if needed (fill via form_input, submit via `document.querySelector('form').requestSubmit()`).
- [ ] **Step 2:** Verify against the 13 imported rules: two separate Trigger status / Match type columns; sort by priority ascending by default; click a column header caret to re-sort; open the Filter button and facet on Match type = Asset (13 rules, all match) then Enabled = Disabled (13) to confirm counts; open Columns and toggle Updated on / Priority off; drag a column header to reorder; export CSV (confirm a download triggers or the exportCsv call path errors nowhere — console clean); search by a trigger label ('into cage') and confirm filtering + result count; toggle a rule's switch off/on (confirm it round-trips); open Edit and confirm the modal still works.
- [ ] **Step 3:** Reload the page — column visibility/order/sort persisted (server-side prefs round-trip).
- [ ] **Step 4:** `read_console_messages` — no errors. Screenshot the finished list for the report.

---

## Plan Self-Review (completed at write time)

- **Spec coverage:** column table → Task 1.1/1.4; toolbar set incl. facets/CSV/persistence → 1.3–1.5; house contracts (cellText mirror, VirtualRows, EmptyClearFilters, grid template) → 1.4/1.6; preserved behaviors → Global Constraints + 1.4.9; out-of-scope untouched.
- **Placeholders:** Step 5's test sketch names exact assertions and fallback strategy; Step 4 anchors every structural element to the named model file rather than reproducing 400 lines — the implementer is required to read it first (Global Constraints).
- **Type consistency:** `RuleRowContext`/`ruleCellText`/`ruleSearchText`/`ruleSortValue`/`lastRunLabel` used consistently across steps; column keys match accessor keys and facet keys.
