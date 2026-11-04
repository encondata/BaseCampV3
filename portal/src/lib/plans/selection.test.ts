/**
 * lib/plans/selection.ts: the sheet's selection (active cell, selected rows,
 * anchor) and moving the active cell with the arrows, clamped at the edges
 * of the visible rows and columns.
 */
import { describe, expect, it } from 'vitest';

import {
  EMPTY_SELECTION, extendRows, moveActive, selectCell, selectRow, toggleRow, type Selection,
} from './selection';

const ROWS = ['a', 'b', 'c'];
const COLS = ['name', 'duration', 'start'];

const at = (id: string, col: string): Selection => selectCell(id, col);

describe('selectCell and selectRow', () => {
  it('a cell makes its row the only selected row and the anchor', () => {
    const sel = selectCell('b', 'duration');
    expect(sel.active).toEqual({ id: 'b', col: 'duration' });
    expect([...sel.rows]).toEqual(['b']);
    expect(sel.anchor).toBe('b');
  });

  it('the blank row selects no task row', () => {
    const sel = selectCell('blank', 'name');
    expect(sel.active).toEqual({ id: 'blank', col: 'name' });
    expect(sel.rows.size).toBe(0);
    expect(sel.anchor).toBeNull();
  });

  it('a row selection keeps the active column', () => {
    const sel = selectRow('c', 'start');
    expect(sel.active).toEqual({ id: 'c', col: 'start' });
    expect([...sel.rows]).toEqual(['c']);
  });

  it('starts empty', () => {
    expect(EMPTY_SELECTION.active).toBeNull();
    expect(EMPTY_SELECTION.rows.size).toBe(0);
    expect(EMPTY_SELECTION.anchor).toBeNull();
  });

  it('never changes a selection in place: the shared empty one stays empty', () => {
    const picked = selectCell('a', 'name');
    const moved = moveActive(EMPTY_SELECTION, 'down', ROWS, COLS);
    const again = moveActive(picked, 'down', ROWS, COLS);
    expect(EMPTY_SELECTION.rows.size).toBe(0);
    expect(EMPTY_SELECTION.active).toBeNull();
    for (const sel of [picked, moved, again]) expect(sel.rows).not.toBe(EMPTY_SELECTION.rows);
    expect([...picked.rows]).toEqual(['a']);
    expect(again.rows).not.toBe(picked.rows);
  });
});

describe('row selection (the ID column)', () => {
  const ROWS5 = ['a', 'b', 'c', 'd', 'e'];

  it('Ctrl/⌘-click toggles a row and leaves the others selected', () => {
    const one = selectRow('b', 'id');
    const two = toggleRow(one, 'd', 'id');
    expect([...two.rows].sort()).toEqual(['b', 'd']);
    expect(two.active).toEqual({ id: 'd', col: 'id' });
    expect(two.anchor).toBe('d');
    const back = toggleRow(two, 'b', 'id');
    expect([...back.rows]).toEqual(['d']);
    expect(one.rows.size).toBe(1);     // the selection it came from is untouched
  });

  it('Shift-click selects every visible row from the anchor', () => {
    const sel = extendRows(selectRow('b', 'id'), 'd', 'id', ROWS5);
    expect([...sel.rows]).toEqual(['b', 'c', 'd']);
    expect(sel.anchor).toBe('b');
    expect(sel.active).toEqual({ id: 'd', col: 'id' });
    expect([...extendRows(sel, 'a', 'id', ROWS5).rows]).toEqual(['a', 'b']);
  });

  it('Shift-click with no anchor (or one now hidden) selects the row alone', () => {
    expect([...extendRows(EMPTY_SELECTION, 'c', 'id', ROWS5).rows]).toEqual(['c']);
    const hidden: Selection = { active: null, rows: new Set(['x']), anchor: 'x' };
    expect([...extendRows(hidden, 'c', 'id', ROWS5).rows]).toEqual(['c']);
  });

  it('never touches the shared empty selection', () => {
    toggleRow(EMPTY_SELECTION, 'a', 'id');
    extendRows(EMPTY_SELECTION, 'a', 'id', ROWS5);
    expect(EMPTY_SELECTION.rows.size).toBe(0);
  });
});

describe('moveActive', () => {
  it('moves down and up through the visible rows', () => {
    expect(moveActive(at('a', 'name'), 'down', ROWS, COLS).active).toEqual({ id: 'b', col: 'name' });
    expect(moveActive(at('c', 'start'), 'up', ROWS, COLS).active).toEqual({ id: 'b', col: 'start' });
  });

  it('moves left and right through the visible columns', () => {
    expect(moveActive(at('b', 'name'), 'right', ROWS, COLS).active).toEqual({ id: 'b', col: 'duration' });
    expect(moveActive(at('b', 'start'), 'left', ROWS, COLS).active).toEqual({ id: 'b', col: 'duration' });
  });

  it('stops at every edge', () => {
    expect(moveActive(at('a', 'name'), 'up', ROWS, COLS).active).toEqual({ id: 'a', col: 'name' });
    expect(moveActive(at('c', 'name'), 'down', ROWS, COLS).active).toEqual({ id: 'c', col: 'name' });
    expect(moveActive(at('b', 'name'), 'left', ROWS, COLS).active).toEqual({ id: 'b', col: 'name' });
    expect(moveActive(at('b', 'start'), 'right', ROWS, COLS).active).toEqual({ id: 'b', col: 'start' });
  });

  it('the selection follows the active cell', () => {
    const sel: Selection = { active: { id: 'a', col: 'name' }, rows: new Set(['a', 'b']), anchor: 'a' };
    const next = moveActive(sel, 'down', ROWS, COLS);
    expect([...next.rows]).toEqual(['b']);
    expect(next.anchor).toBe('b');
  });

  it('reaches the blank row when the rows end with it, and comes back', () => {
    const rows = [...ROWS, 'blank'];
    const down = moveActive(at('c', 'name'), 'down', rows, COLS);
    expect(down.active).toEqual({ id: 'blank', col: 'name' });
    expect(down.rows.size).toBe(0);
    expect(moveActive(down, 'down', rows, COLS).active).toEqual({ id: 'blank', col: 'name' });
    expect(moveActive(down, 'up', rows, COLS).active).toEqual({ id: 'c', col: 'name' });
  });

  it('without an active cell, starts at the first row and column', () => {
    expect(moveActive(EMPTY_SELECTION, 'down', ROWS, COLS).active).toEqual({ id: 'a', col: 'name' });
    expect(moveActive(EMPTY_SELECTION, 'left', ROWS, COLS).active).toEqual({ id: 'a', col: 'name' });
  });

  it('an active row or column that is no longer shown starts over from the first', () => {
    expect(moveActive(at('gone', 'duration'), 'down', ROWS, COLS).active).toEqual({ id: 'a', col: 'duration' });
    expect(moveActive(at('b', 'hidden'), 'right', ROWS, COLS).active).toEqual({ id: 'b', col: 'name' });
  });

  it('nothing to move to leaves the selection as it was', () => {
    const sel = at('a', 'name');
    expect(moveActive(sel, 'down', [], COLS)).toBe(sel);
    expect(moveActive(sel, 'down', ROWS, [])).toBe(sel);
  });
});
