/**
 * The task sheet's columns: MS Project's default and optional columns in
 * MS Project's order, what each cell shows (`value`, also what a copy
 * writes and an editor starts from), and the per-browser column choice
 * (visible set, order, widths) in localStorage `plans.columns.v1`.
 *
 * Every value comes from the task as the API sent it: slack, baseline and
 * variance are the API's numbers, only formatted here (durations in the
 * plan calendar's units, plan times through floatingTime).
 */
import type { PlanTask, TaskStatus } from './api';
import { formatDuration, type Units } from './durations';
import { formatCell, fromInstant } from './floatingTime';
import { CONSTRAINT_LABELS, indicatorsOf, oneLine } from './indicators';
import { colorLabel } from './taskColor';

export type ColumnEditor =
  | 'text' | 'duration' | 'date' | 'datetime' | 'predecessors' | 'resources' | 'percent' | 'select' | 'color'
  | 'none';

/** How a cell renders its value, by the kind of datum (directory.css's
 *  golden classes): the task name, plain text (`cell-top`), prose
 *  (`cell-sub`), identifiers, dates and numbers (`mono`), a status chip,
 *  icons, or a task color (its swatch and name). */
export type CellText = 'name' | 'top' | 'sub' | 'mono' | 'chip' | 'icons' | 'color';

/** What a cell needs beyond its task. */
export interface SheetContext {
  showTimes: boolean;                 // the plan's Show times setting
  units: Units;                       // the plan calendar's units
  timeZone: string;                   // the plan's zone, for instants (Created, Updated)
  locked: boolean;                    // the schedule is locked
}

export interface PlanColumn {
  key: string;
  label: string;                      // MS Project's column name
  width: number;                      // default px at the standard list size
  min: number;
  align: 'start' | 'end' | 'center';
  defaultVisible: boolean;
  editor: ColumnEditor;               // 'date' columns take a datetime editor when the plan shows times
  options?: { value: string; label: string }[];
  /** The cell's text; `row` carries the plan-wide context. */
  value(task: PlanTask, row: SheetContext): string;
  /** How the cell renders (default 'top'). */
  text?: CellText;
  /** A plan-time column: wider while the plan shows times. */
  date?: boolean;
}

/** The sheet's base row height and header height (px at the standard list
 *  size); the Gantt beside it uses the same so the rows line up. */
export const SHEET_ROW_PX = 30;
export const SHEET_HEAD_PX = 44;
/** Rows rendered past each edge of the view, by the sheet and the Gantt
 *  alike (both virtualize the same rows against the same scroll box). */
export const SHEET_OVERSCAN = 20;
/** Extra width a date column needs for `8:00 AM`. */
const TIME_PX = 60;
const MAX_WIDTH = 1200;

export const STATUS_LABELS: Record<TaskStatus, string> = {
  complete: 'Complete',
  late: 'Late',
  in_progress: 'In progress',
  not_started: 'Not started',
};

/** The chip color of each status (directory.css `.chip.c-*`). */
export const STATUS_CHIP: Record<TaskStatus, string> = {
  complete: 'c-green',
  late: 'c-red',
  in_progress: 'c-blue',
  not_started: 'c-slate',
};

const MODE_LABELS = { auto: 'Auto Scheduled', manual: 'Manually Scheduled' } as const;

const day = (s: string | null, row: SheetContext) => formatCell(s, row.showTimes);
const workDays = (minutes: number | null, row: SheetContext) =>
  (minutes === null || minutes === undefined ? '' : formatDuration(minutes, 'd', false, row.units));
const instant = (iso: string | null, row: SheetContext) => day(fromInstant(iso, row.timeZone) || null, row);

type Def = Omit<PlanColumn, 'defaultVisible'>;

const dateColumn = (key: string, label: string, editor: ColumnEditor,
  pick: (t: PlanTask) => string | null, width = 108): Def => ({
  key, label, width, min: 80, align: 'start', editor, text: 'mono', date: true,
  value: (t, row) => day(pick(t), row),
});

