// @vitest-environment jsdom
/**
 * The tab's other views (Plan C Task 4) on the real PlanTab and usePlan
 * against a mocked lib/plans/api:
 *
 * - The switcher (Gantt / Calendar / Board) is `?view=`; Calendar and Board
 *   take the whole view area (no sheet, no chart).
 * - The filter bar applies to them as it does to the Gantt (Group by is the
 *   Gantt's alone).
 * - In Calendar and Board the chart-only commands (Gantt Layout, Critical
 *   Path, Baseline, Zoom, Fit, Scroll to Task) and the Timeline strip are
 *   off: "Switch to the Gantt view to use this".
 * - A Board drop into Complete goes through the completion check, and is one
 *   undo step.
 * - Display › Timeline strip shows the strip above the Gantt, kept per plan
 *   (`plans.strip.<planId>`); a click on its task selects it in the sheet.
 * - A task picked in the Calendar or the Board is the sheet's selection.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { Op, Plan, PlanTask } from '../../lib/plans/api';
import { COMMAND_TIPS, OFF_NOTES } from '../../lib/plans/commandTips';
import { makeOpsResult, makePlan, makeRestore, makeTask } from '../../lib/plans/planFixtures';
import { TIP_DELAY_MS } from '../Tip';
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

/**
 *  1 Prep (summary)
 *    2 Order crates    Mon Nov 2, 0%, late
 *    3 Label racks     Tue–Wed, 50%
 *  4 Go live           milestone Fri Nov 6, on the timeline
 *  5 Wrap up           Fri Nov 6, 100%
 */
function tasks(): PlanTask[] {
  return [
    makeTask('s1', { display_id: 1, wbs: '1', position: 0, is_summary: true, name: 'Prep',
      start: '2026-11-02T08:00', finish: '2026-11-04T17:00', percent_complete: 25 }),
    makeTask('a', { display_id: 2, wbs: '1.1', outline_level: 2, position: 0, parent_id: 's1', name: 'Order crates',
      status: 'late' }),
    makeTask('b', { display_id: 3, wbs: '1.2', outline_level: 2, position: 1, parent_id: 's1', name: 'Label racks',
      start: '2026-11-03T08:00', finish: '2026-11-04T17:00', percent_complete: 50, status: 'in_progress' }),
    makeTask('m', { display_id: 4, wbs: '2', position: 1, name: 'Go live', is_milestone: true, duration_minutes: 0,
      duration_text: '0 days', start: '2026-11-06T17:00', finish: '2026-11-06T17:00', show_on_timeline: true }),
    makeTask('w', { display_id: 5, wbs: '3', position: 2, name: 'Wrap up', start: '2026-11-06T08:00',
      finish: '2026-11-06T17:00', percent_complete: 100, status: 'complete' }),
  ];
}
const viewsPlan = (over: Partial<Plan> = {}) => makePlan({
  tasks: tasks(), project_finish: '2026-11-06T17:00', now: '2026-11-04T12:00', ...over,
});

let location = '';
function Where() {
  const at = useLocation();
  location = at.search;
  return null;
}

function renderTab(path = '/initiatives/init-1?tab=plan') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/initiatives/:id" element={(
          <>
            <PlanTab initiativeId="init-1" initiative={INITIATIVE} />
            <Where />
          </>
        )} />
      </Routes>
    </MemoryRouter>,
  );
}

