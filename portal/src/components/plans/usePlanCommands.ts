/**
 * The plan tab's commands: the toolbar's buttons, the keyboard map's keys
 * and the clipboard, wired to the PlanController (PlanTab owns one).
 * lib/plans/commands and lib/plans/paste build the ops; this posts them,
 * says what went wrong, and moves the selection (a new task is selected,
 * a deleted row's place goes to the row that takes it).
 *
 * - A command that sends two batches (a new summary's subtask, a paste
 *   that names its new rows: Ruling B3) sends the second with the ids the
 *   first answered, joined into its undo step, so one Undo takes back both.
 * - A completion the rules stop goes to the tab's completion check
 *   (`completion`, useCompletion: Ruling B2).
 * - Copy writes TSV of the selected rows' visible columns: through
 *   navigator.clipboard where the browser has it, and through the
 *   browser's own copy, which the shortcut aims at a hidden field in the
 *   tab (`clip`) holding the text selected — a browser fires no copy or
 *   paste event on the sheet itself, which isn't editable. Paste works the
 *   same way: the keystroke pastes into the hidden field, whose paste event
 *   carries the text with no permission prompt; navigator.clipboard is the
 *   fallback when no event comes. Focus is back on the sheet at once.
 *   Pasting the sheet's own copy re-creates the tasks; anything else fills
 *   cells (lib/plans/paste).
 * - Cut of whole tasks copies them and marks their rows (`cutMarks`, a
 *   dashed outline: Excel's marching ants, held still); nothing is deleted
 *   and nothing asks. Pasted back into the same plan while the cut waits,
 *   it is a move (one `move_tasks` batch right above the active row, where
 *   a paste of copies goes; one undo step): the tasks keep their ids,
 *   links, progress and baseline. Pasted with the active cell still on a
 *   cut task it does nothing but end the cut (Excel's); into its own
 *   subtasks it is refused (MOVE_INSIDE). Escape, a new Copy or Cut, a delete or move of a cut
 *   task (or a change of its summary) and a reload end the cut; a paste
 *   then pastes copies. Pasted into another plan it pastes copies, leaves
 *   the originals and says so (PASTED_COPIES). A cut of one cell is a copy.
 * - Dialogs open through PlanTab's host (`openDialog`). Set baseline
 *   sends at once; the dialog only asks when it would replace one
 *   (`replaceBaseline`, from the 409 `baseline_exists`). Unlock goes at
 *   once; Lock, Clear baseline and Delete plan ask first.
 * - The commands work on tasks: `sheet` is useSheetView's `forCommands`
 *   (the tasks shown, each once, and the selection by task). While the
 *   sheet is grouped (Group by) the outline and the links can't change:
 *   Insert, Indent, Outdent, Link, Unlink and a paste that adds rows say so
 *   instead (OFF_NOTES.grouped). A cell paste while grouped fills the rows
 *   on screen from the active one (`sheet.pasteRows`).
 * - Ctrl+F (⌘F) focuses the filter bar's search box (`searchBox`), its
 *   text selected; with no box the browser finds.
 * - A row dragged by its ID (useRowDrag) lands here (`moveTasks`): one
 *   `move_tasks` batch (lib/plans/moveTasks), one undo step.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { listReportDefinitions, type ReportDefinition } from '../../lib/api';
import { useToast } from '../../lib/notificationsContext';
import { exportPlan, type ExportFormat, type Op, type Plan, type PlanTask, type TaskMode } from '../../lib/plans/api';
import type { ApplyResult } from '../../lib/plans/applyResult';
import { COLUMN_BY_KEY, columnPrefsSnapshot, type PlanColumn } from '../../lib/plans/columns';
import { OFF_NOTES } from '../../lib/plans/commandTips';
import {
  deleteSelected, indentSelected, insertTask, linkSelected, markOnTrack, outdentSelected, selectedTasks,
  selectionMode, setColor, setMode as modeOps, setPercent, toggleTimeline, unlinkSelected, type Command,
  type CommandOps, type InsertKind,
} from '../../lib/plans/commands';
import { coarserOf, fitZoom, zoomIn as zoomInOf, zoomOut as zoomOutOf, type Zoom } from '../../lib/plans/ganttGeometry';
import { LABEL_MAX_PX, planFinestZoom, readZoom, writeZoom, type GanttLayout } from '../../lib/plans/ganttView';
import { PLAN_ERRORS, isPlanChanged, planErrorText } from '../../lib/plans/errors';
import { moveOp, moveTops, type MovePlace } from '../../lib/plans/moveTasks';
import { descendants } from '../../lib/plans/outline';
import {
  copyCell, copyRows, opsForInternalPaste, opsForPaste, parseClipboard, sameClipboard, type PasteContext, type PlanCopy,
} from '../../lib/plans/paste';
import { EMPTY_SELECTION, selectCell, type Selection } from '../../lib/plans/selection';
import type { TaskInfoTab } from '../../lib/plans/taskInfo';
import type { ProjectPlanInitial } from '../reports/ProjectPlanOptions';
import { focusQuietly } from './quietFocus';
import { SAID_ALREADY, type Completion } from './useCompletion';
import type { PlanController, ThenOps } from './usePlan';
import { keysBelongElsewhere, type PlanShortcutHandlers } from './usePlanShortcuts';

/** The dialog the tab has open. */
export type PlanDialog =
  /** New project plan: from Blank plan, or From a template (a template required). */
  | { kind: 'create'; fromTemplate?: boolean }
  | { kind: 'columns' }
  | { kind: 'shortcuts' }
  | { kind: 'deleteTasks'; ops: Op[]; tasks: PlanTask[]; subtasks: number; next: Selection }
  | { kind: 'taskInfo'; taskId: string; tab?: TaskInfoTab }
  | { kind: 'dependency'; linkId: string }
  /** Set baseline met one already there (409 `baseline_exists`, set `setAt`). */
  | { kind: 'replaceBaseline'; setAt: string | null }
  | { kind: 'clearBaseline' }
  | { kind: 'lock' }
  | { kind: 'updateProject' }
  | { kind: 'settings' }
  | { kind: 'deletePlan' }
  | { kind: 'saveTemplate' }
  | { kind: 'templates' }
  /** More › Import…, or the empty state's Import from MS Project or Excel (no plan yet). */
  | { kind: 'import' }
  /** More › Export ▸ PDF…: the Project plan report's Generate dialog, starting from this view. */
  | { kind: 'exportPdf'; definition: ReportDefinition; initial: ProjectPlanInitial };

