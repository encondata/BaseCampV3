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
 * - A completion the rules stop goes to useCompletionPrompt (Ruling B2:
 *   the one call site Task 10's CompletionDialog replaces).
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
 * - Dialogs open through PlanTab's host (`openDialog`). Task 10's —
 *   Task Information, Notes, the baseline, Update project, Plan settings,
 *   Delete plan — have kinds here already; until they exist (`DIALOGS_READY`)
 *   their buttons stay off, "Coming in this release".
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
import { noticeText } from '../../lib/plans/editOps';
import { fitZoom, zoomIn as zoomInOf, zoomOut as zoomOutOf, type Zoom } from '../../lib/plans/ganttGeometry';
import { PLAN_ERRORS, isPlanChanged, planErrorText } from '../../lib/plans/errors';
import { descendants } from '../../lib/plans/outline';
import {
  copyRows, opsForInternalPaste, opsForPaste, parseClipboard, sameClipboard, type PasteContext, type PlanCopy,
} from '../../lib/plans/paste';
import { EMPTY_SELECTION, selectCell, type Selection } from '../../lib/plans/selection';
import { SAID_ALREADY, useCompletionPrompt } from './useCompletionPrompt';
import type { ApplyOptions, PlanController } from './usePlan';
import { keysBelongElsewhere, type PlanShortcutHandlers } from './usePlanShortcuts';

/** Task 10's dialogs: wired to these kinds, rendered by PlanTab's host
 *  once they exist. */
export type ComingDialog = 'taskInfo' | 'setBaseline' | 'clearBaseline' | 'updateProject' | 'settings' | 'deletePlan';

/** The dialog the tab has open. */
export type PlanDialog =
  | { kind: 'create' }
  | { kind: 'columns' }
  | { kind: 'shortcuts' }
  | { kind: 'deleteTasks'; ops: Op[]; tasks: PlanTask[]; subtasks: number; next: Selection }
  | { kind: 'taskInfo'; taskId: string; tab?: 'notes' }
  | { kind: Exclude<ComingDialog, 'taskInfo'> };

/** The dialogs that exist; Task 10 adds its kinds. */
export const DIALOGS_READY: ReadonlySet<PlanDialog['kind']> = new Set(['create', 'columns', 'shortcuts', 'deleteTasks']);

export const COMING_SOON = 'Coming in this release';
export const PASTE_LABEL = 'Paste';
/** How long Ctrl+V waits for the browser's paste event before asking
 *  navigator.clipboard instead. */
const PASTE_WAIT_MS = 120;

/** The last copy of whole tasks, kept for the page's life: a paste of the
 *  same text into any plan re-creates them. */
let lastCopy: PlanCopy | null = null;

/** The Gantt's display options (Task 8 draws them). */
export interface GanttDisplay {
  critical: boolean;
  baseline: boolean;
}

export interface SheetState {
  rows: string[];
  collapsed: ReadonlySet<string>;
  selection: Selection;
  select(sel: Selection): void;
  toggleCollapse(id: string): void;
  reveal(id: string): void;
}

interface Options {
  ctl: PlanController;
  sheet: SheetState;
  /** The tab root (the sheet inside it takes focus back after a click). */
  root: RefObject<HTMLElement | null>;
  /** A hidden field in the tab: the clipboard shortcuts' keystroke target. */
  clip: RefObject<HTMLTextAreaElement | null>;
  openDialog(dialog: PlanDialog): void;
}

export interface PlanCommands {
  /** The selected tasks, in the order they were picked. */
  selected: PlanTask[];
  /** The selection's mode when it agrees (the Auto / Manual pair). */
  mode: TaskMode | null;
  /** Every selected task is on the timeline. */
  onTimeline: boolean;
  display: GanttDisplay;
  zoom: Zoom;
  canOpen(kind: PlanDialog['kind']): boolean;

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
  info(tab?: 'notes'): void;
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
  open(kind: 'columns' | 'shortcuts'): void;
  /** Focus back on the sheet (a toolbar click hands it back). */
  focusSheet(): void;
  /** For usePlanShortcuts. */
  handlers: PlanShortcutHandlers;
}

/** The sheet's visible columns, in order. */
function visibleColumns(): PlanColumn[] {
  return columnPrefsSnapshot().visible.map((k) => COLUMN_BY_KEY.get(k)).filter((c): c is PlanColumn => !!c);
}

export function usePlanCommands({ ctl, sheet, root, clip, openDialog }: Options): PlanCommands {
  const toast = useToast();
  const prompt = useCompletionPrompt(ctl);
  const [display, setDisplay] = useState<GanttDisplay>({ critical: false, baseline: false });
  const [zoom, setZoom] = useState<Zoom>('days');

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

  /** One answer said: notices with Undo, a stopped completion to the
   *  prompt, a refusal as a toast (unless usePlan said it already). */
  const answered = useCallback((result: ApplyResult, ops: Op[], label: string, opts: ApplyOptions = {},
    frame: (message: string) => string = (message) => message): boolean => {
    const { toast: say, prompt: ask } = latest.current;
    if (result.ok) {
      for (const notice of result.notices) {
        say(noticeText(notice), { label: 'Undo', onClick: () => void latest.current.ctl.undo() });
      }
      return true;
    }
    if (result.kind !== 'error') {
      ask(result, ops, label, opts);
      return false;
    }
    if (!SAID_ALREADY.has(result.code) && result.message) say(frame(result.message));
    return false;
  }, []);

  /** Sends a command (both batches) and answers its new tasks' ids. */
  const run = useCallback(async (cmd: Command, label: string,
    after?: (ids: Readonly<Record<string, string>>) => void): Promise<boolean> => {
    if ('error' in cmd) {
      latest.current.toast(cmd.error);
      return false;
    }
    if (!cmd.ops.length) return false;
    const first = await latest.current.ctl.apply(cmd.ops, label);
    if (!answered(first, cmd.ops, label) || !first.ok) return false;
    const ids = { ...first.tempIds };
    const more = cmd.then?.(first.tempIds) ?? [];
    if (more.length) {
      // the first batch is in: say what didn't go, and that Undo takes it all back
      const second = await latest.current.ctl.apply(more, label, { joinUndo: true });
      const partly = (message: string) => `Only part of that went in. ${message} Undo takes it back.`;
      if (!answered(second, more, label, { joinUndo: true }, partly)) return false;
    }
    after?.(ids);
    return true;
  }, [answered]);

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
  /** The selection as TSV plus a copy of the tasks (kept as `lastCopy`). */
  const makeCopy = useCallback((): PlanCopy | null => {
    const { ctl: now, sheet: view } = latest.current;
    const plan = now.plan;
    if (!plan) return null;
    const chosen = selectedTasks(view.selection, plan);
    if (!chosen.length) return null;
    const { copy } = copyRows(new Set(chosen.map((t) => t.id)), visibleColumns(), plan);
    lastCopy = copy;
    return copy;
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
    field.value = text;
    field.focus({ preventScroll: true });
    field.select();
  }, [clip]);

  const backToSheet = useCallback(() => {
    const field = clip.current;
    if (field) field.value = '';
    if (!field || document.activeElement === field) focusSheet();
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

  const copy = useCallback((): boolean => {
    const made = makeCopy();
    if (!made) return false;
    writeClipboard(made.text, false);
    return true;
  }, [makeCopy, writeClipboard]);

  /** Copy, then Delete; a reader's cut is a copy. */
  const cut = useCallback((): boolean => {
    if (!latest.current.ctl.plan?.permissions.change) return copy();
    const made = makeCopy();
    if (!made) return false;
    writeClipboard(made.text, true);
    deleteTasks();
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
    void run(opsForPaste(grid, view.selection.active, visibleColumns(), view.rows, ctx), PASTE_LABEL);
  }, [contextOf, run, selectNew]);

  // the browser's own clipboard events: on the hidden field after a
  // shortcut, or on the sheet (a browser's Edit menu)
  useEffect(() => {
    const el = root.current;
    if (!el) return undefined;
    const ours = (target: EventTarget | null) => target === clip.current || !keysBelongElsewhere(target);
    const onCopy = (e: ClipboardEvent) => {
      if (!ours(e.target)) return;
      const ready = armed.current;
      armed.current = null;
      const text = ready?.text ?? makeCopy()?.text;
      if (text === undefined || !e.clipboardData) return;
      e.clipboardData.setData('text/plain', text);
      e.preventDefault();
      // a cut from the browser's own menu (the shortcut has deleted already)
      if (e.type === 'cut' && !ready?.cut) deleteTasks();
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
    const canOpen = (kind: PlanDialog['kind']) => DIALOGS_READY.has(kind);
    const info = (tab?: 'notes') => {
      const { sheet: view, ctl: now, openDialog: open } = latest.current;
      const task = now.plan ? selectedTasks(view.selection, now.plan)[0] : undefined;
      if (!task || !canOpen('taskInfo')) return false;
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
    const scrollToTask = () => {
      const { sheet: view, ctl: now } = latest.current;
      const task = now.plan ? selectedTasks(view.selection, now.plan)[0] : undefined;
      if (task) view.reveal(task.id);
    };
    const fit = () => {
      const now = latest.current.ctl.plan;
      const width = root.current?.querySelector<HTMLElement>('.pln-view')?.clientWidth ?? 0;
      if (now && width > 0) setZoom(fitZoom(now.project_start, now.project_finish, width));
    };
    const undo = () => { void latest.current.ctl.undo(); };
    const redo = () => { void latest.current.ctl.redo(); };
    const lockWith = (write: () => Promise<void>) => {
      void write().catch((err: unknown) => {
        if (!isPlanChanged(err)) latest.current.toast(planErrorText(err));
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
      info: (tab?: 'notes') => { info(tab); },
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
      lock: () => lockWith(() => latest.current.ctl.lock()),
      unlock: () => lockWith(() => latest.current.ctl.unlock()),
      open: (kind: 'columns' | 'shortcuts') => latest.current.openDialog({ kind }),
      focusSheet,
      canOpen,
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
  }, [withPlan, selectNew, deleteTasks, confirmDelete, copy, cut, paste, pasteKey, focusSheet, root]);

  return useMemo(() => ({ ...commands, selected, mode, onTimeline, display, zoom }),
    [commands, selected, mode, onTimeline, display, zoom]);
}
