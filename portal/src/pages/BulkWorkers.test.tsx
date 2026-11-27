// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

const authState = vi.hoisted(() => ({ can: (_r: string, _a: string): boolean => true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 60, godMode: false,
    can: (r: string, a: string) => authState.can(r, a), preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
const api = vi.hoisted(() => ({
  downloadWorkerTemplate: vi.fn(async () => {}), downloadWorkerExport: vi.fn(async () => {}),
  previewWorkerBulk: vi.fn(), commitWorkerBulk: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
afterEach(() => { cleanup(); authState.can = () => true; });
const { default: BulkWorkers } = await import('./BulkWorkers');

it('shows the column guide and the six downloads', async () => {
  render(<MemoryRouter><BulkWorkers /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Add or update workers in bulk' })).toBeTruthy();
  expect(screen.getByText('employee_number')).toBeTruthy();
  expect(screen.getByText('rfid_tag')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Current workers (.xlsx)' }));
  await waitFor(() => expect(api.downloadWorkerExport).toHaveBeenCalledWith('xlsx'));
  fireEvent.click(screen.getByRole('button', { name: 'Template (.csv)' }));
  await waitFor(() => expect(api.downloadWorkerTemplate).toHaveBeenCalledWith('csv'));
  expect(screen.getByText(
    'Uploads are limited to 1,000 rows and 5 MB. Larger exports need to be split before re-uploading.',
  )).toBeTruthy();
  expect(screen.getByLabelText('Upload a file (.csv, .xlsx or .json)')).toBeTruthy();
});

it('offers JSON templates and exports and an upload that accepts .json', async () => {
  const { container } = render(<MemoryRouter><BulkWorkers /></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'Current workers (.json)' }));
  await waitFor(() => expect(api.downloadWorkerExport).toHaveBeenCalledWith('json'));
  fireEvent.click(screen.getByRole('button', { name: 'Template (.json)' }));
  await waitFor(() => expect(api.downloadWorkerTemplate).toHaveBeenCalledWith('json'));
  expect(container.querySelector('input[type=file]')?.getAttribute('accept')).toBe('.csv,.xlsx,.json');
  expect(screen.getByText(/Rows with a person_id from an export match that person first\./)).toBeTruthy();
  expect(screen.getByText(/by person_id, email, phone, or name/)).toBeTruthy();
});

it('hides Current workers without users:view but keeps the templates', () => {
  authState.can = (r, a) => !(r === 'users' && a === 'view');
  render(<MemoryRouter><BulkWorkers /></MemoryRouter>);
  for (const f of ['xlsx', 'csv', 'json']) {
    expect(screen.queryByRole('button', { name: `Current workers (.${f})` })).toBeNull();
    expect(screen.getByRole('button', { name: `Template (.${f})` })).toBeTruthy();
  }
});
