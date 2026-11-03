/**
 * Moving whole tasks in the outline, as pure functions: a row dragged by
 * its ID (components/plans/useRowDrag) and a cut pasted back into its own
 * plan (usePlanCommands) both send one `move_tasks` op, which keeps every
 * task as it is — its id, links, progress and baseline — and changes only
 * where it sits. The API does the move (plans/ops_tasks.move_tasks): the
 * tasks, each with its subtasks, right above `before_id` as its siblings,
 * else at the end of `parent_id`'s subtasks, else at the end of the plan.
 *
 * - `moveTops`: the tasks a move takes — the top-most of those picked, in
 *   outline order (a subtask whose summary moves goes with it).
 * - `moveOp`: the op that puts them at a place; `'inside'` when the place
 *   is in what moves (the API's 422 `cannot_move`), null when they are
 *   there already (nothing to send).
 * - `dropGap` / `dropPlace`: where a drag over the sheet's rows would land
 *   — the gap between rows nearest the pointer; above the row there, or
 *   below the last row at the end of the plan; never above a context row.
 */
import type { MoveTasksOp, Plan, PlanTask } from './api';
import { ancestors } from './outline';

type Tasks = Pick<Plan, 'tasks'>;
type ById = ReadonlyMap<string, Pick<PlanTask, 'parent_id'>>;

/** Where moved tasks go: right above `beforeId`, as its siblings; with
 *  `beforeId` null, at the end of `parentId`'s subtasks (null or left
 *  out: the end of the plan). */
export interface MovePlace {
  beforeId: string | null;
  parentId?: string | null;
}

/** The top-most of `ids`, in outline order: each brings its subtasks. */
export function moveTops(ids: Iterable<string>, plan: Tasks): string[] {
  const chosen = new Set(ids);
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  return plan.tasks
    .filter((t) => chosen.has(t.id) && !ancestors(t.id, byId).some((up) => chosen.has(up)))
    .map((t) => t.id);
}

/** True when `id` is one of `tops` or a subtask of one: what moves. */
export function insideMoved(id: string, tops: readonly string[], byId: ById): boolean {
  const moving = new Set(tops);
  return moving.has(id) || ancestors(id, byId).some((up) => moving.has(up));
}

/** The one op that puts `tops` (moveTops) at `place`: `'inside'` when the
 *  place is in what moves, null when nothing would change. */
export function moveOp(plan: Tasks, tops: readonly string[], place: MovePlace): MoveTasksOp | 'inside' | null {
  if (!tops.length) return null;
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const before = place.beforeId;
  const target = before ?? place.parentId ?? null;
  if (target !== null && !byId.has(target)) return null;
  if (target !== null && insideMoved(target, tops, byId)) return 'inside';
  const parent = before !== null ? byId.get(before)?.parent_id ?? null : place.parentId ?? null;
  // the parent's subtasks now, and after the move: the same order means it is there already
  const siblings = plan.tasks.filter((t) => t.parent_id === parent).map((t) => t.id);
  const moving = new Set(tops);
  const rest = siblings.filter((id) => !moving.has(id));
  const at = before !== null ? rest.indexOf(before) : rest.length;
  const after = [...rest.slice(0, at), ...tops, ...rest.slice(at)];
  if (after.length === siblings.length && after.every((id, i) => id === siblings[i])) return null;
  const op: MoveTasksOp = { op: 'move_tasks', ids: [...tops] };
  if (before !== null) op.before_id = before;
  else if (place.parentId != null) op.parent_id = place.parentId;
  return op;
}

/** The gap between rows nearest a point `y` px down the rows: 0 above the
 *  first, `count` below the last. */
export function dropGap(y: number, rowHeight: number, count: number): number {
  return Math.min(Math.max(Math.round(y / rowHeight), 0), count);
}

/** Where a drop at `gap` lands among `rows` (by task id): above the row
 *  there, or the end of the plan below the last; null above a context row
 *  (`inert`), which is only there to place a match. */
export function dropPlace(gap: number, rows: readonly string[], inert: (key: string) => boolean): MovePlace | null {
  if (gap >= rows.length) return { beforeId: null };
  const key = rows[gap];
  return inert(key) ? null : { beforeId: key };
}
