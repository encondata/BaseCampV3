/**
 * The toolbar's and the keyboard map's task commands (MS Project's Task
 * ribbon), as the ops they send. Pure: components/plans/usePlanCommands
 * calls these with the sheet's selection and posts the answer through
 * PlanController.apply.
 *
 * Each returns `{ops}` or `{error}`, like a cell edit (editOps): a refusal
 * the sheet can tell without asking the API (indenting the first row,
 * linking one task) is said at once and nothing is sent. `{ops: []}` means
 * there is nothing to do (the tasks are already linked). A command that
 * adds tasks and then has to name them (a new summary's subtask) carries
 * `then`, the second batch built from the first one's temp ids: the API
 * can't name a task added earlier in the same batch. Both batches undo as
 * one step (apply's `joinUndo`).
 *
 * "The selection" is the selected rows in the order they were picked
 * (Ctrl-click order; a Shift range top to bottom), else the active cell's
 * row. Outline commands (indent, outdent, delete) act on the selected
 * tasks in outline order, leaving out a task whose summary is selected
 * too, since it goes with its summary (the API's own rule).
 */
import type { Op, Plan, PlanTask, TaskMode } from './api';
import { PLAN_ERRORS } from './errors';
import { ancestors, descendants } from './outline';
import type { Selection } from './selection';

export interface CommandContext {
  plan: Pick<Plan, 'tasks' | 'links'>;
  /** A fresh temp_id for a task the command adds. */
  tempId(): string;
  /** Where a task added at the end goes: the parent of the last row shown
   *  (MS Project's new task takes the level of the one above it). */
  appendParentId?: string | null;
}

/** What a command sends. */
export interface CommandOps {
  ops: Op[];
  /** The second batch, from the first one's temp ids; joined into its undo step. */
  then?: (tempIds: Readonly<Record<string, string>>) => Op[];
  /** The temp id of the task to select once it is added. */
  select?: string;
  /** Ask before sending: the selection takes subtasks with it. */
  confirm?: { tasks: number; subtasks: number };
  /** A paste: filled cells it left out (read-only or hidden columns). */
  skipped?: number;
}

export type Command = CommandOps | { error: string };

export const SELECT_FIRST = 'Select a task first.';
export const SELECT_TWO = 'Select two or more tasks to link.';

export type InsertKind = 'task' | 'milestone' | 'summary';

const NEW_NAMES: Record<InsertKind, string> = {
  task: 'New Task',
  milestone: 'New Milestone',
  summary: 'New Summary Task',
};

/** The selected tasks in the order they were picked, else the active row's. */
export function selectedTasks(sel: Selection, plan: Pick<Plan, 'tasks'>): PlanTask[] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const picked = [...sel.rows].map((id) => byId.get(id)).filter((t): t is PlanTask => t !== undefined);
  if (picked.length) return picked;
  const active = sel.active && sel.active.id !== 'blank' ? byId.get(sel.active.id) : undefined;
  return active ? [active] : [];
}

/** The selected tasks in outline order, without those whose summary is selected too. */
function topsInOrder(sel: Selection, plan: Pick<Plan, 'tasks'>): PlanTask[] {
  const chosen = new Set(selectedTasks(sel, plan).map((t) => t.id));
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  return plan.tasks.filter((t) => chosen.has(t.id) && !ancestors(t.id, byId).some((up) => chosen.has(up)));
}

/** MS Project's Insert: a new task right above the active row (at the end
 *  on the blank row or with nothing active), a milestone (zero duration),
 *  or a summary with one new subtask. */
export function insertTask(sel: Selection, kind: InsertKind, ctx: CommandContext): Command {
  const at = sel.active && sel.active.id !== 'blank' && ctx.plan.tasks.some((t) => t.id === sel.active?.id)
    ? sel.active.id : null;
  const where = at !== null ? { before_id: at } : { parent_id: ctx.appendParentId ?? null };
  const add = (name: string, extra: Partial<Extract<Op, { op: 'add_task' }>> = {}) => {
    const temp = ctx.tempId();
    return { temp, op: { op: 'add_task', temp_id: temp, ...where, name, ...extra } as Op };
  };
  if (kind === 'summary') {
    const summary = add(NEW_NAMES.summary);
    const child = add(NEW_NAMES.task);
    return {
      ops: [summary.op, child.op],
      // the subtask goes under the summary right above it
      then: (ids) => (ids[child.temp] ? [{ op: 'indent', ids: [ids[child.temp]] }] : []),
      select: summary.temp,
    };
  }
  const task = kind === 'milestone' ? add(NEW_NAMES.milestone, { duration: '0' }) : add(NEW_NAMES.task);
  return { ops: [task.op], select: task.temp };
}

/** Deletes the selected tasks with their subtasks; asks first when a
 *  summary takes subtasks with it (the spec's Delete). */
export function deleteSelected(sel: Selection, ctx: CommandContext): Command {
  const tops = topsInOrder(sel, ctx.plan);
  if (!tops.length) return { error: SELECT_FIRST };
  const ops: Op[] = [{ op: 'delete_tasks', ids: tops.map((t) => t.id) }];
  const subtasks = tops.reduce((n, t) => n + (t.is_summary ? descendants(t.id, ctx.plan.tasks).length : 0), 0);
  return subtasks ? { ops, confirm: { tasks: tops.length, subtasks } } : { ops };
}

