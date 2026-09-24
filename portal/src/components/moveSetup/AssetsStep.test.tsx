// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ImportJobOut, MoveSetupDraft } from '../../lib/api';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const api = vi.hoisted(() => ({
  uploadMoveSetupAssets: vi.fn(), recheckMoveSetupAssets: vi.fn(), getMoveSetupCheck: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));
const { default: AssetsStep } = await import('./AssetsStep');

const DRAFT = { id: 'd1' } as MoveSetupDraft;
const job = (over: Partial<ImportJobOut>): ImportJobOut => ({
  id: 'c1', initiative_id: null, kind: 'move_assets', filename: 'ft.csv', options: {},
  phase: 'validate', status: 'queued', total_rows: 2, processed_rows: 0, created_count: 0,
  updated_count: 0, error_count: 0, results: null, error: null, created_at: '',
  started_at: null, finished_at: null, ...over,
});
const DONE = job({ status: 'completed', processed_rows: 2, results: { summary: {}, details: [
  { row: 2, serial_number: 'sn-1', status: 'created', message: 'Asset added to move' },
  { row: 3, serial_number: 'sn-2', status: 'created', message: 'Asset added to move' },
] } });

function Harness({ onNext = vi.fn(), onSkip = vi.fn(async () => {}) }) {
  const [current, setJob] = useState<ImportJobOut | null>(null);
  return (
    <MemoryRouter>
      <AssetsStep draft={DRAFT} job={current} setJob={setJob} onBack={vi.fn()}
                  onSkip={onSkip} onNext={onNext} />
    </MemoryRouter>
  );
}

beforeEach(() => { vi.clearAllMocks(); vi.useRealTimers(); });
afterEach(cleanup);

it('uploads, polls the check every 1.5 s, and unlocks Next once it completes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  api.uploadMoveSetupAssets.mockResolvedValue(job({ status: 'queued' }));
  api.getMoveSetupCheck.mockResolvedValueOnce(job({ status: 'running', processed_rows: 1 }))
    .mockResolvedValueOnce(DONE);
  const onNext = vi.fn();
  render(<Harness onNext={onNext} />);
  const next = () => screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement;
  expect(next().disabled).toBe(true);
  expect(screen.getByText('Upload a From-To file, or skip this step.')).toBeTruthy();

  const file = new File(['Serial Number\nSN-1\n'], 'ft.csv', { type: 'text/csv' });
  await user.upload(document.querySelector('input[type=file]') as HTMLInputElement, file);
  await user.click(screen.getByRole('button', { name: 'Check file' }));
  await waitFor(() => expect(api.uploadMoveSetupAssets).toHaveBeenCalledWith(
    'd1', file, { makeModelMode: 'fuzzy', generateSerials: false }));
  expect(await screen.findByText('Checking the file…')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(await screen.findByText('1 of 2 rows')).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(await screen.findByText('2 rows will be imported when the move is created')).toBeTruthy();
  expect(api.getMoveSetupCheck).toHaveBeenCalledTimes(2);
  await user.click(next());
  expect(onNext).toHaveBeenCalled();
});

it('Check again queues a new check over the same file', async () => {
  const user = userEvent.setup();
  api.uploadMoveSetupAssets.mockResolvedValue(DONE);
  api.recheckMoveSetupAssets.mockResolvedValue(job({ id: 'c2', status: 'queued' }));
  api.getMoveSetupCheck.mockResolvedValue(job({ id: 'c2', status: 'running' }));
  render(<Harness />);
  await user.upload(document.querySelector('input[type=file]') as HTMLInputElement,
    new File(['x'], 'ft.csv', { type: 'text/csv' }));
  await user.click(screen.getByRole('button', { name: 'Check file' }));
  await user.click(await screen.findByRole('button', { name: 'Check again' }));
  expect(api.recheckMoveSetupAssets).toHaveBeenCalledWith('d1');
  expect(await screen.findByText('Checking the file…')).toBeTruthy();
});

it('Skip this step hands off to the page', async () => {
  const user = userEvent.setup();
  const onSkip = vi.fn(async () => {});
  render(<Harness onSkip={onSkip} />);
  await user.click(screen.getByRole('button', { name: 'Skip this step' }));
  expect(onSkip).toHaveBeenCalled();
});

it('stops polling on unmount and drops a response that lands after it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  let resolve!: (j: ImportJobOut) => void;
  api.getMoveSetupCheck.mockReturnValue(new Promise<ImportJobOut>((r) => { resolve = r; }));
  const setJob = vi.fn();
  const { unmount } = render(
    <MemoryRouter>
      <AssetsStep draft={DRAFT} job={job({ status: 'running' })} setJob={setJob}
                  onBack={vi.fn()} onSkip={vi.fn(async () => {})} onNext={vi.fn()} />
    </MemoryRouter>,
  );
  await act(async () => { await vi.advanceTimersByTimeAsync(1500); });
  expect(api.getMoveSetupCheck).toHaveBeenCalledWith('d1');
  unmount();
  await act(async () => { resolve(DONE); await vi.advanceTimersByTimeAsync(6000); });
  expect(setJob).not.toHaveBeenCalled();
  expect(api.getMoveSetupCheck).toHaveBeenCalledTimes(1);
});
