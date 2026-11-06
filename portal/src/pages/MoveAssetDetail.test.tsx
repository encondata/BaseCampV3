// @vitest-environment jsdom
/**
 * /initiatives/:id/assets/:rowId — the parent-asset panel's Location links
 * to the asset's container and truck. The header's Watch button is for everyone who can open
 * the page and the asset (assets:view: a watch on an initiative needs the asset too), not only
 * for editors: it watches the asset on this initiative, and the status it reads is the row's
 * (the move status), not the asset's own.
 */
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AssetItem, InitiativeAssetRow, StatusValue } from '../lib/api';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action: string) => boolean } = {
    can: (resource: string) => resource !== 'scans',
  };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string, action = 'view') => auth.can(resource, action),
    godMode: false,
    preferences: { list_prefs: {} },
    updatePreferences: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  getAsset: vi.fn(),
  getInitiative: vi.fn(),
  listAssetStatuses: vi.fn(async (): Promise<StatusValue[]> => []),
  listInitiativeAssets: vi.fn(),
  getAssetWatchState: vi.fn(),       // the header's Watch button
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const ROW = {
  id: 'ia1', asset_id: 'a1', priority_wave: null, disposition: null, owner: null,
  source_pod: null, destination_pod: null, source_rack: null, source_ru: null,
  source_verified: null, source_position: null, destination_rack: null, destination_ru: null,
  destination_verified: null, destination_position: null, cable_info: null, vendor_involved: null,
  status: 'staged', status_label: 'Staged', status_color: '#178a4c',
  created_at: '2026-09-01T10:00:00Z', updated_at: '2026-09-01T10:00:00Z',
  asset: {
    id: 'a1', legacy_id: null, serial_number: 'SN-0001', name: 'switch-01', rfid_tag: null,
    pod_number: null, model_make: null, model_name: null, ru_size: null, model_form_factor: null,
    location_detail: 'Bay 3', client_name: null, model_category: null, model_category_label: null,
    model_category_color: null, status: 'active', status_label: 'Active', status_color: '#178a4c',
  },
} as InitiativeAssetRow;

const ASSET = {
  id: 'a1', legacy_id: null, serial_number: 'SN-0001', name: 'switch-01', rfid_tag: null,
  pod_number: null, model_id: null, model: null, client_id: null, client_name: null,
  site_id: null, site_name: null, location_detail: 'Bay 3', status: 'active', status_label: 'Active',
  status_color: '#178a4c', has_rails: null, last_seen_at: null, archived_at: null,
  created_at: '2026-08-05T00:00:00Z',
  container_id: 'c1', container_name: 'ATL1-W1M-DC-01', truck_id: 't1', truck_name: 'ATL1-T01',
} as AssetItem;

const status = (key: string, label: string): StatusValue => ({
  record_type: 'asset', key, label, description: '', color: '#888888', sort_order: 0,
  is_active: true, usage_count: null, progress_weight: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  Element.prototype.scrollIntoView = vi.fn();   // jsdom has none; the modal's ComboBox scrolls its active option
  auth.can = (resource: string) => resource !== 'scans';
  api.listInitiativeAssets.mockResolvedValue([ROW]);
  api.getAsset.mockResolvedValue(ASSET);
  api.getInitiative.mockResolvedValue({ id: 'i1', name: 'Move', initiative_type: 'project' });
  api.listAssetStatuses.mockResolvedValue([]);
  api.getAssetWatchState.mockResolvedValue({ watching: false, watch: null });
});
afterEach(cleanup);

const { default: MoveAssetDetail } = await import('./MoveAssetDetail');

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/initiatives/i1/assets/ia1']}>
      <Routes><Route path="/initiatives/:id/assets/:rowId" element={<MoveAssetDetail />} /></Routes>
    </MemoryRouter>,
  );
}

