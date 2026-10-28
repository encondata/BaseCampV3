/**
 * The task sheet's selection, shared by the sheet and the Gantt: the active
 * cell (a task row or the blank new-task row at the bottom, and a column
 * key), the selected task rows (bulk commands act on these) and the anchor a
 * Shift-click extends from. Pure; the tab holds one in state.
 */

export interface ActiveCell {
  /** A task id, or 'blank' for the new-task row under the last task. */
  id: string | 'blank';
  col: string;
}

export interface Selection {
  active: ActiveCell | null;
  rows: Set<string>;
  anchor: string | null;
}

export type MoveDir = 'up' | 'down' | 'left' | 'right';

export const EMPTY_SELECTION: Selection = Object.freeze({
  active: null,
  rows: new Set<string>(),
  anchor: null,
}) as Selection;

/** The cell becomes active and its row the only selected one (the blank
 *  row selects no task). */
export function selectCell(id: string | 'blank', col: string): Selection {
  return id === 'blank'
    ? { active: { id, col }, rows: new Set(), anchor: null }
    : { active: { id, col }, rows: new Set([id]), anchor: id };
}

/** The row alone, keeping `col` as the active column. */
export function selectRow(id: string, col: string): Selection {
  return selectCell(id, col);
}

/**
 * The active cell one step `dir` within `rows` (the visible rows in display
 * order, ending with 'blank' when the sheet shows the new-task row) and
 * `cols` (the visible columns that take the active cell), clamped at the
 * edges. The selection follows the active cell. Without an active cell, or
 * with one whose row or column is no longer shown, it starts from the first
 * row or column instead of stepping. Nothing to move to leaves `sel` as is.
 */
export function moveActive(sel: Selection, dir: MoveDir, rows: readonly string[], cols: readonly string[]): Selection {
  if (!rows.length || !cols.length) return sel;
  const clamp = (i: number, n: number) => Math.min(Math.max(i, 0), n - 1);
  let row = sel.active ? rows.indexOf(sel.active.id) : -1;
  let col = sel.active ? cols.indexOf(sel.active.col) : -1;
  const step = row >= 0 && col >= 0;
  if (row < 0) row = 0;
  if (col < 0) col = 0;
  if (step && dir === 'up') row = clamp(row - 1, rows.length);
  if (step && dir === 'down') row = clamp(row + 1, rows.length);
  if (step && dir === 'left') col = clamp(col - 1, cols.length);
  if (step && dir === 'right') col = clamp(col + 1, cols.length);
  return selectCell(rows[row], cols[col]);
}
