/**
 * The filter bar's rows (spec "Views": Filter, search, Group by), pure.
 *
 * - A filter and a search keep the outline (`filterRows`): the tasks that
 *   match both, plus each one's summary tasks as context rows — dimmed and
 *   inert, the initiatives tree's rule — so a matching subtask keeps its
 *   place. A summary that matches is a result itself; its subtasks that
 *   don't match stay out.
 * - The filters: All Tasks; Incomplete Tasks (under 100%); Late Tasks (not
 *   finished, its finish — or its deadline, when earlier — before the
 *   plan's now: the API's own `task_status` rule, so the Status column says
 *   Late for the same tasks); Critical (leaf tasks on the critical path, as
 *   the chart draws them red); Milestones; Due This Week (not finished,
 *   finishing in the Monday-first week of the plan's now, the portal's
 *   week); Assigned to Me (the signed-in person among its resources);
 *   Summary Tasks. "Now" is the plan's: its status date when set, else its
 *   own clock — plan-local floating time, never the browser's.
 * - The search matches the task's name, notes and resource names, ignoring
 *   case.
 * - Group by (`groupRows`) lists the leaf tasks under a band per resource
 *   (a task with two resources under both; "Unassigned" last) or per status
 *   (Late, In progress, Not started, Complete). Grouped rows have keys of
 *   their own (`rowKey`): a task can be on two rows, so a row is its group
 *   and its task; a band's key is its group's alone (`bandKey`). Ungrouped,
 *   a row's key is its task's id.
 * - The view (filter, search, group) is kept per plan in this browser,
 *   localStorage `plans.view.<planId>`.
 */
import { naturalCompare } from '../naturalSort';
import type { PlanTask, TaskStatus } from './api';
import { STATUS_LABELS } from './columns';
import { toMs } from './floatingTime';
import { MS_PER_DAY } from './ganttGeometry';
import { ancestors } from './outline';

export type PlanFilter = 'all' | 'incomplete' | 'late' | 'critical' | 'milestones' | 'due_week' | 'mine' | 'summary';
export type PlanGroupBy = 'none' | 'assignee' | 'status';

/** The Filter list, in the spec's order, named as MS Project names its filters. */
export const PLAN_FILTERS: readonly { value: PlanFilter; label: string }[] = [
  { value: 'all', label: 'All Tasks' },
  { value: 'incomplete', label: 'Incomplete Tasks' },
  { value: 'late', label: 'Late Tasks' },
  { value: 'critical', label: 'Critical' },
  { value: 'milestones', label: 'Milestones' },
  { value: 'due_week', label: 'Due This Week' },
  { value: 'mine', label: 'Assigned to Me' },
  { value: 'summary', label: 'Summary Tasks' },
];

/** The Group by list. */
export const PLAN_GROUPS: readonly { value: PlanGroupBy; label: string }[] = [
  { value: 'none', label: 'No Group' },
  { value: 'assignee', label: 'Resource' },
  { value: 'status', label: 'Status' },
];

type FilterTask = Pick<PlanTask, 'name' | 'notes' | 'assignees' | 'percent_complete' | 'finish' | 'deadline'
  | 'is_critical' | 'is_summary' | 'is_milestone'>;

/** The Monday-first week `nowS` is in, as [start, end) ms. */
function weekOf(nowS: string): [number, number] {
  const day = Math.floor(toMs(nowS) / MS_PER_DAY);
  // the epoch's day 0 was a Thursday: (day + 3) mod 7 counts from Monday
  const monday = (day - (((day + 3) % 7) + 7) % 7) * MS_PER_DAY;
  return [monday, monday + 7 * MS_PER_DAY];
}

const msOrNaN = (s: string | null): number => (s ? toMs(s) : Number.NaN);

