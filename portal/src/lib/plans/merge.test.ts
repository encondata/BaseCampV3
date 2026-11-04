/**
 * lib/plans/merge.ts: a plan plus one ops batch's answer (OpsOut) is the
 * plan after the batch. Changed rows replace theirs by id, deleted ones go,
 * `order` (when present) is the new outline order, and every task's
 * display ID, WBS, level, summary flag and link text is renumbered the way
 * the API would, since the batch only answers the rows it changed.
 */
import { describe, expect, it } from 'vitest';

import { mergeOps, planView } from './merge';
import { flatTasks, makeLink, makeOpsResult, makePlan, makeTask } from './planFixtures';

describe('planView', () => {
  it('computes the outline of a loaded plan in its task order', () => {
    const view = planView(makePlan({ links: [makeLink('l1', 'a', 'c')] }));
    expect([...view.outline.keys()]).toEqual(['a', 'b', 'c']);
    expect(view.outline.get('c')?.predecessors).toBe('1');
    expect(view.outline.get('a')?.successors).toBe('3');
  });

  it('keeps the plan object as loaded when its rows already agree', () => {
    const plan = makePlan();
    const view = planView(plan);
    expect(view.plan.tasks[0]).toBe(plan.tasks[0]);
  });
});

describe('mergeOps', () => {
  it('replaces a changed task by id and leaves the others as they were', () => {
    const plan = makePlan();
    const changed = makeTask('b', { display_id: 2, wbs: '2', position: 1, name: 'Rack servers' });
    const { plan: next } = mergeOps(plan, makeOpsResult({ version: 6, tasks: [changed] }));
    expect(next.version).toBe(6);
    expect(next.tasks.map((t) => t.id)).toEqual(['a', 'b', 'c']);
    expect(next.tasks[1].name).toBe('Rack servers');
    expect(next.tasks[0]).toBe(plan.tasks[0]);
    expect(next.tasks[2]).toBe(plan.tasks[2]);
    expect(plan.tasks[1].name).toBe('Task b');          // the old plan is not mutated
  });

  it('takes `order` and renumbers every task from it', () => {
    const plan = makePlan();
    const { plan: next, outline } = mergeOps(plan, makeOpsResult({ order: ['c', 'a', 'b'] }));
    expect(next.tasks.map((t) => t.id)).toEqual(['c', 'a', 'b']);
    expect(next.tasks.map((t) => t.display_id)).toEqual([1, 2, 3]);
    expect(next.tasks.map((t) => t.wbs)).toEqual(['1', '2', '3']);
    expect([...outline.keys()]).toEqual(['c', 'a', 'b']);
    expect(outline.get('c')?.displayId).toBe(1);
  });

  it('nests an indented task and turns its parent into a summary', () => {
    const plan = makePlan();
    const indented = makeTask('b', { parent_id: 'a', position: 1, outline_level: 2, wbs: '1.1', display_id: 2 });
    const { plan: next, outline } = mergeOps(plan, makeOpsResult({
      tasks: [indented], order: ['a', 'b', 'c'],
    }));
    const a = next.tasks.find((t) => t.id === 'a')!;
    expect(a.is_summary).toBe(true);
    expect(outline.get('a')?.isSummary).toBe(true);
    expect(next.tasks.map((t) => t.wbs)).toEqual(['1', '1.1', '2']);
    expect(next.tasks.map((t) => t.outline_level)).toEqual([1, 2, 1]);
  });

  it('adds a new task where `order` puts it', () => {
    const plan = makePlan();
    const added = makeTask('n', { position: 1, name: 'New' });
    const { plan: next } = mergeOps(plan, makeOpsResult({
      tasks: [added], order: ['a', 'n', 'b', 'c'], temp_ids: { t1: 'n' },
    }));
    expect(next.tasks.map((t) => t.id)).toEqual(['a', 'n', 'b', 'c']);
    expect(next.tasks.map((t) => t.display_id)).toEqual([1, 2, 3, 4]);
  });

  it('drops deleted tasks with their links, and deleted links', () => {
    const plan = makePlan({
      tasks: flatTasks(['a', 'b', 'c', 'd']),
      links: [makeLink('l1', 'a', 'b'), makeLink('l2', 'b', 'c'), makeLink('l3', 'c', 'd')],
    });
    const { plan: next, outline } = mergeOps(plan, makeOpsResult({
      deleted_tasks: ['b'], deleted_links: ['l3'],
    }));
    expect(next.tasks.map((t) => t.id)).toEqual(['a', 'c', 'd']);
    // l1 and l2 touch the deleted task even if the answer had not named them
    expect(next.links).toEqual([]);
    expect(next.tasks.map((t) => t.display_id)).toEqual([1, 2, 3]);
    expect(outline.get('d')?.predecessors).toBe('');
  });

  it('replaces a changed link and adds a new one, then rewrites the link text', () => {
    const plan = makePlan({ links: [makeLink('l1', 'a', 'b')] });
    const { plan: next, outline } = mergeOps(plan, makeOpsResult({
      links: [
        makeLink('l1', 'a', 'b', { link_type: 'SS' }),
        makeLink('l2', 'b', 'c', { lag_minutes: 960, lag_text: '+2 days' }),
      ],
    }));
    expect(next.links.map((l) => [l.id, l.link_type])).toEqual([['l1', 'SS'], ['l2', 'FS']]);
    expect(outline.get('b')?.predecessors).toBe('1SS');
    expect(outline.get('c')?.predecessors).toBe('2FS+2 days');
    expect(next.tasks.find((t) => t.id === 'c')?.predecessors).toBe('2FS+2 days');
    expect(next.tasks.find((t) => t.id === 'a')?.successors).toBe('2SS');
  });

  it('works out the project finish again from the tasks', () => {
    const plan = makePlan();
    const later = makeTask('c', { display_id: 3, wbs: '3', position: 2, finish: '2026-11-20T17:00' });
    expect(mergeOps(plan, makeOpsResult({ tasks: [later] })).plan.project_finish).toBe('2026-11-20T17:00');
    const emptied = mergeOps(plan, makeOpsResult({ deleted_tasks: ['a', 'b', 'c'] })).plan;
    expect(emptied.tasks).toEqual([]);
    expect(emptied.project_finish).toBeNull();
  });

  it('keeps the plan-level fields', () => {
    const plan = makePlan({ locked_at: null, baseline_set_at: '2026-10-20T10:00:00Z' });
    const { plan: next } = mergeOps(plan, makeOpsResult());
    expect(next.baseline_set_at).toBe('2026-10-20T10:00:00Z');
    expect(next.calendar).toBe(plan.calendar);
    expect(next.resources).toBe(plan.resources);
  });
});