/** The dialogs More opens by name. */
export type MoreDialog = 'columns' | 'shortcuts' | 'clearBaseline' | 'updateProject' | 'settings' | 'deletePlan'
  | 'saveTemplate' | 'templates' | 'import';

export const PASTE_LABEL = 'Paste';
/** What an outline command says while the sheet is grouped. */
export const GROUPED_SAID = `${OFF_NOTES.grouped}.`;
export const BASELINE_SET = 'Baseline set: every task’s Start, Finish and Duration were copied.';
/** A direct download (MS Project XML, Excel) on its way: the API builds it first. */
export const PREPARING_EXPORT = 'Preparing export…';
/** PDF… found no Project plan report (TimeManagement's words for the Timesheet's). */
export const PDF_REPORT_MISSING = 'The Project plan report isn’t set up. Ask an administrator.';
export const PDF_REPORTS_FAILED = 'Couldn’t load the reports. Try again.';
/** A move into the tasks that move (a cut pasted into its own subtasks). */
export const MOVE_INSIDE = 'Can’t move tasks into themselves.';
/** How long Ctrl+V waits for the browser's paste event before asking
 *  navigator.clipboard instead. */
const PASTE_WAIT_MS = 120;

/** What a paste of copies of cut tasks into another plan says. */
export const PASTED_COPIES = 'Pasted copies — cut tasks only move within one plan.';

/** The last copy of whole tasks, kept for the page's life: a paste of the
 *  same text into any plan re-creates them. A copy of one cell clears it. */
let lastCopy: PlanCopy | null = null;

/** A cut of whole tasks waiting for its paste (see the header). */
interface PendingCut {
  planId: string;
  /** The copy the cut made: the cut waits only while it is `lastCopy`. */
  copy: PlanCopy;
  /** The top-most cut tasks, in outline order: what a paste moves. */
  tops: string[];
  /** Every cut task, the tops' subtasks too: the rows marked. */
  all: string[];
  /** Each cut task's summary when it was cut: a move ends the cut. */
  parents: Readonly<Record<string, string | null>>;
  /** The plan's load count when it was cut (PlanController `loads`): a reload ends it. */
  loads: number;
}

/** The cut waiting for its paste, kept with `lastCopy` for the page's life. */
let lastCut: PendingCut | null = null;

const NO_MARKS: ReadonlySet<string> = new Set();

/** How a command words a second batch that didn't go in. */
interface PartWords {
  /** The toast: why, and whether Undo still takes the first batch back. */
  said(reason: string, undoable: boolean): string;
  /** What already went in, said first in the completion check. */
  lead: string;
}

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

const PART_WORDS: PartWords = {
  said: (reason, undoable) => `Only part of that went in. ${capitalized(reason)}${undoable ? ' Undo takes it back.' : ''}`,
  lead: 'Only part of that went in. ',
};

const PASTE_WORDS: PartWords = {
  said: (reason, undoable) => `Rows were added, but some values couldn’t be set: ${reason}`
    + `${undoable ? ' Undo removes the whole paste.' : ''}`,
  lead: 'Rows were added. ',
};

/** The paste toast for filled cells it left out. */
const skippedText = (n: number) =>
  `${n} cell${n === 1 ? ' was' : 's were'} skipped (read-only or hidden columns).`;

/** Text the person selected on the page outside the sheet (the lock
 *  banner, a toast) and is still on: a copy of it is the browser's, not
 *  the sheet's. Selecting it takes focus off the sheet; once focus is back
 *  in the sheet (a click on a row), a selection left behind elsewhere is
 *  stale and the sheet copies. */
function textSelected(): boolean {
  const focus = document.activeElement;
  if (focus instanceof Element && focus.closest('.pln-sheet')) return false;
  const selection = typeof window.getSelection === 'function' ? window.getSelection() : null;
  return !!selection && !selection.isCollapsed && selection.toString() !== '';
}

/** The Gantt's display options (PlanGantt draws them). */
export interface GanttDisplay {
  critical: boolean;
  baseline: boolean;
}

/** A sideways scroll the chart does once (per `seq`): Fit Project scrolls
 *  to the project start, Scroll to Task to the task's bar. */
export interface ChartScroll {
  seq: number;
  to: 'fit' | 'task';
  taskId?: string;
}

export interface SheetState {
  rows: string[];
  collapsed: ReadonlySet<string>;
  selection: Selection;
  select(sel: Selection): void;
  toggleCollapse(id: string): void;
  reveal(id: string): void;
  /** Opens its summaries, selects the row and scrolls it into view. */
  goTo(id: string): void;
  /** Grouped (Group by): the outline and the links can't change. */
  grouped?: boolean;
  /** The tasks a cell paste fills, from the active one down (grouped: the
   *  rows on screen, each task once); `rows` when absent. */
  pasteRows?: string[];
}

interface Options {
  ctl: PlanController;
  sheet: SheetState;
  /** The tab root (the sheet inside it takes focus back after a click). */
  root: RefObject<HTMLElement | null>;
  /** A hidden field in the tab: the clipboard shortcuts' keystroke target. */
  clip: RefObject<HTMLTextAreaElement | null>;
  openDialog(dialog: PlanDialog): void;
  /** The tab's completion check (useCompletion). */
  completion: Pick<Completion, 'answer' | 'prompt'>;
  /** Where the Gantt chart is (Beside by default): Fit leaves room for the
   *  names under the sheet; Hidden has no chart to scroll to a task. */
  layout?: GanttLayout;
  /** The filter bar's search box: Ctrl+F (⌘F) focuses it. */
  searchBox?: RefObject<HTMLInputElement | null>;
}

