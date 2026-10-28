// @vitest-environment jsdom
/**
 * components/plans/TaskInfoModal.tsx: MS Project's Task Information. Five
 * tabs (General, Predecessors, Resources, Advanced, Notes); OK sends one
 * batch with every change (update_task, link ops, set_assignees,
 * set_percent), nothing when nothing changed; a summary's derived fields
 * are read-only; a locked plan edits only progress (% Complete, Notes); a
 * completion stop goes through the completion check and, cancelled, leaves
 * the dialog open with the edits.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Op, Plan, PlanTask } from '../../lib/plans/api';
import type { ApplyResult } from '../../lib/plans/applyResult';
import { planView } from '../../lib/plans/merge';
import { flatTasks, makeLink, makePlan, makeTask } from '../../lib/plans/planFixtures';
import TaskInfoModal from './TaskInfoModal';
import { CompletionHost } from './useCompletion';
import type { PlanController } from './usePlan';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

afterEach(cleanup);
beforeEach(() => toast.mockReset());

const OK: ApplyResult = { ok: true, notices: [], tempIds: {} };

/** Survey, Pack, Go live; Pack follows Survey. */
function plan3(over: Partial<Plan> = {}): Plan {
  const [a, b, c] = flatTasks(['a', 'b', 'c']);
  return makePlan({
    tasks: [{ ...a, name: 'Survey' }, { ...b, name: 'Pack', predecessors: '1' }, { ...c, name: 'Go live' }],
    links: [makeLink('l1', 'a', 'b')],
    resources: [
      { kind: 'person', id: 'p1', name: 'Dana Reyes', group: 'team', has_email: true, has_account: true, is_staff: true },
      { kind: 'person', id: 'p2', name: 'Lee Park', group: 'team', has_email: false, has_account: false, is_staff: false },
    ],
    ...over,
  });
}

function stand(...answers: ApplyResult[]) {
  const release = vi.fn();
  return {
    apply: vi.fn(async (..._args: unknown[]) => answers.shift() ?? OK),
    beginEditing: vi.fn(() => release),
    undo: vi.fn(),
    release,
  };
}

function open(plan: Plan, taskId: string, s = stand(), tab?: 'notes') {
  const view = planView(plan);
  const ctl = { status: 'ready', plan: view.plan, outline: view.outline, ...s } as unknown as PlanController;
  const onClose = vi.fn();
  render(
    <CompletionHost ctl={ctl}>
      <TaskInfoModal ctl={ctl} taskId={taskId} tab={tab} onClose={onClose} />
    </CompletionHost>,
  );
  return { s, onClose, user: userEvent.setup() };
}

const dialog = () => screen.getByRole('dialog', { name: 'Task Information' });
const tabButton = (name: string) => within(dialog()).getByRole('button', { name });
const sentOps = (s: ReturnType<typeof stand>, call = 0) => s.apply.mock.calls[call]?.[0] as Op[];