const DEFAULTS: Def[] = [
  {
    key: 'indicators', label: 'Indicators', width: 56, min: 28, align: 'center', editor: 'none', text: 'icons',
    value: (t, row) => indicatorsOf(t, row).map((i) => i.title).join('; '),
  },
  {
    key: 'id', label: 'ID', width: 44, min: 32, align: 'end', editor: 'none', text: 'mono',
    value: (t) => String(t.display_id),
  },
  {
    key: 'mode', label: 'Mode', width: 48, min: 40, align: 'center', editor: 'select', text: 'icons',
    options: [{ value: 'auto', label: MODE_LABELS.auto }, { value: 'manual', label: MODE_LABELS.manual }],
    value: (t) => MODE_LABELS[t.mode],
  },
  {
    key: 'name', label: 'Task Name', width: 240, min: 120, align: 'start', editor: 'text', text: 'name',
    value: (t) => t.name,
  },
  {
    key: 'duration', label: 'Duration', width: 84, min: 56, align: 'end', editor: 'duration', text: 'mono',
    value: (t) => t.duration_text,
  },
  dateColumn('start', 'Start', 'date', (t) => t.start),
  dateColumn('finish', 'Finish', 'date', (t) => t.finish),
  {
    key: 'predecessors', label: 'Predecessors', width: 108, min: 60, align: 'start', editor: 'predecessors',
    text: 'mono', value: (t) => t.predecessors,
  },
  {
    key: 'resources', label: 'Resource Names', width: 160, min: 80, align: 'start', editor: 'resources',
    value: (t) => t.assignees.map((a) => a.name).join(', '),
  },
  {
    key: 'percent', label: '% Complete', width: 92, min: 56, align: 'end', editor: 'percent', text: 'mono',
    value: (t) => `${t.percent_complete}%`,
  },
  dateColumn('deadline', 'Deadline', 'date', (t) => t.deadline),
];

const OPTIONAL: Def[] = [
  { key: 'wbs', label: 'WBS', width: 64, min: 40, align: 'start', editor: 'none', text: 'mono', value: (t) => t.wbs },
  {
    key: 'successors', label: 'Successors', width: 104, min: 60, align: 'start', editor: 'none', text: 'mono',
    value: (t) => t.successors,
  },
  {
    key: 'slack', label: 'Total Slack', width: 104, min: 60, align: 'end', editor: 'none', text: 'mono',
    value: (t, row) => workDays(t.total_slack_minutes, row),
  },
  {
    key: 'critical', label: 'Critical', width: 76, min: 52, align: 'center', editor: 'none',
    value: (t) => (t.is_critical ? 'Yes' : 'No'),
  },
  {
    key: 'status', label: 'Status', width: 112, min: 80, align: 'start', editor: 'none', text: 'chip',
    value: (t) => STATUS_LABELS[t.status],
  },
  {
    key: 'constraint_type', label: 'Constraint Type', width: 176, min: 100, align: 'start', editor: 'select',
    options: (Object.keys(CONSTRAINT_LABELS) as (keyof typeof CONSTRAINT_LABELS)[])
      .map((value) => ({ value, label: CONSTRAINT_LABELS[value] })),
    value: (t) => CONSTRAINT_LABELS[t.constraint_type],
  },
  dateColumn('constraint_date', 'Constraint Date', 'date', (t) => t.constraint_date, 132),
  dateColumn('actual_start', 'Actual Start', 'date', (t) => t.actual_start, 116),
  dateColumn('actual_finish', 'Actual Finish', 'date', (t) => t.actual_finish, 116),
  dateColumn('baseline_start', 'Baseline Start', 'none', (t) => t.baseline_start, 132),
  dateColumn('baseline_finish', 'Baseline Finish', 'none', (t) => t.baseline_finish, 132),
  {
    key: 'baseline_duration', label: 'Baseline Duration', width: 152, min: 60, align: 'end', editor: 'none',
    text: 'mono',
    value: (t, row) => (t.baseline_duration_minutes === null ? ''
      : formatDuration(t.baseline_duration_minutes, t.duration_unit, t.elapsed, row.units)),
  },
  {
    key: 'start_variance', label: 'Start Variance', width: 132, min: 60, align: 'end', editor: 'none',
    text: 'mono', value: (t, row) => workDays(t.start_variance_minutes, row),
  },
  {
    key: 'finish_variance', label: 'Finish Variance', width: 132, min: 60, align: 'end', editor: 'none',
    text: 'mono', value: (t, row) => workDays(t.finish_variance_minutes, row),
  },
  {
    key: 'notes', label: 'Notes', width: 220, min: 80, align: 'start', editor: 'text', text: 'sub',
    value: (t) => oneLine(t.notes),
  },
  // the bar's color: its palette name, or the hex of a custom one (MS Project has no such column)
  {
    key: 'color', label: 'Color', width: 112, min: 64, align: 'start', editor: 'color', text: 'color',
    value: (t) => colorLabel(t.color),
  },
  {
    key: 'created', label: 'Created', width: 108, min: 80, align: 'start', editor: 'none', text: 'mono', date: true,
    value: (t, row) => instant(t.created_at, row),
  },
  {
    key: 'updated', label: 'Updated', width: 108, min: 80, align: 'start', editor: 'none', text: 'mono', date: true,
    value: (t, row) => instant(t.updated_at, row),
  },
];