export interface PlanCommands {
  /** The selected tasks, in the order they were picked. */
  selected: PlanTask[];
  /** The selection's mode when it agrees (the Auto / Manual pair). */
  mode: TaskMode | null;
  /** Every selected task is on the timeline. */
  onTimeline: boolean;
  display: GanttDisplay;
  /** The Gantt's zoom, kept per plan in localStorage `plans.zoom.<planId>`,
   *  held to `finestZoom`. */
  zoom: Zoom;
  /** The finest zoom this plan's chart can draw (ganttView planFinestZoom):
   *  five minutes unless the plan and its window run for years. Zoom In
   *  stops there. */
  finestZoom: Zoom;
  /** The chart's latest one-off sideways scroll (Fit, Scroll to Task). */
  chartScroll: ChartScroll | null;
  /** The sheet is grouped: Insert, Indent and Outdent are off. */
  grouped: boolean;
  /** The tasks a cut marked, while it waits for its paste in this plan. */
  cutMarks: ReadonlySet<string>;

  undo(): void;
  redo(): void;
  percent(n: number): void;
  markOnTrack(): void;
  link(): void;
  unlink(): void;
  indent(): void;
  outdent(): void;
  setMode(mode: TaskMode): void;
  insert(kind: InsertKind): void;
  timeline(): void;
  /** Properties › Task color: the color (null: the default) on every selected task, one undo step. */
  color(color: string | null): void;
  deleteTasks(): void;
  /** The confirmed delete of a summary with its subtasks. */
  confirmDelete(dialog: Extract<PlanDialog, { kind: 'deleteTasks' }>): Promise<void>;
  /** Moves the tasks (the top-most of `ids`, each with its subtasks) to
   *  `place`: a row drag let go (useRowDrag). */
  moveTasks(ids: string[], place: MovePlace): void;
  info(tab?: TaskInfoTab): void;
  /** Selects the task and scrolls it into view in the sheet and the chart. */
  goToTask(id: string): void;
  /** Scrolls the chart sideways to the task's bar (the `&task=` deep link's). */
  scrollChartTo(id: string): void;
  setBaseline(): void;
  toggleCritical(): void;
  toggleBaseline(): void;
  zoomIn(): void;
  zoomOut(): void;
  fit(): void;
  scrollToTask(): void;
  collapse(): void;
  expand(): void;
  copy(): boolean;
  cut(): boolean;
  paste(text: string): void;
  lock(): void;
  unlock(): void;
  open(kind: MoreDialog): void;
  /** More › Export: the plan as MS Project XML, or the sheet's visible
   *  columns as an Excel workbook, downloaded under the API's file name;
   *  one at a time (a click while one is on its way does nothing). */
  exportPlan(format: ExportFormat): void;
  /** More › Export ▸ PDF…: the Project plan report's Generate dialog, its
   *  choices starting from this view (visible columns, zoom, Display). */
  exportPdf(): void;
  /** Focus back on the sheet (a toolbar click hands it back). */
  focusSheet(): void;
  /** For usePlanShortcuts. */
  handlers: PlanShortcutHandlers;
}

/** The sheet's visible columns, in order. */
function visibleColumns(): PlanColumn[] {
  return columnPrefsSnapshot().visible.map((k) => COLUMN_BY_KEY.get(k)).filter((c): c is PlanColumn => !!c);
}