describe('the dialog', () => {
  it('opens on General with the task’s values, the five tabs as a segmented control', () => {
    open(plan3(), 'b');
    expect(screen.getByText('Project plan').className).toBe('eyebrow');
    expect(dialog().classList.contains('pln-modal-wide')).toBe(true);
    const tabs = within(dialog()).getByRole('group', { name: 'Task Information tabs' });
    expect(tabs.classList.contains('segmented')).toBe(true);
    expect(within(tabs).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['General', 'Predecessors', 'Resources', 'Advanced', 'Notes']);
    expect(tabButton('General').getAttribute('aria-pressed')).toBe('true');
    expect((screen.getByLabelText('Task Name') as HTMLInputElement).value).toBe('Pack');
    expect((screen.getByLabelText('Duration') as HTMLInputElement).value).toBe('1 day');
    // focus in the visible tab's first field
    expect(document.activeElement).toBe(screen.getByLabelText('Task Name'));
  });

  it('holds editing while open', () => {
    const { s } = open(plan3(), 'b');
    expect(s.beginEditing).toHaveBeenCalledWith('task-information');
  });

  it('nothing changed: OK sends nothing and closes', async () => {
    const { s, onClose, user } = open(plan3(), 'b');
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    expect(s.apply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('editing the name and adding a predecessor sends one batch: update_task and add_link', async () => {
    const { s, onClose, user } = open(plan3(), 'c');
    const name = screen.getByLabelText('Task Name');
    await user.clear(name);
    await user.type(name, 'Go live!');
    await user.click(tabButton('Predecessors'));
    await user.click(within(dialog()).getByRole('button', { name: 'Add predecessor' }));
    const pick = within(dialog()).getAllByRole('combobox', { name: /Predecessor task/ }).at(-1)!;
    await user.click(pick);
    fireEvent.mouseDown(await screen.findByRole('button', { name: /^Pack/ }));
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(s.apply).toHaveBeenCalledTimes(1));
    expect(s.apply.mock.calls[0][1]).toBe('Task Information');
    expect(sentOps(s)).toEqual([
      { op: 'update_task', id: 'c', fields: { name: 'Go live!' } },
      { op: 'add_link', predecessor_id: 'b', successor_id: 'c', link_type: 'FS', lag: '0' },
    ]);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('Predecessors: change a link’s type and lag (update_link) and remove another (delete_link)', async () => {
    const plan = plan3({ links: [makeLink('l1', 'a', 'c'), makeLink('l2', 'b', 'c')] });
    const { s, user } = open(plan, 'c');
    await user.click(tabButton('Predecessors'));
    const lags = within(dialog()).getAllByRole('textbox', { name: /Lag/ });
    expect(lags).toHaveLength(2);
    await user.clear(lags[0]);
    await user.type(lags[0], '+2d');
    await user.click(within(dialog()).getByRole('button', { name: 'Remove predecessor 2' }));
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(s.apply).toHaveBeenCalledTimes(1));
    expect(sentOps(s)).toEqual([
      { op: 'delete_link', id: 'l2' },
      { op: 'update_link', id: 'l1', lag: '+2d' },
    ]);
  });

  it('a bad lag is refused here, on its tab, and nothing is sent', async () => {
    const { s, user } = open(plan3(), 'b');
    await user.click(tabButton('Predecessors'));
    const lag = within(dialog()).getByRole('textbox', { name: /Lag/ });
    await user.clear(lag);
    await user.type(lag, 'soon');
    await user.click(tabButton('General'));
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    expect(s.apply).not.toHaveBeenCalled();
    // back on the tab with the error
    expect(tabButton('Predecessors').getAttribute('aria-pressed')).toBe('true');
    expect(within(dialog()).getByRole('alert').textContent).toContain('isn’t a lag');
  });

  it('Resources, % Complete and Notes go in the same batch, completing ops last', async () => {
    const { s, user } = open(plan3(), 'b');
    const percent = screen.getByLabelText('% Complete');
    await user.clear(percent);
    await user.type(percent, '50');
    await user.click(tabButton('Resources'));
    await user.click(within(dialog()).getByRole('combobox', { name: 'Resource Names' }));
    fireEvent.mouseDown(await screen.findByRole('button', { name: /^Dana Reyes/ }));
    await user.click(tabButton('Notes'));
    await user.type(screen.getByLabelText('Notes'), 'Two crates{Enter}Fragile');
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(s.apply).toHaveBeenCalledTimes(1));
    expect(sentOps(s)).toEqual([
      { op: 'update_task', id: 'b', fields: { notes: 'Two crates\nFragile' } },
      { op: 'set_assignees', task_id: 'b', resources: [{ kind: 'person', id: 'p1' }] },
      { op: 'set_percent', ids: ['b'], percent: 50 },
    ]);
  });

  it('Resources says who won’t get reminders', async () => {
    const tasks = plan3().tasks.map((t) => (t.id === 'b'
      ? { ...t, assignees: [{ kind: 'person' as const, id: 'p2', name: 'Lee Park' }] } : t));
    const { user } = open(plan3({ tasks }), 'b');
    await user.click(tabButton('Resources'));
    expect(within(dialog()).getByText(/Lee Park won’t get reminders/)).toBeTruthy();
  });

  it('Advanced: a constraint needs a date; the Elapsed switch rewrites the duration', async () => {
    const { s, user } = open(plan3(), 'b');
    await user.click(tabButton('Advanced'));
    await user.click(within(dialog()).getByRole('combobox', { name: 'Constraint type' }));
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'Must Start On' }));
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    expect(s.apply).not.toHaveBeenCalled();
    expect(within(dialog()).getByRole('alert').textContent).toBe('Enter a constraint date.');
    fireEvent.change(screen.getByLabelText('Constraint date'), { target: { value: '2026-11-05' } });
    await user.click(screen.getByRole('checkbox', { name: 'Elapsed duration' }));
    await user.click(tabButton('General'));
    expect((screen.getByLabelText('Duration') as HTMLInputElement).value).toBe('1 eday');
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(s.apply).toHaveBeenCalledTimes(1));
    expect(sentOps(s)).toEqual([{
      op: 'update_task', id: 'b',
      fields: { duration: '1 eday', constraint_type: 'mso', constraint_date: '2026-11-05' },
    }]);
  });

  it('a refusal stays in the dialog with the reason', async () => {
    const { onClose, user } = open(plan3(), 'b', stand({
      ok: false, kind: 'error', code: 'link_cycle', message: 'Tasks 1 and 2 would depend on each other.',
    }));
    await user.type(screen.getByLabelText('Task Name'), '!');
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    expect(await within(dialog()).findByRole('alert')).toBeTruthy();
    expect(within(dialog()).getByRole('alert').textContent).toBe('Tasks 1 and 2 would depend on each other.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens on Notes when asked (the toolbar’s Notes), focus in the note', () => {
    open(plan3(), 'b', stand(), 'notes');
    expect(tabButton('Notes').getAttribute('aria-pressed')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('Notes'));
  });
});

