// @vitest-environment jsdom
/**
 * components/plans/useSheetView.ts: the Gantt view's shared state. The
 * callbacks it hands every mounted sheet row keep their identity across an
 * op, so a batch that changes one task redraws one row, not all of them.
 */
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Plan } from '../../lib/plans/api';
import { makePlan, makeTask } from '../../lib/plans/planFixtures';
import type { PlanController } from './usePlan';
import { useSheetView } from './useSheetView';

function outlinePlan(over: Partial<Plan> = {}): Plan {
  return makePlan({
    tasks: [
      makeTask('s1', { display_id: 1, wbs: '1', is_summary: true, name: 'Prep' }),
      makeTask('a', { display_id: 2, wbs: '1.1', outline_level: 2, parent_id: 's1', name: 'Order crates' }),
      makeTask('c', { display_id: 3, wbs: '2', position: 1, name: 'Go live' }),
    ],
    ...over,
  });
}

const ctlOf = (plan: Plan) => ({ status: 'ready', plan } as unknown as PlanController);
const scrollRef = { current: null };

beforeEach(() => localStorage.clear());
afterEach(() => {
  cleanup();
  localStorage.clear();
});

describe('useSheetView', () => {
  it('toggleCollapse keeps its identity across an op and acts on the latest state', () => {
    const before = outlinePlan();
    const { result, rerender } = renderHook(({ ctl }) => useSheetView(ctl, null, scrollRef, 30),
      { initialProps: { ctl: ctlOf(before) } });
    const toggle = result.current.toggleCollapse;
    const select = result.current.select;

    // an op: a new tasks array, one task object replaced (as mergeOps answers)
    const tasks = [...before.tasks];
    tasks[2] = { ...tasks[2], name: 'Go live!' };
    rerender({ ctl: ctlOf({ ...before, version: 6, tasks }) });
    expect(result.current.toggleCollapse).toBe(toggle);
    expect(result.current.select).toBe(select);

    act(() => result.current.toggleCollapse('s1'));
    expect([...result.current.collapsed]).toEqual(['s1']);
    expect(result.current.rows).toEqual(['s1', 'c']);
    expect(result.current.toggleCollapse).toBe(toggle);
    expect(JSON.parse(localStorage.getItem('plans.collapsed.plan-1')!)).toEqual(['s1']);

    act(() => result.current.toggleCollapse('s1'));
    expect(result.current.rows).toEqual(['s1', 'a', 'c']);
  });

  it('goTo opens the task’s collapsed summary and selects its row (Go to task)', () => {
    const { result } = renderHook(({ ctl }) => useSheetView(ctl, null, scrollRef, 30),
      { initialProps: { ctl: ctlOf(outlinePlan()) } });
    act(() => result.current.toggleCollapse('s1'));
    expect(result.current.rows).toEqual(['s1', 'c']);
    act(() => result.current.goTo('a'));
    expect(result.current.rows).toEqual(['s1', 'a', 'c']);
    expect(result.current.selection.active).toEqual({ id: 'a', col: 'name' });
    // an id the plan doesn't have changes nothing
    act(() => result.current.goTo('zz'));
    expect(result.current.selection.active).toEqual({ id: 'a', col: 'name' });
  });
});
