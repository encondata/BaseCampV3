// @vitest-environment jsdom
/**
 * Rows drag-reorder by the ID cell (spec "The task sheet"): a press on a
 * row's ID and a drag past the threshold moves the task with its subtasks
 * — or, when the row is part of the selection, every selected task, the
 * top-most ones only — to where the drop line shows, as one `move_tasks`
 * batch and one undo step. Never into what moves, never above a context
 * row; off while the plan is locked or grouped (the note says why) and for
 * someone who may only read it. A press that doesn't move is a click: it
 * selects the row, as ever. The real PlanTab and usePlan run against a
 * mocked lib/plans/api.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Op, Plan, PlanTask } from '../../lib/plans/api';
import { OFF_NOTES } from '../../lib/plans/commandTips';
import { PLAN_ERRORS } from '../../lib/plans/errors';
import { VIEW_PREFIX } from '../../lib/plans/filters';
import { makeLink, makeOpsResult, makePlan, makeRestore, makeTask } from '../../lib/plans/planFixtures';
import { findSheet } from './planTabTesting';

if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string) => resource === 'project_plans',
    person: { id: 'p-me', display_name: 'Jimmy Henderson' },
    preferences: {},
  }),
}));

const api = vi.hoisted(() => ({
  getPlan: vi.fn(),
  createPlan: vi.fn(),
  deletePlan: vi.fn(),
  postOps: vi.fn(),
  patchPlan: vi.fn(),
  lockPlan: vi.fn(),
  unlockPlan: vi.fn(),
  setBaseline: vi.fn(),
  clearBaseline: vi.fn(),
  updateProject: vi.fn(),
  getPlanVersion: vi.fn(),
}));
vi.mock('../../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/plans/api')>()),
  ...api,
}));

const { default: PlanTab } = await import('./PlanTab');

const INITIATIVE = { name: 'NAP11 Hall Migration', scheduled_start: '2026-11-14', scheduled_end: '2026-11-16' };
const ROW = 30;
const JIMMY = { kind: 'person' as const, id: 'p-me', name: 'Jimmy Henderson' };

/**
 *  1 Prep (summary)
 *    2 Crates
 *    3 Labels        FS after Survey (a link out of the subtree)
 *  4 Survey
 *  5 Go live
 */
function outlineTasks(): PlanTask[] {
  return [
    makeTask('s', { display_id: 1, wbs: '1', is_summary: true, name: 'Prep' }),
    makeTask('k1', { display_id: 2, wbs: '1.1', outline_level: 2, parent_id: 's', name: 'Crates', assignees: [JIMMY] }),
    makeTask('k2', { display_id: 3, wbs: '1.2', outline_level: 2, parent_id: 's', position: 1, name: 'Labels',
      predecessors: '4' }),
    makeTask('a', { display_id: 4, wbs: '2', position: 1, name: 'Survey' }),
    makeTask('z', { display_id: 5, wbs: '3', position: 2, name: 'Go live' }),
  ];
}
const outlinePlan = (over: Partial<Plan> = {}) => makePlan({
  tasks: outlineTasks(), links: [makeLink('l1', 'a', 'k2')], ...over,
});

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/initiatives/init-1?tab=plan']}>
      <Routes>
        <Route path="/initiatives/:id" element={<PlanTab initiativeId="init-1" initiative={INITIATIVE} />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function ready(plan: Plan = outlinePlan()) {
  api.getPlan.mockResolvedValueOnce(plan);
  renderTab();
  await findSheet();
}

const grid = () => screen.getByRole('grid', { name: 'Task sheet' });
const sheetIds = () => within(grid()).getAllByRole('row').map((r) => r.getAttribute('data-task')).filter(Boolean);
const rowOf = (id: string) => within(grid()).getAllByRole('row').find((r) => r.getAttribute('data-task') === id) as HTMLElement;
const idCell = (id: string) => rowOf(id).querySelector('[data-col="id"]') as HTMLElement;
const sent = (call = 0): Op[] => api.postOps.mock.calls[call]?.[2];
const tool = (name: string) => within(screen.getByRole('toolbar', { name: 'Project plan' })).getByRole('button', { name });
const dropLine = () => document.querySelector('.pln-drop-line') as HTMLElement | null;
/** The middle of row `i`; the gap above row `i` (the rows' top is 0 here). */
const mid = (i: number) => i * ROW + ROW / 2;
const gap = (i: number) => i * ROW;

/** A press on a row's ID as a browser sends it: the pointer, then the mouse. */
function press(id: string, y: number, mods: { ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {}) {
  const el = idCell(id);
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 20, clientY: y, ...mods });
  fireEvent.mouseDown(el, { button: 0, clientX: 20, clientY: y, ...mods });
  return el;
}
function moveTo(el: HTMLElement, y: number) {
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 22, clientY: y, buttons: 1 });
}
function release(el: HTMLElement, y: number) {
  fireEvent.pointerUp(el, { pointerId: 1, clientX: 22, clientY: y });
  fireEvent.mouseUp(el, { button: 0, clientX: 22, clientY: y });
}
/** Press on `id`'s ID at its row's middle, drag to `to`, let go. */
function dragRow(id: string, at: number, ...to: number[]) {
  const el = press(id, mid(at));
  for (const y of to) moveTo(el, y);
  release(el, to[to.length - 1] ?? mid(at));
}

