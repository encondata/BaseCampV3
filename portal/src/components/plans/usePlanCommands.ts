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
 *   cells (lib/plans/paste). Cut is copy, then Delete.
 * - Dialogs open through PlanTab's host (`openDialog`). Set baseline
 *   sends at once; the dialog only asks when it would replace one
 *   (`replaceBaseline`, from the 409 `baseline_exists`). Unlock goes at
 *   once; Lock, Clear baseline and Delete plan ask first.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import { useToast } from '../../lib/notificationsContext';
import type { Op, Plan, PlanTask, TaskMode } from '../../lib/plans/api';
import type { ApplyResult } from '../../lib/plans/applyResult';
import { COLUMN_BY_KEY, columnPrefsSnapshot, type PlanColumn } from '../../lib/plans/columns';
import {
  deleteSelected, indentSelected, insertTask, linkSelected, markOnTrack, outdentSelected, selectedTasks,
  selectionMode, setMode as modeOps, setPercent, toggleTimeline, unlinkSelected, type Command, type CommandOps,
  type InsertKind,
} from '../../lib/plans/commands';
import { fitZoom, zoomIn as zoomInOf, zoomOut as zoomOutOf, type Zoom } from '../../lib/plans/ganttGeometry';
import { readZoom, writeZoom } from '../../lib/plans/ganttView';
import { PLAN_ERRORS, isPlanChanged, planErrorText } from '../../lib/plans/errors';
import { descendants } from '../../lib/plans/outline';
import {
  copyCell, copyRows, opsForInternalPaste, opsForPaste, parseClipboard, sameClipboard, type PasteContext, type PlanCopy,
} from '../../lib/plans/paste';
import { EMPTY_SELECTION, selectCell, type Selection } from '../../lib/plans/selection';
import type { TaskInfoTab } from '../../lib/plans/taskInfo';
import { SAID_ALREADY, type Completion } from './useCompletion';
import type { PlanController, ThenOps } from './usePlan';
import { keysBelongElsewhere, type PlanShortcutHandlers } from './usePlanShortcuts';

/** The dialog the tab has open. */
export type PlanDialog =
  | { kind: 'create' }
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
  | { kind: 'deletePlan' };

export const PASTE_LABEL = 'Paste';
export const BASELINE_SET = 'Baseline set: every task’s Start, Finish and Duration were copied.';
/** How long Ctrl+V waits for the browser's paste event before asking
 *  navigator.clipboard instead. */
const PASTE_WAIT_MS = 120;

/** The last copy of whole tasks, kept for the page's life: a paste of the
 *  same text into any plan re-creates them. A copy of one cell clears it. */
let lastCopy: PlanCopy | null = null;

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
}

export interface PlanCommands {
  /** The selected tasks, in the order they were picked. */
  selected: PlanTask[];
  /** The selection's mode when it agrees (the Auto / Manual pair). */
  mode: TaskMode | null;
  /** Every selected task is on the timeline. */
  onTimeline: boolean;
  display: GanttDisplay;
  /** The Gantt's zoom, kept per plan in localStorage `plans.zoom.<planId>`. */
  zoom: Zoom;
  /** The chart's latest one-off sideways scroll (Fit, Scroll to Task). */
  chartScroll: ChartScroll | null;

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
  deleteTasks(): void;
  /** The confirmed delete of a summary with its subtasks. */
  confirmDelete(dialog: Extract<PlanDialog, { kind: 'deleteTasks' }>): Promise<void>;
  info(tab?: TaskInfoTab): void;
  /** Selects the task and scrolls it into view in the sheet and the chart. */
  goToTask(id: string): void;
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
  open(kind: 'columns' | 'shortcuts' | 'clearBaseline' | 'updateProject' | 'settings' | 'deletePlan'): void;
  /** Focus back on the sheet (a toolbar click hands it back). */
  focusSheet(): void;
  /** For usePlanShortcuts. */
  handlers: PlanShortcutHandlers;
}

/** The sheet's visible columns, in order. */
function visibleColumns(): PlanColumn[] {
  return columnPrefsSnapshot().visible.map((k) => COLUMN_BY_KEY.get(k)).filter((c): c is PlanColumn => !!c);
}