export const PLAN_COLUMNS: readonly PlanColumn[] = [
  ...DEFAULTS.map((c) => ({ ...c, defaultVisible: true })),
  ...OPTIONAL.map((c) => ({ ...c, defaultVisible: false })),
];

export const COLUMN_BY_KEY: ReadonlyMap<string, PlanColumn> = new Map(PLAN_COLUMNS.map((c) => [c.key, c]));
const ALL_KEYS = PLAN_COLUMNS.map((c) => c.key);
export const DEFAULT_VISIBLE: readonly string[] = PLAN_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key);
/** Never hidden: the row number and the name. */
export const REQUIRED_COLUMNS: ReadonlySet<string> = new Set(['id', 'name']);

/** A column's width: the stored one, else its default for this list size
 *  (`scale`), wider for a date column while the plan shows times. */
export function columnWidth(col: PlanColumn, widths: Readonly<Record<string, number>>, scale: number,
  showTimes: boolean): number {
  const stored = widths[col.key];
  if (stored !== undefined) return stored;
  return Math.round((col.width + (col.date && showTimes ? TIME_PX : 0)) * scale);
}

// ── preferences ──────────────────────────────────────────────────────

export interface ColumnPrefs {
  visible: string[];                  // shown, in display order
  widths: Record<string, number>;     // px, only for columns someone resized
}

export const COLUMNS_KEY = 'plans.columns.v1';

const defaultPrefs = (): ColumnPrefs => ({ visible: [...DEFAULT_VISIBLE], widths: {} });

/** `visible` with `key` added after the nearest column before it (in
 *  PLAN_COLUMNS order) that is shown, else first. */
function insertAtDefault(visible: string[], key: string): string[] {
  for (let i = ALL_KEYS.indexOf(key) - 1; i >= 0; i -= 1) {
    const at = visible.indexOf(ALL_KEYS[i]);
    if (at >= 0) return [...visible.slice(0, at + 1), key, ...visible.slice(at + 1)];
  }
  return [key, ...visible];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((k): k is string => typeof k === 'string') : []);

/**
 * A stored entry made safe: unknown columns (and their widths) dropped,
 * widths kept between the column minimum and a sane maximum, ID and Task
 * Name always shown. Like usePersistentListState's `seen` rule, a default
 * column the entry was never offered (added to the code after it was
 * saved) is shown at its default place; one the person hid stays hidden.
 */
