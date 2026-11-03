// @vitest-environment jsdom
/**
 * The plan tab's commands end to end (PlanTab + usePlan + usePlanCommands
 * against a mocked lib/plans/api): the MS Project keys on the sheet and
 * not in an editor (Review Focus 3), the toolbar, Delete's confirm, the
 * completion check (Ruling B2), copy, and a paste that adds rows sending
 * two batches that one Undo takes back (Ruling B3).
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { AddTaskOp, Op, Plan, PlanTask } from '../../lib/plans/api';
import { PLAN_ERRORS } from '../../lib/plans/errors';
import { parseClipboard } from '../../lib/plans/paste';
import { flatTasks, makeLink, makeOpsResult, makePlan, makeRestore, makeTask } from '../../lib/plans/planFixtures';
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

function tasks3(): PlanTask[] {
  const [a, b, c] = flatTasks(['a', 'b', 'c']);
  return [{ ...a, name: 'Survey' }, { ...b, name: 'Pack', predecessors: '1' }, { ...c, name: 'Go live' }];
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
const sent = (call = 0): Op[] => api.postOps.mock.calls[call]?.[2];
const tool = (name: string) => within(screen.getByRole('toolbar', { name: 'Project plan' })).getByRole('button', { name });
/** A toolbar button's hover tip, as a keyboard focus shows it: its
 *  description and keycaps ("Take back your last change: Indent. (Ctrl+Z)"). */
function tipOf(el: HTMLElement): string {
  fireEvent.keyDown(document.body, { key: 'Tab' });     // the keyboard's focus: the tip shows at once
  fireEvent.focusIn(el);
  const tip = screen.getByRole('tooltip');
  const keys = [...tip.querySelectorAll('kbd')].map((k) => k.textContent).join(' / ');
  const read = `${tip.querySelector('.tip-desc')?.textContent} (${keys})`;
  fireEvent.focusOut(el);
  return read;
}
/** The completion check open now, and its Complete. */
const check = () => screen.findByRole('dialog', { name: 'Confirm completion' });
async function complete() {
  fireEvent.click(within(await check()).getByRole('button', { name: 'Complete' }));
}

async function ready(plan: Plan = plan3()) {
  api.getPlan.mockResolvedValueOnce(plan);
  const user = userEvent.setup();
  // after setup, which puts a clipboard stub of its own on navigator
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: clipboard });
  renderTab();
  await findSheet();
  return user;
}

const SIZES = ['offsetHeight', 'offsetWidth', 'clientHeight', 'clientWidth'] as const;
const realSizes = SIZES.map((key) => Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)
  ?? Object.getOwnPropertyDescriptor(Element.prototype, key));
let clipboard: { writeText: ReturnType<typeof vi.fn>; readText: ReturnType<typeof vi.fn> };
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    top: 0, left: 0, right: 1200, bottom: 600, width: 1200, height: 600, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
  for (const [key, px] of [['offsetHeight', 600], ['offsetWidth', 1200], ['clientHeight', 600], ['clientWidth', 1200]] as const) {
    Object.defineProperty(HTMLElement.prototype, key, { configurable: true, get: () => px });
  }
  for (const fn of [toast, ...Object.values(api)]) fn.mockReset();
  clipboard = { writeText: vi.fn(async () => {}), readText: vi.fn(async () => '') };
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
  delete (navigator as unknown as Record<string, unknown>).clipboard;
  localStorage.clear();
});

describe('the keyboard map on the sheet (Review Focus 3)', () => {
  it('Alt+Shift+→ with a row selected indents it; Ctrl+Z takes it back', async () => {
    const user = await ready();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ inverse: [makeRestore('i1')] }));
    await user.click(cellOf('Pack', 'name'));
    fireEvent.keyDown(grid(), { key: 'ArrowRight', altKey: true, shiftKey: true });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'indent', ids: ['b'] }]);
    expect(tipOf(tool('Undo'))).toBe('Take back your last change: Indent. (Ctrl+Z)');

    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7, inverse: [makeRestore('r1')] }));
    fireEvent.keyDown(grid(), { key: 'z', ctrlKey: true });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sent(1)).toEqual([makeRestore('i1')]);
  });

  it('inside a cell editor Delete, Insert and Alt+Shift+→ type: nothing is sent', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'name'));
    await user.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Task Name' }) as HTMLInputElement;
    for (const init of [{ key: 'Delete' }, { key: 'Insert' }, { key: 'ArrowRight', altKey: true, shiftKey: true }]) {
      fireEvent.keyDown(input, init);
    }
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.postOps).not.toHaveBeenCalled();
    expect(screen.getByRole('textbox', { name: 'Task Name' })).toBe(input);
  });

  it('Insert adds a task above the active row and selects its name', async () => {
    const user = await ready();
    api.postOps.mockImplementationOnce(async (_plan: string, _v: number, ops: Op[]) => makeOpsResult({
      temp_ids: { [(ops[0] as AddTaskOp).temp_id!]: 'n1' },
      tasks: [makeTask('n1', { display_id: 2, position: 1, name: 'New Task' })],
      order: ['a', 'n1', 'b', 'c'],
    }));
    await user.click(cellOf('Pack', 'duration'));
    fireEvent.keyDown(grid(), { key: 'Insert' });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'add_task', temp_id: expect.any(String), before_id: 'b', name: 'New Task' }]);
    await waitFor(() => expect(cellOf('New Task', 'name').getAttribute('aria-selected')).toBe('true'));
  });

  it('a reader’s Delete does nothing; a locked plan’s Indent says so without a request', async () => {
    const user = await ready(plan3({ permissions: { view: true, add: false, change: false, delete: false } }));
    await user.click(cellOf('Pack', 'name'));
    fireEvent.keyDown(grid(), { key: 'Delete' });
    expect(api.postOps).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
    cleanup();

    const again = await ready(plan3({ locked_at: '2026-10-27T12:00:00Z' }));
    await again.click(cellOf('Pack', 'name'));
    fireEvent.keyDown(grid(), { key: 'ArrowRight', altKey: true, shiftKey: true });
    expect(toast).toHaveBeenCalledWith(PLAN_ERRORS.plan_locked);
    expect(api.postOps).not.toHaveBeenCalled();
  });
});