/** Whether the task passes `filter` and `search` (trimmed, any case). */
export function taskMatches(task: FilterTask, filter: PlanFilter, search: string, me: string, nowS: string): boolean {
  const done = task.percent_complete >= 100;
  let ok: boolean;
  switch (filter) {
    case 'incomplete': ok = !done; break;
    case 'late': {
      const finish = msOrNaN(task.finish);
      const deadline = msOrNaN(task.deadline);
      const due = Number.isNaN(deadline) || deadline >= finish ? finish : deadline;
      ok = !done && due < toMs(nowS);
      break;
    }
    case 'critical': ok = task.is_critical && !task.is_summary; break;
    case 'milestones': ok = task.is_milestone; break;
    case 'due_week': {
      const [from, to] = weekOf(nowS);
      const finish = msOrNaN(task.finish);
      ok = !done && finish >= from && finish < to;
      break;
    }
    case 'mine': ok = !!me && task.assignees.some((a) => a.kind === 'person' && a.id === me); break;
    case 'summary': ok = task.is_summary; break;
    default: ok = true;
  }
  const words = search.trim().toLowerCase();
  if (!ok || !words) return ok;
  return task.name.toLowerCase().includes(words)
    || (task.notes ?? '').toLowerCase().includes(words)
    || task.assignees.some((a) => a.name.toLowerCase().includes(words));
}

/** Nothing to filter by: the outline as it is. */
export function isFiltering(filter: PlanFilter, search: string): boolean {
  return filter !== 'all' || search.trim() !== '';
}

/** The ids in `order` that pass the filter and the search. */
export function matchingIds(
  order: readonly string[], tasksById: ReadonlyMap<string, FilterTask>, filter: PlanFilter, search: string,
  me: string, nowS: string,
): Set<string> {
  const out = new Set<string>();
  for (const id of order) {
    const task = tasksById.get(id);
    if (task && taskMatches(task, filter, search, me, nowS)) out.add(id);
  }
  return out;
}

/** The outline's rows for the tasks `kept`: each one, plus its summary
 *  tasks that aren't kept themselves as context. */
export function withContext(
  order: readonly string[], tasksById: ReadonlyMap<string, Pick<PlanTask, 'parent_id'>>, kept: ReadonlySet<string>,
): { rows: string[]; context: Set<string> } {
  const context = new Set<string>();
  for (const id of kept) {
    if (!tasksById.has(id)) continue;
    for (const up of ancestors(id, tasksById)) {
      if (!kept.has(up)) context.add(up);
    }
  }
  return { rows: order.filter((id) => tasksById.has(id) && (kept.has(id) || context.has(id))), context };
}

/**
 * The rows a filter and a search leave, in outline order: the tasks that
 * match, plus their summary tasks as dimmed, inert context rows. With
 * nothing to filter by, `order` itself and no context.
 */
export function filterRows(
  order: readonly string[], tasksById: ReadonlyMap<string, FilterTask & Pick<PlanTask, 'parent_id'>>,
  filter: PlanFilter, search: string, me: string, nowS: string,
): { rows: string[]; context: Set<string> } {
  if (!isFiltering(filter, search)) return { rows: [...order], context: new Set() };
  return withContext(order, tasksById, matchingIds(order, tasksById, filter, search, me, nowS));
}

// ── Group by ──

export interface PlanGroup {
  key: string;
  label: string;
  /** Task ids, in outline order. */
  rows: string[];
}

export const UNASSIGNED = 'unassigned';
const STATUS_ORDER: readonly TaskStatus[] = ['late', 'in_progress', 'not_started', 'complete'];

/**
 * The leaf tasks of `rows` under their groups: a band per resource (a task
 * with two under both, "Unassigned" last, the rest by name) or per status
 * (Late, In progress, Not started, Complete); groups with nothing in them
 * are left out. `none`: the rows as they are, summaries too, in one group.
 */
