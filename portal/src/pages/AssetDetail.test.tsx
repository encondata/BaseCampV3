// @vitest-environment jsdom
/**
 * /assets/:assetId — Overview keeps identity and location; History carries
 * move history above the scan history that was already there. The header's Watch button is
 * for everyone who can open the page, not only for editors; a click opens the Watch modal.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AssetItem, StatusValue } from '../lib/api';

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
  listAssetStatuses: vi.fn(async (): Promise<StatusValue[]> => []),
  listClients: vi.fn(async () => []),
  listSites: vi.fn(async () => []),
  listAssets: vi.fn(async () => []),
  listAssetMoves: vi.fn(async () => []),
  listAssetScans: vi.fn(async () => []),
  getAssetWatchState: vi.fn(),       // the header's Watch button
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

const status = (key: string, label: string): StatusValue => ({
  record_type: 'asset', key, label, description: '', color: '#888888', sort_order: 0,
  is_active: true, usage_count: null, progress_weight: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; the modal's ComboBox scrolls its active option
  auth.perms = new Set(['assets:view', 'assets:change', 'scans:view']);
  api.getAsset.mockResolvedValue(ASSET);
  api.listAssetStatuses.mockResolvedValue([]);
  api.getAssetWatchState.mockResolvedValue({ watching: false, watch: null });
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

it('Overview shows the Location as container and truck links', async () => {
  api.getAsset.mockResolvedValue({
    ...ASSET, container_id: 'c1', container_name: 'ATL1-W1M-DC-01', truck_id: 't1', truck_name: 'ATL1-T01',
  });
  renderAt('/assets/a1');
  const c = await screen.findByRole('link', { name: 'ATL1-W1M-DC-01' });
  expect(c.getAttribute('href')).toBe('/logistics/containers?open=c1');
  expect(screen.getByRole('link', { name: 'ATL1-T01' }).getAttribute('href')).toBe('/logistics/trucks/t1');
});

/* ── the header's Watch button ───────────────────────────────────── */

it('a viewer without assets:change gets the Watch button, and no Edit', async () => {
  auth.perms = new Set(['assets:view']);
  renderAt('/assets/a1');

  expect(await screen.findByRole('button', { name: 'Watch' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  // the state of the asset on its own: no initiative
  expect(api.getAssetWatchState).toHaveBeenCalledWith('a1', null);
});

it('for an editor the Watch button comes first in the header actions, then Edit', async () => {
  renderAt('/assets/a1');

  const watch = await screen.findByRole('button', { name: 'Watch' });
  const actions = watch.closest('.idet-header-actions') as HTMLElement;
  expect(actions.closest('.idet-header')).not.toBeNull();
  expect([...actions.children].map((el) => el.textContent)).toEqual(['Watch', 'Edit']);
});

it('a click on Watch opens the Watch modal for the asset, named by its serial number', async () => {
  auth.perms = new Set(['assets:view']);
  const user = userEvent.setup();
  renderAt('/assets/a1');

  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  // The page's title is the name (web-01); the notices name it by serial first.
  const dialog = screen.getByRole('dialog', { name: 'Watch SN-ALPHA' });
  // not watching yet: a new watch, with no Stop watching
  expect(within(dialog).getByRole('button', { name: 'Watch' })).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: 'Stop watching' })).toBeNull();
});

it('the modal is given the status the asset has now: it says so, and the picker leaves it out', async () => {
  api.listAssetStatuses.mockResolvedValue([status('active', 'Active'), status('shipped', 'Shipped')]);
  auth.perms = new Set(['assets:view']);
  const user = userEvent.setup();
  renderAt('/assets/a1');

  await user.click(await screen.findByRole('button', { name: 'Watch' }));
  const dialog = screen.getByRole('dialog', { name: 'Watch SN-ALPHA' });
  await user.click(within(dialog).getByRole('button', { name: 'Status becomes' }));

  expect(within(dialog).getByText('Its status is Active now.')).toBeTruthy();
  const picker = within(dialog).getByRole('combobox', { name: 'Status' }) as HTMLInputElement;
  await waitFor(() => expect(picker.disabled).toBe(false));
  await user.click(picker);
  expect(await screen.findByText('Shipped', { selector: '.kbar-item' })).toBeTruthy();
  expect(screen.queryByText('Active', { selector: '.kbar-item' })).toBeNull();
});
