// @vitest-environment jsdom
/**
 * components/plans/PlanSheet.tsx, editing: spreadsheet keys (type to edit,
 * F2, double-click, Enter / Tab / Shift+Tab commit and move, Esc cancels,
 * arrows move), the blank new-task row, the cell editors (text, date,
 * ComboBox selects, the Resource Names picker), row-number selection, the
 * locked and read-only rules, notices and the completion check.
 *
 * Review Focus 1: an edit the API rejects leaves the cell showing its old
 * value with the error under it, never a phantom new value.
 *
 * The sheet runs inside the real PlanTab and usePlan against a mocked
 * lib/plans/api, plus one direct render with a fake controller to pin the
 * order of apply and the editing hold.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { ApplyResult } from '../../lib/plans/applyResult';
import type { Plan, PlanTask } from '../../lib/plans/api';
import { planView } from '../../lib/plans/merge';
import { flatTasks, makeLink, makeOpsResult, makePlan, makeRestore, makeTask } from '../../lib/plans/planFixtures';
import { selectCell, type Selection } from '../../lib/plans/selection';
import type { PlanController } from './usePlan';
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
const { default: PlanSheet } = await import('./PlanSheet');

const INITIATIVE = { name: 'NAP11 Hall Migration', scheduled_start: '2026-11-14', scheduled_end: '2026-11-16' };

/** Survey, Pack, Go live: three top-level tasks, numbered 1-3. */
function tasks3(): PlanTask[] {
  const [a, b, c] = flatTasks(['a', 'b', 'c']);
  return [
    { ...a, name: 'Survey' },
    { ...b, name: 'Pack', predecessors: '1' },
    { ...c, name: 'Go live' },
  ];
}
const plan3 = (over: Partial<Plan> = {}) => makePlan({ tasks: tasks3(), links: [makeLink('l1', 'a', 'b')], ...over });

function renderTab() {
  return render(
    <MemoryRouter initialEntries={['/initiatives/init-1?tab=plan']}>
      <Routes>
        <Route path="/initiatives/:id" element={<PlanTab initiativeId="init-1" initiative={INITIATIVE} />} />
      </Routes>
    </MemoryRouter>,
  );
}

const grid = () => screen.getByRole('grid', { name: 'Task sheet' });
const rowOf = (name: string) => within(grid()).getAllByRole('row')
  .find((r) => r.querySelector('[data-col="name"]')?.textContent === name) as HTMLElement;
const cellOf = (name: string, col: string) => rowOf(name).querySelector(`[data-col="${col}"]`) as HTMLElement;
const blankCell = (col: string) => grid().querySelector(`[data-blank] [data-col="${col}"]`) as HTMLElement;
const active = () => {
  const cell = within(grid()).getAllByRole('gridcell').find((c) => c.getAttribute('aria-selected') === 'true');
  if (!cell) return null;
  const row = cell.closest('[role="row"]') as HTMLElement;
  return `${row.hasAttribute('data-blank') ? 'blank' : row.querySelector('[data-col="name"]')?.textContent}/${cell.getAttribute('data-col')}`;
};
/** The sheet's own cell editor (not a dialog's field of the same name). */
const editor = (label: string) => within(grid()).queryByRole('textbox', { name: label }) as HTMLInputElement | null;
const taskInfo = () => screen.queryByRole('dialog', { name: 'Task Information' });
const sentOps = (call = 0) => api.postOps.mock.calls[call]?.[2];

async function ready(plan: Plan = plan3()) {
  api.getPlan.mockResolvedValueOnce(plan);
  const user = userEvent.setup();
  renderTab();
  await findSheet();
  return user;
}

