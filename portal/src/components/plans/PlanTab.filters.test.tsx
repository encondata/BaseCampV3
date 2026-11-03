// @vitest-environment jsdom
/**
 * The filter bar in the tab (Task 11): Filter, search and Group by on the
 * real PlanTab and usePlan against a mocked lib/plans/api.
 *
 * - A filter keeps the outline: the matches, and their summary tasks as
 *   dimmed, inert context rows — in the sheet and in the chart alike
 *   (Review Focus 5), composing with collapse.
 * - A filter applies when picked: a task edited out of it stays until the
 *   filter changes.
 * - Ctrl+F focuses the search box (only from inside the plan); Enter there
 *   selects the first match.
 * - Group by: the leaves under a band per resource, a two-resource task on
 *   both; a grouped row selects, edits and drags as its task; the outline
 *   commands are off ("Turn off Group by to change the outline"); the
 *   blank row goes; links aren't drawn.
 * - The view is kept per plan (`plans.view.<planId>`); the `&task=` deep
 *   link clears a filter that hides its task.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Op, Plan, PlanTask } from '../../lib/plans/api';
import { OFF_NOTES } from '../../lib/plans/commandTips';
import { VIEW_PREFIX, bandKey, rowKey } from '../../lib/plans/filters';
import { makeScale, xOf } from '../../lib/plans/ganttGeometry';
import { scaleSpan, windowSpan } from '../../lib/plans/ganttView';
import { makeLink, makeOpsResult, makePlan, makeTask } from '../../lib/plans/planFixtures';
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
const DANA = { kind: 'person' as const, id: 'p-dana', name: 'Dana Ortiz' };

/**
 *  1 Prep (summary)
 *    2 Order crates      Mon, 0%: late on Wed      Jimmy   notes "48 crates from Acme"
 *    3 Label racks       Tue–Wed, 50%              Jimmy + Dana
 *  4 Move day (summary)
 *    5 Lift racks        Thu, critical             Dana
 *    6 Go live           milestone Fri
 *  7 Wrap up             Fri, 100%
 */
function outlineTasks(): PlanTask[] {
  return [
    makeTask('s1', { display_id: 1, wbs: '1', position: 0, is_summary: true, name: 'Prep',
      start: '2026-11-02T08:00', finish: '2026-11-04T17:00' }),
    makeTask('a', { display_id: 2, wbs: '1.1', outline_level: 2, position: 0, parent_id: 's1', name: 'Order crates',
      notes: '48 crates from Acme', assignees: [JIMMY], status: 'late' }),
    makeTask('b', { display_id: 3, wbs: '1.2', outline_level: 2, position: 1, parent_id: 's1', name: 'Label racks',
      start: '2026-11-03T08:00', finish: '2026-11-04T17:00', percent_complete: 50, assignees: [JIMMY, DANA],
      status: 'in_progress' }),
    makeTask('s2', { display_id: 4, wbs: '2', position: 1, is_summary: true, name: 'Move day',
      start: '2026-11-05T08:00', finish: '2026-11-06T17:00' }),
    makeTask('c', { display_id: 5, wbs: '2.1', outline_level: 2, position: 0, parent_id: 's2', name: 'Lift racks',
      start: '2026-11-05T08:00', finish: '2026-11-05T17:00', is_critical: true, assignees: [DANA] }),
    makeTask('m', { display_id: 6, wbs: '2.2', outline_level: 2, position: 1, parent_id: 's2', name: 'Go live',
      is_milestone: true, duration_minutes: 0, duration_text: '0 days', start: '2026-11-06T17:00',
      finish: '2026-11-06T17:00' }),
    makeTask('w', { display_id: 7, wbs: '3', position: 2, name: 'Wrap up', start: '2026-11-06T08:00',
      finish: '2026-11-06T17:00', percent_complete: 100, status: 'complete' }),
  ];
}
const outlinePlan = (over: Partial<Plan> = {}) => makePlan({
  tasks: outlineTasks(), links: [makeLink('ab', 'a', 'b'), makeLink('cm', 'c', 'm')],
  project_finish: '2026-11-06T17:00', now: '2026-11-04T12:00', ...over,
});

