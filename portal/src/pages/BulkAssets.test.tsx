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
  downloadAssetBulkTemplate: vi.fn(async () => {}), downloadAssetBulkExport: vi.fn(async () => {}),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
afterEach(cleanup);
const { default: BulkAssets } = await import('./BulkAssets');

it('renders the siblings\' sections in order, with the column guide and the 15,000-row note', async () => {
  render(<MemoryRouter><BulkAssets /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Update assets in bulk' })).toBeTruthy();

  const sections = screen.getAllByText(/^(Columns|Download|Upload)$/, { selector: '.eyebrow-sm' });
  expect(sections.map((s) => s.textContent)).toEqual(['Columns', 'Download', 'Upload']);

  expect(screen.getByText('asset_id')).toBeTruthy();
  expect(screen.getByText('has_rails')).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Current assets (.xlsx)' }));
  await waitFor(() => expect(api.downloadAssetBulkExport).toHaveBeenCalledWith('xlsx'));
  fireEvent.click(screen.getByRole('button', { name: 'Template (.csv)' }));
  await waitFor(() => expect(api.downloadAssetBulkTemplate).toHaveBeenCalledWith('csv'));

  expect(screen.getByText('Uploads are limited to 15,000 rows and 20 MB.')).toBeTruthy();
  expect(screen.getByLabelText('Upload a file (.csv or .xlsx)')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Update 0 assets' }) as HTMLButtonElement).disabled).toBe(true);
});
