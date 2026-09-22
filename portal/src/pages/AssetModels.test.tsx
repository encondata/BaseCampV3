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

const item = (id: string, model: string, over: Record<string, unknown> = {}) => ({
  id, make: 'Dell', model, category: null, category_label: null, category_color: null,
  ru_size: null, weight_lbs: null, weight_kg: null, length_in: null, width_in: null, height_in: null,
  length_cm: null, width_cm: null, height_cm: null, mount_type: null, rail_type: null, form_factor: null,
  knowledge: '', aliases: [], review_dismissed_at: null, created_at: '', updated_at: '',
  asset_count: 1, stock_line_count: 0, reason: 'duplicate', group_key: 'dell r740', ...over,
});

it('switches to the Review view', async () => {
  render(<MemoryRouter><AssetModels /></MemoryRouter>);
  expect(screen.getByRole('tablist', { name: 'Catalog view' })).toBeTruthy();
  fireEvent.click(await screen.findByRole('tab', { name: /Review/ }));
  expect(await screen.findByText('The catalog has no import-created or overlapping models.')).toBeTruthy();
});

it('the Review tab badge counts every model awaiting a decision, once each', async () => {
  api.reviewAssetModels.mockResolvedValueOnce({
    imported: [item('f1', 'R740 (Node)', { reason: 'imported', group_key: null })],
    duplicates: [[item('a', 'PowerEdge R740'), item('b', 'PowerEdge_R740')]],
    dismissed_count: 0,
  } as never);
  render(<MemoryRouter><AssetModels /></MemoryRouter>);
  expect(await screen.findByRole('tab', { name: 'Review 3' })).toBeTruthy();
});

it('a model that is both import-created and a duplicate is counted once', async () => {
  api.reviewAssetModels.mockResolvedValueOnce({
    imported: [item('a', 'PowerEdge R740', { reason: 'imported', group_key: null })],
    duplicates: [[item('a', 'PowerEdge R740'), item('b', 'PowerEdge_R740')]],
    dismissed_count: 0,
  } as never);
  render(<MemoryRouter><AssetModels /></MemoryRouter>);
  expect(await screen.findByRole('tab', { name: 'Review 2' })).toBeTruthy();
});