it('the parent-asset Location links to the container and truck', async () => {
  renderPage();
  const c = await screen.findByRole('link', { name: 'ATL1-W1M-DC-01' });
  expect(c.getAttribute('href')).toBe('/logistics/containers?open=c1');
  expect(screen.getByRole('link', { name: 'ATL1-T01' }).getAttribute('href')).toBe('/logistics/trucks/t1');
});

/* ── the header's Watch button ───────────────────────────────────── */

it('a viewer without initiatives:change gets the Watch button, and no Edit', async () => {
  auth.can = (resource, action) => resource !== 'scans' && !(resource === 'initiatives' && action === 'change');
  renderPage();

  expect(await screen.findByRole('button', { name: 'Watch' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
});

it('for an editor the Watch button comes first in the header actions, then Edit', async () => {
  renderPage();

  const watch = await screen.findByRole('button', { name: 'Watch' });
  const actions = watch.closest('.idet-header-actions') as HTMLElement;
  expect([...actions.children].map((el) => el.textContent)).toEqual(['Watch', 'Edit']);
});

it('without assets:view there is no Watch button (a watch on an initiative needs the asset too): an editor keeps Edit', async () => {
  auth.can = (resource, action) => resource !== 'scans' && !(resource === 'assets' && action === 'view');
  renderPage();

  const edit = await screen.findByRole('button', { name: 'Edit' });
  const actions = edit.closest('.idet-header-actions') as HTMLElement;
  expect([...actions.children].map((el) => el.textContent)).toEqual(['Edit']);
  expect(screen.queryByRole('button', { name: 'Watch' })).toBeNull();
  // the button is not even mounted, so no read of a watch state the person cannot use
  expect(api.getAssetWatchState).not.toHaveBeenCalled();
});

it('without assets:view and without initiatives:change the header has no actions row at all', async () => {
  auth.can = (resource, action) => resource !== 'scans'
    && !(resource === 'assets' && action === 'view')
    && !(resource === 'initiatives' && action === 'change');
  renderPage();

  const heading = await screen.findByRole('heading', { name: 'switch-01' });
  expect((heading.closest('.idet-header') as HTMLElement).querySelector('.idet-header-actions')).toBeNull();
  expect(api.getAssetWatchState).not.toHaveBeenCalled();
});

it('it reads the watch of the asset on this initiative, not on its own', async () => {
  renderPage();
  await screen.findByRole('button', { name: 'Watch' });

  expect(api.getAssetWatchState).toHaveBeenCalledTimes(1);
  expect(api.getAssetWatchState).toHaveBeenCalledWith('a1', 'i1');
});

it('a click opens the Watch modal for the asset on this initiative: "On {initiative}."', async () => {
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Watch' }));

  // named by the serial number first, as the notices name it (the page's title is the name)
  const dialog = screen.getByRole('dialog', { name: 'Watch SN-0001' });
  await waitFor(() => expect(dialog.querySelector('p.page-hint')?.textContent).toMatch(/ On Move\.$/));
});

it('the modal reads the status the row has on this initiative, not the asset\'s own', async () => {
  api.listAssetStatuses.mockResolvedValue([
    status('active', 'Active'), status('staged', 'Staged'), status('shipped', 'Shipped'),
  ]);
  const user = userEvent.setup();
  renderPage();

  await user.click(await screen.findByRole('button', { name: 'Watch' }));
  const dialog = screen.getByRole('dialog', { name: 'Watch SN-0001' });
  await user.click(within(dialog).getByRole('button', { name: 'Status becomes' }));

  // the row is Staged; the asset itself is Active
  expect(within(dialog).getByText('Its status on this initiative is Staged now.')).toBeTruthy();
  const picker = within(dialog).getByRole('combobox', { name: 'Status' }) as HTMLInputElement;
  await waitFor(() => expect(picker.disabled).toBe(false));
  await user.click(picker);
  expect(await screen.findByText('Active', { selector: '.kbar-item' })).toBeTruthy();
  expect(screen.getByText('Shipped', { selector: '.kbar-item' })).toBeTruthy();
  expect(screen.queryByText('Staged', { selector: '.kbar-item' })).toBeNull();
});
