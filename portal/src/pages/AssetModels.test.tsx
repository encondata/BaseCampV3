// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { LIST_FIT } from '../lib/listTools';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    person: { id: 'me-1', display_name: 'Me' }, roles: ['admin'], maxRank: 100, godMode: false,
    can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn(),
  }),
}));
const LOOKUP_STATUS = vi.hoisted(() => ({
  configured: true, background_enabled: false, queued: 0, running_model: null,
  last_finished_at: null, pending_count: 2,
  month: { lookups: 0, input_tokens: 0, output_tokens: 0, searches: 0, est_cost_usd: 0 },
}));
const api = vi.hoisted(() => ({
  listAssetModels: vi.fn(async () => []),
  listAssetCategories: vi.fn(async () => []),
  reviewAssetModels: vi.fn(async () => ({ imported: [], duplicates: [], dismissed_count: 0 })),
  getSpecLookupStatus: vi.fn(async () => LOOKUP_STATUS),
  queueSpecLookup: vi.fn(async () => ({ queued: 1, skipped: [] })),
  listSpecSuggestions: vi.fn(async () => []),
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
  knowledge: '', aliases: [], review_dismissed_at: null,
  private: false, spec_lookup_skip: false, specs_looked_up_at: null,
  created_at: '', updated_at: '',
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

it('AssetModels list: column floors, shared template + minimum, sideways-scroll card', async () => {
  api.listAssetModels.mockResolvedValueOnce([item('m1', 'PowerEdge R740')] as never);
  render(<MemoryRouter><AssetModels /></MemoryRouter>);
  const row = (await screen.findByText('PowerEdge R740')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

it('the Spec lookup tab carries the pending count and opens the panel', async () => {
  render(<MemoryRouter><AssetModels /></MemoryRouter>);
  fireEvent.click(await screen.findByRole('tab', { name: 'Spec lookup 2' }));
  expect(await screen.findByRole('button', { name: 'Find missing specs' })).toBeTruthy();
  expect(await screen.findByText('No suggestions in this view.')).toBeTruthy();
});

it('the expanded row queues a lookup for that model and shows when it last ran', async () => {
  api.listAssetModels.mockResolvedValueOnce([item('m1', 'PowerEdge R740')] as never);
  render(<MemoryRouter><AssetModels /></MemoryRouter>);
  fireEvent.click(await screen.findByText('PowerEdge R740'));
  expect(await screen.findByText(/Last looked up never/)).toBeTruthy();
  const statusCalls = api.getSpecLookupStatus.mock.calls.length;
  fireEvent.click(screen.getByRole('button', { name: 'Look up specs' }));
  await waitFor(() => expect(api.queueSpecLookup).toHaveBeenCalledWith(['m1']));
  await waitFor(() => expect(api.getSpecLookupStatus.mock.calls.length).toBeGreaterThan(statusCalls));
});

it('Look up specs is disabled for a private model', async () => {
  api.listAssetModels.mockResolvedValueOnce([item('m1', 'PowerEdge R740', { private: true })] as never);
  render(<MemoryRouter><AssetModels /></MemoryRouter>);
  fireEvent.click(await screen.findByText('PowerEdge R740'));
  const btn = await screen.findByRole('button', { name: 'Look up specs' }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(btn.getAttribute('title')).toBe('Private models are never sent to Claude.');
  expect(screen.getByText(/Last looked up never · Private/)).toBeTruthy();
});
