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

/** The check as the API returns it after a save: each choice stored with
 *  the owner the check saw. */
const saved = (choices: Record<string, 'continue' | 'skip'>) => ({
  ...CHECK,
  options: { client_choices: Object.fromEntries(Object.entries(choices).map(
    ([s, c]) => [s, { choice: c, from_client_id: 'c9' }])) },
}) as unknown as ImportJobOut;

function Harness({ onNext = vi.fn(), draft = DRAFT, check = CHECK }:
                 { onNext?: () => void; draft?: MoveSetupDraft; check?: ImportJobOut }) {
  const [job, setJob] = useState<ImportJobOut | null>(check);
  return (
    <MemoryRouter>
      <AssetsStep draft={draft} job={job} clientName="Acme" setJob={setJob} onBack={vi.fn()}
                  onSkip={vi.fn(async () => {})} onNext={onNext} />
    </MemoryRouter>
  );
}

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

it('gates Next until every flagged serial is chosen, then saves the choices', async () => {
  api.putMoveSetupChoices.mockImplementation(async (_id, c) => saved(c));
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

it('names the move client on each Continue button', () => {
  render(<Harness />);
  expect(screen.getAllByRole('tab', { name: 'Continue — move it to Acme' })).toHaveLength(2);
});

it('keeps the hint and Next disabled after a failed save', async () => {
  api.putMoveSetupChoices.mockRejectedValue(new Error('x'));
  render(<Harness />);
  await userEvent.click(screen.getByRole('button', { name: 'Skip all' }));
  await waitFor(() => expect(api.putMoveSetupChoices).toHaveBeenCalled());
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText(/Choose Continue or Skip for every flagged row/)).toBeTruthy();
});

it('Skip all saves every choice', async () => {
  api.putMoveSetupChoices.mockImplementation(async (_id, c) => saved(c));
  render(<Harness />);
  await userEvent.click(screen.getByRole('button', { name: 'Skip all' }));
  await waitFor(() => expect(api.putMoveSetupChoices)
    .toHaveBeenCalledWith('d1', { 'sn-2': 'skip', 'sn-3': 'skip' }));
});

it('counts a choice as saved only when the server stored it', async () => {
  // the server answers with a different stored map than the one on screen
  api.putMoveSetupChoices.mockImplementation(async () => saved({ 'sn-2': 'skip', 'sn-3': 'skip' }));
  render(<Harness />);
  await userEvent.click(screen.getByRole('button', { name: 'Continue all' }));
  await waitFor(() => expect(api.putMoveSetupChoices).toHaveBeenCalled());
  await waitFor(() => expect(screen.getByText(/Choose Continue or Skip/)).toBeTruthy());
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
});

it('reads stored choices (with their owner) back onto the rows', () => {
  render(<Harness check={saved({ 'sn-2': 'skip', 'sn-3': 'continue' })} />);
  const row = screen.getByLabelText('Choice for sn-2');
  expect(row.querySelector('[aria-selected="true"]')?.textContent).toBe('Skip');
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(false);
});

it('a check run against another client hides the choices until Check again', () => {
  const moved = { id: 'd1', payload: { move: { client_id: 'c2' } } } as unknown as MoveSetupDraft;
  render(<Harness draft={moved}
                  check={{ ...CHECK, options: { client_id: 'c1' } } as unknown as ImportJobOut} />);
  expect(screen.queryByRole('button', { name: 'Continue all' })).toBeNull();
  expect(screen.queryAllByRole('tab', { name: /^Continue/ })).toHaveLength(0);
  expect(screen.getByText(
    "The move's client changed after the file was checked. Check the file again.")).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByRole('button', { name: 'Check again' })).toBeTruthy();
});

it('falls back to the check summary\'s client when the options have none', () => {
  const moved = { id: 'd1', payload: { move: { client_id: 'c2' } } } as unknown as MoveSetupDraft;
  render(<Harness draft={moved} />);           // CHECK summary.client_id is c1
  expect(screen.queryByRole('button', { name: 'Continue all' })).toBeNull();
  expect((screen.getByRole('button', { name: 'Next' }) as HTMLButtonElement).disabled).toBe(true);
});