const SIZES = ['offsetHeight', 'offsetWidth', 'clientHeight'] as const;
const realSizes = SIZES.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
  ?? Object.getOwnPropertyDescriptor(Element.prototype, key));
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  for (const [key, px] of [['offsetHeight', 600], ['offsetWidth', 1200], ['clientHeight', 600]] as const) {
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

describe('typing into a cell', () => {
  it('typing 5d⏎ in Duration posts one op and moves the active cell down', async () => {
    const user = await ready();
    api.postOps.mockResolvedValueOnce(makeOpsResult({
      tasks: [{ ...tasks3()[0], duration_minutes: 2400, duration_text: '5 days' }],
    }));
    await user.click(cellOf('Survey', 'duration'));
    await user.keyboard('5d');
    expect(editor('Duration')?.value).toBe('5d');
    await user.keyboard('{Enter}');
    await waitFor(() => expect(editor('Duration')).toBeNull());
    expect(api.postOps).toHaveBeenCalledTimes(1);
    expect(api.postOps).toHaveBeenCalledWith('plan-1', 5, [{ op: 'update_task', id: 'a', fields: { duration: '5d' } }]);
    expect(cellOf('Survey', 'duration').textContent).toBe('5 days');
    expect(active()).toBe('Pack/duration');
    expect(document.activeElement).toBe(grid());
  });

  it('a 422 keeps the editor open with the error under it, and the cell its old value (Review Focus 1)', async () => {
    const user = await ready();
    api.postOps.mockRejectedValueOnce(new ApiError(422, 'link_cycle',
      { code: 'link_cycle', display_ids: [1, 3], task_ids: ['a', 'c'] }));
    await user.click(cellOf('Survey', 'predecessors'));
    await user.keyboard('3{Enter}');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe('Tasks 1 and 3 would depend on each other.');
    expect(alert.classList.contains('pf-error')).toBe(true);
    expect(editor('Predecessors')?.value).toBe('3');
    expect(editor('Predecessors')?.getAttribute('aria-invalid')).toBe('true');
    // underneath, the cell still shows what the plan holds: nothing
    expect(cellOf('Survey', 'predecessors').textContent).toBe('');
    expect(active()).toBe('Survey/predecessors');
    // Esc gives up the edit; nothing else is sent
    await user.keyboard('{Escape}');
    expect(editor('Predecessors')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(cellOf('Survey', 'predecessors').textContent).toBe('');
    expect(api.postOps).toHaveBeenCalledTimes(1);
    expect(api.getPlan).toHaveBeenCalledTimes(1);
  });

  it('a duration that does not parse shows its error inline and sends nothing', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'duration'));
    await user.keyboard('abc{Enter}');
    expect(screen.getByRole('alert').textContent).toBe('"abc" isn’t a duration. Try 5d, 4h or 3ed.');
    expect(editor('Duration')?.value).toBe('abc');
    expect(api.postOps).not.toHaveBeenCalled();
    // fixing it goes through
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    await user.clear(editor('Duration')!);
    await user.keyboard('2d{Enter}');
    await waitFor(() => expect(editor('Duration')).toBeNull());
    expect(sentOps()).toEqual([{ op: 'update_task', id: 'b', fields: { duration: '2d' } }]);
  });

  it('Esc restores the cell without a request', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'name'));
    await user.keyboard('Crate everything');
    expect(editor('Task Name')?.value).toBe('Crate everything');
    await user.keyboard('{Escape}');
    expect(editor('Task Name')).toBeNull();
    expect(cellOf('Pack', 'name').textContent).toBe('Pack');
    expect(api.postOps).not.toHaveBeenCalled();
    expect(active()).toBe('Pack/name');
    expect(document.activeElement).toBe(grid());
  });

  it('an unchanged value closes the editor without a request', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'duration'));
    await user.keyboard('{F2}{Enter}');
    expect(editor('Duration')).toBeNull();
    expect(api.postOps).not.toHaveBeenCalled();
    expect(active()).toBe('Go live/duration');
  });

  it('F2 and a double-click open the editor with the current value', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'predecessors'));
    await user.keyboard('{F2}');
    expect(editor('Predecessors')?.value).toBe('1');
    await user.keyboard('{Escape}');
    await user.dblClick(cellOf('Go live', 'name'));
    expect(editor('Task Name')?.value).toBe('Go live');
  });

  it('Tab commits and moves right, Shift+Tab left; without an editor Tab moves too', async () => {
    const user = await ready();
    api.postOps.mockResolvedValue(makeOpsResult());
    await user.click(cellOf('Survey', 'name'));
    await user.keyboard('Site survey{Tab}');
    await waitFor(() => expect(active()).toBe('Survey/duration'));
    expect(sentOps()).toEqual([{ op: 'update_task', id: 'a', fields: { name: 'Site survey' } }]);
    await user.keyboard('{Tab}');
    expect(active()).toBe('Survey/start');
    await user.keyboard('{Shift>}{Tab}{/Shift}');
    expect(active()).toBe('Survey/duration');
    await user.keyboard('3d{Shift>}{Tab}{/Shift}');
    await waitFor(() => expect(active()).toBe('Survey/name'));
    expect(sentOps(1)).toEqual([{ op: 'update_task', id: 'a', fields: { duration: '3d' } }]);
  });

  it('tabbing into the sheet with nothing selected lands on the first row’s Task Name; a click does not', async () => {
    const user = await ready(plan3({ tasks: [], links: [] }));
    await user.click(screen.getByRole('button', { name: /Full screen/ }));
    await user.click(screen.getByRole('button', { name: /Exit full screen/ }));
    // past the filter bar: Filter, Group by, the search
    await user.tab();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(document.activeElement).toBe(grid());
    expect(active()).toBe('blank/name');
    api.postOps.mockResolvedValueOnce(makeOpsResult({ inverse: [] }));
    await user.keyboard('Survey site{Enter}');
    await waitFor(() => expect(screen.queryByRole('textbox', { name: 'Task Name' })).toBeNull());
    expect(sentOps()).toEqual([{ op: 'add_task', temp_id: expect.any(String), parent_id: null, name: 'Survey site' }]);
  });

  it('a click on a cell selects that cell, not the first one', async () => {
    const user = await ready();
    await user.click(cellOf('Go live', 'finish'));
    expect(active()).toBe('Go live/finish');
  });

  it('arrows move the active cell; inside an editor they move the caret', async () => {
    const user = await ready();
    await user.click(cellOf('Survey', 'name'));
    await user.keyboard('{ArrowDown}{ArrowRight}');
    expect(active()).toBe('Pack/duration');
    await user.keyboard('{ArrowUp}{ArrowLeft}');
    expect(active()).toBe('Survey/name');
    await user.keyboard('{F2}{ArrowLeft}{ArrowDown}');
    expect(editor('Task Name')).not.toBeNull();
    expect(active()).toBe('Survey/name');
  });

  it('a date typed into Start sends a date alone, and the constraint it added toasts with Undo', async () => {
    const user = await ready();
    api.postOps.mockResolvedValueOnce(makeOpsResult({
      tasks: [{ ...tasks3()[1], start: '2026-11-05T08:00', constraint_type: 'snet', constraint_date: '2026-11-05T08:00' }],
      notices: [{ code: 'constraint_added', task_id: 'b', constraint_type: 'snet' }],
      inverse: [makeRestore('start')],
    }));
    await user.click(cellOf('Pack', 'start'));
    await user.keyboard('{F2}');
    const input = screen.getByLabelText('Start', { selector: 'input' }) as HTMLInputElement;
    expect(input.type).toBe('date');
    expect(input.value).toBe('2026-11-02');
    fireEvent.change(input, { target: { value: '2026-11-05' } });
    await user.keyboard('{Enter}');
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(sentOps()).toEqual([{ op: 'update_task', id: 'b', fields: { start: '2026-11-05' } }]);
    const [message, action] = toast.mock.calls[0];
    expect(message).toBe('Start No Earlier Than constraint added');
    expect(action.label).toBe('Undo');
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7, inverse: [makeRestore('redo')] }));
    act(() => action.onClick());
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sentOps(1)).toEqual([makeRestore('start')]);
  });

  it('a plan that shows times edits dates with a time', async () => {
    const plan = plan3();
    const user = await ready({ ...plan, settings: { ...plan.settings, show_times: true } });
    await user.dblClick(cellOf('Pack', 'finish'));
    const input = screen.getByLabelText('Finish', { selector: 'input' }) as HTMLInputElement;
    expect(input.type).toBe('datetime-local');
    expect(input.value).toBe('2026-11-02T17:00');
  });
});