export function groupRows(
  rows: readonly string[], tasksById: ReadonlyMap<string, Pick<PlanTask, 'is_summary' | 'assignees' | 'status'>>,
  by: PlanGroupBy,
): PlanGroup[] {
  if (by === 'none') return [{ key: '', label: '', rows: [...rows] }];
  const groups = new Map<string, PlanGroup>();
  const add = (key: string, label: string, id: string) => {
    const group = groups.get(key);
    if (group) group.rows.push(id); else groups.set(key, { key, label, rows: [id] });
  };
  for (const id of rows) {
    const task = tasksById.get(id);
    if (!task || task.is_summary) continue;
    if (by === 'status') {
      add(task.status, STATUS_LABELS[task.status], id);
    } else if (!task.assignees.length) {
      add(UNASSIGNED, 'Unassigned', id);
    } else {
      const seen = new Set<string>();
      for (const a of task.assignees) {
        const key = `${a.kind}:${a.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        add(key, a.name, id);
      }
    }
  }
  const out = [...groups.values()];
  if (by === 'status') return out.sort((a, b) => STATUS_ORDER.indexOf(a.key as TaskStatus) - STATUS_ORDER.indexOf(b.key as TaskStatus));
  const rank = (g: PlanGroup) => (g.key === UNASSIGNED ? 1 : 0);
  return out.sort((a, b) => rank(a) - rank(b) || naturalCompare(a.label, b.label)
    || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

// ── row keys ──

const SEP = '/';

/** A group band's row key. */
export function bandKey(groupKey: string): string {
  return `${groupKey}${SEP}`;
}

/** A grouped task row's key: its group, then its task. */
export function rowKey(groupKey: string, taskId: string): string {
  return `${groupKey}${SEP}${taskId}`;
}

/** The task a row shows: its key's task part (a plain row's key is its
 *  task's id, 'blank' the new-task row's); null for a group band. */
export function taskOfRow(key: string): string | null {
  const id = key.slice(key.lastIndexOf(SEP) + 1);
  return id || null;
}

/** True for a group band's row. */
export function isBandRow(key: string): boolean {
  return key.endsWith(SEP);
}

export interface GroupBand {
  label: string;
  /** The rows under it. */
  count: number;
}

/** The groups as rows: each band, then its tasks' rows. */
export function groupedRows(groups: readonly PlanGroup[]): { rows: string[]; bands: Map<string, GroupBand> } {
  const rows: string[] = [];
  const bands = new Map<string, GroupBand>();
  for (const g of groups) {
    const band = bandKey(g.key);
    rows.push(band);
    bands.set(band, { label: g.label, count: g.rows.length });
    for (const id of g.rows) rows.push(rowKey(g.key, id));
  }
  return { rows, bands };
}

// ── the view, kept per plan ──

export interface PlanViewState {
  filter: PlanFilter;
  search: string;
  group: PlanGroupBy;
}

export const VIEW_PREFIX = 'plans.view.';
export const DEFAULT_VIEW: PlanViewState = Object.freeze({ filter: 'all', search: '', group: 'none' });

const FILTERS = new Set<string>(PLAN_FILTERS.map((f) => f.value));
const GROUPS = new Set<string>(PLAN_GROUPS.map((g) => g.value));

/** The plan's view as this browser left it; the default for anything it can't read. */
export function readView(planId: string): PlanViewState {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(VIEW_PREFIX + planId) ?? 'null');
    if (!raw || typeof raw !== 'object') return DEFAULT_VIEW;
    const v = raw as Record<string, unknown>;
    return {
      filter: typeof v.filter === 'string' && FILTERS.has(v.filter) ? v.filter as PlanFilter : DEFAULT_VIEW.filter,
      search: typeof v.search === 'string' ? v.search : DEFAULT_VIEW.search,
      group: typeof v.group === 'string' && GROUPS.has(v.group) ? v.group as PlanGroupBy : DEFAULT_VIEW.group,
    };
  } catch {
    return DEFAULT_VIEW;
  }
}

export function writeView(planId: string, view: PlanViewState): void {
  try {
    localStorage.setItem(VIEW_PREFIX + planId, JSON.stringify(view));
  } catch {
    // storage refused: the view lasts this visit only
  }
}