describe('the toolbar', () => {
  it('Delete on a summary asks first; Delete in the dialog sends, and the next row is selected', async () => {
    const tasks = [
      makeTask('s', { display_id: 1, is_summary: true, name: 'Prep' }),
      makeTask('k', { display_id: 2, wbs: '1.1', outline_level: 2, parent_id: 's', name: 'Crates' }),
      makeTask('z', { display_id: 3, wbs: '2', position: 1, name: 'Go live' }),
    ];
    const user = await ready(makePlan({ tasks }));
    await user.click(cellOf('Prep', 'name'));
    fireEvent.keyDown(grid(), { key: 'Delete' });
    const dialog = screen.getByRole('dialog', { name: 'Delete “Prep”?' });
    expect(dialog.textContent).toContain('Its 1 subtask is deleted too.');
    expect(api.postOps).not.toHaveBeenCalled();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ deleted_tasks: ['s', 'k'], order: ['z'] }));
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'delete_tasks', ids: ['s'] }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(cellOf('Go live', 'name').getAttribute('aria-selected')).toBe('true');
  });

  it('100% goes through the completion check; Complete resends with confirm', async () => {
    const user = await ready();
    api.postOps.mockRejectedValueOnce(new ApiError(409, 'completion_confirm', {
      code: 'completion_confirm', will_complete: [],
      open_predecessors: [{ task_id: 'a', display_id: 1, name: 'Survey', reason: 'predecessor' }],
    }));
    await user.click(cellOf('Pack', 'name'));
    await user.click(tool('100% Complete'));
    expect(within(await check()).getByText('Survey')).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    await complete();
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sent(1)).toEqual([{ op: 'set_percent', ids: ['b'], percent: 100, confirm: true }]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('Mark on Track blocked: Go to task selects the blocker and scrolls the chart to it', async () => {
    const user = await ready();
    api.postOps.mockRejectedValueOnce(new ApiError(409, 'completion_blocked', {
      code: 'completion_blocked', blockers: [{ task_id: 'a', display_id: 1, name: 'Survey', reason: 'predecessor' }],
    }));
    await user.click(cellOf('Go live', 'name'));
    await user.click(tool('Mark on Track'));
    const blocked = await screen.findByRole('dialog', { name: 'Can’t complete yet' });
    await user.click(within(blocked).getByRole('button', { name: 'Go to task 1' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(cellOf('Survey', 'name').getAttribute('aria-selected')).toBe('true'));
    expect(document.activeElement).toBe(grid());
  });

  it('a click on a command hands focus back to the sheet', async () => {
    const user = await ready();
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    await user.click(cellOf('Pack', 'name'));
    await user.click(tool('Outdent'));
    expect(toast).toHaveBeenCalledWith(PLAN_ERRORS.cannot_outdent);
    expect(document.activeElement).toBe(grid());
  });

  it('More › Keyboard shortcuts and `?` open the map', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'name'));
    fireEvent.keyDown(grid(), { key: '?', shiftKey: true });
    const dialog = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });
    expect(within(dialog).getByText('Alt+Shift+→')).toBeTruthy();
    expect(within(dialog).getByText('⌥⇧→')).toBeTruthy();
    await user.click(within(dialog).getByRole('button', { name: 'Done' }));
    // the sheet didn't take the ? as typing
    expect(screen.queryByRole('textbox', { name: 'Task Name' })).toBeNull();
  });
});

