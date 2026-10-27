# Project Plans — Plan B: Portal Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The **Project plan** tab on the initiative detail page: empty state and creation, an MS Project-style task sheet with spreadsheet editing, the Gantt chart with drag interactions, the ribbon-lite toolbar and keyboard map, undo/redo, the dialogs (Task Information, Task Dependency, completion checks, Update project, Plan settings, lock, baseline, delete), filters and grouping.

**Architecture:** All data comes from Plan A's API; the portal never schedules. `lib/plans/` holds pure, tested modules (API client and types, duration/predecessor text, floating times, outline math, Gantt geometry, edit-op builders, paste parsing, filters). `components/plans/usePlan.ts` owns the plan state, op round-trips, undo/redo, conflicts and polling. Components render; they hold no scheduling logic.

**Tech Stack:** React 18, TypeScript, Vite, vitest (jsdom per file), @tanstack/react-virtual.

**Spec:** `docs/superpowers/specs/2026-10-27-project-plans-design.md`. **Depends on:** Plan A merged into this branch (API routes and shapes are defined there — read `api/src/serversherpa/plans/schemas.py` before Task 1).

## Global Constraints

- Worktree `/Users/jrh1812/Developer/BaseCampV3/.claude/worktrees/project-plans`; portal commands from `portal/`: `npx vitest run <path>`; full suite `npx vitest run` and `npm run build` (both foreground, 600000 ms).
- House idioms only (spec *Anti-goals*): `.dir-search`, `.org-select`, `.segmented` (`aria-pressed`, class `on`), `ComboBox` (single), `ChipPicker` (multi), `Switch`, `RowActionsMenu`, `useToast()` from `lib/notificationsContext`, `.pf-form`/`.pf-error`, buttons `btn-solid` / `mini-btn` / `btn-solid btn-danger`. No raw `<table>` (use CSS grid). Native `<input type="date">` / `datetime-local` only inside `.pf-form` or as the sheet's date editor.
- Every dialog uses `components/plans/PlanModal.tsx` (Task 3): eyebrow "Project plan", `h3` title, one-line `page-hint` description, sized to content (`width: fit-content` with `min(…)`/`max(96vw)` bounds), rounded corners, dropdowns portaled.
- CSS: `styles/plans.css` (toolbar, Gantt, dialogs, board) and `styles/plan-sheet.css` (sheet layout only), class prefix `pln-`. **Guardrails** (`styles/listTypography.test.ts`): a selector containing `row|cell|list|table|chip|mono|head|th|td|tr` (substring!) is "list-ish" and may not set `font-size|font-family|font-weight|line-height|min-height|font`; a `.pln-(row|rows|cell|cells|list|table|grid|feed)` selector taints *every* `.pln-*` selector in its file. So: all list-ish selectors live in `plan-sheet.css` and carry layout only (text styling comes from the golden classes `cell-top`, `cell-sub`, `mono` and the `--list-fs-*` tokens through those classes); `plans.css` must contain no list-ish selector (say `pln-bar`, `pln-link-path`, `pln-scale-top`, never `…row…`, `…head…`, `…arrow…`). No inline `fontSize/fontWeight/lineHeight/fontFamily`. Any `overflow: auto` + `border-radius` rule must join the list in `styles/chrome.css` or `NOT_IN_A_DIALOG` in `styles/roundedScrollbars.test.ts` with a reason. Any popup class (`menu|popover|dropdown|listbox|suggest`) used inside a modal must be portaled (`modalDropdowns.test.ts`).
- Floating plan times are strings `YYYY-MM-DDTHH:MM`. Parse and format them only through `lib/plans/floatingTime.ts` (UTC-naive; never `new Date(localString)` and never local-zone getters).
- Tests mock modules with `vi.hoisted` + `vi.mock` (see `components/learning/InitiativeLearningTab.test.tsx:20-58`); each component test file starts with `// @vitest-environment jsdom`. `pages/InitiativeDetail.test.tsx` must mock `lib/plans/api`.
- American English; MS Project vocabulary in labels (Task Name, Duration, Start, Finish, Predecessors, Resource Names, % Complete, Deadline, Indent, Outdent, Mark on Track, Task Information…).
- **Look at it.** Every UI task ends with a live check: the worktree dev servers (see Task 11 Step 1 for the recipe) and a screenshot reviewed before the commit; passing tests is not the UI bar.
- Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Edit, then op fails** — an edit the API rejects (bad duration, cycle, locked plan) must leave the cell showing the old value with the error next to it, not a phantom new value. (Task 2, Task 6)
2. **Someone else changed the plan mid-edit** — a 409 `plan_changed` on a structural edit reloads the plan, clears undo, says so in a toast, and never applies the stale edit on top. (Task 2)
3. **Typing into a cell vs. shortcuts** — `Delete`, `Insert`, arrows and `Alt+Shift+→` must act on the sheet only when no cell editor, input or dialog has focus; inside an editor they type. (Task 7)
4. **Floating times in a non-Eastern browser** — a plan in America/Chicago viewed from a browser in UTC+9 shows the same wall-clock dates as the API sends. (Task 1)
5. **Large plans** — 1,500 tasks scroll smoothly with the sheet and the Gantt in lockstep, and collapsing a summary hides its rows in both. (Task 5, Task 8)

---

### Task 1: `lib/plans` core — API client, text helpers, floating time, outline math