export function usePlanCommands({ ctl, sheet, root, clip, openDialog, completion }: Options): PlanCommands {
  const toast = useToast();
  const { prompt, answer: answered } = completion;
  const [display, setDisplay] = useState<GanttDisplay>({ critical: false, baseline: false });
  const [zoom, setZoom] = usePlanZoom(ctl.plan?.id ?? null);
  const [chartScroll, setChartScroll] = useState<ChartScroll | null>(null);
  const scrollSeq = useRef(0);

  // what callbacks read after an await, and what keeps them one identity
  const latest = useRef({ ctl, sheet, toast, prompt, openDialog });
  useLayoutEffect(() => {
    latest.current = { ctl, sheet, toast, prompt, openDialog };
  });
  const tempRef = useRef(0);

  const focusSheet = useCallback(() => {
    root.current?.querySelector<HTMLElement>('.pln-sheet')?.focus({ preventScroll: true });
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
   *  (not while locked), or new tasks (adding allowed too). False when
   *  it can't run at all here (a reader's key goes on to the browser). */
  const withPlan = useCallback((build: (sel: Selection, ctx: PasteContext) => Command, label: string,
    need: 'progress' | 'schedule' | 'add',
    after?: (cmd: CommandOps, ids: Readonly<Record<string, string>>) => void): boolean => {
    const { ctl: now, sheet: view, toast: say } = latest.current;
    const plan = now.plan;
    if (!plan || !plan.permissions.change) return false;
    if (need === 'add' && !plan.permissions.add) return false;
    if (need !== 'progress' && plan.locked_at) {
      say(PLAN_ERRORS.plan_locked);
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

  /** Copy; false (the browser's own copy) when there is nothing of the
   *  sheet's to copy, or the person selected text on the page. */
  const copy = useCallback((): boolean => {
    if (textSelected()) return false;
    const made = makeCopy();
    if (!made) return false;
    writeClipboard(made.text, false);
    return true;
  }, [makeCopy, writeClipboard]);

  /** Copy, then Delete the tasks; a cut of one cell, or a reader's, is a copy. */
  const cut = useCallback((): boolean => {
    if (textSelected()) return false;
    if (!latest.current.ctl.plan?.permissions.change) return copy();
    const made = makeCopy();
    if (!made) return false;
    writeClipboard(made.text, made.tasks);
    if (made.tasks) deleteTasks();
    return true;
  }, [copy, deleteTasks, makeCopy, writeClipboard]);

  const paste = useCallback((text: string) => {
    const { ctl: now, sheet: view } = latest.current;
    const plan = now.plan;
    if (!plan || !text) return;
    const ctx = contextOf(plan);
    if (lastCopy && sameClipboard(text, lastCopy.text)) {
      // the sheet's own copy: the tasks again, right above the active row
      const cmd = opsForInternalPaste(lastCopy, view.selection, ctx);
      void run(cmd, PASTE_LABEL, 'ops' in cmd ? (ids) => selectNew(cmd, ids) : undefined);
      return;
    }
    const grid = parseClipboard(text);
    if (!grid.length) return;
    void run(opsForPaste(grid, view.selection.active, visibleColumns(), view.rows, ctx), PASTE_LABEL, undefined,
      PASTE_WORDS);
  }, [contextOf, run, selectNew]);

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
      // a cut from the browser's own menu (the shortcut deleted already)
      if (e.type === 'cut' && made?.tasks && latest.current.ctl.plan?.permissions.change) deleteTasks();
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
  }, [root, clip, makeCopy, paste, deleteTasks, backToSheet]);

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
    // the finest zoom at which the project fits the chart pane, scrolled to its start
    const fit = () => {
      const now = latest.current.ctl.plan;
      const width = root.current?.querySelector<HTMLElement>('.pln-pane-chart')?.clientWidth ?? 0;
      if (!now || width <= 0) return;
      setZoom(fitZoom(now.project_start, now.project_finish, width));
      scrollSeq.current += 1;
      setChartScroll({ seq: scrollSeq.current, to: 'fit' });
    };
    // Go to task: the row selected and in view in the sheet, the bar in
    // the chart, focus on the sheet — unless a dialog is still open over it
    // (Task Information, whose completion check this came from)
    const goToTask = (id: string) => {
      const { sheet: view } = latest.current;
      view.goTo(id);
      scrollSeq.current += 1;
      setChartScroll({ seq: scrollSeq.current, to: 'task', taskId: id });
      if (!document.querySelector('.modal-scrim')) focusSheet();
    };
    const undo = () => { void latest.current.ctl.undo(); };
    const redo = () => { void latest.current.ctl.redo(); };
    const unlock = () => {
      void latest.current.ctl.unlock().catch((err: unknown) => {
        if (!isPlanChanged(err)) latest.current.toast(planErrorText(err));
      });
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
      'add', selectNew);
    const indent = () => withPlan(indentSelected, 'Indent', 'schedule');
    const outdent = () => withPlan(outdentSelected, 'Outdent', 'schedule');
    const link = () => withPlan(linkSelected, 'Link Tasks', 'schedule');
    const unlink = () => withPlan(unlinkSelected, 'Unlink Tasks', 'schedule');

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
      deleteTasks,
      confirmDelete,
      info: (tab?: TaskInfoTab) => { info(tab); },
      goToTask,
      setBaseline,
      toggleCritical: () => setDisplay((d) => ({ ...d, critical: !d.critical })),
      toggleBaseline: () => setDisplay((d) => ({ ...d, baseline: !d.baseline })),
      zoomIn: () => setZoom(zoomInOf),
      zoomOut: () => setZoom(zoomOutOf),
      fit,
      scrollToTask,
      collapse: () => collapseTo(true),
      expand: () => collapseTo(false),
      copy,
      cut,
      paste,
      lock: () => latest.current.openDialog({ kind: 'lock' }),
      unlock,
      open: (kind: 'columns' | 'shortcuts' | 'clearBaseline' | 'updateProject' | 'settings' | 'deletePlan') =>
        latest.current.openDialog({ kind }),
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
      scrollToTask,
      collapse: () => (summariesSelected().length ? collapseTo(true) : false),
      expand: () => (summariesSelected().length ? collapseTo(false) : false),
      // the search box arrives with the filters (Task 11): until then the browser finds
      find: () => false,
      help: () => actions.open('shortcuts'),
      copy: () => copy(),
      cut: () => cut(),
      paste: () => (latest.current.ctl.plan?.permissions.change ? pasteKey() : false),
    };
    return { ...actions, handlers };
  }, [withPlan, selectNew, deleteTasks, confirmDelete, copy, cut, paste, pasteKey, focusSheet, root, setZoom]);

  return useMemo(() => ({ ...commands, selected, mode, onTimeline, display, zoom, chartScroll }),
    [commands, selected, mode, onTimeline, display, zoom, chartScroll]);
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