describe('fix round 1', () => {
  /** A promise the test settles, for a commit held in flight. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
  }

  it('an Enter that confirms an IME composition neither commits nor moves', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'name'));
    await user.keyboard('{F2}');
    const input = editor('Task Name')!;
    fireEvent.change(input, { target: { value: 'Pack 箱' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 229 });
    // a commit would post on the write queue's next turn: let it run
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.postOps).not.toHaveBeenCalled();
    expect(editor('Task Name')?.value).toBe('Pack 箱');
    expect(editor('Task Name')?.readOnly).toBe(false);
    expect(active()).toBe('Pack/name');
    // the Enter after the composition commits
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sentOps()).toEqual([{ op: 'update_task', id: 'b', fields: { name: 'Pack 箱' } }]));
  });

  it('a half-typed date says so and changes nothing (the field never clears)', async () => {
    const user = await ready(plan3({ tasks: tasks3().map((t) => (t.id === 'b' ? { ...t, deadline: '2026-11-09T17:00' } : t)) }));
    await user.dblClick(cellOf('Pack', 'deadline'));
    const input = screen.getByLabelText('Deadline', { selector: 'input' }) as HTMLInputElement;
    Object.defineProperty(input, 'validity', { configurable: true, value: { badInput: true } });
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByRole('alert').textContent).toBe('Enter a full date.');
    expect(screen.getByLabelText('Deadline', { selector: 'input' })).toBeTruthy();
    expect(api.postOps).not.toHaveBeenCalled();
    expect(cellOf('Pack', 'deadline').textContent).toBe('Mon 11/9/26');
  });

  it('a select commits and moves down on Enter; a mouse pick commits and stays', async () => {
    const user = await ready();
    api.postOps.mockResolvedValue(makeOpsResult());
    await user.dblClick(cellOf('Survey', 'mode'));
    await screen.findByRole('button', { name: 'Manually Scheduled' });
    await user.keyboard('{ArrowDown}{Enter}');
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sentOps()).toEqual([{ op: 'update_task', id: 'a', fields: { mode: 'manual' } }]);
    await waitFor(() => expect(active()).toBe('Pack/mode'));
    await user.dblClick(cellOf('Go live', 'mode'));
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'Manually Scheduled' }));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(active()).toBe('Go live/mode');
  });

  it('Enter twice, or Enter while a commit is in flight, posts once', async () => {
    const user = await ready();
    const held = deferred<ReturnType<typeof makeOpsResult>>();
    api.postOps.mockReturnValueOnce(held.promise);
    await user.click(cellOf('Survey', 'duration'));
    await user.keyboard('5d{Enter}{Enter}');
    const input = editor('Duration')!;
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(api.postOps).toHaveBeenCalledTimes(1);
    await act(async () => held.resolve(makeOpsResult()));
    await waitFor(() => expect(editor('Duration')).toBeNull());
    expect(api.postOps).toHaveBeenCalledTimes(1);
    expect(active()).toBe('Pack/duration');
  });

  it('the blank row adds under the parent of the last row shown (a subtask’s summary)', async () => {
    const tasks = [
      makeTask('s', { display_id: 1, wbs: '1', is_summary: true, name: 'Prep' }),
      makeTask('a', { display_id: 2, wbs: '1.1', outline_level: 2, parent_id: 's', name: 'Order crates' }),
    ];
    const user = await ready(makePlan({ tasks }));
    api.postOps.mockResolvedValueOnce(makeOpsResult({ inverse: [] }));
    await user.click(blankCell('name'));
    await user.keyboard('Label crates{Enter}');
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sentOps()).toEqual([
      { op: 'add_task', temp_id: expect.any(String), parent_id: 's', name: 'Label crates' },
    ]);
  });

  it('the same refusal again, after focus left the field, brings focus back to it', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'duration'));
    await user.keyboard('abc{Enter}');
    const message = screen.getByRole('alert').textContent;
    expect(document.activeElement).toBe(editor('Duration'));
    // focus leaves (the toolbar): leaving commits, and the same text is
    // refused the same way. (jsdom answers hasFocus() false mid-move; a
    // browser window that has focus answers true.)
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    act(() => screen.getByRole('button', { name: /Full screen/ }).focus());
    expect(screen.getByRole('alert').textContent).toBe(message);
    expect(document.activeElement).toBe(editor('Duration'));
    expect(api.postOps).not.toHaveBeenCalled();
  });

  it('Shift+Enter on an open select picks and moves up; on a closed one it commits and moves up', async () => {
    const user = await ready();
    api.postOps.mockResolvedValue(makeOpsResult());
    await user.dblClick(cellOf('Pack', 'mode'));
    await screen.findByRole('button', { name: 'Manually Scheduled' });
    await user.keyboard('{ArrowDown}{Shift>}{Enter}{/Shift}');
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sentOps()).toEqual([{ op: 'update_task', id: 'b', fields: { mode: 'manual' } }]);
    await waitFor(() => expect(active()).toBe('Survey/mode'));
    // the list closed (Escape closes only the list... here the editor), then Shift+Enter
    await user.dblClick(cellOf('Go live', 'mode'));
    const box = await screen.findByRole('combobox', { name: 'Mode' });
    fireEvent.mouseDown(document.body);          // closes the list, the editor stays
    expect(box.getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(box, { key: 'Enter', shiftKey: true });
    await waitFor(() => expect(active()).toBe('Pack/mode'));
    expect(api.postOps).toHaveBeenCalledTimes(1);   // unchanged: nothing to send
  });

  it('a note with a line break does not open in the cell, and its title says where to edit it', async () => {
    localStorage.setItem('plans.columns.v1', JSON.stringify({
      visible: ['id', 'name', 'notes'], widths: {}, seen: ['id', 'name', 'notes'],
    }));
    const tasks = tasks3().map((t) => (t.id === 'b' ? { ...t, notes: 'Call the dock\nthen pack' } : t));
    const user = await ready(plan3({ tasks }));
    const cell = cellOf('Pack', 'notes');
    // the whole note on hover, and where to edit it
    expect(cell.querySelector('[title]')?.getAttribute('title'))
      .toBe('Call the dock\nthen pack\n\nMulti-line note — edit in Task Information');
    await user.dblClick(cell);
    expect(editor('Notes')).toBeNull();
    await user.dblClick(cellOf('Survey', 'notes'));
    expect(editor('Notes')).not.toBeNull();
  });

  describe('Resource Names picker focus', () => {
    const withPeople = () => plan3({
      resources: [
        { kind: 'person', id: 'p1', name: 'Dana Reyes', group: 'team', has_email: true, has_account: true, is_staff: true },
        { kind: 'person', id: 'p2', name: 'Lee Park', group: 'team', has_email: true, has_account: true, is_staff: true },
      ],
    });
    const picker = () => screen.queryByRole('dialog', { name: 'Resource Names' });
    const pick = (name: string) => {
      const box = within(picker()!).getByRole('combobox');
      fireEvent.focus(box);
      fireEvent.mouseDown(within(picker()!.querySelector('.combo-menu') as HTMLElement).getByText(name));
    };

    it('keeps focus inside while the commit is in flight', async () => {
      const user = await ready(withPeople());
      const held = deferred<ReturnType<typeof makeOpsResult>>();
      api.postOps.mockReturnValueOnce(held.promise);
      await user.dblClick(cellOf('Pack', 'resources'));
      pick('Dana Reyes');
      await user.click(within(picker()!).getByRole('button', { name: 'Save' }));
      expect(api.postOps).toHaveBeenCalledTimes(1);
      expect(picker()!.contains(document.activeElement)).toBe(true);
      expect(picker()!.getAttribute('aria-busy')).toBe('true');
      await act(async () => held.resolve(makeOpsResult()));
      await waitFor(() => expect(picker()).toBeNull());
    });

    it('a refusal keeps focus in the picker, so the next Escape closes it (handled), not full screen', async () => {
      const user = await ready(withPeople());
      const held = deferred<never>();
      api.postOps.mockReturnValueOnce(held.promise);
      await user.dblClick(cellOf('Pack', 'resources'));
      pick('Dana Reyes');
      await user.click(within(picker()!).getByRole('button', { name: 'Save' }));
      // focus went elsewhere while it was in flight (the toolbar, or a browser's focus fixup)
      act(() => screen.getByRole('button', { name: /Full screen/ }).focus());
      expect(picker()!.contains(document.activeElement)).toBe(false);
      await act(async () => held.reject(new ApiError(422, 'bad_resource', { code: 'bad_resource', kind: 'person', id: 'p1' })));
      const alert = await within(picker()!).findByRole('alert');
      expect(alert.textContent).toBe('That person or partner can’t be assigned to tasks in this plan.');
      expect(picker()!.contains(document.activeElement)).toBe(true);
      expect(cellOf('Pack', 'resources').textContent).toBe('');
      const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      act(() => { document.activeElement!.dispatchEvent(esc); });
      expect(esc.defaultPrevented).toBe(true);
      expect(picker()).toBeNull();
      expect(api.postOps).toHaveBeenCalledTimes(1);
    });

    it('tabbing past Save commits the picker', async () => {
      const user = await ready(withPeople());
      api.postOps.mockResolvedValueOnce(makeOpsResult());
      await user.dblClick(cellOf('Pack', 'resources'));
      pick('Lee Park');
      within(picker()!).getByRole('button', { name: 'Save' }).focus();
      await user.tab();
      await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
      expect(sentOps()).toEqual([{ op: 'set_assignees', task_id: 'b', resources: [{ kind: 'person', id: 'p2' }] }]);
      await waitFor(() => expect(picker()).toBeNull());
    });
  });
});

describe('the blank new-task row', () => {
  it('typing a name there adds a task under no parent, and the blank row stays active', async () => {
    const user = await ready();
    const added = makeTask('n1', { display_id: 4, wbs: '4', position: 3, name: 'Label racks' });
    api.postOps.mockImplementationOnce(async (_id: string, _v: number, ops: { temp_id: string }[]) =>
      makeOpsResult({ tasks: [added], order: ['a', 'b', 'c', 'n1'], temp_ids: { [ops[0].temp_id]: 'n1' } }));
    await user.click(blankCell('name'));
    await user.keyboard('Label racks{Enter}');
    await waitFor(() => expect(rowOf('Label racks')).toBeTruthy());
    expect(sentOps()).toEqual([
      { op: 'add_task', temp_id: expect.any(String), parent_id: null, name: 'Label racks' },
    ]);
    expect(active()).toBe('blank/name');
    expect(toast).not.toHaveBeenCalled();
  });

  it('is gone on a locked plan', async () => {
    await ready(plan3({ locked_at: '2026-10-28T15:30:00Z' }));
    expect(grid().querySelector('[data-blank]')).toBeNull();
  });
});

describe('who may edit', () => {
  it('locked: Duration does not open; % Complete does', async () => {
    const user = await ready(plan3({ locked_at: '2026-10-28T15:30:00Z', locked_by_name: 'Dana' }));
    await user.click(cellOf('Pack', 'duration'));
    await user.keyboard('5');
    expect(editor('Duration')).toBeNull();
    await user.keyboard('{F2}');
    expect(editor('Duration')).toBeNull();
    // a double-click on a cell that doesn't edit opens Task Information instead
    await user.dblClick(cellOf('Pack', 'duration'));
    expect(editor('Duration')).toBeNull();
    expect((within(taskInfo()!).getByLabelText('Duration') as HTMLInputElement).disabled).toBe(true);
    await user.keyboard('{Escape}');
    expect(taskInfo()).toBeNull();
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    await user.click(cellOf('Pack', 'percent'));
    await user.keyboard('5');
    expect(editor('% Complete')?.value).toBe('5');
    await user.keyboard('0{Enter}');
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sentOps()).toEqual([{ op: 'set_percent', ids: ['b'], percent: 50 }]);
  });

  it('read-only: no editor opens anywhere', async () => {
    const user = await ready(plan3({ permissions: { view: true, add: false, change: false, delete: false } }));
    await user.click(cellOf('Pack', 'name'));
    await user.keyboard('x{F2}');
    expect(within(grid()).queryByRole('textbox')).toBeNull();
    await user.dblClick(cellOf('Pack', 'percent'));
    expect(within(grid()).queryByRole('textbox')).toBeNull();
    // Task Information instead, to read
    expect(within(taskInfo()!).queryByRole('button', { name: 'OK' })).toBeNull();
  });

  it('a summary’s Duration does not open; its name does', async () => {
    const tasks = [
      makeTask('s', { display_id: 1, wbs: '1', is_summary: true, name: 'Prep' }),
      makeTask('a', { display_id: 2, wbs: '1.1', outline_level: 2, parent_id: 's', name: 'Order crates' }),
    ];
    const user = await ready(makePlan({ tasks }));
    await user.dblClick(cellOf('Prep', 'duration'));
    expect(editor('Duration')).toBeNull();
    expect(taskInfo()).not.toBeNull();
    await user.keyboard('{Escape}');
    await user.dblClick(cellOf('Prep', 'name'));
    expect(editor('Task Name')?.value).toBe('Prep');
    expect(taskInfo()).toBeNull();
  });
});

describe('% Complete and the completion rules', () => {
  it('a confirm answer prompts; confirming resends with confirm: true on the op', async () => {
    const user = await ready();
    api.postOps.mockRejectedValueOnce(new ApiError(409, 'completion_confirm', {
      code: 'completion_confirm', will_complete: [], open_predecessors: [
        { task_id: 'a', display_id: 1, name: 'Survey', reason: 'predecessor' }],
    }));
    await user.click(cellOf('Pack', 'percent'));
    await user.keyboard('100{Enter}');
    const check = await screen.findByRole('dialog', { name: 'Confirm completion' });
    // the edit did not go through: no phantom 100%
    expect(editor('% Complete')).toBeNull();
    expect(cellOf('Pack', 'percent').textContent).toBe('0%');
    expect(within(check).getByRole('region', { name: 'This predecessor isn’t complete yet' }).textContent)
      .toContain('Survey');
    expect(toast).not.toHaveBeenCalled();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ tasks: [{ ...tasks3()[1], percent_complete: 100 }] }));
    await user.click(within(check).getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sentOps(1)).toEqual([{ op: 'set_percent', ids: ['b'], percent: 100, confirm: true }]);
    await waitFor(() => expect(cellOf('Pack', 'percent').textContent).toBe('100%'));
  });

  it('a blocked answer says what is in the way, with nothing to confirm', async () => {
    const user = await ready();
    api.postOps.mockRejectedValueOnce(new ApiError(409, 'completion_blocked', {
      code: 'completion_blocked', blockers: [{ task_id: 'a', display_id: 1, name: 'Survey', reason: 'predecessor' }],
    }));
    await user.click(cellOf('Pack', 'percent'));
    await user.keyboard('100{Enter}');
    const check = await screen.findByRole('dialog', { name: 'Can’t complete yet' });
    expect(within(check).queryByRole('button', { name: 'Complete' })).toBeNull();
    expect(cellOf('Pack', 'percent').textContent).toBe('0%');
    // Go to task: the blocker's row is selected, the dialog gone
    await user.click(within(check).getByRole('button', { name: 'Go to task 1' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(active()).toBe('Survey/name'));
  });
});

describe('select and Resource Names editors', () => {
  it('Mode opens a ComboBox; picking an option commits it', async () => {
    const user = await ready();
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    await user.dblClick(cellOf('Survey', 'mode'));
    const option = await screen.findByRole('button', { name: 'Manually Scheduled' });
    expect(option.closest('.combo-menu')?.parentElement).toBe(document.body);   // portaled
    fireEvent.mouseDown(option);
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sentOps()).toEqual([{ op: 'update_task', id: 'a', fields: { mode: 'manual' } }]);
  });

  it('Resource Names lists the plan’s resources by group, notes who won’t get reminders, and saves', async () => {
    const plan = plan3({
      resources: [
        { kind: 'partner', id: 'x1', name: 'Acme Freight', group: 'partner', has_email: true, has_account: false, is_staff: false },
        { kind: 'person', id: 'p3', name: 'Ari Moss', group: 'staff', has_email: true, has_account: true, is_staff: true },
        { kind: 'person', id: 'p1', name: 'Dana Reyes', group: 'team', has_email: true, has_account: true, is_staff: true },
        { kind: 'person', id: 'p2', name: 'Lee Park', group: 'team', has_email: false, has_account: false, is_staff: false },
      ],
    });
    const user = await ready(plan);
    await user.dblClick(cellOf('Pack', 'resources'));
    const picker = screen.getByRole('dialog', { name: 'Resource Names' });
    const menu = picker.querySelector('.combo-menu') as HTMLElement;
    expect([...menu.children].map((el) => el.textContent)).toEqual([
      'Team', 'Dana Reyes', 'Lee Parkwon’t get reminders', 'Staff', 'Ari Moss', 'Partners', 'Acme Freight',
    ]);
    fireEvent.mouseDown(within(menu).getByText('Dana Reyes'));
    fireEvent.focus(within(picker).getByRole('combobox'));
    fireEvent.mouseDown(within(picker.querySelector('.combo-menu') as HTMLElement).getByText('Acme Freight'));
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    await user.click(within(picker).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sentOps()).toEqual([{
      op: 'set_assignees', task_id: 'b',
      resources: [{ kind: 'person', id: 'p1' }, { kind: 'partner', id: 'x1' }],
    }]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Resource Names' })).toBeNull());
  });

  it('Color opens the task color picker: a swatch sets the color, No color clears it', async () => {
    localStorage.setItem('plans.columns.v1', JSON.stringify({
      visible: ['id', 'name', 'color'], widths: {}, seen: ['id', 'name', 'color'],
    }));
    const tasks = tasks3().map((t) => (t.id === 'b' ? { ...t, color: '#c03540' } : t));
    const user = await ready(plan3({ tasks }));
    // a swatch and the palette name; nothing for no color
    expect(cellOf('Pack', 'color').textContent).toBe('Red');
    expect(cellOf('Pack', 'color').querySelector('.color-swatch')).not.toBeNull();
    expect(cellOf('Survey', 'color').textContent).toBe('');
    // Task Name has no swatch
    expect(cellOf('Pack', 'name').querySelector('.color-swatch')).toBeNull();

    api.postOps.mockResolvedValueOnce(makeOpsResult({ tasks: [{ ...tasks[0], color: '#178a4c' }] }));
    await user.dblClick(cellOf('Survey', 'color'));
    const picker = screen.getByRole('dialog', { name: 'Task color' });
    await user.click(within(picker).getByRole('button', { name: 'Green' }));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sentOps()).toEqual([{ op: 'update_task', id: 'a', fields: { color: '#178a4c' } }]);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Task color' })).toBeNull());
    expect(cellOf('Survey', 'color').textContent).toBe('Green');

    api.postOps.mockResolvedValueOnce(makeOpsResult({ tasks: [{ ...tasks[1], color: null }], version: 7 }));
    await user.dblClick(cellOf('Pack', 'color'));
    await user.click(within(screen.getByRole('dialog', { name: 'Task color' })).getByRole('button', { name: 'No color' }));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sentOps(1)).toEqual([{ op: 'update_task', id: 'b', fields: { color: null } }]);
    await waitFor(() => expect(cellOf('Pack', 'color').textContent).toBe(''));
  });

  it('Escape in the Color picker cancels the edit and is marked handled', async () => {
    localStorage.setItem('plans.columns.v1', JSON.stringify({
      visible: ['id', 'name', 'color'], widths: {}, seen: ['id', 'name', 'color'],
    }));
    const user = await ready();
    await user.dblClick(cellOf('Pack', 'color'));
    const picker = screen.getByRole('dialog', { name: 'Task color' });
    const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { within(picker).getByRole('button', { name: 'Blue' }).dispatchEvent(esc); });
    expect(esc.defaultPrevented).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'Task color' })).toBeNull();
    expect(api.postOps).not.toHaveBeenCalled();
    await waitFor(() => expect(active()).toBe('Pack/color'));
  });

  it('Escape in the picker cancels it and is marked handled (full screen stays)', async () => {
    const user = await ready();
    await user.dblClick(cellOf('Pack', 'resources'));
    const picker = screen.getByRole('dialog', { name: 'Resource Names' });
    const box = within(picker).getByRole('combobox');
    fireEvent.keyDown(box, { key: 'Escape' });   // closes the list first
    expect(screen.getByRole('dialog', { name: 'Resource Names' })).toBeTruthy();
    const second = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    act(() => { box.dispatchEvent(second); });
    expect(second.defaultPrevented).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'Resource Names' })).toBeNull();
    expect(api.postOps).not.toHaveBeenCalled();
  });
});

describe('row numbers', () => {
  it('a click selects the row; Shift extends from it; Ctrl/⌘ toggles', async () => {
    const user = await ready();
    const selected = () => within(grid()).getAllByRole('row')
      .filter((r) => r.getAttribute('aria-selected') === 'true' && r.hasAttribute('data-task'))
      .map((r) => r.querySelector('[data-col="name"]')?.textContent);
    await user.click(cellOf('Survey', 'id'));
    expect(selected()).toEqual(['Survey']);
    await user.keyboard('{Shift>}');
    await user.click(cellOf('Go live', 'id'));
    await user.keyboard('{/Shift}');
    expect(selected()).toEqual(['Survey', 'Pack', 'Go live']);
    await user.keyboard('{Control>}');
    await user.click(cellOf('Pack', 'id'));
    await user.keyboard('{/Control}');
    expect(selected()).toEqual(['Survey', 'Go live']);
  });
});

describe('the editing hold', () => {
  it('a commit calls apply before it lets go of editing (else a waiting refresh drops the edit)', async () => {
    const calls: string[] = [];
    const view = planView(plan3());
    const ok: ApplyResult = { ok: true, notices: [], tempIds: {} };
    const ctl = {
      status: 'ready', plan: view.plan, outline: view.outline,
      apply: vi.fn(async () => { calls.push('apply'); return ok; }),
      beginEditing: vi.fn(() => { calls.push('hold'); return () => calls.push('release'); }),
      undo: vi.fn(),
    } as unknown as PlanController;
    function Harness() {
      const scrollRef = useRef<HTMLDivElement>(null);
      const selection = useRef<Selection>(selectCell('a', 'duration'));
      return (
        <div ref={scrollRef} className="pln-panes">
          <PlanSheet ctl={ctl} rows={['a', 'b', 'c']} collapsed={new Set()} rowHeight={30} scrollRef={scrollRef}
                     selection={selection.current} onSelect={(s) => { selection.current = s; }}
                     onToggleCollapse={() => {}} blankRow />
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    act(() => grid().focus());
    await user.keyboard('4d');
    expect(calls).toEqual(['hold']);
    await user.keyboard('{Enter}');
    await waitFor(() => expect(calls).toEqual(['hold', 'apply', 'release']));
    expect(ctl.apply).toHaveBeenCalledWith([{ op: 'update_task', id: 'a', fields: { duration: '4d' } }], 'Edit Duration');
  });

  it('a refused commit keeps holding editing until the editor closes', async () => {
    const calls: string[] = [];
    const view = planView(plan3());
    const ctl = {
      status: 'ready', plan: view.plan, outline: view.outline,
      apply: vi.fn(async () => {
        calls.push('apply');
        return { ok: false, kind: 'error', code: 'link_cycle', message: 'Tasks 1 and 2 would depend on each other.' };
      }),
      beginEditing: vi.fn(() => { calls.push('hold'); return () => calls.push('release'); }),
    } as unknown as PlanController;
    function Harness() {
      const scrollRef = useRef<HTMLDivElement>(null);
      return (
        <div ref={scrollRef} className="pln-panes">
          <PlanSheet ctl={ctl} rows={['a', 'b', 'c']} collapsed={new Set()} rowHeight={30} scrollRef={scrollRef}
                     selection={selectCell('a', 'predecessors')} onSelect={() => {}}
                     onToggleCollapse={() => {}} blankRow />
        </div>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    act(() => grid().focus());
    await user.keyboard('2{Enter}');
    await screen.findByRole('alert');
    expect(calls).toEqual(['hold', 'apply']);
    await user.keyboard('{Escape}');
    expect(calls).toEqual(['hold', 'apply', 'release']);
  });
});
