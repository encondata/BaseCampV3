/**
 * lib/plans/board: the Board view's columns. A leaf task's column is its
 * % Complete (0 Not started, 100 Complete, anything between In progress);
 * a drop into a column sets 0 / 50 / 100; the cards are the leaf tasks the
 * filter shows, in outline order, each with its summaries' path.
 */
import { describe, expect, it } from 'vitest';

import type { PlanTask } from './api';
import { BOARD_COLUMNS, boardCards, columnOf, pathLabel, percentForColumn } from './board';
import { makeTask } from './planFixtures';

/**
 *  Prep (summary)
 *    Crating (summary)
 *      Wrap racks     40%
 *      Load crates    0%
 *    Order trucks     100%
 *  Move day           0%  (top level)
 *  Go live            milestone, 0%
 */
function tasks(): PlanTask[] {
  return [
    makeTask('s1', { is_summary: true, name: 'Prep', percent_complete: 20 }),
    makeTask('s2', { is_summary: true, name: 'Crating', parent_id: 's1', outline_level: 2, percent_complete: 20 }),
    makeTask('a', { name: 'Wrap racks', parent_id: 's2', outline_level: 3, percent_complete: 40 }),
    makeTask('b', { name: 'Load crates', parent_id: 's2', outline_level: 3 }),
    makeTask('c', { name: 'Order trucks', parent_id: 's1', outline_level: 2, percent_complete: 100 }),
    makeTask('d', { name: 'Move day' }),
    makeTask('m', { name: 'Go live', is_milestone: true }),
  ];
}
const byId = (list: PlanTask[]) => new Map(list.map((t) => [t.id, t]));

describe('columnOf', () => {
  it('0% is Not started, 100% Complete, anything between In progress', () => {
    expect(columnOf(makeTask('x', { percent_complete: 0 }))).toBe('not_started');
    expect(columnOf(makeTask('x', { percent_complete: 1 }))).toBe('in_progress');
    expect(columnOf(makeTask('x', { percent_complete: 40 }))).toBe('in_progress');
    expect(columnOf(makeTask('x', { percent_complete: 99 }))).toBe('in_progress');
    expect(columnOf(makeTask('x', { percent_complete: 100 }))).toBe('complete');
  });
});

describe('percentForColumn', () => {
  it('a drop sets 0 / 50 / 100', () => {
    expect(percentForColumn('not_started')).toBe(0);
    expect(percentForColumn('in_progress')).toBe(50);
    expect(percentForColumn('complete')).toBe(100);
  });

  it('the columns, in order, with their names', () => {
    expect(BOARD_COLUMNS.map((c) => [c.key, c.label])).toEqual([
      ['not_started', 'Not started'], ['in_progress', 'In progress'], ['complete', 'Complete'],
    ]);
  });
});

describe('pathLabel', () => {
  it('names the summaries above a task, the top one first', () => {
    const map = byId(tasks());
    expect(pathLabel('a', map)).toBe('Prep › Crating');
    expect(pathLabel('c', map)).toBe('Prep');
    expect(pathLabel('d', map)).toBe('');
  });
});

describe('boardCards', () => {
  it('puts a 40% task in In progress, with its path', () => {
    const list = tasks();
    const cards = boardCards(list.map((t) => t.id), byId(list));
    expect(cards.in_progress.map((c) => c.task.id)).toEqual(['a']);
    expect(cards.in_progress[0].path).toBe('Prep › Crating');
  });

  it('leaf tasks only, in outline order, each in its column', () => {
    const list = tasks();
    const cards = boardCards(list.map((t) => t.id), byId(list));
    expect(cards.not_started.map((c) => c.task.id)).toEqual(['b', 'd', 'm']);
    expect(cards.complete.map((c) => c.task.id)).toEqual(['c']);
    // the summaries are no cards of their own, only paths
    const all = [...cards.not_started, ...cards.in_progress, ...cards.complete].map((c) => c.task.id);
    expect(all).not.toContain('s1');
    expect(all).not.toContain('s2');
  });

  it('only the rows given (the filter’s), skipping ids the plan doesn’t have', () => {
    const list = tasks();
    const cards = boardCards(['s1', 's2', 'a', 'gone'], byId(list));
    expect(cards.in_progress.map((c) => c.task.id)).toEqual(['a']);
    expect(cards.not_started).toEqual([]);
    expect(cards.complete).toEqual([]);
  });
});
