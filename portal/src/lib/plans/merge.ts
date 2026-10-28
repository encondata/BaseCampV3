/**
 * The plan after one ops batch. A batch answers only what it changed
 * (OpsOut: the changed task and link rows, the deleted ids, the whole
 * outline order when anything moved), so the client puts the rest back
 * together: changed rows replace theirs by id, deleted rows and the links
 * into them go, `order` (when sent) is the new outline order, and every
 * task's display ID, WBS, level, summary flag and Predecessors /
 * Successors text is renumbered by computeOutline (the API's own rules).
 * A row whose numbers did not move keeps its object, so a memoized sheet
 * row does not redraw.
 */
import type { OpsResult, Plan, PlanLink, PlanTask } from './api';
import { STANDARD_UNITS, unitsOf, type Units } from './durations';
import { computeOutline, type Outline } from './outline';

/** A plan with its outline, which every view reads its numbers from. */
export interface PlanView {
  plan: Plan;
  outline: Outline;
}

/** The calendar's units; Standard ones for a calendar the API would never
 *  have stored (unitsOf throws on one). */
export function planUnits(plan: Pick<Plan, 'calendar'>): Units {
  try {
    return unitsOf(plan.calendar);
  } catch {
    return STANDARD_UNITS;
  }
}

/** The task with the outline's numbers, or the same object when they agree. */
function numbered(task: PlanTask, outline: Outline): PlanTask {
  const row = outline.get(task.id);
  if (!row) return task;
  if (task.display_id === row.displayId && task.wbs === row.wbs && task.outline_level === row.level
    && task.is_summary === row.isSummary && task.predecessors === row.predecessors
    && task.successors === row.successors) {
    return task;
  }
  return {
    ...task,
    display_id: row.displayId,
    wbs: row.wbs,
    outline_level: row.level,
    is_summary: row.isSummary,
    predecessors: row.predecessors,
    successors: row.successors,
  };
}

/** The latest task finish (plan times compare as text); null for no tasks. */
function latestFinish(tasks: readonly PlanTask[]): string | null {
  let latest: string | null = null;
  for (const task of tasks) {
    if (task.finish !== null && (latest === null || task.finish > latest)) latest = task.finish;
  }
  return latest;
}

/** `tasks` (in outline order) and `links` as a view: outline computed, rows renumbered. */
function viewOf(plan: Plan, tasks: readonly PlanTask[], links: PlanLink[]): PlanView {
  const outline = computeOutline(tasks, tasks.map((t) => t.id), links, planUnits(plan));
  const ordered = tasks.map((task) => numbered(task, outline));
  const same = ordered.length === plan.tasks.length && ordered.every((t, i) => t === plan.tasks[i]);
  return {
    plan: same && links === plan.links ? plan : { ...plan, tasks: same ? plan.tasks : ordered, links },
    outline,
  };
}

/** A plan as the API sent it (GET, PATCH, lock, baseline), with its outline. */
export function planView(plan: Plan): PlanView {
  return viewOf(plan, plan.tasks, plan.links);
}

/** `plan` after the batch that answered `out`, at `out.version`. */
export function mergeOps(plan: Plan, out: OpsResult): PlanView {
  const deletedTasks = new Set(out.deleted_tasks);
  const changedTasks = new Map(out.tasks.map((t) => [t.id, t]));
  const oldTasks = new Map(plan.tasks.map((t) => [t.id, t]));

  // the outline order: `order` when the batch moved anything, else the old
  // one; then any row neither names (a new task, should `order` be missing)
  const tasks: PlanTask[] = [];
  const placed = new Set<string>();
  const place = (id: string) => {
    if (placed.has(id) || deletedTasks.has(id)) return;
    const task = changedTasks.get(id) ?? oldTasks.get(id);
    if (!task) return;
    placed.add(id);
    tasks.push(task);
  };
  for (const id of out.order ?? plan.tasks.map((t) => t.id)) place(id);
  for (const task of plan.tasks) place(task.id);
  for (const task of out.tasks) place(task.id);

  // links: changed ones replace theirs, new ones follow; none may outlive a task
  const deletedLinks = new Set(out.deleted_links);
  const changedLinks = new Map(out.links.map((l) => [l.id, l]));
  const links: PlanLink[] = [];
  const seenLinks = new Set<string>();
  for (const link of [...plan.links, ...out.links]) {
    if (seenLinks.has(link.id) || deletedLinks.has(link.id)) continue;
    seenLinks.add(link.id);
    const current = changedLinks.get(link.id) ?? link;
    if (placed.has(current.predecessor_id) && placed.has(current.successor_id)) links.push(current);
  }

  return viewOf({ ...plan, version: out.version, project_finish: latestFinish(tasks) }, tasks, links);
}
