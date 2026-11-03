/**
 * lib/plans/moveTasks.ts: moving whole tasks in the outline (a row dragged
 * by its ID, a cut pasted back into its plan) as the one `move_tasks` op
 * the API takes: the top-most tasks picked (each brings its subtasks),
 * right above a row (its siblings) or at the end; never into what moves,
 * and nothing when the tasks are already there.
 */
import { describe, expect, it } from 'vitest';

import { dropGap, dropPlace, insideMoved, moveOp, moveTops } from './moveTasks';
import { makeTask } from './planFixtures';

/**
 *  1 Prep (summary)
 *    2 Crates
 *    3 Labels
 *  4 Survey
 *  5 Go live
 */
const tasks = [
  makeTask('s', { display_id: 1, is_summary: true, name: 'Prep' }),
  makeTask('k1', { display_id: 2, wbs: '1.1', outline_level: 2, parent_id: 's', name: 'Crates' }),
  makeTask('k2', { display_id: 3, wbs: '1.2', outline_level: 2, parent_id: 's', position: 1, name: 'Labels' }),
  makeTask('a', { display_id: 4, wbs: '2', position: 1, name: 'Survey' }),
  makeTask('z', { display_id: 5, wbs: '3', position: 2, name: 'Go live' }),
];
const plan = { tasks };
const byId = new Map(tasks.map((t) => [t.id, t]));

describe('moveTops', () => {
  it('keeps the top-most tasks picked, in outline order: a subtask goes with its summary', () => {
    expect(moveTops(['a', 'k1', 's'], plan)).toEqual(['s', 'a']);
    expect(moveTops(['z', 'k2'], plan)).toEqual(['k2', 'z']);
    expect(moveTops(['gone'], plan)).toEqual([]);
  });
});

describe('insideMoved', () => {
  it('is a moved task or any task under one', () => {
    expect(insideMoved('s', ['s'], byId)).toBe(true);
    expect(insideMoved('k2', ['s'], byId)).toBe(true);
    expect(insideMoved('a', ['s'], byId)).toBe(false);
  });
});

describe('moveOp', () => {
  it('above a row: the tasks become its siblings, right above it', () => {
    expect(moveOp(plan, ['s'], { beforeId: 'z' })).toEqual({ op: 'move_tasks', ids: ['s'], before_id: 'z' });
    // a subtask dropped above a top-level row comes up a level
    expect(moveOp(plan, ['k2'], { beforeId: 'a' })).toEqual({ op: 'move_tasks', ids: ['k2'], before_id: 'a' });
  });

  it('at the end: neither field (the end of the plan), or the end of a summary’s subtasks', () => {
    expect(moveOp(plan, ['s', 'a'], { beforeId: null })).toEqual({ op: 'move_tasks', ids: ['s', 'a'] });
    expect(moveOp(plan, ['z'], { beforeId: null, parentId: 's' }))
      .toEqual({ op: 'move_tasks', ids: ['z'], parent_id: 's' });
  });

  it('into what moves (the task itself or its subtasks) is refused', () => {
    expect(moveOp(plan, ['s'], { beforeId: 's' })).toBe('inside');
    expect(moveOp(plan, ['s'], { beforeId: 'k2' })).toBe('inside');
    expect(moveOp(plan, ['a'], { beforeId: null, parentId: 'a' })).toBe('inside');
    expect(moveOp(plan, ['s'], { beforeId: null, parentId: 'k1' })).toBe('inside');
  });

  it('nothing when the tasks are already there', () => {
    // Survey right above Go live already
    expect(moveOp(plan, ['a'], { beforeId: 'z' })).toBeNull();
    expect(moveOp(plan, ['z'], { beforeId: null })).toBeNull();
    expect(moveOp(plan, ['k1'], { beforeId: 'k2' })).toBeNull();
    expect(moveOp(plan, ['k2'], { beforeId: null, parentId: 's' })).toBeNull();
    expect(moveOp(plan, [], { beforeId: 'z' })).toBeNull();
    // a row the plan doesn't have
    expect(moveOp(plan, ['a'], { beforeId: 'gone' })).toBeNull();
  });
});

describe('dropGap and dropPlace', () => {
  it('the gap nearest the pointer, from above the first row to below the last', () => {
    expect(dropGap(-40, 30, 5)).toBe(0);
    expect(dropGap(14, 30, 5)).toBe(0);
    expect(dropGap(16, 30, 5)).toBe(1);
    expect(dropGap(120, 30, 5)).toBe(4);
    expect(dropGap(999, 30, 5)).toBe(5);
  });

  it('above the row at the gap; below the last row the end; never above a context row', () => {
    const rows = ['s', 'k1', 'k2', 'a', 'z'];
    const context = (key: string) => key === 's';
    expect(dropPlace(4, rows, context)).toEqual({ beforeId: 'z' });
    expect(dropPlace(5, rows, context)).toEqual({ beforeId: null });
    expect(dropPlace(0, rows, context)).toBeNull();
  });
});