function renderTab(path = '/initiatives/init-1?tab=plan') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/initiatives/:id" element={<PlanTab initiativeId="init-1" initiative={INITIATIVE} />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function ready(plan: Plan = outlinePlan(), path?: string) {
  api.getPlan.mockResolvedValue(plan);
  const view = renderTab(path);
  await findSheet();
  return view;
}

const q = (sel: string) => document.querySelector<HTMLElement>(sel);
const qa = (sel: string) => [...document.querySelectorAll<HTMLElement>(sel)];
const grid = () => screen.getByRole('grid', { name: 'Task sheet' });
const sheetRows = () => within(grid()).getAllByRole('row').slice(1);
/** The sheet's rows as their tasks' ids (a band as "band:Label", the blank row as "blank"). */
const sheetIds = () => sheetRows().map((r) => r.getAttribute('data-task')
  ?? (r.hasAttribute('data-blank') ? 'blank' : `band:${r.textContent?.replace(/\d+ tasks?$/, '').trim()}`));
const laneIds = () => qa('.pln-lane').map((l) => l.getAttribute('data-lane'));
const rowOf = (id: string, n = 0) => sheetRows().filter((r) => r.getAttribute('data-task') === id)[n];
const laneOf = (key: string) => qa('.pln-lane').find((l) => l.getAttribute('data-lane') === key) as HTMLElement;
const tool = (name: string) => within(screen.getByRole('toolbar', { name: 'Project plan' })).getByRole('button', { name });
const sent = (call = 0): Op[] => api.postOps.mock.calls[call]?.[2];

/** Picks an option of one of the filter bar's ComboBoxes. */
function pick(box: 'Filter' | 'Group by', label: string) {
  const input = screen.getByRole('combobox', { name: box });
  fireEvent.focus(input);
  const item = [...document.querySelectorAll<HTMLElement>('.combo-menu .kbar-item')].find((i) => i.textContent === label);
  if (!item) throw new Error(`no option ${label}`);
  fireEvent.mouseDown(item);
}
const search = () => screen.getByRole('textbox', { name: 'Search tasks' }) as HTMLInputElement;

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

