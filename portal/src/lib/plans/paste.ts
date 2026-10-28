/**
 * Copy and paste in the task sheet (MS Project's and Excel's). Pure:
 * components/plans/usePlanCommands reads and writes the clipboard and
 * posts what these build.
 *
 * - `parseClipboard` / `toTsv`: tab-separated text as Excel (and Numbers)
 *   write it: rows end in CRLF (LF and CR read too), a cell holding a tab,
 *   a line break or a quote is quoted with its quotes doubled, and the
 *   last row's line break is not another row.
 * - `copyRows`: the selected rows (a summary with its subtasks) as TSV of
 *   the visible columns, plus a copy of the tasks themselves. Pasted back
 *   into a plan (`opsForInternalPaste`), that copy re-creates the tasks
 *   right above the active row with their outline, durations, the links
 *   among them and their resources (MS Project's copy of whole tasks).
 * - `opsForPaste`: anything else pasted fills cells from the active cell
 *   across the visible columns, row by row, as typing each value would
 *   (editOps.opsForCell, so every value is checked the same way and a
 *   refusal names its row and column before anything is sent). Rows past
 *   the last one become new tasks at the end. Read-only columns, empty
 *   cells and a summary's derived dates are skipped.
 *
 * Ruling B3: the API can't name a task added earlier in the same batch,
 * so a paste that adds rows sends two batches: the adds (with the fields
 * an add takes), then everything that has to name a new row — its
 * Predecessors, Resource Names, % Complete, constraint and actuals — by
 * the ids the first batch answers (`then`), joined into one undo step.
 * Every Predecessors value waits for the second batch then, since any of
 * them may name a new row by the ID it gets (the new rows go at the end,
 * so they take the next IDs and no existing ID moves).
 *
 * A batch is at most 5,000 ops (MAX_OPS): a paste that needs more in
 * either batch is refused whole, with the count, rather than split.
 */
import { MAX_OPS, type AddTaskOp, type ConstraintType, type Op, type Plan, type PlanTask, type ResourceRef,
  type TaskMode } from './api';
import type { PlanColumn, SheetContext } from './columns';
import { asciiTrim, unitMinutes, type DurationUnit, type Units } from './durations';
import {
  ADD_FIELDS, LOCKED_COLUMNS, SUMMARY_DERIVED, canAddTasks, opsForCell, resourceKey, type EditContext,
} from './editOps';
import { PLAN_ERRORS } from './errors';
import { toMs } from './floatingTime';
import { planUnits } from './merge';
import { descendants } from './outline';
import type { ActiveCell, Selection } from './selection';
import type { Command } from './commands';

export interface PasteContext {
  plan: Plan;
  /** A fresh temp_id for each task the paste adds. */
  tempId(): string;
  /** Where new rows go: the parent of the last row shown (the blank row's rule). */
  appendParentId: string | null;
}

// ── clipboard text ─────────────────────────────────────────────────