describe('copy and paste', () => {
  it('copy writes the selected rows’ visible columns as TSV; pasting that copy re-creates the task', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'name'));
    fireEvent.keyDown(grid(), { key: 'c', ctrlKey: true });
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    const text = clipboard.writeText.mock.calls[0][0] as string;
    expect(parseClipboard(text)).toEqual([
      ['', '2', 'Auto Scheduled', 'Pack', '1 day', 'Mon 11/2/26', 'Mon 11/2/26', '1', '', '0%', ''],
    ]);
    // the browser's own copy, at the focused hidden field, gets the same text
    const setData = vi.fn();
    fireEvent.copy(document.activeElement!, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', text);

    api.postOps.mockResolvedValueOnce(makeOpsResult());
    await user.click(cellOf('Go live', 'name'));
    fireEvent.paste(grid(), { clipboardData: { getData: () => text.replace(/\r\n/g, '\n') } });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'add_task', temp_id: expect.any(String), before_id: 'c', name: 'Pack', duration: '1d' }]);
  });

  it('⌘/Ctrl+C and V aim the browser’s own copy and paste at a hidden field, then focus comes back', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'name'));
    const clip = document.querySelector('.pln-clip') as HTMLTextAreaElement;
    fireEvent.keyDown(grid(), { key: 'c', ctrlKey: true });
    // the browser copies what the field holds selected: the rows' TSV
    expect(document.activeElement).toBe(clip);
    expect(clip.value.slice(clip.selectionStart, clip.selectionEnd)).toBe(clip.value);
    expect(parseClipboard(clip.value)[0][3]).toBe('Pack');
    const setData = vi.fn();
    fireEvent.copy(clip, { clipboardData: { setData } });
    // Excel's CRLF rows (a textarea's own value reads them as LF)
    expect(setData).toHaveBeenCalledWith('text/plain', clip.value.replace(/\n/g, '\r\n'));
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(document.activeElement).toBe(grid());
    expect(clip.value).toBe('');

    // paste: into the field, whose paste event brings the text; nothing typed lands there
    fireEvent.keyDown(grid(), { key: 'v', ctrlKey: true });
    expect(document.activeElement).toBe(clip);
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    const pasted = fireEvent.paste(clip, { clipboardData: { getData: () => 'Pack crates\r\n' } });
    expect(pasted).toBe(false);                                  // handled: the field stays empty
    expect(document.activeElement).toBe(grid());
    await waitFor(() => expect(sent()).toEqual([{ op: 'update_task', id: 'b', fields: { name: 'Pack crates' } }]));
    expect(clipboard.readText).not.toHaveBeenCalled();           // the event came: no fallback
  });

  it('a paste that adds rows and fills their Predecessors sends two batches; one Undo takes both back', async () => {
    const user = await ready();
    await user.click(blankCell('name'));
    // from Task Name: Duration, Start, Finish, Predecessors (Excel's TSV)
    const text = 'Crate\t2d\t\t\t3\r\n"Load\nthe truck"\t1d\t\t\t4\r\n';
    api.postOps.mockImplementationOnce(async (_plan: string, _v: number, ops: Op[]) => makeOpsResult({
      version: 6,
      temp_ids: Object.fromEntries(ops.map((op, i) => [(op as AddTaskOp).temp_id!, `n${i + 1}`])),
      tasks: ops.map((op, i) => makeTask(`n${i + 1}`, {
        display_id: 4 + i, wbs: String(4 + i), position: 3 + i, name: (op as AddTaskOp).name,
      })),
      order: ['a', 'b', 'c', 'n1', 'n2'],
      inverse: [makeRestore('one')],
    }));
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7, inverse: [makeRestore('two')] }));
    fireEvent.paste(grid(), { clipboardData: { getData: () => text } });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sent(0)).toEqual([
      { op: 'add_task', temp_id: expect.any(String), parent_id: null, name: 'Crate', duration: '2d' },
      { op: 'add_task', temp_id: expect.any(String), parent_id: null, name: 'Load the truck', duration: '1d' },
    ]);
    // the second batch names the new rows by the ids the first answered, at its version
    expect(api.postOps.mock.calls[1][1]).toBe(6);
    expect(sent(1)).toEqual([
      { op: 'update_task', id: 'n1', fields: { predecessors: '3' } },
      { op: 'update_task', id: 'n2', fields: { predecessors: '4' } },
    ]);
    await waitFor(() => expect(tipOf(tool('Undo'))).toBe('Take back your last change: Paste. (Ctrl+Z)'));

    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 8, inverse: [makeRestore('redo-two')] }));
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 9, inverse: [makeRestore('redo-one')] }));
    await user.click(tool('Undo'));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(4));
    // last batch first, both in the one step
    expect(sent(2)).toEqual([makeRestore('two')]);
    expect(sent(3)).toEqual([makeRestore('one')]);
    await waitFor(() => expect(tool('Undo').getAttribute('aria-disabled')).toBe('true'));
    expect(tipOf(tool('Redo'))).toBe('Put back the change you just undid: Paste. (Ctrl+Y / Ctrl+Shift+Z)');
  });

  it('when the second batch is refused, the rows stay in with one Undo step, and the toast says so', async () => {
    const user = await ready();
    await user.click(blankCell('name'));
    api.postOps.mockImplementationOnce(async (_plan: string, _v: number, ops: Op[]) => makeOpsResult({
      temp_ids: { [(ops[0] as AddTaskOp).temp_id!]: 'n1' },
      tasks: [makeTask('n1', { display_id: 4, wbs: '4', position: 3, name: 'Crate' })],
      order: ['a', 'b', 'c', 'n1'],
    }));
    api.postOps.mockRejectedValueOnce(new ApiError(422, 'link_cycle', { code: 'link_cycle', display_ids: [3, 4] }));
    fireEvent.paste(grid(), { clipboardData: { getData: () => 'Crate\t2d\t\t\t3\r\n' } });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Rows were added, but some values couldn’t be set: '
      + 'Tasks 3 and 4 would depend on each other. Undo removes the whole paste.'));
    expect(tipOf(tool('Undo'))).toBe('Take back your last change: Paste. (Ctrl+Z)');
    // one Undo takes the rows back out
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7, deleted_tasks: ['n1'], order: ['a', 'b', 'c'] }));
    await user.click(tool('Undo'));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(3));
    expect(sent(2)).toEqual([makeRestore('inv')]);
    await waitFor(() => expect(tool('Undo').getAttribute('aria-disabled')).toBe('true'));
  });

  /** A paste of one new row with Predecessors: rows, then their links. */
  function pasteRowWithLink() {
    api.postOps.mockImplementationOnce(async (_plan: string, _v: number, ops: Op[]) => makeOpsResult({
      version: 6, inverse: [makeRestore('one')],
      temp_ids: { [(ops[0] as AddTaskOp).temp_id!]: 'n1' },
      tasks: [makeTask('n1', { display_id: 4, wbs: '4', position: 3, name: 'Crate' })],
      order: ['a', 'b', 'c', 'n1'],
    }));
    fireEvent.paste(grid(), { clipboardData: { getData: () => 'Crate\t2d\t\t\t3\r\n' } });
  }

  it('a second batch someone else’s change stopped: one message, saying the plan was reloaded', async () => {
    const user = await ready();
    await user.click(blankCell('name'));
    pasteRowWithLink();
    api.postOps.mockRejectedValueOnce(new ApiError(409, 'plan_changed', { code: 'plan_changed', version: 9 }));
    api.getPlan.mockResolvedValueOnce(plan3({ version: 9 }));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    expect(toast).toHaveBeenCalledWith('Rows were added, but some values couldn’t be set: '
      + 'someone else changed the plan, so it was reloaded.');
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('a second batch whose reload failed: one message, not claiming a reload', async () => {
    const user = await ready();
    await user.click(blankCell('name'));
    pasteRowWithLink();
    api.postOps.mockRejectedValueOnce(new ApiError(409, 'plan_changed', { code: 'plan_changed', version: 9 }));
    api.getPlan.mockRejectedValueOnce(new ApiError(503, 'unavailable', { code: 'unavailable' }, 'Service unavailable'));
    await waitFor(() => expect(toast).toHaveBeenCalledTimes(1));
    const [message] = toast.mock.calls[0];
    expect(message).toMatch(/^Rows were added, but some values couldn’t be set: someone else changed the plan, and reloading it failed/);
    expect(message).not.toContain('so it was reloaded');
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    expect(toast).toHaveBeenCalledTimes(1);
  });

  it('should the check ever stop a two-batch command’s first batch, Complete resends both batches', async () => {
    const user = await ready();
    await user.click(blankCell('name'));
    api.postOps.mockRejectedValueOnce(new ApiError(409, 'completion_confirm', {
      code: 'completion_confirm', will_complete: [],
      open_predecessors: [{ task_id: 'a', display_id: 1, name: 'Survey', reason: 'predecessor' }],
    }));
    fireEvent.paste(grid(), { clipboardData: { getData: () => 'Crate\t2d\t\t\t3\r\n' } });
    await check();
    expect(api.postOps).toHaveBeenCalledTimes(1);
    pasteRowWithLinkAnswer();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7, inverse: [makeRestore('two')] }));
    await complete();
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(3));
    expect(sent(1)).toEqual(sent(0));
    // the second batch went too, by the new id, into the paste's one step
    expect(sent(2)).toEqual([{ op: 'update_task', id: 'n1', fields: { predecessors: '3' } }]);
    await waitFor(() => expect(tipOf(tool('Undo'))).toBe('Take back your last change: Paste. (Ctrl+Z)'));
  });

  function pasteRowWithLinkAnswer() {
    api.postOps.mockImplementationOnce(async (_plan: string, _v: number, ops: Op[]) => makeOpsResult({
      version: 6, inverse: [makeRestore('one')],
      temp_ids: { [(ops[0] as AddTaskOp).temp_id!]: 'n1' },
      tasks: [makeTask('n1', { display_id: 4, wbs: '4', position: 3, name: 'Crate' })],
      order: ['a', 'b', 'c', 'n1'],
    }));
  }

  it('% over existing rows and new rows: the check stops the last batch; Complete finishes the one paste', async () => {
    const user = await ready();
    await user.click(cellOf('Go live', 'percent'));
    api.postOps.mockImplementationOnce(async (_plan: string, _v: number, ops: Op[]) => makeOpsResult({
      version: 6, inverse: [makeRestore('one')],
      temp_ids: { [(ops[0] as AddTaskOp).temp_id!]: 'n1' },
      tasks: [makeTask('n1', { display_id: 4, wbs: '4', position: 3, name: '' })],
      order: ['a', 'b', 'c', 'n1'],
    }));
    api.postOps.mockRejectedValueOnce(new ApiError(409, 'completion_confirm', {
      code: 'completion_confirm', will_complete: [],
      open_predecessors: [{ task_id: 'a', display_id: 1, name: 'Survey', reason: 'predecessor' }],
    }));
    fireEvent.paste(grid(), { clipboardData: { getData: () => '100%\r\n50%\r\n' } });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sent(0)).toEqual([{ op: 'add_task', temp_id: expect.any(String), parent_id: null }]);
    // the second batch, built from the ids the first answered, holds every %
    expect(sent(1)).toEqual([
      { op: 'set_percent', ids: ['c'], percent: 100 },
      { op: 'set_percent', ids: ['n1'], percent: 50 },
    ]);
    // the dialog says the rows went in and the rest waits
    expect(within(await check()).getByText('Rows were added. The rest waits on this check.')).toBeTruthy();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7, inverse: [makeRestore('two')] }));
    await complete();
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(3));
    expect(api.postOps.mock.calls[2][1]).toBe(6);
    expect(sent(2)).toEqual([
      { op: 'set_percent', ids: ['c'], percent: 100, confirm: true },
      { op: 'set_percent', ids: ['n1'], percent: 50, confirm: true },
    ]);
    // one step: Undo posts the resend's inverse, then the rows'
    await waitFor(() => expect(tipOf(tool('Undo'))).toBe('Take back your last change: Paste. (Ctrl+Z)'));
    api.postOps
      .mockResolvedValueOnce(makeOpsResult({ version: 8 }))
      .mockResolvedValueOnce(makeOpsResult({ version: 9 }));
    await user.click(tool('Undo'));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(5));
    expect(sent(3)).toEqual([makeRestore('two')]);
    expect(sent(4)).toEqual([makeRestore('one')]);
    await waitFor(() => expect(tool('Undo').getAttribute('aria-disabled')).toBe('true'));
  });

  it('a paste’s last batch the rules block: the check says the rows went in, with Go to task', async () => {
    const user = await ready();
    await user.click(cellOf('Go live', 'percent'));
    api.postOps.mockImplementationOnce(async (_plan: string, _v: number, ops: Op[]) => makeOpsResult({
      version: 6, inverse: [makeRestore('one')],
      temp_ids: { [(ops[0] as AddTaskOp).temp_id!]: 'n1' },
      tasks: [makeTask('n1', { display_id: 4, wbs: '4', position: 3, name: '' })],
      order: ['a', 'b', 'c', 'n1'],
    }));
    api.postOps.mockRejectedValueOnce(new ApiError(409, 'completion_blocked', {
      code: 'completion_blocked', blockers: [{ task_id: 'a', display_id: 1, name: 'Survey', reason: 'predecessor' }],
    }));
    fireEvent.paste(grid(), { clipboardData: { getData: () => '100%\r\n50%\r\n' } });
    const blocked = await screen.findByRole('dialog', { name: 'Can’t complete yet' });
    expect(within(blocked).getByText('Rows were added. The rest waits until these tasks are complete.')).toBeTruthy();
    expect(within(blocked).getByRole('button', { name: 'Go to task 1' })).toBeTruthy();
    expect(toast).not.toHaveBeenCalled();
  });

  it('a one-batch paste the check stops (100% on a row) resends that batch with confirm, as one step', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'percent'));
    api.postOps.mockRejectedValueOnce(new ApiError(409, 'completion_confirm', {
      code: 'completion_confirm', will_complete: [],
      open_predecessors: [{ task_id: 'a', display_id: 1, name: 'Survey', reason: 'predecessor' }],
    }));
    fireEvent.paste(grid(), { clipboardData: { getData: () => '100\r\n' } });
    await check();
    api.postOps.mockResolvedValueOnce(makeOpsResult({ inverse: [makeRestore('done')] }));
    await complete();
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sent(1)).toEqual([{ op: 'set_percent', ids: ['b'], percent: 100, confirm: true }]);
    await waitFor(() => expect(tipOf(tool('Undo'))).toBe('Take back your last change: Paste. (Ctrl+Z)'));
  });

  it('cells it can’t fill (read-only or past the visible columns) are counted in one toast', async () => {
    const user = await ready();
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    await user.click(cellOf('Pack', 'id'));
    fireEvent.paste(grid(), { clipboardData: { getData: () => '9\tManually Scheduled\tPack crates\r\n' } });
    await waitFor(() => expect(sent()).toEqual([
      { op: 'update_task', id: 'b', fields: { mode: 'manual' } },
      { op: 'update_task', id: 'b', fields: { name: 'Pack crates' } },
    ]));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('1 cell was skipped (read-only or hidden columns).'));
  });

  it('a paste the sheet refuses says where, and sends nothing', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'duration'));
    fireEvent.paste(grid(), { clipboardData: { getData: () => 'soon\r\n' } });
    expect(toast).toHaveBeenCalledWith('Row 1, Duration: "soon" isn’t a duration. Try 5d, 4h or 3ed.');
    expect(api.postOps).not.toHaveBeenCalled();
  });

  it('one copied cell (not ID or Task Name) is that cell’s text: pasted on another row’s Duration it sets it', async () => {
    const tasks = tasks3().map((t) => (t.id === 'b' ? { ...t, duration_minutes: 1440, duration_text: '3 days' } : t));
    const user = await ready(plan3({ tasks }));
    // a task copy first (Task Name), then one Duration cell: the cell replaces it
    await user.click(cellOf('Pack', 'name'));
    fireEvent.keyDown(grid(), { key: 'c', ctrlKey: true });
    await user.click(cellOf('Pack', 'duration'));
    fireEvent.keyDown(grid(), { key: 'c', ctrlKey: true });
    const text = clipboard.writeText.mock.calls.at(-1)![0] as string;
    expect(text).toBe('3 days\r\n');
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    await user.click(cellOf('Go live', 'duration'));
    fireEvent.paste(grid(), { clipboardData: { getData: () => text } });
    await waitFor(() => expect(sent()).toEqual([{ op: 'update_task', id: 'c', fields: { duration: '3 days' } }]));
  });

  it('rows picked by their numbers copy as tasks: pasting re-creates them', async () => {
    await ready();
    fireEvent.mouseDown(cellOf('Survey', 'id'));
    fireEvent.mouseDown(cellOf('Pack', 'id'), { shiftKey: true });
    fireEvent.keyDown(grid(), { key: 'c', ctrlKey: true });
    const text = clipboard.writeText.mock.calls.at(-1)![0] as string;
    expect(parseClipboard(text).map((r) => r[3])).toEqual(['Survey', 'Pack']);
    api.postOps.mockImplementationOnce(async (_plan: string, _v: number, ops: Op[]) => makeOpsResult({
      temp_ids: Object.fromEntries(ops.map((op, i) => [(op as AddTaskOp).temp_id!, `n${i + 1}`])),
    }));
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7 }));
    fireEvent.mouseDown(cellOf('Go live', 'duration'));
    fireEvent.paste(grid(), { clipboardData: { getData: () => text } });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sent().map((op) => [op.op, (op as AddTaskOp).name])).toEqual([['add_task', 'Survey'], ['add_task', 'Pack']]);
    // the link between them comes back, by the new ids
    expect(sent(1)).toEqual([{ op: 'add_link', predecessor_id: 'n1', successor_id: 'n2', link_type: 'FS' }]);
  });

  it('Cut marks the rows and copies: nothing is deleted and nothing asks; Edit › Cut marks too', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'id'));
    fireEvent.keyDown(grid(), { key: 'x', ctrlKey: true });
    const clip = document.querySelector('.pln-clip') as HTMLTextAreaElement;
    expect(document.activeElement).toBe(clip);
    const setData = vi.fn();
    fireEvent.cut(clip, { clipboardData: { setData } });            // the browser's own cut, after the key
    expect(setData).toHaveBeenCalledWith('text/plain', expect.stringContaining('\tPack\t'));
    await waitFor(() => expect(rowOf('Pack').classList.contains('pln-cut')).toBe(true));
    expect(screen.queryByRole('dialog')).toBeNull();
    // the 20 ms negative wait: a delete would post on the write queue's next turn
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.postOps).not.toHaveBeenCalled();

    // Edit › Cut: no key, just the event on the sheet; it marks its rows instead
    await user.click(cellOf('Go live', 'id'));
    const menuData = vi.fn();
    const cut = fireEvent.cut(grid(), { clipboardData: { setData: menuData } });
    expect(cut).toBe(false);
    expect(menuData).toHaveBeenCalledWith('text/plain', expect.stringContaining('\tGo live\t'));
    await waitFor(() => expect(rowOf('Go live').classList.contains('pln-cut')).toBe(true));
    expect(rowOf('Pack').classList.contains('pln-cut')).toBe(false);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.postOps).not.toHaveBeenCalled();
  });

  /** Cuts a row by its ID (⌘X), as the browser's own cut follows the key. */
  async function cutRow(user: Awaited<ReturnType<typeof ready>>, name: string): Promise<string> {
    await user.click(cellOf(name, 'id'));
    fireEvent.keyDown(grid(), { key: 'x', ctrlKey: true });
    const text = clipboard.writeText.mock.calls.at(-1)![0] as string;
    await waitFor(() => expect(document.activeElement).toBe(grid()));
    return text;
  }

  it('a cut pasted in the same plan moves the task: one move_tasks, its outside link and 50% kept, one Undo', async () => {
    // Pack: 50% done, a successor of Survey (a link from outside the cut)
    const tasks = tasks3().map((t) => (t.id === 'b' ? { ...t, percent_complete: 50, status: 'in_progress' as const } : t));
    const user = await ready(plan3({ tasks }));
    const text = await cutRow(user, 'Pack');
    await user.click(cellOf('Survey', 'name'));
    api.postOps.mockResolvedValueOnce(makeOpsResult({ order: ['b', 'a', 'c'], inverse: [makeRestore('moved')] }));
    fireEvent.paste(grid(), { clipboardData: { getData: () => text.replace(/\r\n/g, '\n') } });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    // the task itself moves: its id, link and progress go with it (no copy, no delete)
    expect(sent()).toEqual([{ op: 'move_tasks', ids: ['b'], before_id: 'a' }]);
    expect(sent().some((op) => op.op === 'add_task' || op.op === 'delete_tasks')).toBe(false);
    await waitFor(() => expect(cellOf('Pack', 'id').textContent).toBe('1'));
    expect(cellOf('Pack', 'percent').textContent).toBe('50%');
    expect(cellOf('Pack', 'predecessors').textContent).toBe('2');
    expect(rowOf('Pack').classList.contains('pln-cut')).toBe(false);
    expect(cellOf('Pack', 'name').getAttribute('aria-selected')).toBe('true');
    // one step, Paste
    expect(tipOf(tool('Undo'))).toBe('Take back your last change: Paste. (Ctrl+Z)');
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 7, order: ['a', 'b', 'c'] }));
    await user.click(tool('Undo'));
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(2));
    expect(sent(1)).toEqual([makeRestore('moved')]);
    // spent: the same text pasted again is copies
    api.postOps.mockResolvedValueOnce(makeOpsResult({ version: 8 }));
    await user.click(cellOf('Go live', 'name'));
    fireEvent.paste(grid(), { clipboardData: { getData: () => text } });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(3));
    expect(sent(2)[0]).toMatchObject({ op: 'add_task', name: 'Pack', before_id: 'c' });
  });

  it('Escape takes the cut marks away; a paste then adds copies', async () => {
    const user = await ready();
    const text = await cutRow(user, 'Pack');
    expect(rowOf('Pack').classList.contains('pln-cut')).toBe(true);
    fireEvent.keyDown(grid(), { key: 'Escape' });
    await waitFor(() => expect(rowOf('Pack').classList.contains('pln-cut')).toBe(false));
    api.postOps.mockResolvedValueOnce(makeOpsResult());
    await user.click(cellOf('Survey', 'name'));
    fireEvent.paste(grid(), { clipboardData: { getData: () => text } });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'add_task', temp_id: expect.any(String), before_id: 'a', name: 'Pack', duration: '1d' }]);
  });

  it('a new Copy, or a delete of the cut task, ends the cut', async () => {
    const user = await ready();
    await cutRow(user, 'Pack');
    await user.click(cellOf('Go live', 'name'));
    fireEvent.keyDown(grid(), { key: 'c', ctrlKey: true });
    await waitFor(() => expect(rowOf('Pack').classList.contains('pln-cut')).toBe(false));

    await cutRow(user, 'Go live');
    expect(rowOf('Go live').classList.contains('pln-cut')).toBe(true);
    api.postOps.mockResolvedValueOnce(makeOpsResult({ deleted_tasks: ['c'], order: ['a', 'b'] }));
    fireEvent.keyDown(grid(), { key: 'Delete' });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(sent()).toEqual([{ op: 'delete_tasks', ids: ['c'] }]);
    await waitFor(() => expect(document.querySelector('.pln-cut')).toBeNull());
  });

  it('a cut pasted into its own subtasks says so and sends nothing', async () => {
    const tasks = [
      makeTask('s', { display_id: 1, is_summary: true, name: 'Prep' }),
      makeTask('k', { display_id: 2, wbs: '1.1', outline_level: 2, parent_id: 's', name: 'Crates' }),
      makeTask('z', { display_id: 3, wbs: '2', position: 1, name: 'Go live' }),
    ];
    const user = await ready(makePlan({ tasks }));
    const text = await cutRow(user, 'Prep');
    expect(rowOf('Crates').classList.contains('pln-cut')).toBe(true);
    await user.click(cellOf('Crates', 'name'));
    fireEvent.paste(grid(), { clipboardData: { getData: () => text } });
    expect(toast).toHaveBeenCalledWith('Can’t move tasks into themselves.');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(api.postOps).not.toHaveBeenCalled();
  });

  it('a cut pasted into another plan pastes copies and leaves the originals, and says so', async () => {
    const user = await ready();
    const text = await cutRow(user, 'Pack');
    cleanup();
    // another initiative's plan, in the same page
    const other = makePlan({ id: 'plan-2', tasks: flatTasks(['x', 'y']).map((t, i) => ({ ...t, name: `Other ${i + 1}` })) });
    const again = await ready(other);
    await again.click(cellOf('Other 2', 'name'));
    api.postOps.mockImplementationOnce(async (_plan: string, _v: number, ops: Op[]) => makeOpsResult({
      temp_ids: { [(ops[0] as AddTaskOp).temp_id!]: 'n1' },
    }));
    fireEvent.paste(grid(), { clipboardData: { getData: () => text } });
    await waitFor(() => expect(api.postOps).toHaveBeenCalledTimes(1));
    expect(api.postOps.mock.calls[0][0]).toBe('plan-2');
    expect(sent()).toEqual([{ op: 'add_task', temp_id: expect.any(String), before_id: 'y', name: 'Pack', duration: '1d' }]);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Pasted copies — cut tasks only move within one plan.'));
  });

  /** Selects the lock banner's text. A drag across it also takes focus
   *  off the sheet (`blur`: the banner itself takes none). */
  function selectBanner(blur: boolean): HTMLElement {
    const banner = document.querySelector('.pln-lock-text') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(banner);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
    if (blur) (document.activeElement as HTMLElement | null)?.blur();
    return banner;
  }

  it('text the person selected (the lock banner) copies as text: the sheet leaves it to the browser', async () => {
    const user = await ready(plan3({ locked_at: '2026-10-27T12:00:00Z', locked_by_name: 'Dana Reyes' }));
    await user.click(cellOf('Pack', 'name'));
    const banner = selectBanner(true);
    expect(document.activeElement).toBe(document.body);
    // the copy event, on the selection or on the sheet, is the browser's
    const setData = vi.fn();
    expect(fireEvent.copy(banner, { clipboardData: { setData } })).toBe(true);
    expect(fireEvent.copy(grid(), { clipboardData: { setData } })).toBe(true);
    expect(setData).not.toHaveBeenCalled();
    expect(clipboard.writeText).not.toHaveBeenCalled();
    window.getSelection()!.removeAllRanges();
  });

  it('a selection left in the banner doesn’t block ⌘C on a row once the sheet has focus again', async () => {
    const user = await ready(plan3({ locked_at: '2026-10-27T12:00:00Z', locked_by_name: 'Dana Reyes' }));
    // the person was on a row, with the banner's text still selected from before
    await user.click(cellOf('Pack', 'name'));
    selectBanner(false);
    expect(document.activeElement).toBe(grid());
    expect(window.getSelection()!.toString()).not.toBe('');
    fireEvent.keyDown(grid(), { key: 'c', ctrlKey: true });
    expect(clipboard.writeText).toHaveBeenCalledTimes(1);
    expect(parseClipboard(clipboard.writeText.mock.calls[0][0] as string)[0][3]).toBe('Pack');
    // and the browser's copy event, at the hidden field, carries the row
    const setData = vi.fn();
    fireEvent.copy(document.activeElement!, { clipboardData: { setData } });
    expect(setData).toHaveBeenCalledWith('text/plain', expect.stringContaining('\tPack\t'));
    window.getSelection()!.removeAllRanges();
  });

  it('the clipboard field is out of the way at rest, and a labeled field (never aria-hidden) while it has focus', async () => {
    const user = await ready();
    const clip = document.querySelector('.pln-clip') as HTMLTextAreaElement;
    expect(clip.hidden).toBe(true);                         // no blank field for a screen reader to find
    expect(screen.queryByRole('textbox', { name: 'Clipboard' })).toBeNull();
    expect(clip.getAttribute('aria-hidden')).toBeNull();
    expect(clip.tabIndex).toBe(-1);
    await user.click(cellOf('Pack', 'name'));
    fireEvent.keyDown(grid(), { key: 'c', ctrlKey: true });
    expect(document.activeElement).toBe(clip);
    expect(clip.hidden).toBe(false);
    expect(screen.getByRole('textbox', { name: 'Clipboard' })).toBe(clip);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(document.activeElement).toBe(grid());
    expect(clip.hidden).toBe(true);
  });

  it('a paste into the cell editor is the editor’s own', async () => {
    const user = await ready();
    await user.click(cellOf('Pack', 'name'));
    await user.keyboard('{F2}');
    const input = screen.getByRole('textbox', { name: 'Task Name' });
    const e = fireEvent.paste(input, { clipboardData: { getData: () => 'Crate\t2d' } });
    expect(e).toBe(true);                    // not prevented: the field takes it
    expect(api.postOps).not.toHaveBeenCalled();
  });
});