describe('filters keep the outline, in the sheet and the chart', () => {
  it('Late Tasks: the late task and its summary as a dimmed, inert context row in both panes', async () => {
    await ready();
    pick('Filter', 'Late Tasks');
    await waitFor(() => expect(sheetIds()).toEqual(['s1', 'a', 'blank']));
    expect(laneIds()).toEqual(['s1', 'a', 'blank']);
    const context = rowOf('s1');
    expect(context.classList.contains('pln-context')).toBe(true);
    expect(context.getAttribute('aria-disabled')).toBe('true');
    expect(rowOf('a').classList.contains('pln-context')).toBe(false);
    expect(laneOf('s1').classList.contains('pln-context')).toBe(true);
    expect(laneOf('a').classList.contains('pln-context')).toBe(false);
    // inert: no chevron, a click selects nothing, its bracket takes no drag
    expect(within(context).queryByRole('button', { name: /Collapse|Expand/ })).toBeNull();
    fireEvent.mouseDown(context.querySelector('[data-col="name"]')!, { button: 0 });
    expect(context.getAttribute('aria-selected')).toBe('false');
    fireEvent.mouseDown(laneOf('s1'), { button: 0, clientY: 5 });
    expect(rowOf('s1').getAttribute('aria-selected')).toBe('false');
    fireEvent.mouseDown(rowOf('a').querySelector('[data-col="name"]')!, { button: 0 });
    expect(rowOf('a').getAttribute('aria-selected')).toBe('true');
    // the count is of leaf tasks, the same grouped or not (fix round 1)
    expect(screen.getByText('1 of 5 tasks')).toBeTruthy();
    pick('Group by', 'Resource');
    await waitFor(() => expect(sheetIds()).toEqual(['band:Jimmy Henderson', 'a']));
    expect(screen.getByText('1 of 5 tasks')).toBeTruthy();
    // a link with an end filtered out isn't drawn
    expect(q('[data-link="ab"]')).toBeNull();
  });

  it('composes with collapse: a collapsed match hides its matches; a context summary stays open', async () => {
    await ready();
    // Prep collapsed before the filter
    fireEvent.click(within(rowOf('s1')).getByRole('button', { name: 'Collapse Prep' }));
    await waitFor(() => expect(sheetIds()).toEqual(['s1', 's2', 'c', 'm', 'w', 'blank']));
    pick('Filter', 'Assigned to Me');
    // Prep is context now (only its subtasks are Jimmy's): open, whatever it was
    await waitFor(() => expect(sheetIds()).toEqual(['s1', 'a', 'b', 'blank']));
    expect(laneIds()).toEqual(['s1', 'a', 'b', 'blank']);
    // Summary Tasks: both summaries match; Move day collapsed hides nothing more (its subtasks don't match)
    pick('Filter', 'Summary Tasks');
    await waitFor(() => expect(sheetIds()).toEqual(['s1', 's2', 'blank']));
    pick('Filter', 'Incomplete Tasks');
    // Prep matches (it's incomplete) and is collapsed: its subtasks stay hidden, in both panes
    await waitFor(() => expect(sheetIds()).toEqual(['s1', 's2', 'c', 'm', 'blank']));
    expect(laneIds()).toEqual(['s1', 's2', 'c', 'm', 'blank']);
  });

  it('a task edited out of the filter stays until the filter changes', async () => {
    await ready();
    pick('Filter', 'Incomplete Tasks');
    await waitFor(() => expect(sheetIds()).toEqual(['s1', 'a', 'b', 's2', 'c', 'm', 'blank']));
    fireEvent.mouseDown(rowOf('a').querySelector('[data-col="name"]')!, { button: 0 });
    const done = { ...outlineTasks()[1], percent_complete: 100, status: 'complete' as const };
    api.postOps.mockResolvedValueOnce(makeOpsResult({ tasks: [done] }));
    fireEvent.click(tool('100% Complete'));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(rowOf('a').querySelector('[data-col="name"]')).toBeTruthy());
    expect(sheetIds()).toContain('a');
    // picked again: it applies afresh
    pick('Filter', 'All Tasks');
    pick('Filter', 'Incomplete Tasks');
    await waitFor(() => expect(sheetIds()).not.toContain('a'));
  });

  it('picking the filter that is on again applies it afresh (fix round 1)', async () => {
    await ready();
    pick('Filter', 'Incomplete Tasks');
    await waitFor(() => expect(sheetIds()).toContain('a'));
    fireEvent.mouseDown(rowOf('a').querySelector('[data-col="name"]')!, { button: 0 });
    const done = { ...outlineTasks()[1], percent_complete: 100, status: 'complete' as const };
    api.postOps.mockResolvedValueOnce(makeOpsResult({ tasks: [done] }));
    fireEvent.click(tool('100% Complete'));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(rowOf('a').textContent).toContain('Order crates'));
    expect(sheetIds()).toContain('a');
    pick('Filter', 'Incomplete Tasks');
    await waitFor(() => expect(sheetIds()).not.toContain('a'));
  });

  it('a task added while filtered stays in view', async () => {
    await ready();
    fireEvent.change(search(), { target: { value: 'racks' } });
    await waitFor(() => expect(sheetIds()).toEqual(['s1', 'b', 's2', 'c', 'blank']));
    fireEvent.mouseDown(rowOf('c').querySelector('[data-col="name"]')!, { button: 0 });
    const added = makeTask('n', { display_id: 5, wbs: '2.1', outline_level: 2, position: 0, parent_id: 's2',
      name: 'New Task', start: '2026-11-05T08:00', finish: '2026-11-05T17:00' });
    api.postOps.mockResolvedValueOnce(makeOpsResult({
      tasks: [added], temp_ids: { 'cmd-1': 'n' }, order: ['s1', 'a', 'b', 's2', 'n', 'c', 'm', 'w'],
    }));
    fireEvent.click(tool('Insert Task'));
    await waitFor(() => expect(sheetIds()).toEqual(['s1', 'b', 's2', 'n', 'c', 'blank']));
    await waitFor(() => expect(rowOf('n').getAttribute('aria-selected')).toBe('true'));
  });
});