const SIZES = ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth'] as const;
const realSizes = SIZES.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
  ?? Object.getOwnPropertyDescriptor(Element.prototype, key));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  for (const [key, px] of [['offsetHeight', 600], ['offsetWidth', 1200], ['clientHeight', 600], ['clientWidth', 1200]] as const) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => px });
  }
  for (const fn of [toast, ...Object.values(api)]) fn.mockReset();
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  SIZES.forEach((key, i) => {
    const real = realSizes[i];
    if (real) Object.defineProperty(HTMLElement.prototype, key, real);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  });
  localStorage.clear();
});

describe('dragging a row by its ID', () => {
  it('a summary with its 2 subtasks dragged above Go live: one move_tasks, the rows follow; Undo puts them back', async () => {
    await ready();
    expect(grid().hasAttribute('data-row-drag')).toBe(true);
    api.postOps.mockResolvedValueOnce(makeOpsResult({
      version: 6, order: ['a', 's', 'k1', 'k2', 'z'], inverse: [makeRestore('moved')],
    }));
    const el = press('s', mid(0));
    moveTo(el, mid(0) + 10);
    moveTo(el, gap(4));
    // the drop line sits between Survey and Go live
    expect(dropLine()).not.toBeNull();
    expect(dropLine()!.style.transform).toBe(`translateY(${gap(4)}px)`);
    release(el, gap(4));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'move_tasks', ids: ['s'], before_id: 'z' }]);
    expect(dropLine()).toBeNull();
    await waitFor(() => expect(sheetIds()).toEqual(['a', 's', 'k1', 'k2', 'z']));
    // the chart follows: its lanes are the same rows
    expect([...document.querySelectorAll('.pln-lane')].map((l) => l.getAttribute('data-lane')).filter((k) => k !== 'blank'))
      .toEqual(['a', 's', 'k1', 'k2', 'z']);

    // one step: Undo sends its inverse and the order comes back
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7, order: ['s', 'k1', 'k2', 'a', 'z'] }));
    fireEvent.click(tool('Undo'));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sent(1)).toEqual([makeRestore('moved')]);
    await waitFor(() => expect(sheetIds()).toEqual(['s', 'k1', 'k2', 'a', 'z']));
  });

  it('a drop into its own subtree shows no line and sends nothing', async () => {
    await ready();
    const el = press('s', mid(0));
    moveTo(el, gap(2));                 // above Labels, inside Prep
    expect(dropLine()).toBeNull();
    release(el, gap(2));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.postOps).not.toHaveBeenCalled();
  });

  it('a drop where the rows already are sends nothing', async () => {
    await ready();
    dragRow('a', 3, gap(4));            // Survey above Go live: it is there
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.postOps).not.toHaveBeenCalled();
  });

  it('below the last row: the end of the plan (neither field)', async () => {
    await ready();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ order: ['s', 'k1', 'k2', 'z', 'a'] }));
    dragRow('a', 3, mid(4) + 40, mid(5) + 20);
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'move_tasks', ids: ['a'] }]);
  });

  it('a click without movement just selects the row; nothing is sent', async () => {
    await ready();
    dragRow('a', 3);
    expect(rowOf('a').getAttribute('aria-selected')).toBe('true');
    expect(idCell('a').getAttribute('aria-selected')).toBe('true');
    // a click on one row of several picked: that row alone, once let go
    fireEvent.mouseDown(idCell('z'), { button: 0, ctrlKey: true });
    expect(rowOf('a').getAttribute('aria-selected')).toBe('true');
    expect(rowOf('z').getAttribute('aria-selected')).toBe('true');
    dragRow('a', 3);
    expect(rowOf('a').getAttribute('aria-selected')).toBe('true');
    expect(rowOf('z').getAttribute('aria-selected')).toBe('false');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.postOps).not.toHaveBeenCalled();
  });

  it('a row of a multi-row selection drags every selected task, the top-most only', async () => {
    await ready();
    fireEvent.mouseDown(idCell('s'), { button: 0 });
    fireEvent.mouseDown(idCell('k1'), { button: 0, ctrlKey: true });
    fireEvent.mouseDown(idCell('a'), { button: 0, ctrlKey: true });
    api.postOps.mockResolvedValueOnce(makeOpsResult({ order: ['z', 's', 'k1', 'k2', 'a'] }));
    // the press keeps the selection; the drag takes it below the last row
    dragRow('k1', 1, mid(4) + 40, mid(5));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'move_tasks', ids: ['s', 'a'] }]);
  });

  it('Escape calls a drag off: nothing is sent and the line goes', async () => {
    await ready();
    const el = press('a', mid(3));
    moveTo(el, gap(1));
    expect(dropLine()).not.toBeNull();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    expect(dropLine()).toBeNull();
    release(el, gap(1));
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.postOps).not.toHaveBeenCalled();
  });
});

