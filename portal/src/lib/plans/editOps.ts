/**
 * One cell edit in the task sheet as the ops it sends. Pure: the sheet
 * (components/plans/useSheetEditing) calls `opsForCell` with what was typed
 * and posts the answer through PlanController.apply.
 *
 * - Text is checked here first, with the API's own parsers: a duration or
 *   predecessor list that doesn't parse is an `{error}` and no request goes.
 * - A value equal to what the cell holds sends nothing (`{ops: []}`): F2
 *   then Enter on a Start must not add a Start No Earlier Than constraint.
 * - A date alone stays `YYYY-MM-DD`, so the API applies the calendar's
 *   default start or end time.
 * - The blank row (`task` null) adds a task with the one field typed.
 *
 * `canEditCell` says which cells open an editor: none on a read-only plan,
 * only progress columns on a locked one (derived from `isProgressOnly`, the
 * API's rule), never a summary's derived duration and dates.
 */
import {
  isProgressOnly, type AddTaskOp, type Notice, type Op, type Plan, type PlanTask, type ResourceKind,
  type ResourceRef, type TaskFields,
} from './api';
import { PLAN_COLUMNS, type PlanColumn } from './columns';
import { DurationError, asciiTrim, maxMinutes, parseDuration, type Units } from './durations';
import { PLAN_ERRORS } from './errors';
import { dayOf, fromDateInput, toDateInput, toDateTimeInput } from './floatingTime';
import { CONSTRAINT_LABELS, oneLine } from './indicators';
import { PredecessorError, parsePredecessors } from './predecessors';

export interface EditContext {
  units: Units;                       // the plan calendar's
  validIds: ReadonlySet<number>;      // every display ID in the plan
  displayIdOf(taskId: string): number | null;
  tempId(): string;                   // a fresh temp_id for an added task
  /** Where the blank row adds its task: the parent of the last row shown
   *  (MS Project's new task takes the level of the one above it). */
  appendParentId: string | null;
}

export type CellEdit = { ops: Op[] } | { error: string };

/** Columns that edit one task field with update_task. */
const TASK_FIELD: Readonly<Record<string, keyof TaskFields>> = {
  name: 'name',
  duration: 'duration',
  start: 'start',
  finish: 'finish',
  mode: 'mode',
  predecessors: 'predecessors',
  deadline: 'deadline',
  constraint_type: 'constraint_type',
  constraint_date: 'constraint_date',
  actual_start: 'actual_start',
  actual_finish: 'actual_finish',
  notes: 'notes',
};

type DateKey = 'start' | 'finish' | 'deadline' | 'constraint_date' | 'actual_start' | 'actual_finish';
const DATE_KEYS: ReadonlySet<string> = new Set<DateKey>(
  ['start', 'finish', 'deadline', 'constraint_date', 'actual_start', 'actual_finish']);
/** Dates a task always has (the API refuses null for them). */
const REQUIRED_DATES: ReadonlySet<string> = new Set(['start', 'finish']);

/** The fields an add_task takes (AddTaskOp): the blank row's columns. */
const ADD_FIELDS: ReadonlySet<string> = new Set(['name', 'duration', 'start', 'finish', 'mode', 'deadline', 'notes']);

/** A summary's own duration and dates come from its subtasks (the API's
 *  SUMMARY_FIELDS). Its % stays open: 100 completes it. */
const SUMMARY_DERIVED: ReadonlySet<string> = new Set(['duration', 'start', 'finish', 'actual_start', 'actual_finish']);

const PERCENT = /^[ \t]*([0-9]{1,3})(?:\.([0-9]+))?[ \t]*%?[ \t]*$/;
const PERCENT_ERROR = 'Enter a % Complete from 0 to 100.';

/** A resource as the Resource Names editor names it: `person:<id>`. */
export const resourceKey = (r: { kind: ResourceKind; id: string }): string => `${r.kind}:${r.id}`;

