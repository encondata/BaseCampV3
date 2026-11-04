/** Outline math the sheet recomputes after every op: display IDs, WBS,
 *  levels, summaries and the Predecessors / Successors text (the API's
 *  service.tasks_out rules), collapsed rows, descendants and ancestors. */
import { describe, expect, it } from 'vitest';

import { STANDARD_UNITS } from './durations';
import { ancestors, computeOutline, descendants, visibleRows, type OutlineLink, type OutlineTask } from './outline';

// 1 S1          (summary)
// 2   A
// 3   B         A -> B, FS+2 days
// 4 S2          (summary)
// 5   S3        (nested summary)
// 6     C       B -> C SS, A -> C FS
const task = (id: string, parent_id: string | null, position: number): OutlineTask => ({ id, parent_id, position });
const TASKS: OutlineTask[] = [
  task('s1', null, 0), task('a', 's1', 1), task('b', 's1', 2),
  task('s2', null, 3), task('s3', 's2', 4), task('c', 's3', 5),
];
const ORDER = TASKS.map((t) => t.id);
const link = (predecessor_id: string, successor_id: string, link_type: OutlineLink['link_type'],
  lag_minutes = 0): OutlineLink => ({
  predecessor_id, successor_id, link_type, lag_minutes, lag_unit: 'd', lag_elapsed: false,
});
const LINKS = [link('a', 'b', 'FS', 960), link('b', 'c', 'SS'), link('a', 'c', 'FS')];
const byId = new Map(TASKS.map((t) => [t.id, t]));

describe('computeOutline', () => {
  const outline = computeOutline(TASKS, ORDER, LINKS, STANDARD_UNITS);

  it('numbers the tasks in outline order', () => {
    expect([...outline.keys()]).toEqual(ORDER);
    expect(ORDER.map((id) => outline.get(id)!.displayId)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(ORDER.map((id) => outline.get(id)!.wbs)).toEqual(['1', '1.1', '1.2', '2', '2.1', '2.1.1']);
    expect(ORDER.map((id) => outline.get(id)!.level)).toEqual([1, 2, 2, 1, 2, 3]);
    expect(ORDER.filter((id) => outline.get(id)!.isSummary)).toEqual(['s1', 's2', 's3']);
  });

  it('writes Predecessors and Successors text with display IDs, sorted', () => {
    expect(outline.get('b')!.predecessors).toBe('2FS+2 days');
    expect(outline.get('a')!.successors).toBe('3FS+2 days,6');
    expect(outline.get('c')!.predecessors).toBe('2,3SS');
    expect(outline.get('b')!.successors).toBe('6SS');
    expect(outline.get('s1')!.predecessors).toBe('');
  });

  it('renumbers from a new order', () => {
    // S2's branch moved above S1's
    const moved = computeOutline(TASKS, ['s2', 's3', 'c', 's1', 'a', 'b'], LINKS, STANDARD_UNITS);
    expect(moved.get('s1')!.displayId).toBe(4);
    expect(moved.get('s1')!.wbs).toBe('2');
    expect(moved.get('c')!.wbs).toBe('1.1.1');
    expect(moved.get('b')!.predecessors).toBe('5FS+2 days');
    expect(moved.get('c')!.predecessors).toBe('5,6SS');
  });

  it('places a task the order misses last, by position', () => {
    const extra = [...TASKS, task('z', null, 9), task('y', null, 8)];
    const out = computeOutline(extra, ORDER, LINKS, STANDARD_UNITS);
    expect([...out.keys()].slice(-2)).toEqual(['y', 'z']);
    expect(out.get('y')!.wbs).toBe('3');
    expect(out.get('z')!.displayId).toBe(8);
  });

  it('skips ids the plan no longer has and links to them', () => {
    const left = TASKS.filter((t) => t.id !== 'a');
    const out = computeOutline(left, ORDER, LINKS, STANDARD_UNITS);
    expect(out.has('a')).toBe(false);
    expect(out.get('b')!.displayId).toBe(2);
    expect(out.get('b')!.predecessors).toBe('');
    expect(out.get('c')!.predecessors).toBe('2SS');
  });

  it('reads a parent the plan does not have as top level', () => {
    const out = computeOutline([task('x', 'gone', 0)], ['x'], [], STANDARD_UNITS);
    expect(out.get('x')).toMatchObject({ displayId: 1, wbs: '1', level: 1, isSummary: false });
  });

  it('numbers a parent loop flat instead of hanging', () => {
    const loop = [task('p', 'q', 0), task('q', 'p', 1)];
    const out = computeOutline(loop, ['p', 'q'], [], STANDARD_UNITS);
    expect(out.get('p')).toMatchObject({ displayId: 1, wbs: '1', level: 1 });
    expect(out.get('q')).toMatchObject({ displayId: 2, wbs: '2', level: 1 });
  });
});

describe('visibleRows', () => {
  it('shows every row when nothing is collapsed', () => {
    expect(visibleRows(ORDER, byId, new Set())).toEqual(ORDER);
  });

  it('hides a collapsed summary’s subtasks', () => {
    expect(visibleRows(ORDER, byId, new Set(['s1']))).toEqual(['s1', 's2', 's3', 'c']);
  });

  it('hides every level below a collapsed summary', () => {
    expect(visibleRows(ORDER, byId, new Set(['s2']))).toEqual(['s1', 'a', 'b', 's2']);
    expect(visibleRows(ORDER, byId, new Set(['s3']))).toEqual(['s1', 'a', 'b', 's2', 's3']);
  });

  it('survives a parent loop', () => {
    const loop = new Map([['p', { parent_id: 'q' }], ['q', { parent_id: 'p' }]]);
    expect(visibleRows(['p', 'q'], loop, new Set(['p']))).toEqual(['p']);
  });
});

describe('descendants / ancestors', () => {
  it('lists every task below one, in outline order', () => {
    expect(descendants('s2', TASKS)).toEqual(['s3', 'c']);
    expect(descendants('s1', TASKS)).toEqual(['a', 'b']);
    expect(descendants('c', TASKS)).toEqual([]);
  });

  it('lists the summaries above one, nearest first', () => {
    expect(ancestors('c', byId)).toEqual(['s3', 's2']);
    expect(ancestors('s1', byId)).toEqual([]);
  });

  it('stops at a loop', () => {
    const loop = new Map([['p', { parent_id: 'q' }], ['q', { parent_id: 'p' }]]);
    expect(ancestors('p', loop)).toEqual(['q']);
    expect(descendants('p', [task('p', 'q', 0), task('q', 'p', 1)])).toEqual(['q']);
  });
});
