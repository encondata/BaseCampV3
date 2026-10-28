// @vitest-environment jsdom
/**
 * components/plans/CompletionDialog.tsx and useCompletion: the completion
 * check every 100% path goes through (Ruling B2). Confirm lists what
 * completes along and the open predecessors, Complete resends with
 * confirm; blocked lists what is in the way, each with Go to task; the
 * dialog waits for an answer (no timeout) and holds editing while open.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CompletionBlocker, Op } from '../../lib/plans/api';
import type { ApplyResult } from '../../lib/plans/applyResult';
import CompletionDialog from './CompletionDialog';
import type { PlanController } from './usePlan';
import { useCompletion, type Completion, type CompletionStop } from './useCompletion';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

afterEach(cleanup);
beforeEach(() => toast.mockReset());

const task = (id: string, n: number, name: string, reason: CompletionBlocker['reason']): CompletionBlocker =>
  ({ task_id: id, display_id: n, name, reason });

const CONFIRM: CompletionStop = {
  ok: false, kind: 'confirm',
  willComplete: [task('d', 4, 'Load truck', 'subtask'), task('c', 3, 'Pack crates', 'subtask')],
  openPredecessors: [task('a', 1, 'Survey', 'predecessor')],
};
const BLOCKED: CompletionStop = {
  ok: false, kind: 'blocked',
  blockers: [task('a', 1, 'Survey', 'predecessor'), task('c', 3, 'Pack crates', 'subtask')],
};

describe('CompletionDialog', () => {
  it('confirm: lists the two subtasks and the open predecessor; Complete calls onConfirm', async () => {
    const user = userEvent.setup();
    const onConfirm = vi.fn();
    const onClose = vi.fn();
    render(<CompletionDialog result={CONFIRM} onConfirm={onConfirm} onGoTo={vi.fn()} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Confirm completion' });
    expect(within(dialog).getByText('Project plan').className).toBe('eyebrow');
    const along = within(dialog).getByRole('region', { name: 'Completing this will also complete 2 subtasks' });
    // by ID
    expect(within(along).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['3Pack crates', '4Load truck']);
    const before = within(dialog).getByRole('region', { name: 'This predecessor isn’t complete yet' });
    expect(within(before).getByText('Survey')).toBeTruthy();
    expect(within(dialog).queryByRole('button', { name: /Go to task/ })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Complete' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('blocked: "These need to be complete first", Go to task on each, and one Close', async () => {
    const user = userEvent.setup();
    const onGoTo = vi.fn();
    const onClose = vi.fn();
    render(<CompletionDialog result={BLOCKED} onConfirm={vi.fn()} onGoTo={onGoTo} onClose={onClose} />);
    const dialog = screen.getByRole('dialog', { name: 'Can’t complete yet' });
    const list = within(dialog).getByRole('region', { name: 'These need to be complete first' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // two rules name them, so each says which
    expect(items[0].textContent).toContain('Predecessor');
    expect(items[1].textContent).toContain('Subtask');
    expect(within(dialog).queryByRole('button', { name: 'Complete' })).toBeNull();
    await user.click(within(dialog).getByRole('button', { name: 'Go to task 3' }));
    expect(onGoTo).toHaveBeenCalledWith('c');
    const buttons = within(dialog).getAllByRole('button').filter((b) => !/Go to task|Close$/.test(b.getAttribute('aria-label') ?? b.textContent ?? ''));
    expect(buttons).toHaveLength(0);
    await user.click(within(dialog.querySelector('.modal-foot') as HTMLElement).getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says what already went in before the check (a paste’s rows)', () => {
    render(<CompletionDialog result={CONFIRM} lead="Rows were added. " onConfirm={vi.fn()} onGoTo={vi.fn()}
                             onClose={vi.fn()} />);
    expect(screen.getByText('Rows were added. The rest waits on this check.')).toBeTruthy();
  });
});

// ── useCompletion ──

const ops: Op[] = [{ op: 'set_percent', ids: ['s'], percent: 100 }];
const OK: ApplyResult = { ok: true, notices: [], tempIds: {} };

function fakeCtl(...answers: ApplyResult[]) {
  const release = vi.fn();
  const ctl = {
    apply: vi.fn(async () => answers.shift() ?? OK),
    beginEditing: vi.fn(() => release),
    undo: vi.fn(),
  } as unknown as PlanController;
  return { ctl, release };
}

let completion!: Completion;
function Host({ ctl, onGoTo }: { ctl: PlanController; onGoTo?(id: string): void }) {
  completion = useCompletion(ctl, { onGoTo });
  return <>{completion.dialog}</>;
}

describe('useCompletion', () => {
  it('a confirm answer opens the dialog; Complete resends the same ops with confirm: true', async () => {
    const user = userEvent.setup();
    const { ctl, release } = fakeCtl(CONFIRM, OK);
    render(<Host ctl={ctl} />);
    await act(async () => { await completion.run(ops, '100% Complete'); });
    const dialog = screen.getByRole('dialog', { name: 'Confirm completion' });
    expect(ctl.beginEditing).toHaveBeenCalledWith('completion-check');
    // no timeout: still there a while later
    await act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    expect(screen.getByRole('dialog', { name: 'Confirm completion' })).toBe(dialog);
    await user.click(within(dialog).getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(ctl.apply).toHaveBeenCalledTimes(2);
    expect(vi.mocked(ctl.apply).mock.calls[1]).toEqual([ops, '100% Complete', { confirm: true }]);
    expect(release).toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();
  });

  it('ask answers the resend’s result, or null when cancelled', async () => {
    const user = userEvent.setup();
    const { ctl } = fakeCtl();
    render(<Host ctl={ctl} />);
    const resend = vi.fn(async () => OK);
    let answered: Promise<ApplyResult | null>;
    act(() => { answered = completion.ask(CONFIRM, resend); });
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await expect(answered!).resolves.toBeNull();
    expect(resend).not.toHaveBeenCalled();
    act(() => { answered = completion.ask(CONFIRM, resend); });
    await user.click(screen.getByRole('button', { name: 'Complete' }));
    await expect(answered!).resolves.toEqual(OK);
  });

  it('a resend stopped again shows the new stop in its place', async () => {
    const user = userEvent.setup();
    const { ctl } = fakeCtl(CONFIRM, BLOCKED);
    render(<Host ctl={ctl} />);
    await act(async () => { await completion.run(ops, '100% Complete'); });
    await user.click(screen.getByRole('button', { name: 'Complete' }));
    expect(await screen.findByRole('dialog', { name: 'Can’t complete yet' })).toBeTruthy();
  });

  it('blocked: Go to task closes the dialog and goes to the task', async () => {
    const user = userEvent.setup();
    const onGoTo = vi.fn();
    const { ctl } = fakeCtl(BLOCKED);
    render(<Host ctl={ctl} onGoTo={onGoTo} />);
    await act(async () => { await completion.run(ops, '100% Complete'); });
    await user.click(screen.getByRole('button', { name: 'Go to task 1' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(onGoTo).toHaveBeenCalledWith('a'));
  });

  it('a refused resend is said as a toast; stops that arrive meanwhile wait their turn', async () => {
    const user = userEvent.setup();
    const { ctl } = fakeCtl(CONFIRM, BLOCKED, {
      ok: false, kind: 'error', code: 'plan_locked', message: 'The schedule is locked.',
    });
    render(<Host ctl={ctl} />);
    await act(async () => {
      await completion.run(ops, 'first');
      await completion.run(ops, 'second');
    });
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('The schedule is locked.'));
    // the second stop now
    expect(await screen.findByRole('dialog', { name: 'Can’t complete yet' })).toBeTruthy();
  });
});
