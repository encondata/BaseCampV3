/**
 * Task Information as a form (components/plans/TaskInfoModal): the task's
 * values as the dialog's fields, which of them this person may change, and
 * the one batch OK sends. Pure.
 *
 * - `canEditField`: nothing for someone who may only read the plan; a
 *   summary's duration and dates are derived (editOps SUMMARY_DERIVED); a
 *   locked plan takes progress only, the API's own list (PROGRESS_FIELDS),
 *   as the sheet does.
 * - `taskInfoOps` checks what was typed with the API's parsers first and
 *   answers `{errors}` (by field; a predecessor line's as `pred:<key>`)
 *   when anything is refused here. Otherwise one batch with every change,
 *   in this order: `update_task` with the changed fields, the link ops
 *   (deletes, then updates, then adds, so a predecessor moved between
 *   lines never collides with itself), `set_assignees`, and `set_percent`
 *   last (completing ops ride at the end, as in a paste). Nothing changed:
 *   no ops. Task Information edits an existing task, so no op in the batch
 *   names another op's new row.
 * - The Predecessors tab sends link ops, never the Predecessors text.
 * - The Elapsed switch is the duration text's `e`: `withElapsed` rewrites
 *   "3 days" as "3 edays" and back.
 */
import {
  PROGRESS_FIELDS, type ConstraintType, type Op, type Plan, type PlanLink, type PlanTask, type ResourceRef,
  type TaskFields, type TaskMode,
} from './api';
import {
  DurationError, asciiTrim, durationLabel, formatDuration, maxMinutes, parseDuration, parseLag, type Duration,
  type Units,
} from './durations';
import { PARTIAL_DATE, SUMMARY_DERIVED, resourceKey } from './editOps';
import { PLAN_ERRORS, planErrorText } from './errors';
import { dayOf, fromDateInput, toDateInput, toDateTimeInput } from './floatingTime';
import { planUnits } from './merge';
import { ancestors, descendants } from './outline';
import type { LinkType } from './predecessors';

/** Task Information's tabs, in order. */
export type TaskInfoTab = 'general' | 'predecessors' | 'resources' | 'advanced' | 'notes';

export const TASK_INFO_TABS: readonly { key: TaskInfoTab; label: string }[] = [
  { key: 'general', label: 'General' },
  { key: 'predecessors', label: 'Predecessors' },
  { key: 'resources', label: 'Resources' },
  { key: 'advanced', label: 'Advanced' },
  { key: 'notes', label: 'Notes' },
];

/** One line of the Predecessors tab: an existing link (`linkId`) or a new one. */
export interface PredecessorLine {
  key: string;
  linkId: string | null;
  taskId: string;                    // '' until a task is picked
  type: LinkType;
  lag: string;
}

export interface TaskInfoForm {
  name: string;
  percent: string;
  duration: string;
  start: string;                     // a date or datetime-local input's value
  finish: string;
  mode: TaskMode;
  milestone: boolean;
  timeline: boolean;
  deadline: string;
  predecessors: PredecessorLine[];
  resources: string[];               // resourceKey()s
  constraintType: ConstraintType;
  constraintDate: string;
  notes: string;
}

export type InfoField = 'name' | 'percent' | 'duration' | 'start' | 'finish' | 'mode' | 'milestone' | 'timeline'
  | 'deadline' | 'predecessors' | 'resources' | 'constraint' | 'notes';

/** The task field each form field writes (what PROGRESS_FIELDS names). */
const TASK_FIELD: Record<InfoField, string> = {
  name: 'name',
  percent: 'percent_complete',
  duration: 'duration',
  start: 'start',
  finish: 'finish',
  mode: 'mode',
  milestone: 'is_milestone',
  timeline: 'show_on_timeline',
  deadline: 'deadline',
  predecessors: 'predecessors',
  resources: 'assignees',
  constraint: 'constraint_type',
  notes: 'notes',
};

const TAB_OF: Record<InfoField, TaskInfoTab> = {
  name: 'general',
  percent: 'general',
  duration: 'general',
  start: 'general',
  finish: 'general',
  mode: 'general',
  milestone: 'general',
  timeline: 'general',
  deadline: 'general',
  predecessors: 'predecessors',
  resources: 'resources',
  constraint: 'advanced',
  notes: 'notes',
};

/** The constraints a summary takes (the engine's SUMMARY_CONSTRAINT_TYPES). */
export const SUMMARY_CONSTRAINTS: readonly ConstraintType[] = ['asap', 'snet'];
/** The link types into a summary (the engine's SUMMARY_LINK_TYPES). */
export const SUMMARY_LINK_TYPES: readonly LinkType[] = ['FS', 'SS'];

export type TaskInfoErrors = Record<string, string>;

const PERCENT = /^[ \t]*([0-9]{1,3})[ \t]*%?[ \t]*$/;
const PERCENT_ERROR = 'Enter a % Complete from 0 to 100.';
export const CONSTRAINT_DATE_NEEDED = 'Enter a constraint date.';
export const DUPLICATE_PREDECESSOR = 'This task is already a predecessor.';
export const LABEL = 'Task Information';