/** Tab-separated clipboard text as rows of cells (see the header). */
export function parseClipboard(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let fresh = true;               // at the start of a cell
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (fresh && ch === '"') {
      // a quoted cell runs to the quote that isn't doubled; its line breaks are LF
      i += 1;
      while (i < text.length) {
        if (text[i] === '"') {
          if (text[i + 1] !== '"') {
            i += 1;
            break;
          }
          cell += '"';
          i += 2;
        } else if (text[i] === '\r' && text[i + 1] === '\n') {
          cell += '\n';
          i += 2;
        } else {
          cell += text[i];
          i += 1;
        }
      }
      fresh = false;
      continue;
    }
    fresh = false;
    if (ch === '\t') {
      row.push(cell);
      cell = '';
      fresh = true;
      i += 1;
    } else if (ch === '\r' || ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      fresh = true;
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      cell += ch;
      i += 1;
    }
  }
  // text that doesn't end in a line break still ends its row ("a\t" too)
  if (!fresh || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

const quote = (cell: string): string => (/[\t\n\r"]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell);

/** Rows of cells as Excel writes them to the clipboard (CRLF after every row). */
export function toTsv(grid: readonly (readonly string[])[]): string {
  return grid.map((row) => `${row.map(quote).join('\t')}\r\n`).join('');
}

const normalized = (text: string) => text.replace(/\r\n?/g, '\n').replace(/\n+$/, '');

/** True when two clipboard texts are the same copy (line endings aside:
 *  another app may rewrite them on the way through the clipboard). */
export function sameClipboard(a: string, b: string): boolean {
  return normalized(a) === normalized(b);
}

const ISO = /^([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})(?:[T ]([0-9]{1,2}):([0-9]{2})(?::[0-9]{2}(?:\.[0-9]+)?)?)?$/;
const US = /^(?:[A-Za-z]{3,9},?[ \t]+)?([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{2}|[0-9]{4})(?:[ \t]+([0-9]{1,2}):([0-9]{2})(?::[0-9]{2})?[ \t]*([AaPp][Mm])?)?$/;
const pad = (n: number) => String(n).padStart(2, '0');

/**
 * A pasted date as plan text: the sheet's own `Mon 11/2/26` (and
 * `11/2/2026`, a two-digit year in 2000–2099), or ISO `2026-11-02`, each
 * with an optional time (`1:30 PM`, `13:30`). A date alone stays a date,
 * so the API applies the calendar's default start or end. Null when it
 * isn't a real date.
 */
export function pasteDate(raw: string): string | null {
  const text = asciiTrim(raw);
  let year: number;
  let month: number;
  let day: number;
  let hour: number | null = null;
  let minute = 0;
  const iso = ISO.exec(text);
  const us = iso ? null : US.exec(text);
  if (iso) {
    [year, month, day] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (iso[4] !== undefined) [hour, minute] = [Number(iso[4]), Number(iso[5])];
  } else if (us) {
    [month, day, year] = [Number(us[1]), Number(us[2]), Number(us[3])];
    if (us[3].length === 2) year += 2000;
    if (us[4] !== undefined) {
      [hour, minute] = [Number(us[4]), Number(us[5])];
      const half = us[6]?.toLowerCase();
      if (half) {
        if (hour < 1 || hour > 12) return null;
        hour = (hour % 12) + (half === 'pm' ? 12 : 0);
      }
    }
  } else {
    return null;
  }
  const date = `${year}-${pad(month)}-${pad(day)}`;
  const out = hour === null ? date : `${date}T${pad(hour)}:${pad(minute)}`;
  return Number.isNaN(toMs(out)) ? null : out;
}

// ── copy ────────────────────────────────────────────────────────────

/** A copied task, as the paste re-creates it. */
export interface CopiedTask {
  key: string;                        // its id in the plan it came from
  depth: number;                      // below the copy's top level
  name: string;
  isSummary: boolean;
  mode: TaskMode;
  isMilestone: boolean;
  /** A subtask's duration as exact text ("2d", "0.208333d"). */
  duration: string;
  start: string | null;
  finish: string | null;
  deadline: string | null;
  notes: string | null;
  constraintType: ConstraintType;
  constraintDate: string | null;
  resources: ResourceRef[];
}

export interface CopiedLink {
  from: string;
  to: string;
  type: Plan['links'][number]['link_type'];
  lag: string | null;                 // exact lag text; null for none
}

export interface PlanCopy {
  text: string;                       // what went to the clipboard
  tasks: CopiedTask[];
  links: CopiedLink[];
}

/** Minutes as text the API reads back to the same minutes, in their own
 *  unit: whole units as is, else six decimals (within half a minute for
 *  any unit up to an elapsed month). */
function exactText(minutes: number, unit: DurationUnit, elapsed: boolean, units: Units): string {
  const per = unitMinutes(units, unit, elapsed);
  const size = Math.abs(minutes);
  const number = size % per === 0 ? String(size / per)
    : (size / per).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
  return `${minutes < 0 ? '-' : ''}${number}${elapsed ? 'e' : ''}${unit}`;
}

/** What a sheet column's cell holds as copied text: its display value, a
 *  note whole (line breaks too). */
function cellText(col: PlanColumn, task: PlanTask, ctx: SheetContext): string {
  return col.key === 'notes' ? (task.notes ?? '') : col.value(task, ctx);
}

/** The selected rows, each summary with its subtasks, in outline order:
 *  as TSV of `columns` for the clipboard, and as a copy of the tasks. */
export function copyRows(selected: ReadonlySet<string>, columns: readonly PlanColumn[], plan: Plan): {
  text: string; copy: PlanCopy;
} {
  const ids = new Set(selected);
  for (const t of plan.tasks) {
    if (selected.has(t.id) && t.is_summary) descendants(t.id, plan.tasks).forEach((id) => ids.add(id));
  }
  const tasks = plan.tasks.filter((t) => ids.has(t.id));
  const units = planUnits(plan);
  const ctx: SheetContext = {
    showTimes: plan.settings.show_times, units, timeZone: plan.timezone, locked: plan.locked_at !== null,
  };
  const text = toTsv(tasks.map((t) => columns.map((col) => cellText(col, t, ctx))));

  // depth below the copy's top: never more than one below the row above it
  const base = Math.min(...tasks.map((t) => t.outline_level));
  let above = -1;
  const copied = tasks.map((t): CopiedTask => {
    const depth = Math.max(0, Math.min(t.outline_level - base, above + 1));
    above = depth;
    return {
      key: t.id, depth, name: t.name, isSummary: t.is_summary, mode: t.mode, isMilestone: t.is_milestone,
      duration: exactText(t.duration_minutes, t.duration_unit, t.elapsed, units),
      start: t.start, finish: t.finish, deadline: t.deadline, notes: t.notes,
      constraintType: t.constraint_type, constraintDate: t.constraint_date,
      resources: t.assignees.map((a) => ({ kind: a.kind, id: a.id })),
    };
  });
  const links = plan.links.filter((l) => ids.has(l.predecessor_id) && ids.has(l.successor_id))
    .map((l): CopiedLink => ({
      from: l.predecessor_id, to: l.successor_id, type: l.link_type,
      lag: l.lag_minutes === 0 ? null : exactText(l.lag_minutes, l.lag_unit, l.lag_elapsed, units),
    }));
  return { text, copy: { text, tasks: copied, links } };
}

// ── paste ───────────────────────────────────────────────────────────

const plural = (n: number) => n.toLocaleString('en-US');

/** Refused whole when either batch needs more than the API takes. */
function tooBig(...batches: readonly (readonly unknown[])[]): { error: string } | null {
  const most = Math.max(...batches.map((b) => b.length));
  if (most <= MAX_OPS) return null;
  return {
    error: `That paste is too big to make in one change (${plural(most)} edits; the most is ${plural(MAX_OPS)}). `
      + 'Paste fewer rows at a time.',
  };
}

/** Why rows can't be added here. */
const noAdding = (plan: Plan) => ({ error: plan.locked_at ? PLAN_ERRORS.plan_locked : PLAN_ERRORS.forbidden });

/** The second batch's ops with each new row's temp id swapped for its id. */
function renamed(ops: readonly Op[], ids: Readonly<Record<string, string>>): Op[] {
  const real = (id: string) => ids[id] ?? id;
  return ops.map((op): Op => {
    switch (op.op) {
      case 'update_task': return { ...op, id: real(op.id) };
      case 'set_assignees': return { ...op, task_id: real(op.task_id) };
      case 'set_percent': return { ...op, ids: op.ids.map(real) };
      case 'indent': return { ...op, ids: op.ids.map(real) };
      case 'add_link': return { ...op, predecessor_id: real(op.predecessor_id), successor_id: real(op.successor_id) };
      default: return op;
    }
  });
}

/** Pastes a copy of whole tasks (copyRows) right above the active row, or
 *  at the end from the blank row. */
export function opsForInternalPaste(copy: PlanCopy, sel: Selection, ctx: PasteContext): Command {
  const { plan } = ctx;
  if (!copy.tasks.length) return { ops: [] };
  if (!canAddTasks(plan)) return noAdding(plan);
  const at = sel.active && sel.active.id !== 'blank' && plan.tasks.some((t) => t.id === sel.active?.id)
    ? sel.active.id : null;
  const where = at !== null ? { before_id: at } : { parent_id: ctx.appendParentId };
  const defaultMode = plan.settings.default_task_mode;
  const temp = new Map(copy.tasks.map((t) => [t.key, ctx.tempId()]));

  const adds = copy.tasks.map((t): Op => {
    const op: AddTaskOp = { op: 'add_task', temp_id: temp.get(t.key)!, ...where, name: t.name };
    if (t.mode !== defaultMode) op.mode = t.mode;
    if (!t.isSummary) {
      if (t.mode === 'manual' && t.start && t.finish) {
        op.start = t.start;
        op.finish = t.finish;
      } else {
        op.duration = t.duration;
      }
      if (t.isMilestone && t.duration !== '0d') op.is_milestone = true;
    }
    if (t.deadline) op.deadline = t.deadline;
    if (t.notes) op.notes = t.notes;
    return op;
  });

  const later: Op[] = [];
  // the outline: all start side by side; each pass indents one level more
  const deepest = Math.max(...copy.tasks.map((t) => t.depth));
  for (let level = 1; level <= deepest; level += 1) {
    later.push({ op: 'indent', ids: copy.tasks.filter((t) => t.depth >= level).map((t) => temp.get(t.key)!) });
  }
  for (const t of copy.tasks) {
    if (t.constraintType !== 'asap') {
      later.push({
        op: 'update_task', id: temp.get(t.key)!,
        fields: { constraint_type: t.constraintType, constraint_date: t.constraintDate },
      });
    }
  }
  for (const l of copy.links) {
    later.push({
      op: 'add_link', predecessor_id: temp.get(l.from)!, successor_id: temp.get(l.to)!, link_type: l.type,
      ...(l.lag ? { lag: l.lag } : {}),
    });
  }
  const known = new Set(plan.resources.map(resourceKey));
  for (const t of copy.tasks) {
    const resources = t.resources.filter((r) => known.has(resourceKey(r)));
    if (resources.length) later.push({ op: 'set_assignees', task_id: temp.get(t.key)!, resources });
  }

  const big = tooBig(adds, later);
  if (big) return big;
  return {
    ops: adds,
    ...(later.length ? { then: (ids: Readonly<Record<string, string>>) => renamed(later, ids) } : {}),
    select: temp.get(copy.tasks[0].key),
  };
}

/** A stand-in for a row the paste adds: no value it holds equals one
 *  pasted, so opsForCell sends every pasted value. */
function newRow(id: string): PlanTask {
  return {
    id, display_id: 0, wbs: '', outline_level: 1, parent_id: null, position: 0, is_summary: false,
    name: '\u0000', is_milestone: false, mode: '' as TaskMode, duration_minutes: -1, duration_unit: 'd',
    elapsed: false, duration_text: '', start: null, finish: null, constraint_type: '' as ConstraintType,
    constraint_date: null, deadline: null, percent_complete: -1, actual_start: null, actual_finish: null,
    notes: null, show_on_timeline: false, total_slack_minutes: null, is_critical: false, conflict: null,
    baseline_start: null, baseline_finish: null, baseline_duration_minutes: null, start_variance_minutes: null,
    finish_variance_minutes: null, completed_at: null, completed_by_name: null, predecessors: '', successors: '',
    assignees: [], status: 'not_started', missed_deadline: false, created_at: '', updated_at: '',
  };
}

/** Lower-cased resource names to their editor keys (`person:<id>`): the
 *  plan's resources, then the row's own assignees. */
function resourceNames(plan: Plan, task: PlanTask | null): Map<string, string> {
  const names = new Map<string, string>();
  for (const r of [...plan.resources, ...(task?.assignees ?? [])]) {
    const name = r.name.trim().toLowerCase();
    if (!names.has(name)) names.set(name, resourceKey(r));
  }
  return names;
}

/** A pasted cell as the text its column's editor takes, or why it can't be. */
function editorText(column: PlanColumn, raw: string, plan: Plan, task: PlanTask | null): string | { error: string } {
  switch (column.editor) {
    case 'date':
    case 'datetime':
      return pasteDate(raw) ?? { error: 'Enter a date like 11/2/26.' };
    case 'select': {
      const typed = asciiTrim(raw).toLowerCase();
      const option = column.options?.find((o) => o.value === typed || o.label.toLowerCase() === typed);
      return option ? option.value : { error: `Use one of: ${(column.options ?? []).map((o) => o.label).join(', ')}.` };
    }
    case 'resources': {
      const names = resourceNames(plan, task);
      const keys: string[] = [];
      for (const part of raw.split(/[,;]/)) {
        const name = part.trim();
        if (!name) continue;
        const key = names.get(name.toLowerCase());
        if (!key) return { error: `“${name.length > 40 ? `${name.slice(0, 40)}...` : name}” isn’t one of this plan’s resources.` };
        if (!keys.includes(key)) keys.push(key);
      }
      return keys.join(',');
    }
    default:
      // a name is one line
      return column.key === 'name' ? raw.replace(/[\r\n]+/g, ' ') : raw;
  }
}

/**
 * The ops a pasted grid sends (see the header): `active` is where its top
 * left cell lands, `columns` the visible columns in order, `rows` the task
 * rows shown in order.
 */
export function opsForPaste(
  grid: readonly (readonly string[])[], active: ActiveCell | null, columns: readonly PlanColumn[],
  rows: readonly string[], ctx: PasteContext,
): Command {
  const { plan } = ctx;
  if (!active) return { error: 'Select a cell to paste into.' };
  const startCol = columns.findIndex((c) => c.key === active.col);
  const startRow = active.id === 'blank' ? rows.length : rows.indexOf(active.id);
  if (startCol < 0 || startRow < 0) return { error: 'Select a cell to paste into.' };
  if (!grid.length) return { ops: [] };

  const filled = Math.max(0, Math.min(grid.length, rows.length - startRow));
  const adding = grid.length - filled;
  if (adding > 0 && !canAddTasks(plan)) return noAdding(plan);

  const byId = new Map(plan.tasks.map((t) => [t.id, t]));
  const temps = Array.from({ length: adding }, () => ctx.tempId());
  // the new rows go at the end: they take the next display IDs
  const count = plan.tasks.length;
  const displayOf = new Map<string, number>([
    ...plan.tasks.map((t): [string, number] => [t.id, t.display_id]),
    ...temps.map((t, i): [string, number] => [t, count + i + 1]),
  ]);
  const edit: EditContext = {
    units: planUnits(plan),
    validIds: new Set(displayOf.values()),
    displayIdOf: (id) => displayOf.get(id) ?? null,
    tempId: ctx.tempId,
    appendParentId: ctx.appendParentId,
  };

  const first: Op[] = [];
  const later: Op[] = [];
  for (let r = 0; r < grid.length; r += 1) {
    const task = r < filled ? byId.get(rows[startRow + r]) ?? null : null;
    if (r < filled && !task) return { error: 'That row no longer exists, so reload the plan and try again.' };
    const add: AddTaskOp | null = task ? null : { op: 'add_task', temp_id: temps[r - filled], parent_id: ctx.appendParentId };
    const target = task ?? newRow(add!.temp_id!);
    for (let c = 0; c < grid[r].length; c += 1) {
      const column = columns[startCol + c];
      const raw = grid[r][c];
      if (!column || column.editor === 'none' || asciiTrim(raw) === '') continue;
      const where = `Row ${r + 1}, ${column.label}`;
      if (task) {
        if (task.is_summary && SUMMARY_DERIVED.has(column.key)) continue;    // derived: nothing to paste over
        if (!plan.permissions.change) return { error: `${where}: ${PLAN_ERRORS.forbidden}` };
        if (plan.locked_at && !LOCKED_COLUMNS.has(column.key)) return { error: `${where}: ${PLAN_ERRORS.plan_locked}` };
      }
      const text = editorText(column, raw, plan, task);
      if (typeof text !== 'string') return { error: `${where}: ${text.error}` };
      const cell = opsForCell(target, column, text, edit);
      if ('error' in cell) return { error: `${where}: ${cell.error}` };
      for (const op of cell.ops) {
        if (add && op.op === 'update_task' && ADD_FIELDS.has(column.key)) Object.assign(add, op.fields);
        else if (add || (adding > 0 && column.key === 'predecessors')) later.push(op);
        else first.push(op);
      }
    }
    if (add) first.push(add);
  }

  const big = tooBig(first, later);
  if (big) return big;
  return later.length
    ? { ops: first, then: (ids: Readonly<Record<string, string>>) => renamed(later, ids) }
    : { ops: first };
}
