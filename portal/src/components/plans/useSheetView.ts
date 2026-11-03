/**
 * The Gantt view's shared state (PlanTab owns one): the rows the sheet and
 * the chart show, which summaries are collapsed (per plan in localStorage
 * `plans.collapsed.<planId>`), the filter bar's view (per plan in
 * `plans.view.<planId>`, lib/plans/filters), the selection, and the
 * `&task=` deep link (handled once per plan and task id: its row selected
 * and scrolled into view here, its bar in the chart by `onLinked`).
 *
 * The rows, in order:
 *  1. The filter and the search (lib/plans/filters): the tasks that match,
 *     plus their summary tasks as context rows — dimmed and inert, never
 *     selected — so the outline holds. A filter applies when it is picked
 *     (MS Project's way): the tasks it matched then stay, and so do tasks
 *     added since, until the filter is picked again (the one on now too),
 *     the search or the status date changes. So a task you just edited or
 *     added never disappears from under you.
 *  2. Collapse composes with it: a collapsed summary's subtasks are out,
 *     unless the summary is a context row (it is only there to place a
 *     match, so it is always open — the initiatives tree's rule). Collapse
 *     is the sheet's: the Calendar and the Board (`collapsible` off) show
 *     every task the filter keeps.
 *  3. Group by (the Gantt view only): the leaf tasks under a band per
 *     resource or status, a task with two resources under both. Grouped
 *     rows have keys of their own (filters `rowKey`, `bandKey`); ungrouped
 *     a row's key is its task's id.
 *
 * The sheet and the chart select rows (`selection`, by row key: a task on
 * two rows can be picked on either); the commands work on tasks
 * (`forCommands`, by task id, its rows the tasks shown once each; a paste
 * while grouped walks the rows on screen from the active one). The
 * mapping between the two is lib/plans/viewRows. A selection whose rows a
 * new filter or grouping hid is moved to the task's row there, or
 * dropped; one left on a grouped row when grouping goes is its task again.
 * While grouped the outline and the links can't change: Insert, Indent,
 * Outdent, Link, Unlink and pasting new rows say "Turn off Group by to
 * change the outline". Scroll to Task scrolls to the row picked (a task's
 * second copy, say), else to the task's first row.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import type { PlanTask } from '../../lib/plans/api';
import { SHEET_HEAD_PX } from '../../lib/plans/columns';
import {
  DEFAULT_VIEW, filterCount, groupRows, groupedRows, isBandRow, isFiltering, matchingIds, readView, taskOfRow,
  withContext, writeView, type GroupBand, type PlanViewState,
} from '../../lib/plans/filters';
import { ancestors, visibleRows } from '../../lib/plans/outline';
import { EMPTY_SELECTION, selectCell, type Selection } from '../../lib/plans/selection';
import {
  firstRowsOf, pasteRowsFrom, taskRowsOf, taskSelection as asTasks, viewSelection,
} from '../../lib/plans/viewRows';
import type { PlanController } from './usePlan';
import type { SheetState } from './usePlanCommands';

const COLLAPSED_PREFIX = 'plans.collapsed.';
const NO_TASKS: PlanTask[] = [];
const NO_KEYS: ReadonlySet<string> = new Set();
const NO_BANDS: ReadonlyMap<string, GroupBand> = new Map();

/** The summaries collapsed in this browser for the plan. */
function readCollapsed(planId: string): Set<string> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(COLLAPSED_PREFIX + planId) ?? '[]');
    return new Set(Array.isArray(stored) ? stored.filter((id): id is string => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

function writeCollapsed(planId: string, ids: Iterable<string>): void {
  try {
    localStorage.setItem(COLLAPSED_PREFIX + planId, JSON.stringify([...ids]));
  } catch {
    // storage refused: the choice lasts this visit only
  }
}

/** What a filter matched when it was applied, and the tasks there were then. */
interface Applied {
  key: string;
  matched: ReadonlySet<string>;
  known: ReadonlySet<string>;
}

export interface SheetViewOptions {
  /** The signed-in person's id (Assigned to Me). */
  me?: string;
  /** Group by applies (the Gantt view). */
  groupable?: boolean;
  /** Collapsed summaries hide their subtasks (the Gantt view's sheet). */
  collapsible?: boolean;
  /** The `&task=` deep link was handled for this task (the tab scrolls the
   *  chart to its bar). */
  onLinked?(taskId: string): void;
}

/**
 * The Gantt view's shared state: the rows the sheet and the chart show,
 * collapse, the filter bar's view, the selection, and the `&task=` deep
 * link (handled once per plan and task id).
 */
export function useSheetView(ctl: PlanController, taskParam: string | null,
  scrollRef: RefObject<HTMLDivElement | null>, rowHeight: number, options: SheetViewOptions = {}) {
  const { me = '', groupable = true, collapsible = true, onLinked } = options;
  const linkedTo = useRef(onLinked);
  useLayoutEffect(() => {
    linkedTo.current = onLinked;
  });
  const plan = ctl.plan;
  const planId = plan?.id ?? null;
  const tasks = plan?.tasks ?? NO_TASKS;
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const order = useMemo(() => tasks.map((t) => t.id), [tasks]);

  const stored = useMemo(() => (planId ? readCollapsed(planId) : new Set<string>()), [planId]);
  const [changed, setChanged] = useState<{ planId: string; ids: Set<string> } | null>(null);
  const collapsed = changed && changed.planId === planId ? changed.ids : stored;

  // ── the filter bar's view, kept per plan ──
  const storedView = useMemo(() => (planId ? readView(planId) : DEFAULT_VIEW), [planId]);
  const [picked, setPicked] = useState<{ planId: string; view: PlanViewState } | null>(null);
  const view = picked && picked.planId === planId ? picked.view : storedView;
  const grouped = groupable && view.group !== 'none';
  const filtering = isFiltering(view.filter, view.search);

  // a filter applies when it is picked: what it matched then, and the tasks there were
  const nowS = plan ? plan.status_date ?? plan.now : '';
  const statusDate = plan?.status_date ?? null;
  // every pick of a filter applies it afresh, the one on now too
  const [applySeq, setApplySeq] = useState(0);
  const applyKey = filtering && planId
    ? JSON.stringify([planId, view.filter, view.search.trim().toLowerCase(), me, statusDate, applySeq]) : '';
  const [applied, setApplied] = useState<Applied | null>(null);
  let filter = applied;
  if (applyKey && applied?.key !== applyKey) {
    filter = {
      key: applyKey,
      matched: matchingIds(order, tasksById, view.filter, view.search, me, nowS),
      known: new Set(order),
    };
    setApplied(filter);
  } else if (!applyKey && applied) {
    // cleared: picking the same filter again applies it afresh
    filter = null;
    setApplied(null);
  }

  // what the callbacks below read, so they keep one identity for the life
  // of the view: every mounted sheet row takes them as props, and a new
  // function after each op would redraw every row
  const latest = useRef({ planId, collapsed, tasksById, view });
  useLayoutEffect(() => {
    latest.current = { planId, collapsed, tasksById, view };
  }, [planId, collapsed, tasksById, view]);

  const setCollapsed = useCallback((ids: Set<string>) => {
    const { planId: id, tasksById: byId } = latest.current;
    if (!id) return;
    latest.current = { ...latest.current, collapsed: ids };
    setChanged({ planId: id, ids });
    writeCollapsed(id, [...ids].filter((t) => byId.has(t)));
  }, []);

  /** Changes the filter bar's view (and keeps it for the plan). */
  const setView = useCallback((change: Partial<PlanViewState>) => {
    const { planId: id, view: now } = latest.current;
    if (!id) return;
    const next = { ...now, ...change };
    latest.current = { ...latest.current, view: next };
    setPicked({ planId: id, view: next });
    if (change.filter !== undefined) setApplySeq((n) => n + 1);
    writeView(id, next);
  }, []);

  // ── the rows ──
  const shown = useMemo(() => {
    if (!filtering || !filter) return { rows: order, context: NO_KEYS as ReadonlySet<string> };
    const kept = new Set(filter.matched);
    for (const id of order) if (!filter.known.has(id)) kept.add(id);
    const { rows, context } = withContext(order, tasksById, kept);
    return { rows, context: context as ReadonlySet<string> };
  }, [filtering, filter, order, tasksById]);

  const layout = useMemo(() => {
    if (grouped) {
      const g = groupedRows(groupRows(shown.rows, tasksById, view.group));
      return { rows: g.rows, context: NO_KEYS, bands: g.bands as ReadonlyMap<string, GroupBand> };
    }
    if (!collapsible) return { rows: shown.rows, context: shown.context, bands: NO_BANDS };
    // a context row is only there to place a match: always open
    const shut = shown.context.size ? new Set([...collapsed].filter((id) => !shown.context.has(id))) : collapsed;
    return { rows: visibleRows(shown.rows, tasksById, shut), context: shown.context, bands: NO_BANDS };
  }, [grouped, collapsible, shown, tasksById, view.group, collapsed]);
  const { rows, context, bands } = layout;

  /** A row nobody selects: a context row, a band. */
  const inert = useCallback((key: string) => isBandRow(key) || context.has(key), [context]);
  /** Each task's first row (grouped: the first band it is under). */
  const firstRows = useMemo(() => firstRowsOf(rows, inert), [rows, inert]);

  // ── the selection: by row (the panes), and by task (the commands) ──
  // another plan (another initiative) starts with nothing selected
  const [picks, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [selectionPlan, setSelectionPlan] = useState(planId);
  if (selectionPlan !== planId) {
    setSelectionPlan(planId);
    setSelection(EMPTY_SELECTION);
  }
  const shaped = grouped || filtering;
  const selection = useMemo(() => viewSelection(picks, { rows, inert, shaped, grouped, firstRows }),
    [picks, rows, inert, shaped, grouped, firstRows]);

  const toggleCollapse = useCallback((id: string) => {
    const { collapsed: now, tasksById: byId } = latest.current;
    const next = new Set(now);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
      // the active cell's row going out of sight: the summary takes it (MS Project)
      setSelection((sel) => (sel.active && sel.active.id !== 'blank'
        && ancestors(sel.active.id, byId).includes(id) ? selectCell(id, sel.active.col) : sel));
    }
    setCollapsed(next);
  }, [setCollapsed]);

  /**
   * Shows the task: its collapsed summaries open; a filter or search that
   * hides it is cleared; grouping goes when it's a summary (grouping shows
   * leaf tasks only). True when the plan has it.
   */
  const showTask = useCallback((id: string, keptNow: (task: string) => boolean): boolean => {
    const { collapsed: now, tasksById: byId, view: v } = latest.current;
    const task = byId.get(id);
    if (!task) return false;
    const closed = ancestors(id, byId).filter((a) => now.has(a));
    if (closed.length) setCollapsed(new Set([...now].filter((a) => !closed.includes(a))));
    const change: Partial<PlanViewState> = {};
    if (!keptNow(id)) Object.assign(change, { filter: 'all', search: '' });
    if (v.group !== 'none' && task.is_summary) change.group = 'none';
    if (Object.keys(change).length) setView(change);
    return true;
  }, [setCollapsed, setView]);

  // what the deep link and Go to task read of the rows
  const shownNow = useRef(shown);
  useLayoutEffect(() => {
    shownNow.current = shown;
  }, [shown]);
  const kept = useCallback((task: string) => {
    const s = shownNow.current;
    return s.rows.includes(task) && !s.context.has(task);
  }, []);

  const linked = useRef<string | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  useEffect(() => {
    if (!planId || !taskParam) return;
    const key = `${planId}:${taskParam}`;
    if (linked.current === key) return;
    linked.current = key;
    if (!showTask(taskParam, kept)) return;
    // the task's id: the selection moves it to its row once the rows have it
    setSelection(selectCell(taskParam, 'name'));
    setScrollTo(taskParam);
    linkedTo.current?.(taskParam);
  }, [planId, taskParam, showTask, kept]);

  // runs once the rows include the task, so the scroll box is tall enough;
  // to the row picked when it is the task's (a second copy), else its first
  useEffect(() => {
    if (!scrollTo) return;
    const active = selection.active?.id ?? null;
    const at = active !== null && taskOfRow(active) === scrollTo ? active : firstRows.get(scrollTo) ?? scrollTo;
    const index = rows.indexOf(at);
    const box = scrollRef.current;
    if (index < 0 || !box) return;
    const below = Math.max(0, box.clientHeight - SHEET_HEAD_PX - rowHeight);
    box.scrollTop = Math.max(0, index * rowHeight - below / 2);
    setScrollTo(null);
  }, [scrollTo, rows, firstRows, rowHeight, scrollRef, selection]);

  /** Scrolls the task's row to the middle of the view (Scroll to task). */
  const reveal = useCallback((id: string) => setScrollTo(id), []);

  /** Go to task (the completion check's): the task shown (showTask), its
   *  row selected and scrolled to the middle of the view. */
  const goTo = useCallback((id: string) => {
    if (!showTask(id, kept)) return;
    setSelection(selectCell(id, 'name'));
    setScrollTo(id);
  }, [showTask, kept]);

  // the commands' view: tasks, each once, in the order shown; a paste
  // while grouped walks the rows on screen from the active one
  const taskRows = useMemo(() => (grouped || context.size ? taskRowsOf(firstRows) : rows),
    [grouped, context, firstRows, rows]);
  const taskSelection = useMemo(() => asTasks(selection), [selection]);
  const activeKey = selection.active?.id ?? null;
  const pasteRows = useMemo(() => (grouped ? pasteRowsFrom(rows, inert, activeKey) : taskRows),
    [grouped, rows, inert, activeKey, taskRows]);
  const forCommands = useMemo<SheetState>(() => ({
    rows: taskRows, pasteRows, collapsed, selection: taskSelection, select: setSelection, toggleCollapse, reveal, goTo,
    grouped,
  }), [taskRows, pasteRows, collapsed, taskSelection, toggleCollapse, reveal, goTo, grouped]);

  const counts = useMemo(() => (filtering
    ? filterCount(shown.rows, shown.context, tasksById, view.filter, grouped) : null),
  [filtering, shown, tasksById, view.filter, grouped]);

  return {
    rows, context, bands, collapsed, toggleCollapse, selection, select: setSelection, reveal, goTo,
    view, setView, grouped, filtering, counts, forCommands,
  };
}