async function loaded(plan: Plan = viewsPlan(), path?: string) {
  api.getPlan.mockResolvedValue(plan);
  const view = renderTab(path);
  await screen.findByRole('toolbar', { name: 'Project plan' }, { timeout: 3000 });
  return view;
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const toolbar = () => screen.getByRole('toolbar', { name: 'Project plan' });
const tool = (name: string) => within(toolbar()).getByRole('button', { name });
const views = () => screen.getByRole('group', { name: 'View' });
const sent = (call = 0): Op[] => api.postOps.mock.calls[call]?.[2];
const column = (name: string) => screen.getByRole('region', { name });
const cardNames = (col: string) => within(column(col)).queryAllByRole('group').map((g) => g.getAttribute('aria-label'));

function hoverTip(el: HTMLElement) {
  fireEvent.pointerEnter(el);
  act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
  const tip = screen.getByRole('tooltip');
  const note = tip.querySelector('.tip-note')?.textContent ?? null;
  fireEvent.pointerLeave(el);
  return note;
}

/** Picks an option of the filter bar's Filter. */
function pickFilter(label: string) {
  const input = screen.getByRole('combobox', { name: 'Filter' });
  fireEvent.focus(input);
  const item = [...document.querySelectorAll<HTMLElement>('.combo-menu .kbar-item')].find((i) => i.textContent === label);
  if (!item) throw new Error(`no option ${label}`);
  fireEvent.mouseDown(item);
}

// jsdom does no layout: every box gets a size, so the sheet's virtualizer draws rows
const SIZES = ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth'] as const;
const realSizes = SIZES.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
  ?? Object.getOwnPropertyDescriptor(Element.prototype, key));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  for (const [key, px] of [['offsetHeight', 600], ['offsetWidth', 1200], ['clientHeight', 600], ['clientWidth', 800]] as const) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => px });
  }
  localStorage.clear();
  for (const fn of [toast, ...Object.values(api)]) fn.mockReset();
  api.getPlanVersion.mockResolvedValue({ version: 5, updated_by_name: null, updated_at: null });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  SIZES.forEach((key, i) => {
    const real = realSizes[i];
    if (real) Object.defineProperty(HTMLElement.prototype, key, real);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key];
  });
  localStorage.clear();
});