**Files:**
- Create: `portal/src/lib/plans/api.ts`, `durations.ts`, `predecessors.ts`, `floatingTime.ts`, `outline.ts`, `errors.ts`
- Test: `portal/src/lib/plans/durations.test.ts`, `predecessors.test.ts`, `floatingTime.test.ts`, `outline.test.ts`, `api.test.ts`

**Interfaces:**
- Consumes: Plan A's API (`plans/schemas.py`) and the shared vectors `api/tests/fixtures/plans/durations.json` and `predecessors.json` (read in tests with `fs.readFileSync(path.resolve(__dirname, '../../../../api/tests/fixtures/plans/durations.json'), 'utf8')`).
- Produces:
  - `api.ts` — types mirroring the API exactly: `Plan`, `PlanTask`, `PlanLink`, `PlanResource`, `Op` (discriminated union of every op name in Plan A), `OpsResult`, `PlanPatch`, `CompletionBlocker`; functions `getPlan(initiativeId)`, `createPlan(initiativeId, body)`, `deletePlan(initiativeId)`, `postOps(planId, baseVersion, ops)`, `patchPlan(planId, patch)`, `lockPlan(planId)`, `unlockPlan(planId)`, `setBaseline(planId, replace)`, `clearBaseline(planId)`, `updateProject(planId, body)`, `getPlanVersion(planId)` — the private `send/get` shape of `lib/learning.ts:36-49` over `apiFetch`/`errorFrom` (`lib/api.ts`).
  - `durations.ts` — `Units`, `unitsOf(calendar)`, `parseDuration(text, units)`, `parseLag(text, units)`, `formatDuration(minutes, unit, elapsed, units)`, `formatLag(...)`, `DurationError` — behavior identical to Plan A Task 2 (same vectors).
  - `predecessors.ts` — `parsePredecessors(text, units, validIds: Set<number>, selfId: number | null)`, `formatPredecessors(specs, units)` — identical to Plan A Task 7.
  - `floatingTime.ts` — `toMs(s: string): number` (`Date.UTC` of the parts), `fromMs(ms: number): string`, `formatDay(s)` → `Mon 11/2/26`, `formatDayTime(s)` → `Mon 11/2/26 8:00 AM`, `formatCell(s, showTimes)`, `toDateInput(s)` / `toDateTimeInput(s)` / `fromDateInput(v)` (date-only stays `YYYY-MM-DD` so the API applies the calendar's default time), `dayOf(s)`; every getter is `getUTC*`.
  - `outline.ts` — `computeOutline(tasks: PlanTask[], order: string[], links: PlanLink[], units) -> Map<id, {displayId, wbs, level, isSummary, predecessors, successors}>`, `visibleRows(order, tasksById, collapsed: Set<string>) -> string[]`, `descendants(id, tasks)`, `ancestors(id, tasksById)`.
  - `errors.ts` — `PLAN_ERRORS: Record<code, string>` (one plain sentence per API code: `plan_changed`, `plan_locked`, `link_cycle`, `link_to_outline`, `bad_summary_link`, `bad_summary_constraint`, `bad_duration`, `bad_predecessor`, `bad_link`, `duplicate_link`, `bad_resource`, `summary_field`, `cannot_indent`, `cannot_outdent`, `bad_calendar`, `bad_timezone`, `baseline_exists`, `no_plan`, `plan_exists`, `unknown_task`, `forbidden`) and `planErrorText(err)` via `apiErrorText` (`lib/learningDoc.ts:79`); `link_cycle` text names the display IDs ("Tasks 2 and 5 would depend on each other").

- [ ] **Step 1: Failing tests** — durations/predecessors: every vector row from both JSON files (parse, invalid, lag, format). floatingTime: `toMs("2026-11-02T08:00") === Date.UTC(2026,10,2,8,0)`; `formatDay("2026-11-02T08:00") === "Mon 11/2/26"`; `formatDayTime("2026-11-02T13:30") === "Mon 11/2/26 1:30 PM"`; with `process.env.TZ = 'Asia/Tokyo'` set before import (restore with `if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev`), `formatDay("2026-11-02T00:00")` is still `"Mon 11/2/26"` (Review Focus 4). outline: a 6-task fixture (two summaries, one nested) → display IDs 1–6, WBS `1`, `1.1`, `1.2`, `2`, `2.1`, `2.1.1`; predecessors text `"2FS+2 days"` for an FS+960 link; successors text; `visibleRows` with the first summary collapsed hides its two children. api: `postOps` sends `{base_version, ops}` to `/plans/p1/ops` and throws an `ApiError` whose `code` is `plan_changed` on a 409.
- [ ] **Step 2: Run** `npx vitest run src/lib/plans` → FAIL.
- [ ] **Step 3: Implement** the six modules.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plans-portal): lib/plans core`.

### Task 2: `usePlan` — state, ops, undo/redo, conflicts, polling

**Files:**
- Create: `portal/src/components/plans/usePlan.ts`, `portal/src/lib/plans/undo.ts`
- Test: `portal/src/components/plans/usePlan.test.tsx`, `portal/src/lib/plans/undo.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces:
  - `undo.ts` — `class UndoStack { constructor(limit = 20); push(inverse: Op[], label: string); undo(): Entry | null; redo(): Entry | null; clear(); canUndo; canRedo }` where applying an entry's ops returns a new inverse that becomes the redo (or undo) entry.
  - `usePlan(initiativeId: string) -> PlanController`:
    ```ts
    interface PlanController {
      status: 'loading' | 'none' | 'ready' | 'error';
      plan: Plan | null;                 // tasks/links merged after every op
      outline: ReturnType<typeof computeOutline>;
      error: string;                     // load error text
      busy: boolean;
      apply(ops: Op[], label: string, opts?: { confirm?: boolean }): Promise<ApplyResult>;
      undo(): Promise<void>; redo(): Promise<void>; canUndo: boolean; canRedo: boolean;
      patch(p: PlanPatch): Promise<void>; lock(): Promise<void>; unlock(): Promise<void>;
      setBaseline(replace: boolean): Promise<ApplyResult>; clearBaseline(): Promise<void>;
      updateProject(body: { status_date: string | null; complete_through?: string | null; confirm?: boolean }): Promise<ApplyResult>;
      create(body: { project_start: string; template_id?: string }): Promise<void>;
      remove(): Promise<void>; reload(): Promise<void>;
      setEditing(on: boolean): void;     // defers polling refreshes
      staleBy: string | null;            // "Plan updated by <name>" while a refresh waits
    }
    type ApplyResult =
      | { ok: true; notices: Notice[] }
      | { ok: false; kind: 'confirm'; willComplete: CompletionBlocker[]; openPredecessors: CompletionBlocker[] }
      | { ok: false; kind: 'blocked'; blockers: CompletionBlocker[] }
      | { ok: false; kind: 'error'; message: string; code: string; taskIds?: string[] };
    ```
  - Rules: merge `OpsOut` (replace changed tasks/links by id, drop deleted, take `order` when present, recompute `outline`); push `inverse` on the undo stack (undo/redo applies those ops and swaps); a 409 `plan_changed` → `reload()`, clear the stack, toast "This plan was changed by someone else — reloaded." and return `kind: 'error'`; `completion_confirm` / `completion_blocked` map to their kinds; any other error returns `kind: 'error'` with `planErrorText` and leaves state untouched. Progress-only batches (Plan A's `is_progress_only` set, mirrored as `isProgressOnly(ops)` in `api.ts`) still send `base_version`. Polling: every 30 s while `document.visibilityState === 'visible'`, `getPlanVersion`; a higher version reloads at once unless `setEditing(true)` is in force, in which case `staleBy` is set and the reload waits until editing ends.

- [ ] **Step 1: Failing tests** (`api` mocked): `undo.test.ts` — limit 20 drops the oldest; undo then redo round-trips; `push` clears redo. `usePlan.test.tsx` (`renderHook`): loads → `ready`; 404 `no_plan` → `none`; `apply` merges a changed task and an `order`; `apply` pushes the inverse and `undo()` posts it; 409 `plan_changed` → reload called, `canUndo === false`, toast called (Review Focus 2); 409 `completion_confirm` → `{kind:'confirm'}` and state unchanged; a 422 → `{kind:'error'}` and state unchanged (Review Focus 1); fake timers: version probe higher → reload; with `setEditing(true)` → no reload, `staleBy` set; after `setEditing(false)` → reload.
- [ ] **Step 2: Run** `npx vitest run src/components/plans/usePlan.test.tsx src/lib/plans/undo.test.ts` → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plans-portal): plan state hook with undo and conflict handling`.

### Task 3: The tab — gating, empty state, create, full screen, lock banner

**Files:**
- Create: `portal/src/components/plans/PlanTab.tsx`, `PlanModal.tsx`, `PlanCreateModal.tsx`, `PlanEmptyState.tsx`, `portal/src/styles/plans.css`
- Modify: `portal/src/pages/InitiativeDetail.tsx` (`DETAIL_TABS` gains `{ key: 'plan', label: 'Project plan' }` after `full`; filter it out unless `can('project_plans', 'view')`; render `<div className="idet-plan"><PlanTab initiativeId={initiative.id} initiative={initiative} /></div>` for `tab === 'plan'`; the panel spans the full grid width)
- Test: `portal/src/components/plans/PlanTab.test.tsx`; modify `portal/src/pages/InitiativeDetail.test.tsx`

**Interfaces:**
- Consumes: `usePlan` (Task 2).
- Produces: `PlanModal` — same props and markup as `components/learning/LearningModal.tsx` with class `pln-modal` and a `size?: 'normal' | 'wide' | 'xwide'` prop (`min(720px, 96vw)`, `min(980px, 96vw)`, `min(1200px, 96vw)`). `PlanTab` props `{ initiativeId: string; initiative: { name: string; scheduled_start: string | null; scheduled_end: string | null } }`; it renders the toolbar slot, view area and dialogs host for later tasks. URL state: `?tab=plan&view=gantt|calendar|board&task=<id>` read with `useSearchParams` (view defaults to `gantt`; Plan C adds the other two — until then the switcher shows Gantt only).

- [ ] **Step 1: Failing tests.** InitiativeDetail: with `can('project_plans','view')` false the tab is absent and `?tab=plan` falls back to Overview; with it true the "Project plan" tab renders `PlanTab`. PlanTab (`usePlan` mocked or `api` mocked): `none` + `project_plans:add` → "No project plan yet" with three choice cards *Blank plan*, *From a template*, *Import from MS Project or Excel* (the last two disabled with the hint "Coming soon" until Plan C — Plan C removes the hint); without `add` → message only; *Blank plan* → PlanCreateModal with a date input defaulting to today (plan-local is unknown before creation: use the browser's today) → Create calls `create({project_start: 'YYYY-MM-DD'})`; `ready` + `locked_at` → banner "Schedule locked by <name> on <date> — progress updates only" with an Unlock button only when `permissions.change`; Full screen button toggles class `pln-fullscreen` on the tab root and Escape leaves it.
- [ ] **Step 2: Run** `npx vitest run src/components/plans/PlanTab.test.tsx src/pages/InitiativeDetail.test.tsx` → FAIL.
- [ ] **Step 3: Implement.** Empty-state cards reuse the `ChoiceCard` piece from `components/reports/ReportOptionsLayout.tsx`. Full screen = `position: fixed; inset: 0` inside `.portal-shell` with `z-index` above the nav and the page background token.
- [ ] **Step 4: Run** → PASS. **Live check:** create a plan on the NAP11 demo initiative; screenshot the empty state and the created (empty) plan.
- [ ] **Step 5: Commit** `feat(plans-portal): project plan tab, empty state and creation`.

### Task 4: Gantt geometry (pure)

**Files:**
- Create: `portal/src/lib/plans/ganttGeometry.ts`, `portal/src/lib/plans/calendarShade.ts`
- Test: `portal/src/lib/plans/ganttGeometry.test.ts`, `calendarShade.test.ts`

**Interfaces:**
- Produces:
  - `type Zoom = 'hours' | 'days' | 'weeks' | 'months' | 'quarters'`; `ZOOM_PX_PER_DAY: Record<Zoom, number> = { hours: 480, days: 48, weeks: 18, months: 5, quarters: 1.8 }`; `zoomIn(z)`, `zoomOut(z)`.
  - `interface Scale { startMs: number; endMs: number; pxPerMs: number; width: number }`; `makeScale(projectStart: string, projectFinish: string, zoom: Zoom): Scale` (pads two units before the start and four after the finish, snapped to the bottom tier's unit); `fitZoom(projectStart, projectFinish, widthPx): Zoom` (largest zoom whose width ≤ widthPx, else `quarters`); `xOf(scale, s: string): number`.
  - `tiers(scale, zoom): { top: Tick[]; bottom: Tick[] }` with `Tick { x, width, label }` — hours: days over hours (`Mon 11/2` / `8`), days: weeks over days (`Nov 2, '26` / `M T W…`), weeks: months over weeks (`November 2026` / `11/2`), months: quarters over months (`Q4 2026` / `Nov`), quarters: years over quarters (`2026` / `Q4`).
  - `barOf(scale, task): { x, width }` (milestone width 0); `progressWidth(bar, percent)`; `baselineOf(scale, task) | null`.
  - `linkPath(from: {x0, x1, y}, to: {x0, x1, y}, type: LinkType, rowH: number): string` — right-angle SVG path from the predecessor's end (FS/FF) or start (SS/SF) to the successor's start (FS/SS) or end (FF/SF), with an 8px stub and a detour below the predecessor row when the successor begins left of the stub.
  - `calendarShade.ts`: `nonworkingBands(calendar, scale): { x, width }[]` — whole nonworking days (weekday pattern empty or exception with `hours: []`) for `days`/`hours` zoom; `[]` for coarser zooms.