describe('a summary', () => {
  function summaryPlan() {
    const tasks: PlanTask[] = [
      makeTask('s', { display_id: 1, wbs: '1', is_summary: true, name: 'Prep', duration_text: '3 days' }),
      makeTask('a', { display_id: 2, wbs: '1.1', outline_level: 2, parent_id: 's', position: 1, name: 'Order crates' }),
    ];
    return makePlan({ tasks, links: [] });
  }

  it('shows its derived Duration, Start and Finish read-only', async () => {
    const { s, user } = open(summaryPlan(), 's');
    const duration = screen.getByLabelText('Duration') as HTMLInputElement;
    expect(duration.value).toBe('3 days');
    expect(duration.readOnly || duration.disabled).toBe(true);
    for (const label of ['Start', 'Finish']) {
      const field = screen.getByLabelText(label) as HTMLInputElement;
      expect(field.readOnly || field.disabled, label).toBe(true);
    }
    expect(within(dialog()).getByText(/come from its subtasks/)).toBeTruthy();
    // its name still edits
    await user.type(screen.getByLabelText('Task Name'), ' work');
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(sentOps(s)).toEqual([{ op: 'update_task', id: 's', fields: { name: 'Prep work' } }]));
  });

  it('offers only the constraints a summary takes', async () => {
    const { user } = open(summaryPlan(), 's');
    await user.click(tabButton('Advanced'));
    await user.click(within(dialog()).getByRole('combobox', { name: 'Constraint type' }));
    const menu = document.querySelector('.combo-menu') as HTMLElement;
    expect(within(menu).getAllByRole('button').map((b) => b.textContent))
      .toEqual(['As Soon As Possible', 'Start No Earlier Than']);
  });
});