describe('search', () => {
  it('"crate" finds the task by its notes; Enter selects the first match and goes to the sheet', async () => {
    await ready();
    fireEvent.change(search(), { target: { value: 'from acme' } });
    await waitFor(() => expect(sheetIds()).toEqual(['s1', 'a', 'blank']));
    fireEvent.keyDown(search(), { key: 'Enter' });
    await waitFor(() => expect(document.activeElement).toBe(grid()));
    expect(rowOf('a').getAttribute('aria-selected')).toBe('true');
    // Escape clears it
    fireEvent.keyDown(search(), { key: 'Escape' });
    await waitFor(() => expect(sheetIds()).toEqual(['s1', 'a', 'b', 's2', 'c', 'm', 'w', 'blank']));
    expect(q('.pln-fcount')).toBeNull();
  });

  it('a search that matches only a summary shows it and doesn’t say none match; grouped, it says why', async () => {
    await ready();
    fireEvent.change(search(), { target: { value: 'move day' } });
    await waitFor(() => expect(sheetIds()).toEqual(['s2', 'blank']));
    expect(q('.pln-fcount')?.textContent).toBe('Only summary tasks match');
    pick('Group by', 'Resource');
    await waitFor(() => expect(sheetIds()).toEqual([]));
    expect(q('.pln-fcount')?.textContent).toBe('Turn off Group by to see summary tasks.');
    // Summary Tasks while grouped: the same
    fireEvent.change(search(), { target: { value: '' } });
    pick('Filter', 'Summary Tasks');
    await waitFor(() => expect(q('.pln-fcount')?.textContent).toBe('Turn off Group by to see summary tasks.'));
    // nothing matches at all: none
    fireEvent.change(search(), { target: { value: 'zebra' } });
    pick('Filter', 'All Tasks');
    await waitFor(() => expect(q('.pln-fcount')?.textContent).toBe('No tasks match'));
  });

  it('Ctrl+F from inside the plan focuses the search box; outside it the browser keeps its find', async () => {
    await ready();
    grid().focus();
    const inPlan = fireEvent.keyDown(grid(), { key: 'f', ctrlKey: true });
    expect(inPlan).toBe(false);                        // handled: the browser's find doesn't open
    expect(document.activeElement).toBe(search());
    (document.activeElement as HTMLElement).blur();
    const outside = fireEvent.keyDown(document.body, { key: 'f', ctrlKey: true });
    expect(outside).toBe(true);
    // in the search box itself, Ctrl+F is the browser's
    search().focus();
    expect(fireEvent.keyDown(search(), { key: 'f', ctrlKey: true })).toBe(true);
  });
});

