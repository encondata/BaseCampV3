/**
 * The Gantt view's shared state (PlanTab owns one): the rows the sheet and
 * the chart show (the outline less collapsed subtasks), which summaries are
 * collapsed (per plan in localStorage `plans.collapsed.<planId>`), the
 * selection, and the `&task=` deep link (handled once per plan and task id).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from 'react';

import type { PlanTask } from '../../lib/plans/api';
import { SHEET_HEAD_PX } from '../../lib/plans/columns';
import { ancestors, visibleRows } from '../../lib/plans/outline';
import { EMPTY_SELECTION, selectCell, type Selection } from '../../lib/plans/selection';
import type { PlanController } from './usePlan';

const COLLAPSED_PREFIX = 'plans.collapsed.';
const NO_TASKS: PlanTask[] = [];

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

/**
 * The Gantt view's shared state: the rows the sheet and the chart show,
 * which summaries are collapsed, the selection, and the `&task=` deep
 * link (handled once per plan and task id).
 */
export function useSheetView(ctl: PlanController, taskParam: string | null,
  scrollRef: RefObject<HTMLDivElement | null>, rowHeight: number) {
  const plan = ctl.plan;
  const planId = plan?.id ?? null;
  const tasks = plan?.tasks ?? NO_TASKS;
  const tasksById = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const order = useMemo(() => tasks.map((t) => t.id), [tasks]);

  const stored = useMemo(() => (planId ? readCollapsed(planId) : new Set<string>()), [planId]);
  const [changed, setChanged] = useState<{ planId: string; ids: Set<string> } | null>(null);
  const collapsed = changed && changed.planId === planId ? changed.ids : stored;

  // what the callbacks below read, so they keep one identity for the life
  // of the view: every mounted sheet row takes them as props, and a new
  // function after each op would redraw every row
  const latest = useRef({ planId, collapsed, tasksById });
  useLayoutEffect(() => {
    latest.current = { planId, collapsed, tasksById };
  }, [planId, collapsed, tasksById]);

  const setCollapsed = useCallback((ids: Set<string>) => {
    const { planId: id, tasksById: byId } = latest.current;
    if (!id) return;
    latest.current = { ...latest.current, collapsed: ids };
    setChanged({ planId: id, ids });
    writeCollapsed(id, [...ids].filter((t) => byId.has(t)));
  }, []);

  const rows = useMemo(() => visibleRows(order, tasksById, collapsed), [order, tasksById, collapsed]);

  // another plan (another initiative) starts with nothing selected
  const [selection, setSelection] = useState<Selection>(EMPTY_SELECTION);
  const [selectionPlan, setSelectionPlan] = useState(planId);
  if (selectionPlan !== planId) {
    setSelectionPlan(planId);
    setSelection(EMPTY_SELECTION);
  }

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

  const linked = useRef<string | null>(null);
  const [scrollTo, setScrollTo] = useState<string | null>(null);
  useEffect(() => {
    if (!planId || !taskParam) return;
    const key = `${planId}:${taskParam}`;
    if (linked.current === key) return;
    linked.current = key;
    if (!tasksById.has(taskParam)) return;
    const closed = ancestors(taskParam, tasksById).filter((id) => collapsed.has(id));
    if (closed.length) setCollapsed(new Set([...collapsed].filter((id) => !closed.includes(id))));
    setSelection(selectCell(taskParam, 'name'));
    setScrollTo(taskParam);
  }, [planId, taskParam, tasksById, collapsed, setCollapsed]);

  // runs once the rows include the task, so the scroll box is tall enough
  useEffect(() => {
    if (!scrollTo) return;
    const index = rows.indexOf(scrollTo);
    const box = scrollRef.current;
    if (index < 0 || !box) return;
    const below = Math.max(0, box.clientHeight - SHEET_HEAD_PX - rowHeight);
    box.scrollTop = Math.max(0, index * rowHeight - below / 2);
    setScrollTo(null);
  }, [scrollTo, rows, rowHeight, scrollRef]);

  return { rows, collapsed, toggleCollapse, selection, select: setSelection };
}