function resourcesOf(text: string): ResourceRef[] | null {
  const refs: ResourceRef[] = [];
  for (const part of text.split(',')) {
    if (!part) continue;
    const at = part.indexOf(':');
    const kind = part.slice(0, at);
    if (at < 1 || (kind !== 'person' && kind !== 'partner')) return null;
    refs.push({ kind, id: part.slice(at + 1) });
  }
  return refs;
}

const dateOf = (task: PlanTask, key: string): string | null => task[key as DateKey];

/** What an editor starts from on F2: the value as it can be typed back. */
export function editText(task: PlanTask | null, column: PlanColumn, showTimes: boolean): string {
  if (!task) return '';
  const key = column.key;
  if (DATE_KEYS.has(key)) {
    const value = dateOf(task, key);
    return showTimes ? toDateTimeInput(value) : toDateInput(value);
  }
  switch (key) {
    case 'name': return task.name;
    case 'duration': return task.duration_text;
    case 'predecessors': return task.predecessors;
    case 'percent': return String(task.percent_complete);
    case 'notes': return oneLine(task.notes);
    case 'mode': return task.mode;
    case 'constraint_type': return task.constraint_type;
    case 'resources': return task.assignees.map(resourceKey).join(',');
    default: return '';
  }
}

/** True when date-input text names the value the task already has: the
 *  same minute, or (a date alone) the same day. */
function sameDate(text: string, current: string | null): boolean {
  if (current === null) return text === '';
  return text.length === 10 ? dayOf(current) === text : current === text;
}

/** One field's value from the text, or an error. `null` clears it. */
type Parsed = { value: unknown } | { error: string };

function parseField(task: PlanTask | null, column: PlanColumn, text: string, ctx: EditContext): Parsed | 'same' {
  const key = column.key;
  if (DATE_KEYS.has(key)) {
    const value = fromDateInput(asciiTrim(text));
    if (task && sameDate(value ?? '', dateOf(task, key))) return 'same';
    if (value === null && REQUIRED_DATES.has(key) && task) return { error: `Enter a ${column.label} date.` };
    return { value };
  }
  switch (key) {
    case 'name': {
      const name = asciiTrim(text);
      return task && name === task.name ? 'same' : { value: name };
    }
    case 'notes': {
      const notes = asciiTrim(text);
      if (task && (notes === oneLine(task.notes) || (!notes && task.notes === null))) return 'same';
      return { value: notes || null };
    }
    case 'duration': {
      let parsed;
      try {
        parsed = parseDuration(text, ctx.units);
      } catch (err) {
        if (err instanceof DurationError) return { error: err.message };
        throw err;
      }
      if (parsed.minutes > maxMinutes(ctx.units, parsed.elapsed)) return { error: PLAN_ERRORS.bad_duration };
      if (task && parsed.minutes === task.duration_minutes && parsed.unit === task.duration_unit
        && parsed.elapsed === task.elapsed) return 'same';
      return { value: asciiTrim(text) };
    }
    case 'predecessors': {
      const typed = asciiTrim(text);
      if (task && typed === task.predecessors) return 'same';
      try {
        parsePredecessors(typed, ctx.units, ctx.validIds, task ? ctx.displayIdOf(task.id) : null);
      } catch (err) {
        if (err instanceof PredecessorError) return { error: err.message };
        throw err;
      }
      return { value: typed };
    }
    case 'percent': {
      const m = PERCENT.exec(text);
      if (!m) return { error: PERCENT_ERROR };
      // whole percent, halves up (MS Project shows 50.5 as 51%)
      const percent = Number(m[1]) + (m[2] && m[2][0] >= '5' ? 1 : 0);
      if (percent > 100) return { error: PERCENT_ERROR };
      return task && percent === task.percent_complete ? 'same' : { value: percent };
    }
    case 'mode':
    case 'constraint_type': {
      if (!column.options?.some((o) => o.value === text)) return { error: PLAN_ERRORS.bad_field };
      return task && text === task[key] ? 'same' : { value: text };
    }
    case 'resources': {
      const refs = resourcesOf(text);
      if (!refs) return { error: PLAN_ERRORS.bad_resource };
      if (task) {
        const now = new Set(task.assignees.map(resourceKey));
        const next = new Set(refs.map(resourceKey));
        if (now.size === next.size && [...next].every((k) => now.has(k))) return 'same';
      }
      return { value: refs };
    }
    default:
      return { error: PLAN_ERRORS.bad_field };
  }
}