describe('Group by', () => {
  it('Resource: leaves under a band per person, a two-resource task under both, Unassigned last — both panes', async () => {
    await ready();
    pick('Group by', 'Resource');
    await waitFor(() => expect(sheetIds()).toEqual([
      'band:Dana Ortiz', 'b', 'c', 'band:Jimmy Henderson', 'a', 'b', 'band:Unassigned', 'm', 'w',
    ]));
    expect(laneIds()).toEqual([
      bandKey('person:p-dana'), rowKey('person:p-dana', 'b'), rowKey('person:p-dana', 'c'),
      bandKey('person:p-me'), rowKey('person:p-me', 'a'), rowKey('person:p-me', 'b'),
      bandKey('unassigned'), rowKey('unassigned', 'm'), rowKey('unassigned', 'w'),
    ]);
    // a grouped task's name sits one level in from its band, whatever its outline level
    const levels = sheetRows().filter((r) => r.hasAttribute('data-task'))
      .map((r) => (r.querySelector('[data-col="name"]') as HTMLElement).style.getPropertyValue('--pln-level'));
    expect(new Set(levels)).toEqual(new Set(['2']));
    // no blank row, no links drawn
    expect(grid().querySelector('[data-blank]')).toBeNull();
    expect(q('.pln-link-path')).toBeNull();
    expect(JSON.parse(localStorage.getItem(`${VIEW_PREFIX}plan-1`)!)).toEqual(
      { filter: 'all', search: '', group: 'assignee' });
  });

  it('a grouped row selects on its own, and edits its task', async () => {
    await ready();
    pick('Group by', 'Resource');
    await waitFor(() => expect(rowOf('b', 1)).toBeTruthy());
    // Label racks' second row (under Jimmy): that row is the one selected
    fireEvent.mouseDown(rowOf('b', 1).querySelector('[data-col="name"]')!, { button: 0 });
    expect(rowOf('b', 1).getAttribute('aria-selected')).toBe('true');
    expect(rowOf('b', 0).getAttribute('aria-selected')).toBe('false');
    // a band takes no selection
    const band = sheetRows()[0];
    fireEvent.mouseDown(band.querySelector('[role="rowheader"]')!, { button: 0 });
    expect(rowOf('b', 1).getAttribute('aria-selected')).toBe('true');
    // F2 edits the task's name: the op names the task
    api.postOps.mockResolvedValueOnce(makeOpsResult({ tasks: [{ ...outlineTasks()[2], name: 'Label all racks' }] }));
    grid().focus();
    fireEvent.keyDown(grid(), { key: 'F2' });
    const editor = await screen.findByRole('textbox', { name: /Task Name/ });
    fireEvent.change(editor, { target: { value: 'Label all racks' } });
    fireEvent.keyDown(editor, { key: 'Enter' });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'update_task', id: 'b', fields: { name: 'Label all racks' } }]);
    await waitFor(() => expect(rowOf('b', 0).textContent).toContain('Label all racks'));
    expect(rowOf('b', 1).textContent).toContain('Label all racks');
    // arrows move through the task rows, skipping the bands
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    expect(rowOf('a').getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(grid(), { key: 'ArrowUp' });
    expect(rowOf('c').getAttribute('aria-selected')).toBe('true');
  });

  it('the outline commands are off while grouped, and say why', async () => {
    await ready();
    pick('Group by', 'Status');
    await waitFor(() => expect(sheetIds()[0]).toBe('band:Late'));
    fireEvent.mouseDown(rowOf('a').querySelector('[data-col="name"]')!, { button: 0 });
    for (const name of ['Insert Task', 'Insert Summary Task', 'Insert Milestone', 'Indent', 'Outdent', 'Link Tasks',
      'Unlink Tasks']) {
      expect(tool(name).getAttribute('aria-disabled'), name).toBe('true');
    }
    // no link handles on the bars: a link made now would have no line to show
    expect(q('.pln-link-dot')).toBeNull();
    // their keys say so too
    grid().focus();
    fireEvent.keyDown(grid(), { key: 'Insert' });
    fireEvent.keyDown(grid(), { key: 'ArrowRight', altKey: true, shiftKey: true });
    fireEvent.keyDown(grid(), { key: 'F2', ctrlKey: true });
    fireEvent.keyDown(grid(), { key: 'F2', ctrlKey: true, shiftKey: true });
    expect(toast).toHaveBeenCalledWith(`${OFF_NOTES.grouped}.`);
    expect(toast).toHaveBeenCalledTimes(4);
    expect(api.postOps).not.toHaveBeenCalled();
    // progress still works on a grouped row
    api.postOps.mockResolvedValueOnce(makeOpsResult({ tasks: [] }));
    fireEvent.click(tool('50% Complete'));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'set_percent', ids: ['a'], percent: 50 }]);
  });

  it('a bar on a grouped row drags as its task', async () => {
    await ready();
    pick('Group by', 'Resource');
    await waitFor(() => expect(laneOf(rowKey('person:p-me', 'b'))).toBeTruthy());
    const lane = laneOf(rowKey('person:p-me', 'b'));
    const bar = lane.querySelector('[data-task-id="b"]:not(.pln-link-dot)') as HTMLElement;
    const span = scaleSpan(outlinePlan().project_start, outlinePlan().project_finish,
      windowSpan({ start: INITIATIVE.scheduled_start, end: INITIATIVE.scheduled_end }));
    const scale = makeScale(span.start, span.finish, 'days');
    const chartBar = q('.pln-pane-chart > .pln-hbar') as HTMLElement;
    const x = xOf(scale, '2026-11-04T08:00') - chartBar.scrollLeft;
    const y = 5 * ROW + ROW / 2;                     // the sixth row: Jimmy's Label racks
    api.postOps.mockResolvedValueOnce(makeOpsResult({ tasks: [] }));
    fireEvent.pointerDown(bar, { clientX: x, clientY: y, pointerId: 1, button: 0 });
    fireEvent.pointerMove(bar, { clientX: x + 20, clientY: y, pointerId: 1 });
    fireEvent.pointerMove(bar, { clientX: x + 48, clientY: y, pointerId: 1 });
    fireEvent.pointerUp(bar, { clientX: x + 48, clientY: y, pointerId: 1 });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'update_task', id: 'b', fields: { start: '2026-11-04T08:00' } }]);
    // a press too short to drag selects that row
    fireEvent.pointerDown(bar, { clientX: x, clientY: y, pointerId: 2, button: 0 });
    fireEvent.pointerUp(bar, { clientX: x + 1, clientY: y, pointerId: 2 });
    expect(rowOf('b', 1).getAttribute('aria-selected')).toBe('true');
    expect(rowOf('b', 0).getAttribute('aria-selected')).toBe('false');
  });

  it('a band’s name stays at the sheet’s visible left edge as the sheet scrolls sideways', async () => {
    await ready();
    pick('Group by', 'Resource');
    await waitFor(() => expect(q('.pln-band-cell')).not.toBeNull());
    const bar = q('.pln-pane-sheet > .pln-hbar') as HTMLElement;
    const shift = q('.pln-pane-sheet > .pln-pane-shift') as HTMLElement;
    act(() => {
      bar.scrollLeft = 57;
      bar.dispatchEvent(new Event('scroll'));
    });
    // the pane's sideways scroll as a custom property the band's label is offset by (plan-sheet.css)
    expect(shift.style.getPropertyValue('--pln-pane-x')).toBe('57px');
    const css = (await import('node:fs')).readFileSync(
      (await import('node:path')).join(__dirname, '../../styles/plan-sheet.css'), 'utf8');
    expect(css).toMatch(/\.pln-band-cell\s*\{[^}]*var\(--pln-pane-x/);
  });

  it('a grouped row picked, then No Group: its task stays selected and the commands see it (fix round 1)', async () => {
    await ready();
    pick('Group by', 'Resource');
    await waitFor(() => expect(rowOf('b', 1)).toBeTruthy());
    // Jimmy's Label racks: the second copy
    fireEvent.mouseDown(rowOf('b', 1).querySelector('[data-col="name"]')!, { button: 0 });
    pick('Group by', 'No Group');
    await waitFor(() => expect(sheetIds()).toEqual(['s1', 'a', 'b', 's2', 'c', 'm', 'w', 'blank']));
    expect(rowOf('b').getAttribute('aria-selected')).toBe('true');
    api.postOps.mockResolvedValueOnce(makeOpsResult({ tasks: [] }));
    fireEvent.click(tool('75% Complete'));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'set_percent', ids: ['b'], percent: 75 }]);
    // and the keys go on from its row
    grid().focus();
    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    expect(rowOf('s2').getAttribute('aria-selected')).toBe('true');
  });

  it('a cell paste while grouped fills the rows on screen from the active one, each task once (fix round 1)', async () => {
    await ready();
    pick('Group by', 'Resource');
    await waitFor(() => expect(rowOf('b', 1)).toBeTruthy());
    // on screen: Dana: b, c · Jimmy: a, b · Unassigned: m, w — active on Jimmy's b, the second copy of b
    fireEvent.mouseDown(rowOf('b', 1).querySelector('[data-col="name"]')!, { button: 0 });
    api.postOps.mockResolvedValueOnce(makeOpsResult({ tasks: [] }));
    fireEvent.paste(grid(), { clipboardData: { getData: () => 'Label racks again\r\nGo live!\r\n' } });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    const named = sent().filter((op): op is Extract<Op, { op: 'update_task' }> => op.op === 'update_task')
      .map((op) => [op.id, op.fields.name]);
    expect(named).toEqual([['b', 'Label racks again'], ['m', 'Go live!']]);
    // from Jimmy's a: a, then b (shown under Jimmy next), not c
    api.postOps.mockClear();
    fireEvent.mouseDown(rowOf('a').querySelector('[data-col="name"]')!, { button: 0 });
    api.postOps.mockResolvedValueOnce(makeOpsResult({ tasks: [] }));
    fireEvent.paste(grid(), { clipboardData: { getData: () => 'One\r\nTwo\r\n' } });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent().filter((op): op is Extract<Op, { op: 'update_task' }> => op.op === 'update_task')
      .map((op) => [op.id, op.fields.name])).toEqual([['a', 'One'], ['b', 'Two']]);
  });

  it('Scroll to Task on a second copy scrolls to that row, not the first copy (fix round 1)', async () => {
    await ready();
    pick('Group by', 'Resource');
    await waitFor(() => expect(rowOf('b', 1)).toBeTruthy());
    const box = (q('.pln-pane-sheet') as HTMLElement).closest('.pln-panes') as HTMLElement;
    let top = 0;
    Object.defineProperty(box, 'scrollTop', { configurable: true, get: () => top, set: (v: number) => { top = v; } });
    fireEvent.mouseDown(rowOf('b', 1).querySelector('[data-col="name"]')!, { button: 0 });
    // a short box, so where the row lands shows
    Object.defineProperty(box, 'clientHeight', { configurable: true, get: () => 100 });
    top = 0;
    fireEvent.keyDown(grid(), { key: 'F5', ctrlKey: true, shiftKey: true });
    // Jimmy's b is the sixth row (index 5), the first copy the second (index 1): centered,
    // index × 30 less (100 − 44 − 30) / 2
    await waitFor(() => expect(top).toBe(5 * ROW - (100 - 44 - ROW) / 2));
  });

  it('switching grouping keeps the selected task selected', async () => {
    await ready();
    fireEvent.mouseDown(rowOf('c').querySelector('[data-col="name"]')!, { button: 0 });
    pick('Group by', 'Resource');
    await waitFor(() => expect(rowOf('c').getAttribute('aria-selected')).toBe('true'));
    pick('Group by', 'No Group');
    await waitFor(() => expect(sheetIds()).toEqual(['s1', 'a', 'b', 's2', 'c', 'm', 'w', 'blank']));
    expect(rowOf('c').getAttribute('aria-selected')).toBe('true');
  });
});

