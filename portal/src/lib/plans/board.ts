/**
 * The Board view's columns (spec "Views": Board), pure; components/plans/
 * PlanBoard draws them.
 *
 * - A task's column is its % Complete: 0 Not started, 100 Complete, anything
 *   between In progress (MS Project's own reading of progress). Late is a
 *   badge on the card, not a column.
 * - A drop into a column sets 0 / 50 / 100 (`percentForColumn`); the
 *   toolbar's setPercent builds the op, and 100 goes through the completion
 *   rules like every other 100%.
 * - The cards are the leaf tasks among the rows the filter bar shows, in
 *   outline order; a summary is no card of its own, only the path on its
 *   subtasks' cards ("Prep › Crating", the top summary first).
 */
import type { PlanTask } from './api';
import { ancestors } from './outline';

export type BoardColumn = 'not_started' | 'in_progress' | 'complete';

/** The columns, in order, with their names. */
export const BOARD_COLUMNS: readonly { key: BoardColumn; label: string }[] = [
  { key: 'not_started', label: 'Not started' },
  { key: 'in_progress', label: 'In progress' },
  { key: 'complete', label: 'Complete' },
];

/** One card: the task and the names of the summaries above it. */
export interface BoardCard {
  task: PlanTask;
  /** "Prep › Crating"; '' for a top-level task. */
  path: string;
}

/** The column a task's % Complete puts it in. */
export function columnOf(task: Pick<PlanTask, 'percent_complete'>): BoardColumn {
  if (task.percent_complete >= 100) return 'complete';
  return task.percent_complete > 0 ? 'in_progress' : 'not_started';
}

/** The % Complete a drop into `column` sets. */
export function percentForColumn(column: BoardColumn): 0 | 50 | 100 {
  if (column === 'complete') return 100;
  return column === 'in_progress' ? 50 : 0;
}

/** The names of the summaries above the task, the top one first, joined
 *  with " › "; '' for a top-level task. */
export function pathLabel(id: string, tasksById: ReadonlyMap<string, Pick<PlanTask, 'parent_id' | 'name'>>): string {
  return ancestors(id, tasksById).reverse().map((up) => tasksById.get(up)?.name ?? '').join(' › ');
}

/** The cards for `rows` (task ids in outline order, the filter's), each
 *  leaf task in its column; ids the plan doesn't have are skipped. */
export function boardCards(
  rows: readonly string[], tasksById: ReadonlyMap<string, PlanTask>,
): Record<BoardColumn, BoardCard[]> {
  const out: Record<BoardColumn, BoardCard[]> = { not_started: [], in_progress: [], complete: [] };
  for (const id of rows) {
    const task = tasksById.get(id);
    if (!task || task.is_summary) continue;
    out[columnOf(task)].push({ task, path: pathLabel(id, tasksById) });
  }
  return out;
}
