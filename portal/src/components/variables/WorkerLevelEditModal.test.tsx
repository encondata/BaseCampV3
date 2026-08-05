// @vitest-environment jsdom
/**
 * The create-mode retry trap described in this modal's header comment: once
 * createWorkerLevel succeeds, a retry after a later failure (the parent's
 * refetch throwing, via onSaved) must NOT re-create the level.
 *
 * lib/variables.test.ts already covers needsWorkerLevelCreate,
 * workerLevelCreatePayload, rankAfter and previewOrder as pure functions.
 * What is asserted here is the wiring those helpers depend on — that
 * createdKey survives the failed refetch and re-routes the second submit
 * onto the PATCH path — plus that the position preview renders the chosen
 * insertion.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type WorkerLevel } from '../../lib/api';

const api = vi.hoisted(() => ({
  createWorkerLevel: vi.fn(),
  updateWorkerLevel: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const LEVELS: WorkerLevel[] = [
  { level: 'L1', rank: 1, title: 'Apprentice', description: '', expected_skills: [], color: '#8a93a6' },
  { level: 'L2', rank: 2, title: 'Junior', description: '', expected_skills: [], color: '#4dd0ff' },
];

const CREATED: WorkerLevel = {
  level: 'L3', rank: 3, title: 'Tech', description: '', expected_skills: [], color: '#178a4c',
};

beforeEach(() => {
  vi.clearAllMocks();
  api.createWorkerLevel.mockResolvedValue(CREATED);
  api.updateWorkerLevel.mockResolvedValue(CREATED);
});

afterEach(cleanup);

const { default: WorkerLevelEditModal } = await import('./WorkerLevelEditModal');

function renderCreateModal(onSaved = vi.fn().mockResolvedValue(undefined)) {
  const onClose = vi.fn();
  render(
    <WorkerLevelEditModal
      value={null}
      levels={LEVELS}
      canChange
      onClose={onClose}
      onSaved={onSaved}
    />,
  );
  return { onSaved, onClose };
}

it('previews the resulting order for the default (last) position', async () => {
  const user = userEvent.setup();
  renderCreateModal();

  const levelInput = document.querySelector<HTMLInputElement>('.pf-form input')!;
  await user.type(levelInput, 'L3');

  await screen.findByText('L1');
  // A single textContent assertion pins the ORDER, not just presence — three
  // separate getByText('L1'/'L2'/'L3') checks would still pass for a preview
  // that returned them as ['L3','L1','L2'].
  const preview = document.querySelector('.chips')!;
  expect(preview.textContent).toBe('L1L2L3');
});

it('does not re-create the level when a retry follows a failed refetch', async () => {
  const onSaved = vi.fn()
    .mockRejectedValueOnce(new ApiError(500, 'unknown_error'))
    .mockResolvedValueOnce(undefined);
  const user = userEvent.setup();

  renderCreateModal(onSaved);

  // Plain <label> text isn't programmatically associated with these inputs
  // (no htmlFor/id — same as every other modal in this directory), so pick
  // them positionally: Level, then Title (Description is a textarea; the
  // ColorField and TagInput inputs come after).
  const inputs = document.querySelectorAll<HTMLInputElement>('.pf-form input');
  await user.type(inputs[0], 'L3');
  await user.type(inputs[1], 'Tech');

  await user.click(screen.getByRole('button', { name: 'Create level' }));

  await waitFor(() => expect(api.createWorkerLevel).toHaveBeenCalledTimes(1));
  // the modal has flipped itself to edit mode — the create affordance is gone
  expect(screen.queryByRole('button', { name: 'Create level' })).toBeNull();

  // change something so the retry's diff isn't empty (an unchanged form has
  // nothing to PATCH — that's correct, but doesn't exercise this wiring).
  // The flip to edit mode drops the Level input and Position select (now
  // pf-static text), so Title is index 0 here, not 1.
  const titleAgain = document.querySelectorAll<HTMLInputElement>('.pf-form input')[0];
  await user.type(titleAgain, ' II');

  // RETRY
  await user.click(screen.getByRole('button', { name: 'Save' }));

  await waitFor(() => expect(api.updateWorkerLevel).toHaveBeenCalledTimes(1));

  // the trap: still exactly one create, and the retry PATCHed the created level
  expect(api.createWorkerLevel).toHaveBeenCalledTimes(1);
  expect(api.updateWorkerLevel).toHaveBeenCalledWith('L3', expect.anything());
});
