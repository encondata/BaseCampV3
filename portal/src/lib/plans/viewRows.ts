/**
 * The Gantt view's rows and selection between its two sides (pure; used by
 * components/plans/useSheetView):
 *
 * - The panes (the sheet and the chart) work by row key: a task's id, or
 *   under Group by its group's key and its own (lib/plans/filters
 *   `rowKey`), so a task with two resources has two rows, each picked on
 *   its own.
 * - The commands work by task: `taskRowsOf` (the tasks shown, each once,
 *   in screen order) and `taskSelection` (the selection read as tasks).
 * - `viewSelection` is what the panes show of what was picked: a row a
 *   filter or grouping hides moves to its task's first row, or goes; with
 *   nothing shaping the view, a grouped key left behind (Group by turned
 *   off) is read as its task again.
 * - `pasteRowsFrom`: while grouped, a paste fills the rows on screen from
 *   the active one down, each task once.
 */
import { taskOfRow } from './filters';
import type { Selection } from './selection';

/** A row nobody selects: a filter's context row, a group's band. */
export type Inert = (key: string) => boolean;

/** Each task's first row, in screen order (inert rows skipped). */
export function firstRowsOf(rows: readonly string[], inert: Inert): Map<string, string> {
  const out = new Map<string, string>();
  for (const key of rows) {
    if (inert(key)) continue;
    const task = taskOfRow(key);
    if (task && !out.has(task)) out.set(task, key);
  }
  return out;
}

/** The tasks shown, each once, in screen order. */
export function taskRowsOf(firstRows: ReadonlyMap<string, string>): string[] {
  return [...firstRows.keys()];
}

/** `sel` with every row it names that isn't one to select (`ok`) moved to
 *  its task's first row (`firstRow`), or dropped; `sel` itself when that
 *  changes nothing. */
export function settleSelection(
  sel: Selection, ok: (key: string) => boolean, firstRow: (task: string) => string | null,
): Selection {
  let changed = false;
  const place = (key: string): string | null => {
    if (ok(key)) return key;
    changed = true;
    const task = taskOfRow(key);
    return task ? firstRow(task) : null;
  };
  const activeId = sel.active ? place(sel.active.id) : null;
  const rows = new Set<string>();
  for (const key of sel.rows) {
    const at = place(key);
    if (at) rows.add(at);
  }
  const anchor = sel.anchor === null ? null : place(sel.anchor);
  if (!changed) return sel;
  return { active: sel.active && activeId ? { id: activeId, col: sel.active.col } : null, rows, anchor };
}

/** `sel` read as tasks (each row its task, each task once); `sel` itself
 *  when none of its rows names a group. */
export function taskSelection(sel: Selection): Selection {
  const id = (key: string | null) => (key === null ? null : taskOfRow(key));
  const plain = (key: string | null) => key === null || id(key) === key;
  if (plain(sel.active?.id ?? null) && plain(sel.anchor) && [...sel.rows].every(plain)) return sel;
  const activeId = sel.active ? id(sel.active.id) : null;
  return {
    active: sel.active && activeId ? { id: activeId, col: sel.active.col } : null,
    rows: new Set([...sel.rows].map(id).filter((t): t is string => !!t)),
    anchor: id(sel.anchor),
  };
}

export interface ViewShape {
  /** The rows on screen, by key. */
  rows: readonly string[];
  inert: Inert;
  /** A filter or Group by shapes the rows. */
  shaped: boolean;
  grouped: boolean;
  /** Each task's first row (firstRowsOf), when the caller has it. */
  firstRows?: ReadonlyMap<string, string>;
}

/** What the panes show selected of `picks` (see the header). */
export function viewSelection(picks: Selection, shape: ViewShape): Selection {
  if (!shape.shaped) return taskSelection(picks);
  const rowSet = new Set(shape.rows);
  const first = shape.firstRows ?? firstRowsOf(shape.rows, shape.inert);
  const ok = (key: string) => (key === 'blank' ? !shape.grouped : rowSet.has(key) && !shape.inert(key));
  return settleSelection(picks, ok, (task) => first.get(task) ?? null);
}

/** The tasks a paste fills while grouped: the rows on screen from the
 *  active one (`activeKey`) down, in screen order, each task once (a task
 *  already filled isn't filled again under its next resource). */
export function pasteRowsFrom(rows: readonly string[], inert: Inert, activeKey: string | null): string[] {
  const at = activeKey === null ? -1 : rows.indexOf(activeKey);
  if (at < 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const key of rows.slice(at)) {
    if (inert(key)) continue;
    const task = taskOfRow(key);
    if (!task || seen.has(task)) continue;
    seen.add(task);
    out.push(task);
  }
  return out;
}
