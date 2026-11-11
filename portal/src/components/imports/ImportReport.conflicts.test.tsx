// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { ClientChoice, ImportJobOut } from '../../lib/api';
import ImportReport from './ImportReport';

vi.mock('../../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
afterEach(cleanup);

const mk = (summary: Record<string, number | string>, extra: Record<string, unknown>[] = []) => ({
  id: 'j1', initiative_id: 'i1', kind: 'move_assets', filename: 'ft.csv', options: {},
  phase: 'validate', status: 'completed', total_rows: 3, processed_rows: 3, created_count: 1,
  updated_count: 0, error_count: 0, error: null, created_at: '', started_at: null, finished_at: null,
  results: { summary, details: [
    { row: 2, serial_number: 'sn-1', status: 'created', message: 'Asset added to move' },
    { row: 3, serial_number: 'sn-2', status: 'conflict', message: 'x', current_client: { id: 'c9', name: 'Initech' } },
    { row: 4, serial_number: 'sn-2', status: 'conflict', message: 'x', current_client: { id: 'c9', name: 'Initech' } },
    { row: 5, serial_number: 'sn-3', status: 'conflict', message: 'x', current_client: { id: 'c8', name: 'Globex' } },
    ...extra,
  ] },
}) as unknown as ImportJobOut;

function show(job: ImportJobOut, choices: Record<string, ClientChoice> = {},
              onChoicesChange = vi.fn()) {
  render(<MemoryRouter><ImportReport job={job} fixedTexts={new Set()} onFix={vi.fn()}
    canAddModels canChangeModels choices={choices} onChoicesChange={onChoicesChange}
    clientName="Acme" /></MemoryRouter>);
  return onChoicesChange;
}

it('lists each flagged serial once with the client it belongs to', () => {
  show(mk({ conflicts: 3 }));
  expect(screen.getByText('Belongs to Initech')).toBeTruthy();
  expect(screen.getByText('Belongs to Globex')).toBeTruthy();
  expect(screen.getAllByRole('tablist')).toHaveLength(2);
  expect(screen.getAllByRole('tab', { name: 'Continue — move it to Acme' })).toHaveLength(2);
});

it('a row choice, Continue all and Skip all report the choices', async () => {
  const onChange = show(mk({ conflicts: 3 }), { 'sn-3': 'skip' });
  const row = screen.getByLabelText('Choice for sn-2');
  await userEvent.click(within(row).getByRole('tab', { name: 'Skip' }));
  expect(onChange).toHaveBeenLastCalledWith({ 'sn-3': 'skip', 'sn-2': 'skip' });
  await userEvent.click(screen.getByRole('button', { name: 'Continue all' }));
  expect(onChange).toHaveBeenLastCalledWith({ 'sn-2': 'continue', 'sn-3': 'continue' });
  await userEvent.click(screen.getByRole('button', { name: 'Skip all' }));
  expect(onChange).toHaveBeenLastCalledWith({ 'sn-2': 'skip', 'sn-3': 'skip' });
});

it('marks the chosen segment selected', () => {
  show(mk({ conflicts: 3 }), { 'sn-2': 'continue' });
  const row = screen.getByLabelText('Choice for sn-2');
  expect(within(row).getByRole('tab', { name: 'Skip' }).getAttribute('aria-selected')).toBe('false');
  expect(within(row).getByRole('tab', { name: /Continue/ }).getAttribute('aria-selected')).toBe('true');
});

it('shows the Owner line with a Review groups link only when N > 0', () => {
  show(mk({ conflicts: 3, owner_unmatched: 2, client_id: 'c1' }));
  expect(screen.getByText(/2 Owner values don't match a group/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Review groups' }).getAttribute('href'))
    .toBe('/stakeholders/clients/c1?groups=review');
  cleanup();
  show(mk({ conflicts: 3, owner_unmatched: 0, client_id: 'c1' }));
  expect(screen.queryByRole('link', { name: 'Review groups' })).toBeNull();
});
