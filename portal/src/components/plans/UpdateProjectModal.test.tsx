// @vitest-environment jsdom
/**
 * components/plans/UpdateProjectModal.tsx: MS Project's Update Project.
 * The status date defaults to today in plan time (`plan.now`); "Update
 * work as complete through" is sent only while its switch is on; a 100%
 * the completion rules stop goes through the completion check.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Plan, UpdateProjectBody } from '../../lib/plans/api';
import type { ApplyResult } from '../../lib/plans/applyResult';
import { planView } from '../../lib/plans/merge';
import { makePlan } from '../../lib/plans/planFixtures';
import UpdateProjectModal from './UpdateProjectModal';
import { CompletionHost } from './useCompletion';
import type { PlanController } from './usePlan';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

afterEach(cleanup);
beforeEach(() => toast.mockReset());

const OK: ApplyResult = { ok: true, notices: [], tempIds: {} };

function open(p: Plan, ...answers: ApplyResult[]) {
  const view = planView(p);
  const updateProject = vi.fn(async (_body: UpdateProjectBody) => answers.shift() ?? OK);
  const ctl = {
    status: 'ready', plan: view.plan, outline: view.outline, updateProject, apply: vi.fn(), undo: vi.fn(),
    beginEditing: vi.fn(() => vi.fn()),
  } as unknown as PlanController;
  const onClose = vi.fn();
  render(
    <CompletionHost ctl={ctl}>
      <UpdateProjectModal ctl={ctl} onClose={onClose} />
    </CompletionHost>,
  );
  return { updateProject, onClose, user: userEvent.setup() };
}

const dialog = () => screen.getByRole('dialog', { name: 'Update project' });
const PLAN = makePlan({ now: '2026-11-04T10:15', status_date: null });

describe('Update project', () => {
  it('the status date starts at today in plan time; complete-through stays off and unsent', async () => {
    const { updateProject, onClose, user } = open(PLAN);
    expect((screen.getByLabelText('Status date') as HTMLInputElement).value).toBe('2026-11-04');
    const through = screen.getByLabelText('Complete through') as HTMLInputElement;
    expect(through.disabled).toBe(true);
    await user.click(within(dialog()).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith({ status_date: '2026-11-04' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('posts complete_through only when its switch is on', async () => {
    const { updateProject, user } = open(PLAN);
    await user.click(screen.getByRole('checkbox', { name: 'Update work as complete through' }));
    const through = screen.getByLabelText('Complete through') as HTMLInputElement;
    expect(through.disabled).toBe(false);
    expect(through.value).toBe('2026-11-04');
    fireEvent.change(through, { target: { value: '2026-11-03' } });
    await user.click(within(dialog()).getByRole('button', { name: 'Update' }));
    await waitFor(() => expect(updateProject).toHaveBeenCalledWith({
      status_date: '2026-11-04', complete_through: '2026-11-03',
    }));
  });

  it('a 100% the rules stop goes through the completion check: Complete resends with confirm', async () => {
    const confirm: ApplyResult = {
      ok: false, kind: 'confirm',
      willComplete: [{ task_id: 'c', display_id: 3, name: 'Go live', reason: 'subtask' }], openPredecessors: [],
    };
    const { updateProject, onClose, user } = open(PLAN, confirm, OK);
    await user.click(screen.getByRole('checkbox', { name: 'Update work as complete through' }));
    await user.click(within(dialog()).getByRole('button', { name: 'Update' }));
    const check = await screen.findByRole('dialog', { name: 'Confirm completion' });
    await user.click(within(check).getByRole('button', { name: 'Complete' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(updateProject.mock.calls[1][0]).toEqual({
      status_date: '2026-11-04', complete_through: '2026-11-04', confirm: true,
    });
  });

  it('a refusal stays in the dialog', async () => {
    const { onClose, user } = open(PLAN, {
      ok: false, kind: 'error', code: 'bad_field', message: 'Check Status Date.',
    });
    await user.click(within(dialog()).getByRole('button', { name: 'Update' }));
    expect((await within(dialog()).findByRole('alert')).textContent).toBe('Check Status Date.');
    expect(onClose).not.toHaveBeenCalled();
  });
});
