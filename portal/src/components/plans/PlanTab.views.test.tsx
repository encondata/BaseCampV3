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
const viewButton = () => within(views()).getByRole('button');
/** A button's accessible name: its aria-label, else its text less what is aria-hidden (the ▾). */
function nameOf(el: HTMLElement): string {
  const label = el.getAttribute('aria-label');
  if (label !== null) return label;
  const copy = el.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((n) => n.remove());
  return (copy.textContent ?? '').trim();
}
/** Picks a view from the switcher's menu. */
function chooseView(name: 'Gantt' | 'Calendar' | 'Board') {
  fireEvent.click(viewButton());
  fireEvent.click(screen.getByRole('menuitemradio', { name }));
}
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
  it('one compact dropdown names the view on; its menu offers the three, the current one checked', async () => {
    await loaded();
    await findSheet();
    // the group holds one menu button, named by the view on now (its ▾ is decoration)
    const trigger = viewButton();
    expect(within(views()).getAllByRole('button')).toHaveLength(1);
    expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    expect(nameOf(trigger)).toBe('Gantt');
    fireEvent.click(trigger);
    const items = screen.getAllByRole('menuitemradio');
    expect(items.map((i) => i.getAttribute('aria-label'))).toEqual(['Gantt', 'Calendar', 'Board']);
    expect(items.map((i) => i.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false']);
    fireEvent.click(items[1]);
    expect(location).toContain('view=calendar');
    expect(q('.pln-view')?.getAttribute('data-view')).toBe('calendar');
    expect(nameOf(viewButton())).toBe('Calendar');
    expect(screen.queryByRole('grid', { name: 'Task sheet' })).toBeNull();
    expect(q('.pln-gantt')).toBeNull();
    expect(screen.getByRole('heading', { name: 'November 2026' })).toBeTruthy();
    chooseView('Board');
    expect(location).toContain('view=board');
    expect(nameOf(viewButton())).toBe('Board');
    expect(cardNames('Not started')).toEqual(['Order crates', 'Go live']);
    chooseView('Gantt');
    expect(location).not.toContain('view=');
    await findSheet();
  });

  it('the switcher’s tip names the view on and says what the menu does', async () => {
    await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=board');
    vi.useFakeTimers();
    const trigger = viewButton();
    fireEvent.pointerEnter(trigger);
    act(() => { vi.advanceTimersByTime(TIP_DELAY_MS); });
    const tip = screen.getByRole('tooltip');
    expect(tip.querySelector('.tip-label')?.textContent).toBe('Board');
    expect(tip.querySelector('.tip-desc')?.textContent).toBe(COMMAND_TIPS.view.desc);
    fireEvent.pointerLeave(trigger);
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
    chooseView('Calendar');
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
      chooseView('Board');
      expect(tool('Fit Project').getAttribute('aria-disabled')).toBe('true');
      chooseView('Gantt');
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
    chooseView('Gantt');
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
    // the view area's top band, above the sheet and the chart: it takes its
    // height from the area (which keeps its floor), so the page never scrolls
    expect(q('.pln-view')?.firstElementChild?.classList.contains('pln-strip')).toBe(true);
    // the Calendar has no strip
    chooseView('Calendar');
    expect(q('.pln-strip')).toBeNull();
    chooseView('Gantt');
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

const boardCard = (col: string, name: string) => within(column(col)).getByRole('group', { name });
const boardNote = () => document.querySelector<HTMLElement>('.pln-board [role="status"]');
const sheetRow = (grid: HTMLElement, id: string) =>
  within(grid).getAllByRole('row').find((r) => r.getAttribute('data-task') === id);

describe('a Board move from the keyboard', () => {
  it('focus follows the card to its new column, a note says so, and Ctrl+Z right away undoes it', async () => {
    await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=board');
    api.postOps.mockResolvedValueOnce(makeOpsResult({
      version: 6, tasks: [{ ...tasks()[2], percent_complete: 100, status: 'complete' }], inverse: [makeRestore('b')],
    }));
    fireEvent.click(within(boardCard('In progress', 'Label racks')).getByRole('button', { name: 'Actions for Label racks' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move to Complete' }));
    await waitFor(() => expect(document.activeElement?.getAttribute('aria-label')).toBe('Actions for Label racks'));
    expect(column('Complete').contains(document.activeElement)).toBe(true);
    expect(boardNote()?.textContent).toBe('Moved Label racks to Complete');
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7, tasks: [tasks()[2]], inverse: [makeRestore('r')] }));
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sent(1)).toEqual([makeRestore('b')]);
    await waitFor(() => expect(cardNames('In progress')).toEqual(['Label racks']));
  });
});

describe('outside the Gantt the selection is what the view draws', () => {
  it('switching to the Board drops a summary from the selection and keeps the tasks it draws', async () => {
    await loaded();
    const grid = await findSheet();
    fireEvent.mouseDown(sheetRow(grid, 's1')?.querySelector('[data-col="name"]') as HTMLElement, { button: 0 });
    expect(tool('Information').getAttribute('aria-disabled')).toBeNull();
    chooseView('Board');
    await waitFor(() => expect(tool('Information').getAttribute('aria-disabled')).toBe('true'));
    // a summary and a task: the task stays
    chooseView('Gantt');
    const again = await findSheet();
    fireEvent.mouseDown(sheetRow(again, 's1')?.querySelector('[data-col="id"]') as HTMLElement, { button: 0 });
    fireEvent.mouseDown(sheetRow(again, 'b')?.querySelector('[data-col="id"]') as HTMLElement,
      { button: 0, ctrlKey: true });
    chooseView('Board');
    await waitFor(() => expect(boardCard('In progress', 'Label racks').classList.contains('on')).toBe(true));
    // 100% would complete a selected summary too: only the drawn task goes
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    fireEvent.click(tool('100% Complete'));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent(0)).toEqual([{ op: 'set_percent', ids: ['b'], percent: 100 }]);
  });

  it('Enter in the search box picks the first task the Board draws, never a summary', async () => {
    await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=board');
    const box = screen.getByRole('textbox', { name: 'Search tasks' });
    fireEvent.change(box, { target: { value: 'r' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    await waitFor(() => expect(boardCard('Not started', 'Order crates').classList.contains('on')).toBe(true));
    expect(document.querySelectorAll('.pln-card.on')).toHaveLength(1);
  });

  it('Shift+F2 opens the focused card’s or bar’s task, ahead of the selection', async () => {
    await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=board');
    fireEvent.click(boardCard('Complete', 'Wrap up'));
    const name = within(boardCard('In progress', 'Label racks')).getByRole('button', { name: 'Label racks' });
    name.focus();
    fireEvent.keyDown(name, { key: 'F2', shiftKey: true });
    const dialog = await screen.findByRole('dialog', { name: /Task Information/ });
    expect(within(dialog).getByDisplayValue('Label racks')).toBeTruthy();
    fireEvent.click(within(dialog).getAllByRole('button', { name: /Close|Cancel/ })[0]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    chooseView('Calendar');
    const bar = document.querySelector<HTMLElement>('[data-task-id="a"]') as HTMLElement;
    bar.focus();
    fireEvent.keyDown(bar, { key: 'F2', shiftKey: true });
    const info = await screen.findByRole('dialog', { name: /Task Information/ });
    expect(within(info).getByDisplayValue('Order crates')).toBeTruthy();
  });

  it('back in the Gantt, the picked task’s collapsed summary opens to show it', async () => {
    localStorage.setItem('plans.collapsed.plan-1', JSON.stringify(['s1']));
    await loaded(viewsPlan(), '/initiatives/init-1?tab=plan&view=board');
    fireEvent.click(boardCard('In progress', 'Label racks'));
    chooseView('Gantt');
    const grid = await findSheet();
    await waitFor(() => expect(sheetRow(grid, 'b')?.getAttribute('aria-selected')).toBe('true'));
    expect(JSON.parse(localStorage.getItem('plans.collapsed.plan-1') ?? '[]')).toEqual([]);
  });
});

describe('Escape in full screen', () => {
  it('closing an open Calendar week takes the Escape; the next one leaves full screen', async () => {
    const crews = Array.from({ length: 5 }, (_, i) => makeTask(`c${i}`, {
      display_id: 6 + i, wbs: String(4 + i), position: 3 + i, name: `Crew ${i + 1}`,
      start: '2026-11-02T08:00', finish: '2026-11-06T17:00',
    }));
    await loaded(viewsPlan({ tasks: [...tasks(), ...crews] }), '/initiatives/init-1?tab=plan&view=calendar');
    fireEvent.click(screen.getByRole('button', { name: 'Full screen' }));
    const tab = q('.pln-tab') as HTMLElement;
    expect(tab.classList.contains('pln-fullscreen')).toBe(true);
    fireEvent.click(screen.getAllByRole('button', { name: /more on Nov 2/ })[0]);
    const less = screen.getByRole('button', { name: 'Show less' });
    fireEvent.keyDown(less, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Show less' })).toBeNull();
    expect(tab.classList.contains('pln-fullscreen')).toBe(true);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    expect(tab.classList.contains('pln-fullscreen')).toBe(false);
  });
});

describe('the Timeline strip in the view area', () => {
  it('Below: the sheet’s splitter leaves the strip’s height out of what it shares', async () => {
    localStorage.setItem('plans.strip.plan-1', '1');
    // the strip is 100px tall; every other box 600
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) { return this.classList.contains('pln-strip') ? 100 : 600; },
    });
    await loaded();
    await findSheet();
    fireEvent.click(tool('Gantt Layout'));
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Below' }));
    const splitter = screen.getByRole('separator', { name: 'Resize the task sheet' });
    // the view's 600px less the strip's 100, less the splitter (6) and the chart's least (120)
    await waitFor(() => expect(splitter.getAttribute('aria-valuemax')).toBe('374'));
  });
});
