// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { ImportJobOut, InitiativeDetail } from '../lib/api';
import ImportMoveAssets from './ImportMoveAssets';

vi.mock('react-router-dom', async (importActual) => ({
  ...(await importActual<typeof import('react-router-dom')>()),
  useParams: () => ({ id: 'i1' }),
}));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true, person: { display_name: 'J' } }),
}));
const api = vi.hoisted(() => ({
  getInitiative: vi.fn(), getImportJob: vi.fn(), commitImportJob: vi.fn(),
  cancelImportJob: vi.fn(), createMoveAssetImportJob: vi.fn(),
  downloadMoveAssetTemplate: vi.fn(), reprocessImportJob: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const check = {
  id: 'job-1', initiative_id: 'i1', kind: 'move_assets', filename: 'a.csv', options: {},
  phase: 'validate', status: 'completed', total_rows: 3, processed_rows: 3, created_count: 1,
  updated_count: 0, error_count: 0, error: null, created_at: '', started_at: null, finished_at: null,
  results: { summary: { conflicts: 2, client_id: 'c1' }, details: [
    { row: 1, serial_number: 'SN1', status: 'created', message: 'ok' },
    { row: 2, serial_number: 'SN2', status: 'conflict', message: 'x', current_client: { id: 'c9', name: 'Initech' } },
    { row: 3, serial_number: 'SN3', status: 'conflict', message: 'x', current_client: { id: 'c9', name: 'Initech' } },
  ] },
} as unknown as ImportJobOut;

async function open() {
  api.getInitiative.mockResolvedValue({
    id: 'i1', name: 'NAP11', initiative_type: 'move', client_id: 'c1', client_name: 'Acme',
  } as unknown as InitiativeDetail);
  api.createMoveAssetImportJob.mockResolvedValue(check);
  render(<MemoryRouter><ImportMoveAssets /></MemoryRouter>);
  await screen.findByText('NAP11');
  await userEvent.upload(document.querySelector('input[type="file"]') as HTMLInputElement,
    new File(['a'], 'a.csv', { type: 'text/csv' }));
  await userEvent.click(await screen.findByRole('button', { name: /Validate file/ }));
  await screen.findAllByText('Belongs to Initech');
}

it('blocks Import until every flagged serial has a choice, then sends the exact map', async () => {
  api.commitImportJob.mockResolvedValue({ ...check, phase: 'commit', results: null, status: 'queued' });
  await open();
  const btn = () => screen.getByRole('button', { name: /^Import \d+ rows$/ }) as HTMLButtonElement;
  expect(btn().disabled).toBe(true);
  expect(screen.getByText('Choose Continue or Skip for every flagged row before importing.')).toBeTruthy();
  await userEvent.click(screen.getAllByRole('tab', { name: 'Skip' })[0]);
  expect(btn().disabled).toBe(true);
  await userEvent.click(screen.getAllByRole('tab', { name: /^Continue/ })[1]);
  expect(btn().disabled).toBe(false);
  expect(btn().textContent).toBe('Import 2 rows');
  await userEvent.click(btn());
  await waitFor(() => expect(api.commitImportJob).toHaveBeenCalledWith(
    'job-1', { sn2: 'skip', sn3: 'continue' }));
});

it('Continue all unlocks Import', async () => {
  await open();
  await userEvent.click(screen.getByRole('button', { name: 'Continue all' }));
  expect((screen.getByRole('button', { name: /^Import 3 rows$/ }) as HTMLButtonElement).disabled).toBe(false);
});
