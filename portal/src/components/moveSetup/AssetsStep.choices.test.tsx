// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ImportJobOut, MoveSetupDraft } from '../../lib/api';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const api = vi.hoisted(() => ({
  uploadMoveSetupAssets: vi.fn(), recheckMoveSetupAssets: vi.fn(), getMoveSetupCheck: vi.fn(),
  putMoveSetupChoices: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: AssetsStep } = await import('./AssetsStep');

const DRAFT = { id: 'd1', payload: { move: { client_id: 'c1' } } } as unknown as MoveSetupDraft;
const CHECK = {
  id: 'c1', initiative_id: null, kind: 'move_assets', filename: 'ft.csv', options: {},
  phase: 'validate', status: 'completed', total_rows: 3, processed_rows: 3, created_count: 1,
  updated_count: 0, error_count: 0, error: null, created_at: '', started_at: null, finished_at: null,
  results: { summary: { conflicts: 2, client_id: 'c1' }, details: [
    { row: 2, serial_number: 'sn-1', status: 'created', message: 'ok' },
    { row: 3, serial_number: 'sn-2', status: 'conflict', message: 'x', current_client: { id: 'c9', name: 'Initech' } },
    { row: 4, serial_number: 'sn-3', status: 'conflict', message: 'x', current_client: { id: 'c9', name: 'Initech' } },
  ] },
} as unknown as ImportJobOut;

function Harness({ onNext = vi.fn() }) {
  const [job, setJob] = useState<ImportJobOut | null>(CHECK);
  return (
    <MemoryRouter>
      <AssetsStep draft={DRAFT} job={job} setJob={setJob} onBack={vi.fn()}
                  onSkip={vi.fn(async () => {})} onNext={onNext} />
    </MemoryRouter>
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it('gates Next until every flagged serial is chosen, then saves the choices', async () => {
  api.putMoveSetupChoices.mockImplementation(async () => CHECK);
  const onNext = vi.fn();
  render(<Harness onNext={onNext} />);
  const next = () => screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
  expect(next().disabled).toBe(true);
  expect(screen.getByText('Choose Continue or Skip for every flagged row before importing.')).toBeTruthy();
  await userEvent.click(screen.getAllByRole('tab', { name: 'Skip' })[0]);
  expect(api.putMoveSetupChoices).not.toHaveBeenCalled();
  expect(next().disabled).toBe(true);
  await userEvent.click(screen.getAllByRole('tab', { name: /^Continue/ })[1]);
  await waitFor(() => expect(api.putMoveSetupChoices)
    .toHaveBeenCalledWith('d1', { 'sn-2': 'skip', 'sn-3': 'continue' }));
  await waitFor(() => expect(next().disabled).toBe(false));
  await userEvent.click(next());
  expect(onNext).toHaveBeenCalled();
});

it('Skip all saves every choice', async () => {
  api.putMoveSetupChoices.mockImplementation(async () => CHECK);
  render(<Harness />);
  await userEvent.click(screen.getByRole('button', { name: 'Skip all' }));
  await waitFor(() => expect(api.putMoveSetupChoices)
    .toHaveBeenCalledWith('d1', { 'sn-2': 'skip', 'sn-3': 'skip' }));
});