/** Each selected task becomes the last subtask of the task above it at its
 *  level; the first task at a level can't be indented. */
export function indentSelected(sel: Selection, ctx: CommandContext): Command {
  const tops = topsInOrder(sel, ctx.plan);
  if (!tops.length) return { error: SELECT_FIRST };
  const first = tops[0];
  const at = ctx.plan.tasks.indexOf(first);
  if (!ctx.plan.tasks.slice(0, at).some((t) => t.parent_id === first.parent_id)) {
    return { error: PLAN_ERRORS.cannot_indent };
  }
  return { ops: [{ op: 'indent', ids: tops.map((t) => t.id) }] };
}

/** Each selected task moves up a level (the tasks after it at its old
 *  level become its subtasks, as in MS Project). */
export function outdentSelected(sel: Selection, ctx: CommandContext): Command {
  const tops = topsInOrder(sel, ctx.plan);
  if (!tops.length) return { error: SELECT_FIRST };
  if (tops.some((t) => t.parent_id === null)) return { error: PLAN_ERRORS.cannot_outdent };
  return { ops: [{ op: 'outdent', ids: tops.map((t) => t.id) }] };
}

/** Finish-to-Start links between the selected tasks, in the order they were
 *  picked, skipping a pair that is linked already. */
export function linkSelected(sel: Selection, ctx: CommandContext): Command {
  const chosen = selectedTasks(sel, ctx.plan);
  if (chosen.length < 2) return { error: SELECT_TWO };
  const linked = new Set(ctx.plan.links.map((l) => `${l.predecessor_id}>${l.successor_id}`));
  const ops: Op[] = [];
  for (let i = 1; i < chosen.length; i += 1) {
    const [pred, succ] = [chosen[i - 1].id, chosen[i].id];
    if (linked.has(`${pred}>${succ}`)) continue;
    linked.add(`${pred}>${succ}`);
    ops.push({ op: 'add_link', predecessor_id: pred, successor_id: succ, link_type: 'FS' });
  }
  return { ops };
}

/** Every link among the selected tasks; with one task, every link into
 *  and out of it (MS Project's Unlink). */
export function unlinkSelected(sel: Selection, ctx: CommandContext): Command {
  const chosen = new Set(selectedTasks(sel, ctx.plan).map((t) => t.id));
  if (!chosen.size) return { error: SELECT_FIRST };
  const goes = chosen.size === 1
    ? (pred: string, succ: string) => chosen.has(pred) || chosen.has(succ)
    : (pred: string, succ: string) => chosen.has(pred) && chosen.has(succ);
  return {
    ops: ctx.plan.links.filter((l) => goes(l.predecessor_id, l.successor_id))
      .map((l): Op => ({ op: 'delete_link', id: l.id })),
  };
}

/** The toolbar's 0%–100%: below 100 a summary's % is derived, so only the
 *  selected subtasks take it; 100 completes summaries too. */
export function setPercent(sel: Selection, percent: number, ctx: CommandContext): Command {
  const chosen = selectedTasks(sel, ctx.plan);
  if (!chosen.length) return { error: SELECT_FIRST };
  const ids = (percent === 100 ? chosen : chosen.filter((t) => !t.is_summary)).map((t) => t.id);
  if (!ids.length) return { error: PLAN_ERRORS.summary_field };
  return { ops: [{ op: 'set_percent', ids, percent }] };
}

/** Mark on Track: each task (a summary: its subtasks) to its scheduled %. */
export function markOnTrack(sel: Selection, ctx: CommandContext): Command {
  const chosen = selectedTasks(sel, ctx.plan);
  if (!chosen.length) return { error: SELECT_FIRST };
  return { ops: [{ op: 'mark_on_track', ids: chosen.map((t) => t.id) }] };
}

/** Auto Schedule / Manually Schedule for each selected task not already so. */
export function setMode(sel: Selection, mode: TaskMode, ctx: CommandContext): Command {
  const chosen = selectedTasks(sel, ctx.plan);
  if (!chosen.length) return { error: SELECT_FIRST };
  return {
    ops: chosen.filter((t) => t.mode !== mode)
      .map((t): Op => ({ op: 'update_task', id: t.id, fields: { mode } })),
  };
}

/** Add to Timeline: on for every selected task unless all are on already,
 *  then off for all. */
export function toggleTimeline(sel: Selection, ctx: CommandContext): Command {
  const chosen = selectedTasks(sel, ctx.plan);
  if (!chosen.length) return { error: SELECT_FIRST };
  const on = !chosen.every((t) => t.show_on_timeline);
  return {
    ops: chosen.filter((t) => t.show_on_timeline !== on)
      .map((t): Op => ({ op: 'update_task', id: t.id, fields: { show_on_timeline: on } })),
  };
}

/** The mode the Auto / Manual pair shows: the selection's, when it agrees. */
export function selectionMode(sel: Selection, plan: Pick<Plan, 'tasks'>): TaskMode | null {
  const modes = new Set(selectedTasks(sel, plan).map((t) => t.mode));
  return modes.size === 1 ? [...modes][0] : null;
}