export function usePlanCommands({
  ctl, sheet, root, clip, openDialog, completion, layout = 'beside', searchBox,
}: Options): PlanCommands {
  const toast = useToast();
  const { prompt, answer: answered } = completion;
  const [display, setDisplay] = useState<GanttDisplay>({ critical: false, baseline: false });
  const [storedZoom, setZoom] = usePlanZoom(ctl.plan?.id ?? null);
  const startAt = ctl.plan?.project_start;
  const finishAt = ctl.plan?.project_finish;
  const winFrom = ctl.plan?.initiative_window?.start ?? null;
  const winTo = ctl.plan?.initiative_window?.end ?? null;
  const finestZoom = useMemo(() => planFinestZoom(startAt, finishAt, { start: winFrom, end: winTo }),
    [startAt, finishAt, winFrom, winTo]);
  // a zoom kept for this plan when it was shorter is held to what it can draw now
  const zoom = coarserOf(storedZoom, finestZoom);
  const [chartScroll, setChartScroll] = useState<ChartScroll | null>(null);
  const scrollSeq = useRef(0);

  // what callbacks read after an await, and what keeps them one identity
  const latest = useRef({ ctl, sheet, toast, prompt, openDialog, layout, display, zoom, finestZoom });
  useLayoutEffect(() => {
    latest.current = { ctl, sheet, toast, prompt, openDialog, layout, display, zoom, finestZoom };
  });
  const tempRef = useRef(0);
  // an export on its way: a second click waits for it (MS Project XML and
  // Excel download straight away; PDF… looks up its report first)
  const exporting = useRef(false);
  const findingPdf = useRef(false);

  // the cut waiting for its paste: the page's (`lastCut`), mirrored for drawing
  const [pendingCut, setPendingCutState] = useState<PendingCut | null>(() => lastCut);
  const setPendingCut = useCallback((next: PendingCut | null) => {
    lastCut = next;
    setPendingCutState(next);
  }, []);
  /** The cut waiting in the plan on screen, if any. */
  const cutHere = useCallback((): PendingCut | null => {
    const plan = latest.current.ctl.plan;
    return lastCut && lastCut.copy === lastCopy && plan && lastCut.planId === plan.id ? lastCut : null;
  }, []);

  // focus back on the sheet without it taking that for a Tab into it (with
  // nothing selected that would select the first row and scroll up to it)
  const focusSheet = useCallback(() => {
    const sheet = root.current?.querySelector<HTMLElement>('.pln-sheet');
    if (sheet) focusQuietly(sheet);
  }, [root]);

  /** The command context for the plan on screen. */
  const contextOf = useCallback((plan: Plan): PasteContext => {
    const { rows } = latest.current.sheet;
    const last = rows.length ? plan.tasks.find((t) => t.id === rows[rows.length - 1]) : undefined;
    return {
      plan,
      tempId: () => {
        tempRef.current += 1;
        return `cmd-${tempRef.current}`;
      },
      appendParentId: last?.parent_id ?? null,
    };
  }, []);

  /** A second batch that didn't go in, said as the outcome of the whole
   *  command, in one message: the first batch's rows stay (its undo step
   *  takes them back); a completion stop's Complete resends the second
   *  batch into that same step. Someone else's change under it: usePlan
   *  reloaded without a word of its own (undo went with the reload), so
   *  this is the one message, and it says "reloaded" only when it was. */
  const partlyDone = useCallback((second: Exclude<ApplyResult, { ok: true }>, more: Op[], label: string,
    step: number | null | undefined, words: PartWords) => {
    const { toast: say, prompt: ask } = latest.current;
    if (second.kind !== 'error') {
      // the completion check, saying what went in (a blocked one has nothing to resend)
      ask(second, () => latest.current.ctl.apply(more, label, { confirm: true, joinUndo: step ?? null }),
        { lead: words.lead });
    } else if (second.code === 'plan_changed') {
      say(words.said(second.reloaded === false
        ? `someone else changed the plan, and reloading it failed${second.message ? `: ${second.message}` : '.'}`
        : 'someone else changed the plan, so it was reloaded.', false));
    } else if (second.code !== 'gone' && second.message) {
      say(words.said(second.message, true));
    }
  }, []);

  /** Sends a command — both batches in one write (applyThen) — and
   *  answers its new tasks' ids. */
  const run = useCallback(async (cmd: Command, label: string,
    after?: (ids: Readonly<Record<string, string>>) => void, words: PartWords = PART_WORDS): Promise<boolean> => {
    const say = latest.current.toast;
    if ('error' in cmd) {
      say(cmd.error);
      return false;
    }
    const skipped = () => { if (cmd.skipped) say(skippedText(cmd.skipped)); };
    if (!cmd.ops.length) {
      skipped();
      return false;
    }
    const then = cmd.then;
    let more: Op[] = [];
    const build: ThenOps = (done) => {
      more = then ? then(done.tempIds) : [];
      return more.length ? more : null;
    };
    /** Once the first batch went in: the second's answer, the cells
     *  skipped, and what follows the command. */
    const rest = (first: Extract<ApplyResult, { ok: true }>, second: ApplyResult | null): boolean => {
      if (second && !second.ok) {
        partlyDone(second, more, label, first.undoStep, words);
        return false;
      }
      if (second) answered(second, more, label);
      skipped();
      after?.(first.tempIds);
      return true;
    };
    const ctl = latest.current.ctl;
    const { first, second } = await ctl.applyThen(cmd.ops, label, build);
    if (!first.ok && first.kind !== 'error') {
      // every completing op rides in the last batch, so a stop here is a
      // one-batch command's. The guard all the same: Complete resends the
      // whole command, so a second batch is never dropped
      latest.current.prompt(first, async () => {
        const again = await latest.current.ctl.applyThen(cmd.ops, label, build, { confirm: true });
        if (again.first.ok) rest(again.first, again.second);
        return again.first;
      });
      return false;
    }
    if (!answered(first, cmd.ops, label) || !first.ok) return false;
    return rest(first, second);
  }, [answered, partlyDone]);

  /** A command on the selection, for the plan on screen. `need`: what it
   *  changes — progress (any plan the person may change), the schedule
   *  (not while locked), or new tasks (adding allowed too); `outline`: it
   *  changes the outline or the links (not while grouped: Insert, Indent,
   *  Outdent, and Link and Unlink, whose lines grouping doesn't draw).
   *  False when it can't run at all here (a reader's key goes on to the
   *  browser). */
  const withPlan = useCallback((build: (sel: Selection, ctx: PasteContext) => Command, label: string,
    need: 'progress' | 'schedule' | 'add',
    after?: (cmd: CommandOps, ids: Readonly<Record<string, string>>) => void, outline = false): boolean => {
    const { ctl: now, sheet: view, toast: say } = latest.current;
    const plan = now.plan;
    if (!plan || !plan.permissions.change) return false;
    if (need === 'add' && !plan.permissions.add) return false;
    if (need !== 'progress' && plan.locked_at) {
      say(PLAN_ERRORS.plan_locked);
      return true;
    }
    if (outline && view.grouped) {
      say(GROUPED_SAID);
      return true;
    }
    const cmd = build(view.selection, contextOf(plan));
    void run(cmd, label, after && 'ops' in cmd ? (ids) => after(cmd, ids) : undefined);
    return true;
  }, [contextOf, run]);

  const selectNew = useCallback((cmd: CommandOps, ids: Readonly<Record<string, string>>) => {
    const id = cmd.select ? ids[cmd.select] : undefined;
    if (id) latest.current.sheet.select(selectCell(id, 'name'));
  }, []);

  /** Where the selection goes once the tasks are deleted: the row that
   *  takes the first one's place, else the one above, else the blank row. */
  const afterDelete = useCallback((plan: Plan, ids: readonly string[]): Selection => {
    const { rows, selection } = latest.current.sheet;
    const doomed = new Set(ids.flatMap((id) => [id, ...descendants(id, plan.tasks)]));
    const at = rows.findIndex((id) => doomed.has(id));
    const col = selection.active?.col ?? 'name';
    const next = rows.slice(Math.max(0, at)).find((id) => !doomed.has(id))
      ?? rows.slice(0, Math.max(0, at)).reverse().find((id) => !doomed.has(id));
    if (next) return selectCell(next, col);
    return plan.permissions.add ? selectCell('blank', col) : EMPTY_SELECTION;
  }, []);

  /** Delete (with a confirm when summaries take subtasks along); false
   *  when this person can't delete here at all. */
  const deleteTasks = useCallback((): boolean => {
    const { ctl: now, sheet: view } = latest.current;
    const plan = now.plan;
    if (!plan || !plan.permissions.change) return false;
    if (plan.locked_at) {
      latest.current.toast(PLAN_ERRORS.plan_locked);
      return true;
    }
    const cmd = deleteSelected(view.selection, contextOf(plan));
    if ('error' in cmd) {
      latest.current.toast(cmd.error);
      return true;
    }
    const ids = (cmd.ops[0] as Extract<Op, { op: 'delete_tasks' }>).ids;
    const next = afterDelete(plan, ids);
    if (cmd.confirm) {
      const tasks = ids.map((id) => plan.tasks.find((t) => t.id === id)).filter((t): t is PlanTask => !!t);
      latest.current.openDialog({ kind: 'deleteTasks', ops: cmd.ops, tasks, subtasks: cmd.confirm.subtasks, next });
      return true;
    }
    void run(cmd, ids.length > 1 ? 'Delete Tasks' : 'Delete Task', () => latest.current.sheet.select(next));
    return true;
  }, [afterDelete, contextOf, run]);

  const confirmDelete = useCallback(async (dialog: Extract<PlanDialog, { kind: 'deleteTasks' }>) => {
    const label = dialog.tasks.length > 1 ? 'Delete Tasks' : 'Delete Task';
    await run({ ops: dialog.ops }, label, () => latest.current.sheet.select(dialog.next));
  }, [run]);

  /** A row drag let go: the tasks to `place` in one `move_tasks` batch.
   *  The plan as it is now decides (the drag checked it as it went). */
  const moveTasks = useCallback((ids: string[], place: MovePlace) => {
    const { ctl: now, sheet: view, toast: say } = latest.current;
    const plan = now.plan;
    if (!plan || !plan.permissions.change) return;
    if (plan.locked_at) {
      say(PLAN_ERRORS.plan_locked);
      return;
    }
    if (view.grouped) {
      say(GROUPED_SAID);
      return;
    }
    const tops = moveTops(ids, plan);
    const op = moveOp(plan, tops, place);
    if (op === 'inside') {
      say(MOVE_INSIDE);
      return;
    }
    if (!op) return;
    // a cut task moved by hand: the cut is over
    const cut = cutHere();
    if (cut) {
      const moved = new Set(tops.flatMap((id) => [id, ...descendants(id, plan.tasks)]));
      if (cut.all.some((id) => moved.has(id))) setPendingCut(null);
    }
    void run({ ops: [op] }, tops.length > 1 ? 'Move Rows' : 'Move Row');
  }, [run, cutHere, setPendingCut]);

  // ── the clipboard ──
  /**
   * What a copy takes. Whole tasks — TSV of the rows plus a copy of the
   * tasks (`lastCopy`, which a paste re-creates) — when rows were picked by
   * their numbers or the active cell is an ID or a Task Name; else the one
   * active cell's text, as Excel copies a cell (and `lastCopy` goes).
   */
  const makeCopy = useCallback((): { text: string; tasks: boolean } | null => {
    const { ctl: now, sheet: view } = latest.current;
    const plan = now.plan;
    const sel = view.selection;
    if (!plan || !sel.active) return null;
    const active = sel.active;
    if (sel.rows.size < 2 && active.col !== 'id' && active.col !== 'name') {
      const task = plan.tasks.find((t) => t.id === active.id);
      const column = COLUMN_BY_KEY.get(active.col);
      if (!task || !column) return null;
      lastCopy = null;
      return { text: copyCell(task, column, plan), tasks: false };
    }
    const chosen = selectedTasks(sel, plan);
    if (!chosen.length) return null;
    const { copy } = copyRows(new Set(chosen.map((t) => t.id)), visibleColumns(), plan);
    lastCopy = copy;
    return { text: copy.text, tasks: true };
  }, []);

  /** What the copy or cut shortcut put together, for the clipboard event
   *  that follows it (cleared once that event had its chance). */
  const armed = useRef<{ text: string; cut: boolean } | null>(null);
  const waitingPaste = useRef<number | null>(null);

  /** The shortcut's keystroke goes to the hidden field (`clip`): the
   *  browser copies what it holds selected, or pastes into it, and fires
   *  its clipboard event there — it fires none on the sheet, which isn't
   *  editable. Focus comes back to the sheet right after. */
  const toClip = useCallback((text: string) => {
    const field = clip.current;
    if (!field) return;
    // `hidden` at rest: out of the accessibility tree except for this keystroke
    field.hidden = false;
    field.value = text;
    field.focus({ preventScroll: true });
    field.select();
  }, [clip]);

  const backToSheet = useCallback(() => {
    const field = clip.current;
    const had = !!field && document.activeElement === field;
    if (field) {
      field.value = '';
      field.hidden = true;
    }
    if (!field || had) focusSheet();
  }, [clip, focusSheet]);

  const writeClipboard = useCallback((text: string, cut: boolean) => {
    armed.current = { text, cut };
    toClip(text);
    window.setTimeout(() => {
      armed.current = null;
      backToSheet();
    });
    // the browser's clipboard API too, where it has one
    void navigator.clipboard?.writeText?.(text).catch(() => undefined);
  }, [toClip, backToSheet]);

  /** The copy just made (`lastCopy`) becomes a cut waiting for its paste:
   *  its rows are marked. */
  const markCut = useCallback(() => {
    const plan = latest.current.ctl.plan;
    const made = lastCopy;
    if (!plan || !made) return;
    const all = made.tasks.map((t) => t.key);
    const byId = new Map(plan.tasks.map((t) => [t.id, t]));
    setPendingCut({
      planId: plan.id, copy: made, tops: moveTops(all, plan), all,
      parents: Object.fromEntries(all.map((id) => [id, byId.get(id)?.parent_id ?? null])),
      loads: latest.current.ctl.loads,
    });
  }, [setPendingCut]);

  /** Copy; false (the browser's own copy) when there is nothing of the
   *  sheet's to copy, or the person selected text on the page. A copy ends
   *  a cut waiting for its paste. */
  const copy = useCallback((): boolean => {
    if (textSelected()) return false;
    const made = makeCopy();
    if (!made) return false;
    setPendingCut(null);
    writeClipboard(made.text, false);
    return true;
  }, [makeCopy, writeClipboard, setPendingCut]);

  /** Copy, and mark the tasks cut (a paste in this plan moves them); a cut
   *  of one cell, or a reader's, is a copy. */
  const cut = useCallback((): boolean => {
    if (textSelected()) return false;
    if (!latest.current.ctl.plan?.permissions.change) return copy();
    const made = makeCopy();
    if (!made) return false;
    writeClipboard(made.text, made.tasks);
    if (made.tasks) markCut(); else setPendingCut(null);
    return true;
  }, [copy, makeCopy, writeClipboard, markCut, setPendingCut]);

  /** A cut pasted back into its plan: the tasks themselves move, right
   *  above the active row (at the end from the blank row), in one batch. */
  const pasteMove = useCallback((pending: PendingCut, plan: Plan, ctx: PasteContext) => {
    const { sheet: view, toast: say } = latest.current;
    if (plan.locked_at) {
      say(PLAN_ERRORS.plan_locked);
      return;
    }
    const active = view.selection.active;
    const at = active && active.id !== 'blank' && plan.tasks.some((t) => t.id === active.id) ? active.id : null;
    // pasted where it is (the active cell still on a cut task): the cut ends, nothing moves, nothing is said
    if (at !== null && pending.tops.includes(at)) {
      setPendingCut(null);
      return;
    }
    const place: MovePlace = at !== null ? { beforeId: at } : { beforeId: null, parentId: ctx.appendParentId };
    const op = moveOp(plan, pending.tops, place);
    if (op === 'inside') {
      say(MOVE_INSIDE);
      return;
    }
    setPendingCut(null);
    if (!op) return;                    // they are there already
    const first = pending.tops[0];
    void run({ ops: [op] }, PASTE_LABEL, () => latest.current.sheet.select(selectCell(first, 'name')));
  }, [run, setPendingCut]);

  const paste = useCallback((text: string) => {
    const { ctl: now, sheet: view } = latest.current;
    const plan = now.plan;
    if (!plan || !text) return;
    const ctx = contextOf(plan);
    if (lastCopy && sameClipboard(text, lastCopy.text)) {
      // the sheet's own copy: the tasks again, right above the active row
      if (view.grouped) {
        latest.current.toast(GROUPED_SAID);
        return;
      }
      // a cut: moved within its plan; copies anywhere else (and the cut is spent)
      const pending = lastCut && lastCut.copy === lastCopy ? lastCut : null;
      if (pending && pending.planId === plan.id) {
        pasteMove(pending, plan, ctx);
        return;
      }
      if (pending) setPendingCut(null);
      const cmd = opsForInternalPaste(lastCopy, view.selection, ctx);
      void run(cmd, PASTE_LABEL, 'ops' in cmd ? (ids) => {
        selectNew(cmd, ids);
        if (pending) latest.current.toast(PASTED_COPIES);
      } : undefined);
      return;
    }
    const grid = parseClipboard(text);
    if (!grid.length) return;
    const cmd = opsForPaste(grid, view.selection.active, visibleColumns(), view.pasteRows ?? view.rows, ctx);
    // grouped, cells fill in; rows past the last would be new tasks
    if (view.grouped && 'ops' in cmd && cmd.ops.some((op) => op.op === 'add_task')) {
      latest.current.toast(GROUPED_SAID);
      return;
    }
    void run(cmd, PASTE_LABEL, undefined, PASTE_WORDS);
  }, [contextOf, run, selectNew, pasteMove, setPendingCut]);

  // the browser's own clipboard events: on the hidden field after a
  // shortcut, or on the sheet (a browser's Edit menu)
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const ours = (target: EventTarget | null) => target === clip.current || !keysBelongElsewhere(target);
    /** A copy or cut that is the sheet's: from the hidden field after a
     *  shortcut, or with the sheet focused and no text selected (else the
     *  browser copies the text the person selected). */
    const sheetCopy = (target: EventTarget | null) => {
      if (target === clip.current) return true;
      const focus = document.activeElement;
      return !textSelected() && focus instanceof HTMLElement && focus.classList.contains('pln-sheet');
    };
    const onCopy = (e: ClipboardEvent) => {
      if (!sheetCopy(e.target)) return;
      const ready = armed.current;
      armed.current = null;
      const made = ready ? null : makeCopy();
      const text = ready?.text ?? made?.text;
      if (text === undefined || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
      // the browser's own menu (the shortcut marked or ended the cut already)
      if (!made) return;
      if (e.type === 'cut' && made.tasks && latest.current.ctl.plan?.permissions.change) markCut();
      else setPendingCut(null);
    };
    const onPaste = (e: ClipboardEvent) => {
      if (!ours(e.target)) return;
      if (waitingPaste.current !== null) window.clearTimeout(waitingPaste.current);
      waitingPaste.current = null;
      const text = e.clipboardData?.getData('text/plain') ?? '';
      e.preventDefault();
      backToSheet();
      paste(text);
    };
    el.addEventListener('copy', onCopy);
    el.addEventListener('cut', onCopy);
    el.addEventListener('paste', onPaste);
    return () => {
      el.removeEventListener('copy', onCopy);
      el.removeEventListener('cut', onCopy);
      el.removeEventListener('paste', onPaste);
    };
  }, [root, clip, makeCopy, paste, markCut, setPendingCut, backToSheet]);

  // Escape ends a cut waiting for its paste (Excel's), before full screen hears it
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented || keysBelongElsewhere(e.target) || !cutHere()) return;
      e.preventDefault();
      setPendingCut(null);
    };
    el.addEventListener('keydown', onKey);
    return () => el.removeEventListener('keydown', onKey);
  }, [root, cutHere, setPendingCut]);

  // a cut task deleted or moved (its summary changed), or the plan read
  // again (someone else's change): the cut is over
  const { plan: planNow, loads } = ctl;
  useEffect(() => {
    const pending = pendingCut;
    if (!pending || !planNow || pending.planId !== planNow.id) return;
    const byId = new Map(planNow.tasks.map((t) => [t.id, t]));
    const stale = pending.copy !== lastCopy || pending.loads !== loads
      || pending.all.some((id) => !byId.has(id) || (byId.get(id)?.parent_id ?? null) !== pending.parents[id]);
    if (stale) setPendingCut(null);
  }, [pendingCut, planNow, loads, setPendingCut]);

  /** Ctrl+V: the keystroke pastes into the hidden field, whose paste event
   *  brings the text. Should none come, ask the browser's clipboard API. */
  const pasteKey = useCallback(() => {
    toClip('');
    if (waitingPaste.current !== null) window.clearTimeout(waitingPaste.current);
    waitingPaste.current = window.setTimeout(() => {
      waitingPaste.current = null;
      backToSheet();
      const read = navigator.clipboard?.readText;
      if (!read) return;
      read.call(navigator.clipboard).then((text) => paste(text), () => {
        latest.current.toast('The browser didn’t share the clipboard. Allow clipboard access for this site, then paste again.');
      });
    }, PASTE_WAIT_MS);
  }, [paste, toClip, backToSheet]);

  useEffect(() => () => {
    if (waitingPaste.current !== null) window.clearTimeout(waitingPaste.current);
  }, []);

  // ── the rest ──
  const plan = ctl.plan;
  const { selection } = sheet;
  const selected = useMemo(() => (plan ? selectedTasks(selection, plan) : []), [plan, selection]);
  const mode = useMemo(() => (plan ? selectionMode(selection, plan) : null), [plan, selection]);
  const onTimeline = selected.length > 0 && selected.every((t) => t.show_on_timeline);

  const commands = useMemo(() => {
    const info = (tab?: TaskInfoTab) => {
      const { sheet: view, ctl: now, openDialog: open } = latest.current;
      const task = now.plan ? selectedTasks(view.selection, now.plan)[0] : undefined;
      if (!task) return false;
      open({ kind: 'taskInfo', taskId: task.id, ...(tab ? { tab } : {}) });
      return true;
    };
    const summariesSelected = () => {
      const { sheet: view, ctl: now } = latest.current;
      return now.plan ? selectedTasks(view.selection, now.plan).filter((t) => t.is_summary) : [];
    };
    const collapseTo = (shut: boolean) => {
      const { sheet: view } = latest.current;
      for (const t of summariesSelected()) {
        if (view.collapsed.has(t.id) !== shut) view.toggleCollapse(t.id);
      }
    };
    // the row into view in the sheet, the bar into view in the chart
    const scrollToTask = () => {
      const { sheet: view, ctl: now } = latest.current;
      const task = now.plan ? selectedTasks(view.selection, now.plan)[0] : undefined;
      if (!task) return;
      view.reveal(task.id);
      scrollSeq.current += 1;
      setChartScroll({ seq: scrollSeq.current, to: 'task', taskId: task.id });
    };
    // the finest zoom at which the project fits the chart pane, scrolled to its
    // start; under the sheet (Gantt › Below) less the room its first names take
    const fit = () => {
      const now = latest.current.ctl.plan;
      const pane = root.current?.querySelector<HTMLElement>('.pln-pane-chart');
      const width = (pane?.clientWidth ?? 0) - (latest.current.layout === 'below' ? LABEL_MAX_PX : 0);
      if (!now || width <= 0) return;
      setZoom(coarserOf(fitZoom(now.project_start, now.project_finish, width), latest.current.finestZoom));
      scrollSeq.current += 1;
      setChartScroll({ seq: scrollSeq.current, to: 'fit' });
    };
    // Go to task: the row selected and in view in the sheet, the bar in
    // the chart, focus on the sheet — unless a dialog is still open over it
    // (Task Information, whose completion check this came from)
    const scrollChartTo = (id: string) => {
      scrollSeq.current += 1;
      setChartScroll({ seq: scrollSeq.current, to: 'task', taskId: id });
    };
    const goToTask = (id: string) => {
      const { sheet: view } = latest.current;
      view.goTo(id);
      scrollChartTo(id);
      if (!document.querySelector('.modal-scrim')) focusSheet();
    };
    const undo = () => { void latest.current.ctl.undo(); };
    const redo = () => { void latest.current.ctl.redo(); };
    const unlock = () => {
      void latest.current.ctl.unlock().catch((err: unknown) => {
        if (!isPlanChanged(err)) latest.current.toast(planErrorText(err));
      });
    };
    // a download through the bearer token, named by the API (`<code or
    // name> - Project plan.<ext>`; this the fallback when its header can't
    // be read); Excel gets the sheet's visible columns
    const exportFile = (format: ExportFormat) => {
      const plan = latest.current.ctl.plan;
      if (!plan || exporting.current) return;
      exporting.current = true;
      latest.current.toast(PREPARING_EXPORT);
      const columns = format === 'xlsx' ? columnPrefsSnapshot().visible : undefined;
      void exportPlan(plan.id, format, columns, `${plan.initiative_name} - Project plan.${format}`)
        .catch((err: unknown) => latest.current.toast(planErrorText(err)))
        .finally(() => { exporting.current = false; });
    };
    // PDF…: the Project plan report (found by its type, as the Timesheet
    // screen finds the Timesheet's), starting from what this view shows;
    // its dialog's progress step covers the run
    const exportPdf = () => {
      if (!latest.current.ctl.plan || findingPdf.current) return;
      findingPdf.current = true;
      void listReportDefinitions().then((defs) => {
        const { ctl: c, display: shown, zoom: at, openDialog: open, toast: say } = latest.current;
        const definition = defs.find((d) => d.report_type === 'project_plan');
        if (!definition) {
          say(PDF_REPORT_MISSING);
          return;
        }
        if (!c.plan) return;
        open({
          kind: 'exportPdf', definition,
          initial: { columns: columnPrefsSnapshot().visible, zoom: at, critical: shown.critical, baseline: shown.baseline },
        });
      }).catch(() => latest.current.toast(PDF_REPORTS_FAILED))
        .finally(() => { findingPdf.current = false; });
    };
    // sent at once; only replacing one asks (the 409 says when it was set)
    const setBaseline = () => {
      void latest.current.ctl.setBaseline(false).then((result) => {
        const { toast: say, openDialog: open } = latest.current;
        if (result.ok) say(BASELINE_SET);
        else if (result.kind === 'error' && result.code === 'baseline_exists') {
          open({ kind: 'replaceBaseline', setAt: result.setAt ?? null });
        } else if (result.kind === 'error' && !SAID_ALREADY.has(result.code) && result.message) say(result.message);
      });
    };

    const insert = (kind: InsertKind) => withPlan((sel, c) => insertTask(sel, kind, c),
      kind === 'summary' ? 'Insert Summary Task' : kind === 'milestone' ? 'Insert Milestone' : 'Insert Task',
      'add', selectNew, true);
    const indent = () => withPlan(indentSelected, 'Indent', 'schedule', undefined, true);
    const outdent = () => withPlan(outdentSelected, 'Outdent', 'schedule', undefined, true);
    // grouped, no links are drawn: a link made then would show nowhere
    const link = () => withPlan(linkSelected, 'Link Tasks', 'schedule', undefined, true);
    const unlink = () => withPlan(unlinkSelected, 'Unlink Tasks', 'schedule', undefined, true);

    const actions = {
      undo,
      redo,
      percent: (n: number) => { withPlan((sel, c) => setPercent(sel, n, c), `${n}% Complete`, 'progress'); },
      markOnTrack: () => { withPlan(markOnTrack, 'Mark on Track', 'progress'); },
      link: () => { link(); },
      unlink: () => { unlink(); },
      indent: () => { indent(); },
      outdent: () => { outdent(); },
      setMode: (m: TaskMode) => {
        withPlan((sel, c) => modeOps(sel, m, c), m === 'manual' ? 'Manually Schedule' : 'Auto Schedule', 'schedule');
      },
      insert: (kind: InsertKind) => { insert(kind); },
      timeline: () => { withPlan(toggleTimeline, 'Add to Timeline', 'schedule'); },
      // cosmetic: a locked plan takes it too (PROGRESS_FIELDS)
      color: (c: string | null) => { withPlan((sel, ctx) => setColor(sel, c, ctx), 'Task color', 'progress'); },
      deleteTasks,
      confirmDelete,
      moveTasks,
      info: (tab?: TaskInfoTab) => { info(tab); },
      goToTask,
      scrollChartTo,
      setBaseline,
      toggleCritical: () => setDisplay((d) => ({ ...d, critical: !d.critical })),
      toggleBaseline: () => setDisplay((d) => ({ ...d, baseline: !d.baseline })),
      // each step from the zoom on screen (the kept one held to finestZoom),
      // and never finer than it
      zoomIn: () => setZoom((now) => {
        const finest = latest.current.finestZoom;
        return coarserOf(zoomInOf(coarserOf(now, finest)), finest);
      }),
      zoomOut: () => setZoom((now) => zoomOutOf(coarserOf(now, latest.current.finestZoom))),
      fit,
      scrollToTask,
      collapse: () => collapseTo(true),
      expand: () => collapseTo(false),
      copy,
      cut,
      paste,
      lock: () => latest.current.openDialog({ kind: 'lock' }),
      unlock,
      open: (kind: MoreDialog) =>
        latest.current.openDialog({ kind }),
      exportPlan: exportFile,
      exportPdf,
      focusSheet,
    };
    const handlers: PlanShortcutHandlers = {
      insert: () => insert('task'),
      delete: () => deleteTasks(),
      indent,
      outdent,
      link,
      unlink,
      info: () => info(),
      undo: () => (latest.current.ctl.plan?.permissions.change ? undo() : false),
      redo: () => (latest.current.ctl.plan?.permissions.change ? redo() : false),
      // with the chart hidden, Scroll to Task is off: the key does nothing (as
      // its button would), and isn't the browser's either
      scrollToTask: () => (latest.current.layout === 'hidden' ? undefined : scrollToTask()),
      collapse: () => (summariesSelected().length ? collapseTo(true) : false),
      expand: () => (summariesSelected().length ? collapseTo(false) : false),
      // the filter bar's search box, its text selected; without one the browser finds
      find: () => {
        const box = searchBox?.current;
        if (!box) return false;
        box.focus();
        box.select();
        return true;
      },
      help: () => actions.open('shortcuts'),
      copy: () => copy(),
      cut: () => cut(),
      paste: () => (latest.current.ctl.plan?.permissions.change ? pasteKey() : false),
    };
    return { ...actions, handlers };
  }, [withPlan, selectNew, deleteTasks, confirmDelete, moveTasks, copy, cut, paste, pasteKey, focusSheet, root,
    setZoom, searchBox]);

  const grouped = !!sheet.grouped;
  const planId = plan?.id ?? null;
  const cutMarks = useMemo(() => (pendingCut && pendingCut.planId === planId ? new Set(pendingCut.all) : NO_MARKS),
    [pendingCut, planId]);
  return useMemo(() => ({
    ...commands, selected, mode, onTimeline, display, zoom, finestZoom, chartScroll, grouped, cutMarks,
  }), [commands, selected, mode, onTimeline, display, zoom, finestZoom, chartScroll, grouped, cutMarks]);
}

/** The Gantt's zoom for the plan on screen: kept per plan in this browser
 *  (`plans.zoom.<planId>`, days until changed). The setter takes a zoom or
 *  a step from the current one, and stores the result. */
function usePlanZoom(planId: string | null): [Zoom, (next: Zoom | ((now: Zoom) => Zoom)) => void] {
  const stored = useMemo(() => readZoom(planId), [planId]);
  const [picked, setPicked] = useState<{ planId: string | null; zoom: Zoom } | null>(null);
  const zoom = picked && picked.planId === planId ? picked.zoom : stored;
  const latest = useRef({ planId, zoom });
  useLayoutEffect(() => {
    latest.current = { planId, zoom };
  }, [planId, zoom]);
  const set = useCallback((next: Zoom | ((now: Zoom) => Zoom)) => {
    const { planId: id, zoom: now } = latest.current;
    const value = typeof next === 'function' ? next(now) : next;
    latest.current = { planId: id, zoom: value };
    setPicked({ planId: id, zoom: value });
    if (id) writeZoom(id, value);
  }, []);
  return [zoom, set];
}