export function sanitizeColumnPrefs(raw: unknown): ColumnPrefs {
  if (!raw || typeof raw !== 'object') return defaultPrefs();
  const entry = raw as { visible?: unknown; widths?: unknown; seen?: unknown };
  let visible = [...DEFAULT_VISIBLE];
  const kept = [...new Set(strings(entry.visible).filter((k) => COLUMN_BY_KEY.has(k)))];
  if (kept.length) {
    visible = kept;
    const seen = new Set(Array.isArray(entry.seen) ? strings(entry.seen) : kept);
    for (const key of DEFAULT_VISIBLE) {
      if (!seen.has(key) && !visible.includes(key)) visible = insertAtDefault(visible, key);
    }
  }
  for (const key of REQUIRED_COLUMNS) {
    if (!visible.includes(key)) visible = insertAtDefault(visible, key);
  }
  const widths: Record<string, number> = {};
  if (entry.widths && typeof entry.widths === 'object' && !Array.isArray(entry.widths)) {
    for (const [key, px] of Object.entries(entry.widths as Record<string, unknown>)) {
      const col = COLUMN_BY_KEY.get(key);
      if (col && typeof px === 'number' && Number.isFinite(px)) {
        widths[key] = Math.min(Math.max(Math.round(px), col.min), MAX_WIDTH);
      }
    }
  }
  return { visible, widths };
}

// Where the choice lives when localStorage refuses (private browsing, a
// full quota): this tab keeps it for the session.
let memoryRaw: string | null = null;
let memoryWins = false;

function readRaw(): string | null {
  try {
    const raw = localStorage.getItem(COLUMNS_KEY);
    return memoryWins ? memoryRaw : raw;
  } catch {
    return memoryRaw;
  }
}

function parse(raw: string | null): ColumnPrefs {
  if (raw === null) return defaultPrefs();
  try {
    return sanitizeColumnPrefs(JSON.parse(raw));
  } catch {
    return defaultPrefs();
  }
}

/** The stored choice, made safe; the defaults when there is none. */
export function loadColumnPrefs(): ColumnPrefs {
  return parse(readRaw());
}

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((fn) => fn());

/** The stored text the snapshot last read, kept only while someone is
 *  subscribed: a save here and a `storage` event from another tab (the only
 *  ways the text changes) both drop it. Without subscribers nothing tells it
 *  about a change, so every read goes to storage. */
let rawCache: { raw: string | null } | null = null;

/** Stores the choice (with every column it offered, for the `seen` rule)
 *  and tells every subscriber. */
export function saveColumnPrefs(prefs: ColumnPrefs): void {
  const raw = JSON.stringify({ visible: prefs.visible, widths: prefs.widths, seen: ALL_KEYS });
  memoryRaw = raw;
  try {
    localStorage.setItem(COLUMNS_KEY, raw);
    memoryWins = false;
  } catch {
    memoryWins = true;
  }
  rawCache = null;
  notify();
}

let snapshot: { raw: string | null; prefs: ColumnPrefs } | null = null;

/** The current choice for useSyncExternalStore: the same object until the
 *  stored text changes. Called on every render of every sheet, so while
 *  subscribed it reads storage only after a change. */
export function columnPrefsSnapshot(): ColumnPrefs {
  let raw: string | null;
  if (rawCache) {
    raw = rawCache.raw;
  } else {
    raw = readRaw();
    if (listeners.size > 0) rawCache = { raw };
  }
  if (!snapshot || snapshot.raw !== raw) snapshot = { raw, prefs: parse(raw) };
  return snapshot.prefs;
}

/** Calls `fn` after every save, here or in another tab. */
export function subscribeColumnPrefs(fn: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key !== COLUMNS_KEY && e.key !== null) return;
    rawCache = null;
    fn();
  };
  listeners.add(fn);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(fn);
    window.removeEventListener('storage', onStorage);
    if (listeners.size === 0) rawCache = null;
  };
}
