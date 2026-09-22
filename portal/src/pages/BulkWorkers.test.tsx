// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 60, godMode: false,
    can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
const api = vi.hoisted(() => ({
  downloadWorkerTemplate: vi.fn(async () => {}), downloadWorkerExport: vi.fn(async () => {}),
  previewWorkerBulk: vi.fn(), commitWorkerBulk: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
afterEach(cleanup);
const { default: BulkWorkers } = await import('./BulkWorkers');

it('shows the column guide and the four downloads', async () => {
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
  expect(screen.getByLabelText('Upload a file (.csv or .xlsx)')).toBeTruthy();
});