describe('the view switcher', () => {
  it('offers Gantt, Calendar and Board, each with its tip; a pick is ?view=', async () => {
    await loaded();
    await findSheet();
    const buttons = within(views()).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['Gantt', 'Calendar', 'Board']);
    expect(buttons[0].getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(buttons[1]);
    expect(location).toContain('view=calendar');
    expect(q('.pln-view')?.getAttribute('data-view')).toBe('calendar');
    expect(within(views()).getByRole('button', { name: 'Calendar' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('grid', { name: 'Task sheet' })).toBeNull();
    expect(q('.pln-gantt')).toBeNull();
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy();
    fireEvent.click(within(views()).getByRole('button', { name: 'Board' }));
    expect(location).toContain('view=board');
    expect(cardNames('Not started')).toEqual(['Order crates', 'Go live']);
    fireEvent.click(within(views()).getByRole('button', { name: 'Gantt' }));
    expect(location).not.toContain('view=');
    await findSheet();
    expect(COMMAND_TIPS.viewCalendar.label).toBe('Calendar');
    expect(COMMAND_TIPS.viewBoard.label).toBe('Board');
  });

  it('?view=board opens on the Board', async () => {
    await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=board');
    expect(q('.pln-view')?.getAttribute('data-view')).toBe('board');
    expect(cardNames('In progress')).toEqual(['Label racks']);
    expect(cardNames('Complete')).toEqual(['Wrap up']);
  });
});

describe('the filter bar in the Calendar and the Board', () => {
  it('a filter applies to both; Group by is the Gantt’s alone', async () => {
    await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=board');
    expect(screen.queryByRole('combobox', { name: 'Group by' })).toBeNull();
    pickFilter('Late Tasks');
    await waitFor(() => expect(cardNames('Not started')).toEqual(['Order crates']));
    expect(cardNames('In progress')).toEqual([]);
    expect(cardNames('Complete')).toEqual([]);
    fireEvent.click(within(views()).getByRole('button', { name: 'Calendar' }));
    expect(document.querySelectorAll('[data-task-id="a"]').length).toBe(1);
    expect(document.querySelectorAll('[data-task-id="b"]').length).toBe(0);
    expect(document.querySelectorAll('[data-task-id="m"]').length).toBe(0);
  });

  it('collapsing a summary in the sheet hides nothing in the Calendar or the Board', async () => {
    localStorage.setItem('plans.collapsed.plan-1', JSON.stringify(['s1']));
    await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=board');
    expect(cardNames('Not started')).toEqual(['Order crates', 'Go live']);
    expect(cardNames('In progress')).toEqual(['Label racks']);
  });
});

describe('the chart-only commands outside the Gantt', () => {
  it('Gantt Layout, Critical Path, Baseline, Zoom, Fit, Scroll to Task and the Timeline strip are off, saying why',
    async () => {
      await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=calendar');
      const names = ['Gantt Layout', 'Critical Path', 'Baseline', 'Zoom Out', 'Zoom In', 'Fit Project',
        'Scroll to Task', 'Timeline strip'];
      vi.useFakeTimers();
      for (const name of names) {
        const b = tool(name);
        expect(b.getAttribute('aria-disabled'), name).toBe('true');
        expect(hoverTip(b), name).toBe(OFF_NOTES.ganttOnly);
      }
      vi.useRealTimers();
      expect(OFF_NOTES.ganttOnly).toBe('Switch to the Gantt view to use this');
      // the layout button opens no menu here
      fireEvent.click(tool('Gantt Layout'));
      expect(screen.queryByRole('menu')).toBeNull();
      // the rest still works: Undo/Redo, 0–100%, Information…
      expect(tool('Information').getAttribute('aria-disabled')).toBe('true');   // nothing selected yet
      fireEvent.click(within(views()).getByRole('button', { name: 'Board' }));
      expect(tool('Fit Project').getAttribute('aria-disabled')).toBe('true');
      fireEvent.click(within(views()).getByRole('button', { name: 'Gantt' }));
      await findSheet();
      expect(tool('Fit Project').getAttribute('aria-disabled')).toBeNull();
      expect(tool('Timeline strip').getAttribute('aria-disabled')).toBeNull();
    });
});

describe('the Board’s moves', () => {
  it('a drop into Complete meets the completion check; Complete resends with confirm, and Undo takes it back',
    async () => {
      await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=board');
      api.postOps.mockRejectedValueOnce(new ApiError(409, 'completion_confirm', {
        code: 'completion_confirm', will_complete: [],
        open_predecessors: [{ task_id: 'a', display_id: 2, name: 'Order crates', reason: 'predecessor' }],
      }));
      const card = within(column('In progress')).getByRole('group', { name: 'Label racks' });
      fireEvent.dragStart(card);
      fireEvent.dragOver(column('Complete'));
      fireEvent.drop(column('Complete'));
      const dialog = await screen.findByRole('dialog', { name: 'Confirm completion' });
      expect(sent(0)).toEqual([{ op: 'set_percent', ids: ['b'], percent: 100 }]);
      api.postOps.mockResolvedValueOnce(makeOpsResult({
        version: 6, tasks: [{ ...tasks()[2], percent_complete: 100, status: 'complete' }], inverse: [makeRestore('b')],
      }));
      fireEvent.click(within(dialog).getByRole('button', { name: 'Complete' }));
      await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
      expect(sent(1)).toEqual([{ op: 'set_percent', ids: ['b'], percent: 100, confirm: true }]);
      await waitFor(() => expect(cardNames('Complete')).toEqual(['Label racks', 'Wrap up']));
      // one undo step
      api.postOps.mockResolvedValueOnce(makeOpsResult({
        version: 7, tasks: [{ ...tasks()[2] }], inverse: [makeRestore('redo')],
      }));
      fireEvent.click(tool('Undo'));
      await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(3));
      expect(sent(2)).toEqual([makeRestore('b')]);
      await waitFor(() => expect(cardNames('In progress')).toEqual(['Label racks']));
    });

  it('outside the Gantt the keys that don’t need the sheet still work: Ctrl+Z undoes a move; Delete is not taken',
    async () => {
      await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=board');
      api.postOps.mockResolvedValueOnce(makeOpsResult({
        version: 6, tasks: [{ ...tasks()[1], percent_complete: 50, status: 'in_progress' }], inverse: [makeRestore('a')],
      }));
      const card = within(column('Not started')).getByRole('group', { name: 'Order crates' });
      fireEvent.dragStart(card);
      fireEvent.drop(column('In progress'));
      await waitFor(() => expect(cardNames('In progress')).toEqual(['Order crates', 'Label racks']));
      expect(sent(0)).toEqual([{ op: 'set_percent', ids: ['a'], percent: 50 }]);
      // Delete on a picked card: the sheet's key, not the Board's
      const moved = within(column('In progress')).getByRole('group', { name: 'Order crates' });
      fireEvent.click(moved);
      fireEvent.keyDown(moved, { key: 'Delete' });
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(api.postOps).toHaveBeenCalledTimes(1);
      // Ctrl+Z: Undo
      api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7, tasks: [tasks()[1]], inverse: [makeRestore('r')] }));
      fireEvent.keyDown(moved, { key: 'z', ctrlKey: true });
      await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
      expect(sent(1)).toEqual([makeRestore('a')]);
      await waitFor(() => expect(cardNames('Not started')).toEqual(['Order crates', 'Go live']));
      // Shift+F2: Task Information for the picked task
      fireEvent.keyDown(within(column('Not started')).getByRole('group', { name: 'Order crates' }), { key: 'F2', shiftKey: true });
      expect(await screen.findByRole('dialog', { name: /Task Information/ })).toBeTruthy();
    });

  it('a card picked on the Board is the sheet’s selection', async () => {
    await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=board');
    fireEvent.click(within(column('In progress')).getByRole('group', { name: 'Label racks' }));
    expect(tool('Information').getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(within(views()).getByRole('button', { name: 'Gantt' }));
    const grid = await findSheet();
    const row = within(grid).getAllByRole('row').find((r) => r.getAttribute('data-task') === 'b');
    expect(row?.getAttribute('aria-selected')).toBe('true');
  });

  it('a double-click on a card opens Task Information', async () => {
    await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=board');
    fireEvent.doubleClick(within(column('Complete')).getByRole('group', { name: 'Wrap up' }));
    expect(await screen.findByRole('dialog', { name: /Task Information/ })).toBeTruthy();
  });
});