- [ ] **Step 1: Failing tests** — `makeScale` for 11-02 → 11-06 at `days` starts at 2026-10-31 00:00 (two days before, day-snapped); `xOf(scale, "2026-11-02T00:00") === 96` and `xOf(scale, "2026-11-02T08:00") === 112`; `barOf` for a 5-day task 11-02 08:00 → 11-06 17:00 at `days` has `width === (4 × 24 + 9) / 24 × 48`; milestone width 0; `fitZoom` picks `days` for a 2-week plan in 1,000px and `quarters` for a 3-year plan; `tiers` labels at `weeks` begin `November 2026` / `11/2`; `linkPath` FS forward is `M x1 y H x1+8 V y2 H x0'` shaped (assert the exact string for one fixture) and the backward detour has 5 segments; `nonworkingBands` returns Sat+Sun for one week at `days` and nothing at `months`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(plans-portal): gantt geometry`.

### Task 5: Task sheet — display

**Files:**
- Create: `portal/src/components/plans/PlanSheet.tsx`, `portal/src/lib/plans/columns.ts`, `portal/src/components/plans/ColumnsModal.tsx`, `portal/src/styles/plan-sheet.css`
- Modify: `portal/src/components/plans/PlanTab.tsx` (render the sheet in the Gantt view's left pane)
- Test: `portal/src/components/plans/PlanSheet.test.tsx`, `portal/src/lib/plans/columns.test.ts`

**Interfaces:**
- Produces:
  - `columns.ts` — `interface PlanColumn { key: string; label: string; width: number; min: number; align: 'start'|'end'|'center'; defaultVisible: boolean; editor: 'text'|'duration'|'date'|'datetime'|'predecessors'|'resources'|'percent'|'select'|'none'; options?: {value,label}[]; value(task, row): string }`; `PLAN_COLUMNS` with the spec's default and optional columns in MS Project order (keys: `indicators, id, mode, name, duration, start, finish, predecessors, resources, percent, deadline, wbs, successors, slack, critical, status, constraint_type, constraint_date, actual_start, actual_finish, baseline_start, baseline_finish, baseline_duration, start_variance, finish_variance, notes, created, updated`); `loadColumnPrefs()` / `saveColumnPrefs()` in localStorage `plans.columns.v1` (`{visible: string[], widths: Record<string, number>}`; unknown keys dropped, new default columns surfaced like `usePersistentListState`'s `seen` rule).
  - `PlanSheet` props `{ ctl: PlanController; rows: string[]; rowHeight: number; scrollRef: RefObject<HTMLDivElement>; selection: Selection; onSelect(...): void; onToggleCollapse(id): void; editable: boolean }` — a CSS-grid sheet (`role="grid"`, `aria-rowcount`), header row with resizable column borders, rows virtualized with `useVirtualizer({ count, getScrollElement: () => scrollRef.current, estimateSize: () => rowHeight, overscan: 20 })`. The Gantt (Task 8) shares `scrollRef` so both panes scroll together.
  - Cells: Task Name indented `level × 16px`, summaries bold (via the golden `cell-top` weight) with a chevron button; indicators column shows icons with `title` tooltips (note, constraint type + date, missed deadline, conflict, complete, locked); `%` renders as text; Resource Names as comma-joined names; dates through `formatCell(s, plan.settings.show_times)`.
  - Collapse state per plan in localStorage `plans.collapsed.<planId>`.
  - Deep link: when the URL carries `&task=<id>` (reminder emails use it), expand that task's collapsed ancestors, select its row and scroll it into view once after load; an unknown id is ignored.
  - `ColumnsModal`: `Switch` per column, Move up / Move down buttons, Reset to default.
- [ ] **Step 1: Failing tests** — renders the default columns' headers in order; a summary row shows a chevron and clicking it hides its children (both from DOM and `rows`); a constraint indicator carries `title` "Start No Earlier Than Thu 11/5/26"; `ColumnsModal` hiding `predecessors` removes the column and persists; the `columns.test.ts` fixture of prefs with an unknown key drops it; `?task=<id of a task under a collapsed summary>` expands the summary and marks the row selected; a 1,500-task fixture renders fewer than 80 row elements (virtualized; Review Focus 5).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS, plus `npx vitest run src/styles` (guardrails). **Live check** with a seeded 40-task plan; screenshot.
- [ ] **Step 5: Commit** `feat(plans-portal): task sheet display`.

### Task 6: Task sheet — editing

**Files:**
- Create: `portal/src/lib/plans/editOps.ts`, `portal/src/components/plans/CellEditor.tsx`, `portal/src/components/plans/ResourcePicker.tsx`
- Modify: `PlanSheet.tsx`
- Test: `portal/src/lib/plans/editOps.test.ts`, `portal/src/components/plans/PlanSheet.edit.test.tsx`

**Interfaces:**
- Produces:
  - `editOps.ts` — `opsForCell(task: PlanTask | null, column: PlanColumn, text: string, ctx: { units; validIds; displayIdOf; tempId(): string; appendParentId: string | null }): { ops: Op[] } | { error: string }` — validates locally first (duration/predecessor parse errors return `{error}` without a request); a `null` task (the blank row) yields `add_task` with the typed field; name → `update_task.fields.name`; duration → `fields.duration`; start/finish/deadline/constraint_date → the date string (date-only stays date-only); predecessors → `fields.predecessors`; percent → `set_percent`; mode/constraint_type → select values; resources → `set_assignees`.
  - Selection model `type Selection = { active: { id: string | 'blank'; col: string } | null; rows: Set<string>; anchor: string | null }` and `moveActive(sel, dir, rows, cols)`.
  - Behavior: click selects a cell; typing a printable key opens the editor seeded with that key; F2 or double-click opens it with the current value; Enter commits and moves down; Tab / Shift+Tab commit and move right/left; Esc cancels; arrows move when not editing. While an editor is open `ctl.setEditing(true)`. A rejected commit (`{error}` locally or `kind: 'error'` from `apply`) keeps the editor open with the old value restorable and shows the message in `.pf-error` under the cell (Review Focus 1). `kind: 'confirm'|'blocked'` from a % edit opens the CompletionDialog (Task 10 provides it; until then, a toast with the message). Row-number clicks select rows; Shift extends, Ctrl/⌘ toggles. Notices `constraint_added` show a toast "Start No Earlier Than constraint added" with an Undo action that calls `ctl.undo()`.
  - Editors: text input `.org-select`; date `<input type="date">` (or `datetime-local` when `show_times`); select columns use `ComboBox portal`; resources use `ResourcePicker` (a portaled `ChipPicker` popover listing `plan.resources` grouped Team / Staff / Partners; people with `!has_email && !has_account` carry the note "won't get reminders").
  - Read-only plans (`!permissions.change`) never open editors; locked plans open editors only for `percent`, `actual_start`, `actual_finish`, `notes`.
- [ ] **Step 1: Failing tests** — `editOps`: `"abc"` duration → `{error}`; `"3FS+2d"` predecessors → `update_task` with that text; blank row name → `add_task` with `parent_id` null; `%` 100 → `set_percent`. Sheet: typing `5d⏎` in Duration posts one op and moves the active cell down; a 422 response keeps the editor open with the error text and the cell's old value; Esc restores without a request; locked plan: Duration editor does not open, % does; Tab moves right.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Live check:** build a 10-task plan purely from the keyboard; screenshot.
- [ ] **Step 5: Commit** `feat(plans-portal): spreadsheet editing in the task sheet`.

### Task 7: Toolbar, keyboard map, commands, copy and paste

**Files:**
- Create: `portal/src/components/plans/PlanToolbar.tsx`, `portal/src/lib/plans/commands.ts`, `portal/src/components/plans/usePlanShortcuts.ts`, `portal/src/components/plans/ShortcutsModal.tsx`, `portal/src/lib/plans/paste.ts`
- Test: `portal/src/lib/plans/commands.test.ts`, `paste.test.ts`, `portal/src/components/plans/usePlanShortcuts.test.tsx`, `PlanToolbar.test.tsx`

**Interfaces:**
- Produces:
  - `commands.ts` — pure builders returning `Op[]` (or `{error}`): `insertTask(sel, kind: 'task'|'milestone'|'summary')` (summary = a new task plus a child, indented), `deleteSelected`, `indentSelected`, `outdentSelected`, `linkSelected` (FS in selection order, skipping pairs that already exist), `unlinkSelected` (every link among the selected tasks), `setPercent(sel, n)`, `markOnTrack`, `setMode(sel, mode)`, `toggleTimeline(sel)`.
  - `PlanToolbar` — the spec's groups, in order, each a labeled cluster of icon buttons with `title` = name + shortcut: Undo/Redo · Schedule (0% 25% 50% 75% 100%, Mark on Track, Link, Unlink, Indent, Outdent) · Tasks (Auto Schedule / Manually Schedule as a `.segmented` pair reflecting the selection) · Insert (Task, Summary, Milestone) · Properties (Information, Notes, Add to Timeline) · Display (Critical path, Baseline, Zoom −/+/Fit, Scroll to task; Timeline strip arrives in Plan C) · More (`RowActionsMenu`: Set baseline…, Clear baseline, Update project…, Lock schedule / Unlock, Plan settings…, Columns…, Keyboard shortcuts, Delete plan… — Plan C adds Save as template…, Import…, Export ▸, Print…). Read-only users see Display only. Locked plans disable structure buttons with the hint "Schedule is locked".
  - `usePlanShortcuts(handlers, { enabled })` — a capture-phase `keydown` listener on the tab root modeled on `components/labels/builder/useBuilderShortcuts.ts` (`isTypingTarget`, `ownsKeys`); skips when a dialog (`.modal-scrim`) is open or an editor/input has focus (Review Focus 3). Map (⌘ for Ctrl, ⌥ for Alt on Mac): Insert, Delete, Alt+Shift+→/←, Ctrl+F2, Ctrl+Shift+F2, Shift+F2, Ctrl+Z, Ctrl+Y and Ctrl+Shift+Z, Ctrl+Shift+F5, Alt+Shift+− / +, Ctrl+F (focus search, Task 11), `?`, Ctrl+C / X / V.
  - `ShortcutsModal` — the map as a two-column grid (Windows / Mac).
  - `paste.ts` — `parseClipboard(text): string[][]` (tab/newline separated; strips a trailing empty line; handles quoted cells with embedded tabs/newlines as Excel writes them); `opsForPaste(grid, activeCell, visibleColumns, rows, ctx) -> Op[] | {error}` — fills cells from the active cell across the visible columns, creates tasks for rows past the end. Copy writes TSV of the selected rows' visible columns to the clipboard and keeps an internal copy of the tasks; paste of an internal copy re-creates the tasks with their durations and the links among them; Cut = copy + delete.
- [ ] **Step 1: Failing tests** — commands: `linkSelected([A,B,C])` → `add_link A→B`, `add_link B→C`; `indentSelected` on the first row → `{error: PLAN_ERRORS.cannot_indent}`; paste: Excel TSV with a quoted multi-line cell parses to the right grid; 3×2 paste starting at Name on the last row → 2 `update_task` + 2 `add_task`; shortcuts: Alt+Shift+ArrowRight with a row selected calls `indent`; the same key with focus in an `<input>` does nothing; `Delete` with the ColumnsModal open does nothing; toolbar: read-only hides Schedule/Insert; locked disables Indent with the hint.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Live check:** paste 10 rows copied from a real `.xlsx` opened in Numbers/Excel; screenshot the toolbar.
- [ ] **Step 5: Commit** `feat(plans-portal): toolbar, MS Project shortcuts, copy and paste`.

### Task 8: Gantt chart — rendering

**Files:**
- Create: `portal/src/components/plans/PlanGantt.tsx`, `portal/src/components/plans/GanttHoverCard.tsx`, `portal/src/components/plans/Splitter.tsx`
- Modify: `PlanTab.tsx` (split view: sheet | splitter | Gantt; split position persisted in localStorage `plans.split.v1`), `styles/plans.css`
- Test: `portal/src/components/plans/PlanGantt.test.tsx`

**Interfaces:**
- Consumes: Task 4 geometry, Task 5's `rows`/`rowHeight`/`scrollRef`.
- Produces: `PlanGantt` props `{ ctl; rows: string[]; rowHeight: number; scrollRef; zoom: Zoom; display: { critical: boolean; baseline: boolean }; selection; onSelect; editable }`. Two-tier timescale header (sticky); body rows virtualized with the same virtualizer settings as the sheet; bars as absolutely positioned `div`s: task `pln-bar` (accent), progress fill, summary bracket `pln-bar-summary`, milestone diamond `pln-diamond` with its date label, critical `pln-bar-critical` (`--c-red`) when `display.critical`, baseline `pln-baseline` under the bar when `display.baseline`, deadline marker `pln-deadline` (down-arrow glyph, `--c-green`), resource names right of the bar; nonworking shading; today line, status-date line (when set), and the initiative window band labeled "Scheduled: Nov 14–16"; link paths in one absolutely positioned `<svg>` per visible window (only links whose ends are both within the rendered rows ± overscan). Zoom state (`days` default; Fit computes `fitZoom` from the pane width) persisted per plan in localStorage `plans.zoom.<planId>`. Hover card: pointer-tracking like `InitiativeHoverCard` (180ms intent, portaled, `pointer-events: none`), class prefix `pln-hover`; content name, start, finish, duration, %, assignees, deadline, slack.
- [ ] **Step 1: Failing tests** — a 3-task fixture with an FS link renders three `pln-bar`, one `<path>`, a diamond for the milestone; `display.critical` toggles `pln-bar-critical` only on critical tasks; collapsing a summary in the sheet removes its children's bars too (shared `rows`; Review Focus 5); the window band label reads "Scheduled: Nov 14–16" for a 2026-11-14 → 2026-11-16 initiative.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Live check** at 1512px and 1280px widths, critical path and baseline on; screenshot.
- [ ] **Step 5: Commit** `feat(plans-portal): gantt chart rendering`.

### Task 9: Gantt chart — interactions

**Files:**
- Create: `portal/src/lib/plans/drag.ts`, `portal/src/components/plans/TaskDependencyModal.tsx`
- Modify: `PlanGantt.tsx`
- Test: `portal/src/lib/plans/drag.test.ts`, `portal/src/components/plans/PlanGantt.drag.test.tsx`

**Interfaces:**
- Produces: `drag.ts` — `dragKind(pointerX, bar): 'move'|'resize'|'progress'|'link'` (right 6px = resize, a progress handle at the progress edge = progress, a link handle dot right of the bar = link, else move); `snapMs(ms, zoom)` (hours → 15 min, days → 1 h, weeks → 1 day, coarser → 1 day); `opsForDrag(kind, task, deltaMs | targetTaskId, units) -> Op[]` — move → `update_task.fields.start` (the API adds SNET), resize → `fields.duration` (text in the task's display unit, at least 1 minute), progress → `set_percent` (rounded to 5%), link → `add_link {predecessor_id, successor_id, link_type: 'FS'}`. A live ghost bar and a tooltip with the new date/duration show during the drag; nothing is sent until pointer-up; Esc cancels. Double-click a bar → Task Information (Task 10; until then nothing). Clicking a link path opens `TaskDependencyModal` (From/To names, Type select FS/SS/FF/SF, Lag text, Delete, OK). Locked or read-only: only progress drag (locked + change) or nothing (read-only).
- [ ] **Step 1: Failing tests** — `dragKind` zones; `snapMs`; `opsForDrag('resize', 2d task, +1 day at days zoom)` → duration `"3 days"`; Gantt: pointerdown/move/up on a bar posts one `update_task` with the snapped start; a drag from the link handle onto another bar posts `add_link`; TaskDependencyModal changes type to SS and posts `update_link`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Live check** (drag a bar, link two bars, edit a link); screenshot.
- [ ] **Step 5: Commit** `feat(plans-portal): gantt drag, link and dependency editing`.

### Task 10: Dialogs — Task Information, completion, Update project, baseline, lock, settings, delete

**Files:**
- Create: `portal/src/components/plans/TaskInfoModal.tsx`, `CompletionDialog.tsx`, `UpdateProjectModal.tsx`, `PlanSettingsModal.tsx`, `CalendarEditor.tsx`, `DeletePlanModal.tsx`, `portal/src/lib/plans/settingsForm.ts`
- Modify: `PlanTab.tsx`, `PlanSheet.tsx` (Shift+F2 / double-click), `PlanGantt.tsx` (double-click)
- Test: `TaskInfoModal.test.tsx`, `CompletionDialog.test.tsx`, `PlanSettingsModal.test.tsx`, `UpdateProjectModal.test.tsx`, `portal/src/lib/plans/settingsForm.test.ts`

**Interfaces:**
- Produces:
  - `TaskInfoModal` (size `wide`) — `.segmented` tabs General / Predecessors / Resources / Advanced / Notes (spec *Dialogs*); OK sends one batch with every changed field (`update_task` + link ops + `set_assignees`), Cancel discards. Predecessors tab: a grid of ID, Task Name (ComboBox over the plan's tasks), Type, Lag; add/remove rows. Summary tasks show derived fields read-only.
  - `CompletionDialog` — props `{ result: ApplyResult & {ok:false; kind:'confirm'|'blocked'}; onConfirm(): void; onGoTo(taskId): void; onClose(): void }`. Confirm: "Completing this will also complete N subtasks" list + open predecessors list, buttons "Complete" / Cancel. Blocked: "These need to be complete first" list with a "Go to task" per row, single Close. Every 100% path (sheet %, toolbar 100%, Gantt progress drag, Update project, Board in Plan C) routes through `useCompletion(ctl)` → `{ run(ops, label): Promise<void>, dialog: ReactNode }`, which resends with `confirm: true`.
  - `UpdateProjectModal` — status date (date input, default today in plan time via `plan.now`), "Update work as complete through" (Switch + date), Update.
  - Baseline: More › Set baseline… → `setBaseline(false)`; on 409 `baseline_exists` a confirm "Replace the baseline set on <date>?" → `setBaseline(true)`. Clear baseline asks first.
  - Lock: More › Lock schedule… confirm modal ("Only progress can be updated until someone unlocks it."); banner Unlock button.
  - `PlanSettingsModal` (size `xwide`) — `.segmented` sections General / Calendar / Completion rules / Reminders. General: project start, owner (ComboBox of staff resources), timezone (ComboBox of all IANA zones via `timezoneOptions()` from `lib/notifications.ts`), status date (blank = now), show times, default task mode, default duration, honor constraints, critical slack (days). Completion/Reminders: each field has a "Use system default (<value>)" Switch; turning it off reveals the control. `settingsForm.ts`: `toForm(plan)`, `toPatch(form, plan) -> PlanPatch` (only changed keys; inherited fields send `null`), `validate(form) -> Record<field, message>`.
  - `CalendarEditor` — the week pattern as seven rows (weekday name, Working Switch, up to two hour ranges as time inputs) plus an exceptions list (date, name, Nonworking Switch or hours) with Add/Remove; hours-per-day/week and days-per-month numbers; default start/end times.
  - `DeletePlanModal` — type the initiative name to enable Delete (`btn-solid btn-danger`).
- [ ] **Step 1: Failing tests** — TaskInfo: editing name + adding a predecessor row sends one batch with `update_task` and `add_link`; summary hides Duration editing. CompletionDialog: confirm lists two subtasks and Complete calls `onConfirm`; blocked shows Go to task. `useCompletion`: a `confirm` result then OK → the same ops resent with `confirm: true`. settingsForm: turning "Use system default" back on for predecessors yields `settings: {completion: {predecessors: null}}`; an empty calendar week fails validation with "At least one working day is needed". UpdateProject posts `complete_through` only when its Switch is on.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS. **Live check** each dialog; screenshot Task Information and Plan settings › Calendar.
- [ ] **Step 5: Commit** `feat(plans-portal): task information, completion checks and plan dialogs`.

### Task 11: Filters, search, group by — and the Plan B live pass

**Files:**
- Create: `portal/src/lib/plans/filters.ts`, `portal/src/components/plans/PlanFilterBar.tsx`
- Modify: `PlanTab.tsx`, `PlanSheet.tsx`, `PlanGantt.tsx`
- Test: `portal/src/lib/plans/filters.test.ts`, `portal/src/components/plans/PlanFilterBar.test.tsx`

**Interfaces:**
- Produces: `filters.ts` — `type PlanFilter = 'all'|'incomplete'|'late'|'critical'|'milestones'|'due_week'|'mine'|'summary'`; `filterRows(order, tasksById, filter, search, me: string, nowS: string) -> { rows: string[]; context: Set<string> }` (matching tasks plus their ancestors as dimmed, inert context rows — the initiatives-tree rule; search matches name, notes and assignee names case-insensitively); `groupRows(rows, tasksById, by: 'none'|'assignee'|'status') -> Array<{ key, label, rows }>` (grouping shows leaves only under group bands; "Unassigned" last). `PlanFilterBar`: Filter `.org-select`-styled `ComboBox`, `.dir-search`, Group by `ComboBox` (Gantt only); persisted per plan in localStorage `plans.view.<planId>`. Ctrl+F focuses the search box.
- [ ] **Step 1: Failing tests** — `late` keeps an incomplete task whose finish is before `nowS` and its parent as context; `mine` matches the signed-in person's assignments; search "crate" finds a task by its notes; `groupRows` by assignee lists a two-assignee task under both people.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Live pass of Plan B.** Never migrate the shared dev DB (the main checkout's stack runs on it at 0109). Clone it instead: `createdb serversherpa_plans_dev` and `pg_dump -Fc <dev db> | pg_restore -d serversherpa_plans_dev` (connection details from the root `.env` `SS_DATABASE_URL`), then `alembic upgrade head` from the worktree `api/` with `PYTHONPATH=src` and `SS_DATABASE_URL` pointing at the clone. Start worktree servers detached (the desktop app reaps preview servers): from the worktree root, `SS_DATABASE_URL=<clone url> PYTHONPATH=$PWD/api/src nohup api/.venv/bin/python -m uvicorn --factory serversherpa.api.app:create_app --app-dir api/src --port 8011 > .devlogs/api-8011.log 2>&1 &`; portal `VITE_API_URL=http://localhost:8011 npx vite --port 5185 --strictPort` from `portal/` (check `portal/vite.config.ts` / `lib/siblingOrigin.ts` for the variable the portal actually reads and use that). Sign in as claude-dev (recipe in the dev-workflow notes). Build a 25-task move plan with summaries, links of all four types, a milestone, deadlines, assignees; exercise every toolbar button, shortcut, drag, dialog, filter; lock and baseline. Screenshot at 1512px and 1280px. Fix anything ugly before the commit.
- [ ] **Step 6: Run** `npx vitest run` and `npm run build` → PASS.
- [ ] **Step 7: Commit** `feat(plans-portal): filters, search and grouping`.
