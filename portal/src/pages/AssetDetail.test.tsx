// @vitest-environment jsdom
/**
 * /assets/:assetId — Overview keeps identity and location; History carries
 * move history above the scan history that was already there.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AssetItem } from '../lib/api';

const auth = vi.hoisted(() => ({ perms: new Set<string>(['assets:view', 'assets:change', 'scans:view']) }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (res: string, action = 'view') => auth.perms.has(`${res}:${action}`),
    godMode: false,
    preferences: { list_prefs: {} },
    updatePreferences: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  getAsset: vi.fn(),
  listAssetStatuses: vi.fn(async () => []),
  listClients: vi.fn(async () => []),
  listSites: vi.fn(async () => []),
  listAssets: vi.fn(async () => []),
  listAssetMoves: vi.fn(async () => []),
  listAssetScans: vi.fn(async () => []),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const ASSET = {
  id: 'a1', legacy_id: 100042, serial_number: 'SN-ALPHA', name: 'web-01',
  rfid_tag: null, model_id: null, model: null,
  client_id: null, client_name: 'Acme', site_id: null, site_name: 'DC1',
  location_detail: 'Rack 3', status: 'active', status_label: 'Active',
  status_color: '#178a4c', has_rails: null, last_seen_at: null,
  archived_at: null, created_at: '2026-08-05T00:00:00Z',
} as unknown as AssetItem;

beforeEach(() => {
  vi.clearAllMocks();
  auth.perms = new Set(['assets:view', 'assets:change', 'scans:view']);
  api.getAsset.mockResolvedValue(ASSET);
});
afterEach(cleanup);

const { default: AssetDetail } = await import('./AssetDetail');

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/assets/:assetId" element={<AssetDetail />} />
        <Route path="/assets/:assetId/history" element={<AssetDetail />} />
      </Routes>
    </MemoryRouter>,
  );
}

it('Overview shows identity and no history panels', async () => {
  renderAt('/assets/a1');
  expect(await screen.findByText('Identity')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByText('Move history')).toBeNull();
  expect(screen.queryByText('Scan History')).toBeNull();
});

it('History shows move history and scan history, not identity', async () => {
  renderAt('/assets/a1/history');
  expect(await screen.findByText('Move history')).toBeTruthy();
  expect(screen.getByText('Scan History')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'History' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByText('Identity')).toBeNull();
});

it('clicking History navigates to the history path', async () => {
  renderAt('/assets/a1');
  await screen.findByText('Identity');
  fireEvent.click(screen.getByRole('tab', { name: 'History' }));
  expect(await screen.findByText('Move history')).toBeTruthy();
});

it('hides the scan panel without scans:view but keeps move history', async () => {
  auth.perms = new Set(['assets:view']);
  renderAt('/assets/a1/history');
  expect(await screen.findByText('Move history')).toBeTruthy();
  expect(screen.queryByText('Scan History')).toBeNull();
});