type Access = Pick<Plan, 'permissions' | 'locked_at'>;

/** Whether this person may change `field` of `task` here. */
export function canEditField(plan: Access, task: Pick<PlanTask, 'is_summary'>, field: InfoField): boolean {
  if (!plan.permissions.change) return false;
  if (task.is_summary && SUMMARY_DERIVED.has(field)) return false;
  if (plan.locked_at !== null) return PROGRESS_FIELDS.has(TASK_FIELD[field]);
  return true;
}

/** The tab an error key belongs to. */
export function tabOfError(key: string): TaskInfoTab {
  if (key.startsWith('pred:')) return 'predecessors';
  return TAB_OF[key as InfoField] ?? 'general';
}

const dateInput = (value: string | null, showTimes: boolean) =>
  (showTimes ? toDateTimeInput(value) : toDateInput(value));

/** The links into the task, by their predecessor's ID. */
export function linksInto(task: Pick<PlanTask, 'id'>, plan: Pick<Plan, 'links' | 'tasks'>): PlanLink[] {
  const idOf = new Map(plan.tasks.map((t) => [t.id, t.display_id]));
  return plan.links.filter((l) => l.successor_id === task.id)
    .sort((a, b) => (idOf.get(a.predecessor_id) ?? 0) - (idOf.get(b.predecessor_id) ?? 0));
}

export function taskInfoForm(task: PlanTask, plan: Plan): TaskInfoForm {
  const showTimes = plan.settings.show_times;
  return {
    name: task.name,
    percent: String(task.percent_complete),
    duration: task.duration_text,
    start: dateInput(task.start, showTimes),
    finish: dateInput(task.finish, showTimes),
    mode: task.mode,
    milestone: task.is_milestone,
    timeline: task.show_on_timeline,
    deadline: dateInput(task.deadline, showTimes),
    predecessors: linksInto(task, plan).map((l) => ({
      key: l.id, linkId: l.id, taskId: l.predecessor_id, type: l.link_type, lag: l.lag_text,
    })),
    resources: task.assignees.map(resourceKey),
    constraintType: task.constraint_type,
    constraintDate: dateInput(task.constraint_date, showTimes),
    notes: task.notes ?? '',
  };
}

/** The tasks that can be the task's predecessor: any but itself, its
 *  summaries and its subtasks (a link into the outline is refused). */
export function predecessorChoices(task: PlanTask, plan: Pick<Plan, 'tasks'>): PlanTask[] {
  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const out = new Set([task.id, ...ancestors(task.id, byId), ...descendants(task.id, plan.tasks)]);
  return plan.tasks.filter((t) => !out.has(t.id));
}

/** The duration text's elapsed flag; null while it doesn't parse. */
export function elapsedOf(text: string, units: Units): boolean | null {
  try {
    return parseDuration(text, units).elapsed;
  } catch {
    return null;
  }
}

/** The duration text with its elapsed flag set: "3 days" ⇄ "3 edays"
 *  (the number and unit kept, as MS Project does); null while it doesn't parse. */
export function withElapsed(text: string, units: Units, elapsed: boolean): string | null {
  let d: Duration;
  try {
    d = parseDuration(text, units);
  } catch {
    return null;
  }
  if (d.elapsed === elapsed) return text;
  const number = formatDuration(d.minutes, d.unit, d.elapsed, units).split(' ')[0];
  return `${number} ${durationLabel(d.unit, elapsed, number === '1')}`;
}

/** Date-input text against the value the task has: the same minute, or
 *  (a date alone) the same day. */
function sameDate(text: string, current: string | null): boolean {
  if (current === null) return text === '';
  return text.length === 10 ? dayOf(current) === text : current === text;
}

type DateParse = { value: string | null } | { error: string } | 'same';

function parseDate(text: string, current: string | null, required: string | null): DateParse {
  const typed = asciiTrim(text);
  const value = fromDateInput(typed);
  if (value === null && typed !== '') return { error: PARTIAL_DATE };
  if (sameDate(value ?? '', current)) return 'same';
  if (value === null && required) return { error: `Enter a ${required} date.` };
  return { value };
}

const sameLag = (d: Duration, link: PlanLink): boolean =>
  d.minutes === link.lag_minutes && d.unit === link.lag_unit && d.elapsed === link.lag_elapsed;

function refOf(key: string): ResourceRef {
  const at = key.indexOf(':');
  return { kind: key.slice(0, at) as ResourceRef['kind'], id: key.slice(at + 1) };
}

