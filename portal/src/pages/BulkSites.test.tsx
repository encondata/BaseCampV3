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
  downloadSiteTemplate: vi.fn(async () => {}), downloadSiteExport: vi.fn(async () => {}),
  previewSiteBulk: vi.fn(), commitSiteBulk: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
afterEach(cleanup);
const { default: BulkSites } = await import('./BulkSites');

it('shows the column guide and the four downloads', async () => {
  render(<MemoryRouter><BulkSites /></MemoryRouter>);
  expect(screen.getByRole('heading', { name: 'Add or update sites in bulk' })).toBeTruthy();
  expect(screen.getByText('address_line1')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Current sites (.xlsx)' }));
  await waitFor(() => expect(api.downloadSiteExport).toHaveBeenCalledWith('xlsx'));
  fireEvent.click(screen.getByRole('button', { name: 'Template (.csv)' }));
  await waitFor(() => expect(api.downloadSiteTemplate).toHaveBeenCalledWith('csv'));
});
