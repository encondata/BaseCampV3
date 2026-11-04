# Worker Trade Chips Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a worker's comma-separated trade as chips everywhere in the portal, edit it with the chips input, and filter the Trade column by individual trade.

**Architecture:** Portal only. `splitTrades` (lib/workers.ts) turns the stored text into a list; a `TradeChips` component renders it; `lib/columnMenu.tsx` gains an optional multi-value accessor (`CellValues<T>`) so a column's checklist and filters work per value; `ProfileForm` swaps its text box for `TagInput`.

**Tech Stack:** React + TypeScript, vitest + Testing Library, run from `portal/`.

**Spec:** `docs/superpowers/specs/2026-11-03-worker-trade-chips-design.md`

## Global Constraints

- No API or database change; `worker_profiles.trade` stays one text value.
- Split rule: split on `,`, trim, drop empties, drop case-insensitive duplicates (first spelling wins), keep order.
- Save rule: chips joined with `", "`; `null` when there are none.
- Chip markup: `<div className="chips">` with one `<span className="chip tag">` per trade (same as External's Functions column). Empty → the caller's fallback text, default `—`.
- Sorting, global search, CSV export and the god-edit Trade cell keep using the full text.
- American English in all copy and comments.
- Run tests from `portal/`: `npx vitest run <files>`; typecheck `npx tsc -b` (the first half of `npm run build`).
- Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. Messy stored text (`"Cable, , Hardware,"`, `" Hardware "`, `"Hardware, hardware"`) — no empty chips, no duplicate chips or checkboxes. (Task 1 tests)
2. A filter saved before this change holding a full combination (`"Cable, Hardware"`) still matches that worker. (Task 2 test)
3. A worker with no trade — shows `—` chip-free fallback and is reachable through the `—` checkbox. (Task 2 + Task 3 tests)
4. Typing a trade in Edit profile and clicking Save without pressing Enter still saves it (TagInput commits on blur). (Task 4 test)
5. A pasted `"Cable, Fiber"` that lands as one tag is saved as `"Cable, Fiber"` and shows as two chips afterward — save normalizes through `splitTrades`. (Task 4 test)

---

### Task 1: `splitTrades` and `TradeChips`

**Files:**
- Modify: `portal/src/lib/workers.ts`
- Create: `portal/src/components/workers/TradeChips.tsx`
- Test: `portal/src/lib/workers.test.ts`, create `portal/src/components/workers/TradeChips.test.tsx`

**Interfaces:**
- Produces: `export function splitTrades(trade: string | null | undefined): string[]` (lib/workers.ts); `export default function TradeChips({ trade, fallback = '—' }: { trade: string | null | undefined; fallback?: string })`.

- [ ] **Step 1: Failing tests** — in `workers.test.ts`, `describe('splitTrades')`:
  - `splitTrades('Cable, General, Hardware')` → `['Cable', 'General', 'Hardware']`
  - `splitTrades('Cable, , Hardware,')` → `['Cable', 'Hardware']`
  - `splitTrades(' Hardware ')` → `['Hardware']`
  - `splitTrades('Hardware, hardware, Cable')` → `['Hardware', 'Cable']`
  - `splitTrades(null)`, `splitTrades('')`, `splitTrades(' , ')` → `[]`

  In `TradeChips.test.tsx`: `trade="Cable, Hardware"` renders two `.chip.tag` elements with those texts inside one `.chips`; `trade={null}` renders no `.chip` and the text `—`; `trade={null} fallback="No trade set"` renders `No trade set`.
- [ ] **Step 2:** `npx vitest run src/lib/workers.test.ts src/components/workers/TradeChips.test.tsx` → FAIL (not defined).
- [ ] **Step 3:** Implement both. Fallback renders as plain text (no `.chips` wrapper), so callers can place it like the old text.
- [ ] **Step 4:** Same command → PASS.
- [ ] **Step 5:** Commit `feat(workers): splitTrades + TradeChips`.

### Task 2: Multi-value column filters in `columnMenu`

**Files:**
- Modify: `portal/src/lib/columnMenu.tsx`
- Test: `portal/src/lib/columnMenu.test.tsx`

**Interfaces:**
- Produces: `export type CellValues<T> = (row: T, colKey: string) => string[] | null;` — `null` means "use the single text as today".
  - `passesColumnFilters(row, filters, text, cellValues?)`
  - `rowsForMenu(rows, filters, colKey, text, cellValues?)`
  - `uniqueValues(rows, colKey, text, cellValues?)`
  - `ColumnMenu` prop `cellValues?: CellValues<T>`, passed through to `rowsForMenu`/`uniqueValues` for the local (non-`valuesSource`) checklist.

Rules when `cellValues(row, colKey)` returns an array (empty array → treat as `['—']`):
- checklist lists each value once (naturalCompare sort, as today);
- `values` passes when any row value is in `values`, **or** the row's full `displayOf(text(row, colKey))` is in `values` (old saved combinations);
- `exclude` passes when at least one row value is not in `exclude`;
- `text` still substring-matches `text(row, colKey)`.

- [ ] **Step 1: Failing tests** — new `describe('multi-value columns')` with rows `{t: 'Cable, Hardware'}`, `{t: 'Hardware'}`, `{t: 'Cable'}`, `{t: ''}`, `text = (r) => r.t || '—'` style accessor and `cellValues = (r, k) => k === 't' ? splitLike(r.t) : null` (a local split helper in the test, not `splitTrades`, to keep columnMenu tests independent):
  - `uniqueValues(rows, 't', text, cellValues)` contains exactly `—`, `Cable`, `Hardware` once each (assert as a sorted set; don't pin where `—` sorts)
  - `values: ['Hardware']` keeps rows 1 and 2
  - `values: ['—']` keeps only the blank row
  - `exclude: ['Hardware']` keeps rows 1, 3, 4 and drops row 2
  - `values: ['Cable, Hardware']` (old saved combo) keeps row 1
  - `text: 'cable, h'` keeps row 1 only
  - a column where `cellValues` returns `null` behaves exactly as before (repeat one existing single-value assertion with `cellValues` passed)
  - `ColumnMenu` with `cellValues`: open the menu on a page with the rows above; the checklist shows `Cable` and `Hardware` as separate checkboxes and no `Cable, Hardware` entry (follow the existing `describe('ColumnMenu')` render pattern in this file).
- [ ] **Step 2:** `npx vitest run src/lib/columnMenu.test.tsx` → new tests FAIL.
- [ ] **Step 3:** Implement. Keep the existing signatures working with the extra argument omitted.
- [ ] **Step 4:** Same command → PASS (old and new).
- [ ] **Step 5:** Commit `feat(column-menu): multi-value column filters`.

### Task 3: Chips and per-trade filter on Workers and the partner page

**Files:**
- Modify: `portal/src/pages/Workers.tsx` (Trade cell ~line 281, detail panel `Trade` ~line 500, both `ColumnMenu`s and the `passesColumnFilters` calls ~lines 219, 238)
- Modify: `portal/src/pages/StakeholderDetail.tsx` (worker Trade cell ~line 481, worker `ColumnMenu` ~line 815, `passesColumnFilters` ~line 459)
- Optionally add `export function workerCellValues(w: WorkerItem, colKey: string): string[] | null` to `portal/src/lib/workers.ts` (returns `splitTrades(w.trade)` for `'trade'`, else `null`) and use it on both pages.
- Test: create `src/pages/Workers.test.tsx` (no Workers page test exists yet; follow `StakeholderDetail.test.tsx`'s mock setup), `src/pages/StakeholderDetail.test.tsx`, `src/lib/workers.test.ts` (for `workerCellValues`)

**Interfaces:**
- Consumes: `splitTrades`, `TradeChips` (Task 1); `CellValues`, `cellValues` prop and argument (Task 2).

- [ ] **Step 1: Failing tests:**
  - Workers list: a worker with `trade: 'Cable, Hardware'` renders two `.chip.tag` chips `Cable` and `Hardware` in its row; a worker with `trade: null` shows `—` in the Trade cell.
  - Workers list: opening the Trade column menu lists `Cable` and `Hardware` separately; checking only `Hardware` (or applying a `trade: {values: ['Hardware']}` filter, whichever the existing tests use) keeps the `Cable, Hardware` worker visible.
  - Workers detail panel shows the trade as chips.
  - StakeholderDetail Workers tab: the fixture worker's trade (change the fixture at line 131 to `'Electrician, Cable'` or add a second worker) renders as two chips.
  - `workerCellValues` (if added): `'trade'` → split list; other keys → `null`.
- [ ] **Step 2:** `npx vitest run src/pages/Workers.test.tsx src/pages/StakeholderDetail.test.tsx src/lib/workers.test.ts` → FAIL.
- [ ] **Step 3:** Render `<TradeChips trade={w.trade} />` in the cells (drop the `cell-line` span for trade; chips wrap and the row grows); pass `cellValues` to the `ColumnMenu`s and to `passesColumnFilters` on both pages. Leave `sortValueFor`, CSV columns, search text and the god-edit field untouched.
- [ ] **Step 4:** Same command → PASS; `npx tsc -b` clean.
- [ ] **Step 5:** Commit `feat(workers): trade chips + per-trade filter on lists`.

### Task 4: Chips input in Edit profile, and chips on the remaining pages

**Files:**
- Modify: `portal/src/components/workers/ProfileForm.tsx`
- Modify: `portal/src/pages/Workers.tsx` (pass `tradeSuggestions` to its `ProfileForm`)
- Modify: `portal/src/pages/WorkerDetail.tsx` (header `pm-role` ~line 199, Profile panel ~line 245)
- Modify: `portal/src/components/users/UserProfileTab.tsx` (~line 167)
- Modify: `portal/src/pages/OrgDirectory.tsx` (~line 891)
- Test: create `portal/src/components/workers/ProfileForm.test.tsx`; update `src/pages/WorkerDetail.test.tsx`, `src/pages/UserDetail.test.tsx`, and create `src/pages/OrgDirectory.test.tsx` only for the picker sub-line if mocking the page is light; otherwise cover the sub-line by extracting it into a small rendered helper and testing that

**Interfaces:**
- Consumes: `splitTrades`, `TradeChips` (Task 1); `TagInput` (`components/TagInput.tsx`, free-text mode: `value`, `onChange`, `suggestions`, `placeholder`).
- Produces: `ProfileForm` gains optional prop `tradeSuggestions?: string[]`.

- [ ] **Step 1: Failing tests** in `ProfileForm.test.tsx` (mock `apiFetch` from `lib/api` and capture the PUT body):
  - seeded with `trade: 'Cable, Hardware'` shows two chips in the Trade box;
  - removing a chip and saving sends `trade: 'Hardware'`;
  - removing all chips and saving sends `trade: null`;
  - typing `Fiber` in the Trade box and clicking Save without Enter sends `trade: 'Cable, Hardware, Fiber'` (Review Focus 4);
  - a tag committed as `Cable, Fiber` (e.g. seeded via a paste/`fireEvent.change` then blur) on a worker with no trade saves `trade: 'Cable, Fiber'` — save sends `splitTrades(tags.join(',')).join(', ') || null` (Review Focus 5);
  - `tradeSuggestions={['Cable', 'Fiber']}` offers `Fiber` when typing `Fi`.

  Page tests: WorkerDetail with `trade: 'Cable, Hardware'` shows chips in the header and Profile panel, and `No trade set` in the header when `trade: null`; UserDetail's Worker profile table shows `Cabling` as a `.chip.tag`; OrgDirectory picker sub-line shows trade chips followed by the level, and `no profile` when both are empty.
- [ ] **Step 2:** `npx vitest run src/components/workers/ProfileForm.test.tsx src/pages/WorkerDetail.test.tsx src/pages/UserDetail.test.tsx` (plus the OrgDirectory test file) → FAIL.
- [ ] **Step 3:** Implement:
  - ProfileForm: label stays `Trade / specialty`; `TagInput` with `placeholder="Add a trade…"`, `suggestions={tradeSuggestions ?? []}`, `maxTags` large enough not to truncate an existing longer list (`Math.max(12, seeded.length)`).
  - Workers.tsx: `tradeSuggestions` = distinct `splitTrades` of all loaded workers' trades, naturalCompare-sorted.
  - WorkerDetail header: `<TradeChips trade={worker.trade} fallback="No trade set" />` then ` · {partner or 'Direct hire'}` on the same line (inline-flex, keep `pm-role` styling).
  - UserProfileTab cell, WorkerDetail Profile `dd`: `<TradeChips trade={...} />`.
  - OrgDirectory sub-line: chips then `· level`; `no profile` when both empty.
- [ ] **Step 4:** Same command → PASS; full portal suite `npx vitest run` and typecheck clean.
- [ ] **Step 5:** Commit `feat(workers): edit trades as chips; chips on worker, user and directory pages`.
