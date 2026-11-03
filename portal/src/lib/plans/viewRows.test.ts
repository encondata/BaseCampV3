/**
 * lib/plans/viewRows.ts: the sheet view's rows and selection between the
 * panes (by row key) and the commands (by task). A grouped key left behind
 * when grouping goes reads as its task; a selection a filter or grouping
 * hides moves to the task's first row, or goes; a paste while grouped walks
 * the rows on screen from the active one, each task once.
 */
import { describe, expect, it } from 'vitest';

import { bandKey, rowKey } from './filters';
import { selectCell, type Selection } from './selection';
import { firstRowsOf, pasteRowsFrom, settleSelection, taskRowsOf, taskSelection, viewSelection } from './viewRows';

const D = 'person:p-dana';
const J = 'person:p-me';
const U = 'unassigned';
/** Dana: b, c · Jimmy: a, b · Unassigned: m, w */
const grouped = [
  bandKey(D), rowKey(D, 'b'), rowKey(D, 'c'),
  bandKey(J), rowKey(J, 'a'), rowKey(J, 'b'),
  bandKey(U), rowKey(U, 'm'), rowKey(U, 'w'),
];
const bands = new Set([bandKey(D), bandKey(J), bandKey(U)]);
const inertGrouped = (key: string) => bands.has(key);

const sel = (active: string, rows: string[] = [active], anchor: string | null = active): Selection => ({
  active: { id: active, col: 'name' }, rows: new Set(rows), anchor,
});

describe('firstRowsOf / taskRowsOf', () => {
  it('each task’s first row, skipping bands and context rows; the tasks once, in screen order', () => {
    const first = firstRowsOf(grouped, inertGrouped);
    expect([...first]).toEqual([['b', rowKey(D, 'b')], ['c', rowKey(D, 'c')], ['a', rowKey(J, 'a')],
      ['m', rowKey(U, 'm')], ['w', rowKey(U, 'w')]]);
    expect(taskRowsOf(first)).toEqual(['b', 'c', 'a', 'm', 'w']);
    expect([...firstRowsOf(['s1', 'a', 'c'], (k) => k === 's1').keys()]).toEqual(['a', 'c']);
  });
});

describe('taskSelection', () => {
  it('reads every row as its task; the same object when nothing names a group', () => {
    expect(taskSelection(sel(rowKey(J, 'b'), [rowKey(J, 'b'), rowKey(D, 'b'), rowKey(J, 'a')]))).toEqual(
      sel('b', ['b', 'a'], 'b'));
    const plain = sel('b', ['b', 'a']);
    expect(taskSelection(plain)).toBe(plain);
  });
});

describe('settleSelection', () => {
  it('moves a row not on screen to its task’s first row, drops one with none, and keeps identity otherwise', () => {
    const first = firstRowsOf(grouped, inertGrouped);
    const ok = (key: string) => grouped.includes(key) && !inertGrouped(key);
    const settled = settleSelection(sel('a', ['a', 'zz'], 'a'), ok, (t) => first.get(t) ?? null);
    expect(settled).toEqual(sel(rowKey(J, 'a'), [rowKey(J, 'a')], rowKey(J, 'a')));
    const already = sel(rowKey(J, 'b'));
    expect(settleSelection(already, ok, (t) => first.get(t) ?? null)).toBe(already);
  });
});

describe('viewSelection', () => {
  it('Group by gone: a grouped key left as the selection is its task again (no row lost, no command blind)', () => {
    const left = sel(rowKey(J, 'b'));
    const view = viewSelection(left, { rows: ['a', 'b', 'c'], inert: () => false, shaped: false, grouped: false });
    expect(view).toEqual(sel('b'));
    const plain = sel('b');
    expect(viewSelection(plain, { rows: ['a', 'b', 'c'], inert: () => false, shaped: false, grouped: false }))
      .toBe(plain);
  });

  it('grouped: a task id moves to its first row; a band is never selected; no blank row', () => {
    const opts = { rows: grouped, inert: inertGrouped, shaped: true, grouped: true };
    expect(viewSelection(selectCell('b', 'name'), opts).active).toEqual({ id: rowKey(D, 'b'), col: 'name' });
    expect(viewSelection(sel(bandKey(J)), opts).active).toBeNull();
    expect(viewSelection(selectCell('blank', 'name'), opts).active).toBeNull();
    const second = sel(rowKey(J, 'b'));
    expect(viewSelection(second, opts)).toBe(second);
  });

  it('filtered: a context row or a hidden task goes; the blank row stays', () => {
    const opts = { rows: ['s1', 'a'], inert: (k: string) => k === 's1', shaped: true, grouped: false };
    expect(viewSelection(sel('s1'), opts).active).toBeNull();
    expect(viewSelection(sel('c'), opts).active).toBeNull();
    expect(viewSelection(selectCell('blank', 'name'), opts).active).toEqual({ id: 'blank', col: 'name' });
  });
});

describe('pasteRowsFrom', () => {
  it('grouped: the rows on screen from the active one down, each task once', () => {
    expect(pasteRowsFrom(grouped, inertGrouped, rowKey(J, 'a'))).toEqual(['a', 'b', 'm', 'w']);
    // the second resource's copy of b: b, then what's below it
    expect(pasteRowsFrom(grouped, inertGrouped, rowKey(J, 'b'))).toEqual(['b', 'm', 'w']);
    // the first copy: b, c, then a (b again is skipped), m, w
    expect(pasteRowsFrom(grouped, inertGrouped, rowKey(D, 'b'))).toEqual(['b', 'c', 'a', 'm', 'w']);
    expect(pasteRowsFrom(grouped, inertGrouped, null)).toEqual([]);
  });
});