/** The link ops the Predecessors tab's lines make, or the lines' errors. */
function linkOps(form: TaskInfoForm, task: PlanTask, plan: Plan, units: Units, errors: TaskInfoErrors): Op[] {
  const into = linksInto(task, plan);
  const byId = new Map(into.map((l) => [l.id, l]));
  const kept = new Set<string>();
  const seen = new Set<string>();
  const updates: Op[] = [];
  const adds: Op[] = [];
  for (const line of form.predecessors) {
    if (!line.taskId) continue;                     // a line left blank
    const where = `pred:${line.key}`;
    if (seen.has(line.taskId)) {
      errors[where] = DUPLICATE_PREDECESSOR;
      continue;
    }
    seen.add(line.taskId);
    const link = line.linkId ? byId.get(line.linkId) : undefined;
    const text = asciiTrim(line.lag) || '0';
    let lag: Duration | null = null;
    if (!link || text !== asciiTrim(link.lag_text)) {
      try {
        lag = parseLag(text, units);
      } catch (err) {
        errors[where] = err instanceof DurationError ? err.message : planErrorText(err);
        continue;
      }
      if (Math.abs(lag.minutes) > maxMinutes(units, lag.elapsed)) {
        errors[where] = 'Enter a lag like +2d, -4h or 1ed, up to 10 years.';
        continue;
      }
    }
    if (link && link.predecessor_id === line.taskId) {
      kept.add(link.id);
      const change: { link_type?: LinkType; lag?: string } = {};
      if (line.type !== link.link_type) change.link_type = line.type;
      if (lag && !sameLag(lag, link)) change.lag = text;
      if (change.link_type !== undefined || change.lag !== undefined) updates.push({ op: 'update_link', id: link.id, ...change });
    } else {
      adds.push({ op: 'add_link', predecessor_id: line.taskId, successor_id: task.id, link_type: line.type, lag: text });
    }
  }
  const deletes: Op[] = into.filter((l) => !kept.has(l.id)).map((l) => ({ op: 'delete_link', id: l.id }));
  return [...deletes, ...updates, ...adds];
}

/** The batch OK sends (see the header), or what is refused here. */
export function taskInfoOps(form: TaskInfoForm, task: PlanTask, plan: Plan): { ops: Op[] } | { errors: TaskInfoErrors } {
  const units = planUnits(plan);
  const can = (field: InfoField) => canEditField(plan, task, field);
  const errors: TaskInfoErrors = {};
  const fields: TaskFields = {};

  if (can('name')) {
    const name = asciiTrim(form.name);
    if (name !== task.name) fields.name = name;
  }
  if (can('duration')) {
    try {
      const d = parseDuration(form.duration, units);
      if (d.minutes > maxMinutes(units, d.elapsed)) errors.duration = PLAN_ERRORS.bad_duration;
      else if (d.minutes !== task.duration_minutes || d.unit !== task.duration_unit || d.elapsed !== task.elapsed) {
        fields.duration = asciiTrim(form.duration);
      }
    } catch (err) {
      errors.duration = err instanceof DurationError ? err.message : planErrorText(err);
    }
  }
  for (const [key, label] of [['start', 'Start'], ['finish', 'Finish'], ['deadline', null]] as const) {
    if (!can(key)) continue;
    const parsed = parseDate(form[key], task[key], label);
    if (parsed === 'same') continue;
    if ('error' in parsed) errors[key] = parsed.error;
    else fields[key] = parsed.value as string;
  }
  if (can('mode') && form.mode !== task.mode) fields.mode = form.mode;
  if (can('milestone') && form.milestone !== task.is_milestone) fields.is_milestone = form.milestone;
  if (can('timeline') && form.timeline !== task.show_on_timeline) fields.show_on_timeline = form.timeline;
  if (can('constraint')) {
    const typeChanged = form.constraintType !== task.constraint_type;
    if (form.constraintType === 'asap') {
      if (typeChanged) fields.constraint_type = 'asap';      // the API drops the date
    } else {
      const typed = asciiTrim(form.constraintDate);
      const value = fromDateInput(typed);
      if (value === null) {
        errors.constraint = typed ? PARTIAL_DATE : CONSTRAINT_DATE_NEEDED;
      } else {
        if (typeChanged) fields.constraint_type = form.constraintType;
        // a new type reads its date again (a finish constraint's date alone ends the day)
        if (typeChanged || !sameDate(value, task.constraint_date)) fields.constraint_date = value;
      }
    }
  }
  if (can('notes')) {
    const notes = form.notes.trim();
    if (notes !== (task.notes ?? '').trim()) fields.notes = notes || null;
  }

  const links = can('predecessors') ? linkOps(form, task, plan, units, errors) : [];

  let assign: Op | null = null;
  if (can('resources')) {
    const now = new Set(task.assignees.map(resourceKey));
    const next = new Set(form.resources);
    if (now.size !== next.size || [...next].some((k) => !now.has(k))) {
      assign = { op: 'set_assignees', task_id: task.id, resources: form.resources.map(refOf) };
    }
  }

  let percent: Op | null = null;
  if (can('percent')) {
    const m = PERCENT.exec(form.percent);
    const value = m ? Number(m[1]) : Number.NaN;
    if (!(value >= 0 && value <= 100)) errors.percent = PERCENT_ERROR;
    else if (value !== task.percent_complete) percent = { op: 'set_percent', ids: [task.id], percent: value };
  }

  if (Object.keys(errors).length) return { errors };
  const ops: Op[] = [];
  if (Object.keys(fields).length) ops.push({ op: 'update_task', id: task.id, fields });
  ops.push(...links);
  if (assign) ops.push(assign);
  if (percent) ops.push(percent);
  return { ops };
}