/**
 * The ops one cell edit sends: `{ops: []}` when the value didn't change
 * (or the blank row got nothing), `{error}` when the text is refused here.
 */
export function opsForCell(task: PlanTask | null, column: PlanColumn, text: string, ctx: EditContext): CellEdit {
  const parsed = parseField(task, column, text, ctx);
  if (parsed === 'same') return { ops: [] };
  if ('error' in parsed) return parsed;
  const { value } = parsed;

  if (!task) {
    if (!ADD_FIELDS.has(column.key)) return { error: 'Type the task’s name first, then fill in this column.' };
    if (value === null || value === '') return { ops: [] };
    const add = { op: 'add_task', temp_id: ctx.tempId(), parent_id: ctx.appendParentId, [column.key]: value };
    return { ops: [add as AddTaskOp] };
  }
  if (column.key === 'percent') return { ops: [{ op: 'set_percent', ids: [task.id], percent: value as number }] };
  if (column.key === 'resources') {
    return { ops: [{ op: 'set_assignees', task_id: task.id, resources: value as ResourceRef[] }] };
  }
  const field = TASK_FIELD[column.key];
  if (!field) return { error: PLAN_ERRORS.bad_field };
  return { ops: [{ op: 'update_task', id: task.id, fields: { [field]: value } as TaskFields }] };
}

/** A stand-in for the op a column's edit sends, to ask the API's rule
 *  (isProgressOnly) whether a locked plan takes it. */
function probe(key: string): Op | null {
  if (key === 'percent') return { op: 'set_percent', ids: ['probe'], percent: 0 };
  if (key === 'resources') return { op: 'set_assignees', task_id: 'probe', resources: [] };
  const field = TASK_FIELD[key];
  return field ? { op: 'update_task', id: 'probe', fields: { [field]: null } } : null;
}

/** The columns a locked plan still edits: those whose op is a progress
 *  edit (% Complete, Actual Start, Actual Finish, Notes). */
export const LOCKED_COLUMNS: ReadonlySet<string> = new Set(PLAN_COLUMNS
  .filter((c) => c.editor !== 'none')
  .map((c) => c.key)
  .filter((key) => {
    const op = probe(key);
    return op !== null && isProgressOnly([op]);
  }));

type PlanAccess = Pick<Plan, 'permissions' | 'locked_at'>;

/** The blank new-task row is shown: tasks can be added (the ops route
 *  also needs `change`) and the schedule isn't locked. */
export function canAddTasks(plan: PlanAccess): boolean {
  return plan.permissions.add && plan.permissions.change && plan.locked_at === null;
}

/** Whether the cell opens an editor (typing, F2, a double-click). */
export function canEditCell(plan: PlanAccess, task: PlanTask | null, column: PlanColumn): boolean {
  if (column.editor === 'none') return false;
  if (!task) return canAddTasks(plan) && ADD_FIELDS.has(column.key);
  if (!plan.permissions.change) return false;
  if (plan.locked_at !== null) return LOCKED_COLUMNS.has(column.key);
  return !(task.is_summary && SUMMARY_DERIVED.has(column.key));
}

/** The undo step's name (the toolbar shows "Undo Edit Duration"). */
export function editLabel(task: PlanTask | null, column: PlanColumn): string {
  return task ? `Edit ${column.label}` : 'New Task';
}

/** A notice as its toast says it, in the constraint's MS Project name. */
export function noticeText(notice: Notice): string {
  if (notice.code === 'constraint_added') {
    return `${CONSTRAINT_LABELS[notice.constraint_type]} constraint added`;
  }
  return `Constraint set back to ${CONSTRAINT_LABELS.asap}`;
}
