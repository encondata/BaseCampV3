// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 100, godMode: false,
    can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
const api = vi.hoisted(() => ({
  listAssetModels: vi.fn(async () => []),
  listAssetCategories: vi.fn(async () => []),
  reviewAssetModels: vi.fn(async () => ({ imported: [], duplicates: [], dismissed_count: 0 })),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));
afterEach(cleanup);
const { default: AssetModels } = await import('./AssetModels');

it('switches to the Review view', async () => {
  render(<MemoryRouter><AssetModels /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('tab', { name: /Review/ }));
  expect(await screen.findByText('Nothing to review — the catalog has no import-created or overlapping models.')).toBeTruthy();
});