describe('kept per plan; the deep link', () => {
  it('the view comes back for the plan', async () => {
    localStorage.setItem(`${VIEW_PREFIX}plan-1`, JSON.stringify({ filter: 'critical', search: '', group: 'none' }));
    await ready();
    await waitFor(() => expect(sheetIds()).toEqual(['s2', 'c', 'blank']));
    expect((screen.getByRole('combobox', { name: 'Filter' }) as HTMLInputElement).value).toBe('Critical');
  });

  it('a &task= link to a task the filter hides clears the filter, then selects it', async () => {
    localStorage.setItem(`${VIEW_PREFIX}plan-1`, JSON.stringify({ filter: 'critical', search: 'x', group: 'none' }));
    await ready(outlinePlan(), '/initiatives/init-1?tab=plan&task=w');
    await waitFor(() => expect(rowOf('w')?.getAttribute('aria-selected')).toBe('true'));
    expect((screen.getByRole('combobox', { name: 'Filter' }) as HTMLInputElement).value).toBe('All Tasks');
    expect(search().value).toBe('');
  });

  it('a &task= link while grouped selects the task’s first row', async () => {
    localStorage.setItem(`${VIEW_PREFIX}plan-1`, JSON.stringify({ filter: 'all', search: '', group: 'assignee' }));
    await ready(outlinePlan(), '/initiatives/init-1?tab=plan&task=b');
    await waitFor(() => expect(rowOf('b', 0)?.getAttribute('aria-selected')).toBe('true'));
    expect(rowOf('b', 1).getAttribute('aria-selected')).toBe('false');
  });

  it('Read-only people have the filter bar too', async () => {
    await ready(outlinePlan({ permissions: { view: true, add: false, change: false, delete: false } }));
    expect(screen.getByRole('combobox', { name: 'Filter' })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: 'Group by' })).toBeTruthy();
    pick('Filter', 'Milestones');
    await waitFor(() => expect(sheetIds()).toEqual(['s2', 'm']));
  });
});