describe('when the drag is off', () => {
  it('a locked plan: no grab, and a drag says the schedule is locked and sends nothing', async () => {
    await ready(outlinePlan({ locked_at: '2026-10-27T12:00:00Z' }));
    expect(grid().hasAttribute('data-row-drag')).toBe(false);
    dragRow('a', 3, gap(1) + 8, gap(1));
    expect(toast).toHaveBeenCalledWith(PLAN_ERRORS.plan_locked);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.postOps).not.toHaveBeenCalled();
  });

  it('grouped: no grab, and a drag gives the grouped note and sends nothing', async () => {
    localStorage.setItem(`${VIEW_PREFIX}plan-1`, JSON.stringify({ filter: 'all', search: '', group: 'assignee' }));
    await ready();
    expect(grid().hasAttribute('data-row-drag')).toBe(false);
    const row = within(grid()).getAllByRole('row').find((r) => r.getAttribute('data-task') === 'z') as HTMLElement;
    const el = row.querySelector('[data-col="id"]') as HTMLElement;
    fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 20, clientY: 100 });
    fireEvent.mouseDown(el, { button: 0, clientX: 20, clientY: 100 });
    moveTo(el, 20);
    release(el, 20);
    expect(toast).toHaveBeenCalledWith(`${OFF_NOTES.grouped}.`);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.postOps).not.toHaveBeenCalled();
  });

  it('someone who may only read the plan: no grab, and a press only selects', async () => {
    await ready(outlinePlan({ permissions: { view: true, add: false, change: false, delete: false } }));
    expect(grid().hasAttribute('data-row-drag')).toBe(false);
    dragRow('a', 3, gap(1) + 8, gap(1));
    expect(toast).not.toHaveBeenCalled();
    expect(api.postOps).not.toHaveBeenCalled();
  });
});