describe('the Timeline strip', () => {
  it('Display › Timeline strip shows it above the Gantt, kept for the plan', async () => {
    await loaded();
    await findSheet();
    expect(q('.pln-strip')).toBeNull();
    expect(tool('Timeline strip').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(tool('Timeline strip'));
    expect(q('.pln-strip')).not.toBeNull();
    expect(tool('Timeline strip').getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('plans.strip.plan-1')).toBe('1');
    // above the view area
    const strip = q('.pln-strip') as HTMLElement;
    expect(strip.compareDocumentPosition(q('.pln-view') as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the Calendar has no strip
    fireEvent.click(within(views()).getByRole('button', { name: 'Calendar' }));
    expect(q('.pln-strip')).toBeNull();
    fireEvent.click(within(views()).getByRole('button', { name: 'Gantt' }));
    expect(q('.pln-strip')).not.toBeNull();
    fireEvent.click(tool('Timeline strip'));
    expect(q('.pln-strip')).toBeNull();
    expect(localStorage.getItem('plans.strip.plan-1')).toBe('0');
  });

  it('comes back on for a plan it was left on; a click on its task selects it in the sheet', async () => {
    localStorage.setItem('plans.strip.plan-1', '1');
    await loaded();
    const grid = await findSheet();
    const diamond = within(q('.pln-strip') as HTMLElement).getByRole('button', { name: /Go live/ });
    fireEvent.click(diamond);
    await waitFor(() => {
      const row = within(grid).getAllByRole('row').find((r) => r.getAttribute('data-task') === 'm');
      expect(row?.getAttribute('aria-selected')).toBe('true');
    });
  });

  it('storage that refuses is no trouble: the strip still toggles', async () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      await loaded();
      await findSheet();
      fireEvent.click(tool('Timeline strip'));
      expect(q('.pln-strip')).not.toBeNull();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