describe('a locked plan', () => {
  it('only % Complete and Notes can change; the rest shows, off', async () => {
    const { s, user } = open(plan3({ locked_at: '2026-10-27T12:00:00Z' }), 'b');
    expect((screen.getByLabelText('Task Name') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('Duration') as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText('% Complete') as HTMLInputElement).disabled).toBe(false);
    expect(within(dialog()).getByText(/Schedule is locked/)).toBeTruthy();
    await user.click(tabButton('Predecessors'));
    expect(within(dialog()).getByRole('button', { name: 'Add predecessor' }).hasAttribute('disabled')).toBe(true);
    await user.click(tabButton('Notes'));
    await user.type(screen.getByLabelText('Notes'), 'Truck late');
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(sentOps(s)).toEqual([{ op: 'update_task', id: 'b', fields: { notes: 'Truck late' } }]));
  });

  it('someone who may only read sees the task with Close only', () => {
    open(plan3({ permissions: { view: true, add: false, change: false, delete: false } }), 'b');
    expect((screen.getByLabelText('Task Name') as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog()).queryByRole('button', { name: 'OK' })).toBeNull();
    expect(within(dialog().querySelector('.modal-foot') as HTMLElement).getByRole('button', { name: 'Close' })).toBeTruthy();
  });
});

describe('the task’s color', () => {
  it('General has a Color field: its picker sets the color, sent with the batch', async () => {
    const { s, onClose, user } = open(plan3(), 'b');
    const field = screen.getByLabelText('Color');
    expect(field.textContent).toBe('No color');
    await user.click(field);
    const picker = screen.getByRole('dialog', { name: 'Task color' });
    await user.click(within(picker).getByRole('button', { name: 'Violet' }));
    expect(screen.queryByRole('dialog', { name: 'Task color' })).toBeNull();
    expect(field.textContent).toBe('Violet');
    expect(onClose).not.toHaveBeenCalled();
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(sentOps(s)).toEqual([{ op: 'update_task', id: 'b', fields: { color: '#6d4fc4' } }]));
  });

  it('a locked plan still changes it; Escape in the picker leaves Task Information open', async () => {
    const plan = plan3({ locked_at: '2026-10-27T12:00:00Z' });
    plan.tasks[1] = { ...plan.tasks[1], color: '#e91e63' };
    const { s, onClose, user } = open(plan, 'b');
    const field = screen.getByLabelText('Color') as HTMLButtonElement;
    expect(field.textContent).toBe('#e91e63');
    expect(field.disabled).toBe(false);
    expect(within(dialog()).getByText(/only % Complete, Notes and Color can change/)).toBeTruthy();
    await user.click(field);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Task color' })).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(field);
    await user.click(within(screen.getByRole('dialog', { name: 'Task color' })).getByRole('button', { name: 'No color' }));
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    await waitFor(() => expect(sentOps(s)).toEqual([{ op: 'update_task', id: 'b', fields: { color: null } }]));
  });

  it('someone who may only read sees the color, off', () => {
    const plan = plan3({ permissions: { view: true, add: false, change: false, delete: false } });
    plan.tasks[1] = { ...plan.tasks[1], color: '#178a4c' };
    open(plan, 'b');
    const field = screen.getByLabelText('Color') as HTMLButtonElement;
    expect(field.textContent).toBe('Green');
    expect(field.disabled).toBe(true);
  });
});

describe('the completion check', () => {
  const confirm: ApplyResult = {
    ok: false, kind: 'confirm', willComplete: [],
    openPredecessors: [{ task_id: 'a', display_id: 1, name: 'Survey', reason: 'predecessor' }],
  };

  it('100% stops on the check; Cancel goes back to the dialog with the edits; Complete resends with confirm', async () => {
    const { s, onClose, user } = open(plan3(), 'b', stand(confirm, confirm, OK));
    const percent = screen.getByLabelText('% Complete');
    await user.clear(percent);
    await user.type(percent, '100');
    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    const check = await screen.findByRole('dialog', { name: 'Confirm completion' });
    await user.click(within(check).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Confirm completion' })).toBeNull());
    expect(onClose).not.toHaveBeenCalled();
    expect((screen.getByLabelText('% Complete') as HTMLInputElement).value).toBe('100');

    await user.click(within(dialog()).getByRole('button', { name: 'OK' }));
    await user.click(within(await screen.findByRole('dialog', { name: 'Confirm completion' })).getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(s.apply.mock.calls[2]).toEqual([[{ op: 'set_percent', ids: ['b'], percent: 100 }], 'Task Information',
      { confirm: true }]);
  });
});
