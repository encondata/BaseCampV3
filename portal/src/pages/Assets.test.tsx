// @vitest-environment jsdom
/**
 * /assets — covers the identity columns specifically: "Serial / Name"
 * (the combined cell, default on), plus the separate "Serial" and "Name"
 * columns the Columns picker can swap in, and the backward-compatible
 * hydration of a saved layout that predates all three. Generic
 * toolbar/column-menu/reorder/CSV behavior is covered by
 * lib/listTools.test.tsx and lib/columnMenu.test.tsx.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AssetItem, UiPreferences } from '../lib/api';
import { LIST_FIT } from '../lib/listTools';

const auth = vi.hoisted(() => {
  const state: { listPrefs: Record<string, unknown> } = { listPrefs: {} };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
      motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { sound: 'chime', categories: { approvals: 'email', reports: 'email', wiki: 'email', security: 'email' } },
      list_prefs: auth.listPrefs,
    } as unknown as UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  listAssets: vi.fn(),
  listAssetStatuses: vi.fn(),
  listAssetModels: vi.fn(),
  listClients: vi.fn(),
  listSites: vi.fn(),
  updateAsset: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const ASSETS: AssetItem[] = [
  {
    id: 'a1', legacy_id: 100042, serial_number: 'SN-ALPHA', name: 'web-01',
    rfid_tag: null, pod_number: null, model_id: null, model: null,
    client_id: null, client_name: 'Acme', site_id: null, site_name: 'DC1',
    location_detail: 'Rack 3', status: 'active', status_label: 'Active',
    status_color: '#178a4c', has_rails: null, last_seen_at: null,
    archived_at: null, created_at: '2026-08-05T00:00:00Z',
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.listPrefs = {};
  api.listAssets.mockResolvedValue(ASSETS);
  api.listAssetStatuses.mockResolvedValue([]);
  api.listAssetModels.mockResolvedValue([]);
  api.listClients.mockResolvedValue([]);
  api.listSites.mockResolvedValue([]);
});

afterEach(cleanup);

const { default: Assets } = await import('./Assets');

const mount = () => render(<MemoryRouter><Assets /></MemoryRouter>);

const headerNames = () => Array.from(document.querySelectorAll('.list-head .col-head button.sortable'))
  .map((b) => b.textContent?.trim().replace(/\s*[▲▼]$/, '').trim() ?? '');

it('defaults to the combined Serial / Name column', async () => {
  mount();
  await waitFor(() => expect(screen.queryByText('SN-ALPHA')).not.toBeNull());

  expect(headerNames()).toContain('Serial / Name');
  expect(headerNames()).not.toContain('Serial');
  expect(headerNames()).not.toContain('Name');

  const primary = document.querySelector('.dir-row .cell.cell-primary');
  expect(primary).not.toBeNull();
  expect(within(primary as HTMLElement).queryByText('SN-ALPHA')).not.toBeNull();
  expect(within(primary as HTMLElement).queryByText('web-01')).not.toBeNull();
});

it('Columns picker swaps the combined column for separate Serial and Name', async () => {
  mount();
  await waitFor(() => expect(screen.queryByText('SN-ALPHA')).not.toBeNull());

  await userEvent.click(screen.getByRole('button', { name: /Columns/ }));
  const menu = document.querySelector('.pop-menu') as HTMLElement;
  await userEvent.click(within(menu).getByText('Serial', { selector: '.pop-item' }));
  await userEvent.click(within(menu).getByText('Name', { selector: '.pop-item' }));
  await userEvent.click(within(menu).getByText('Serial / Name', { selector: '.pop-item' }));

  await waitFor(() => expect(headerNames()).toContain('Serial'));
  expect(headerNames()).toContain('Name');
  expect(headerNames()).not.toContain('Serial / Name');
  expect(document.querySelector('.dir-row .cell.cell-primary')).toBeNull();

  const row = document.querySelector('.dir-row .row-main') as HTMLElement;
  const cells = Array.from(row.querySelectorAll(':scope > .cell'));
  const labels = headerNames();
  const cellText = (label: string) => cells[labels.indexOf(label)]?.textContent?.trim();
  expect(cellText('Serial')).toBe('SN-ALPHA');
  expect(cellText('Name')).toBe('web-01');
});

it('a saved layout that predates the identity columns still shows the combined one, first', async () => {
  auth.listPrefs = {
    assets: {
      visible: ['asset_id', 'model', 'client', 'site', 'status'],
      order: ['model', 'client'],
      sortKey: 'primary',
      sortDir: 1,
    },
  };
  mount();
  await waitFor(() => expect(screen.queryByText('SN-ALPHA')).not.toBeNull());

  expect(headerNames()[0]).toBe('Serial / Name');
  expect(headerNames()).not.toContain('Serial');
  expect(headerNames()).not.toContain('Name');

  const row = document.querySelector('.dir-row .row-main') as HTMLElement;
  const first = row.querySelector(':scope > .cell') as HTMLElement;
  expect(first.classList.contains('cell-primary')).toBe(true);
  expect(within(first).queryByText('SN-ALPHA')).not.toBeNull();
});

it("a layout saved while 'primary' was only a pseudo-key gets the combined column back", async () => {
  // Saved between the Asset ID change and the identity-columns change:
  // `seen` names 'primary' (it was in ALL_COLUMN_KEYS), `visible` can't
  // (it wasn't a COLUMNS entry), and 'serial'/'name' didn't exist yet.
  auth.listPrefs = {
    assets: {
      visible: ['asset_id', 'model', 'category', 'client', 'site', 'status'],
      seen: ['primary', 'asset_id', 'model', 'category', 'client', 'site', 'status',
             'ru', 'location', 'rfid', 'last_seen', 'has_rails', 'archived'],
      order: [],
      sortKey: 'primary',
      sortDir: 1,
    },
  };
  mount();
  await waitFor(() => expect(screen.queryByText('SN-ALPHA')).not.toBeNull());

  expect(headerNames()[0]).toBe('Serial / Name');
  expect(headerNames()).not.toContain('Serial');
  expect(headerNames()).not.toContain('Name');
});

it('a layout saved after the split with all three identity columns off stays that way', async () => {
  auth.listPrefs = {
    assets: {
      visible: ['model'],
      seen: ['primary', 'serial', 'name', 'asset_id', 'model', 'category', 'client', 'site',
             'status', 'ru', 'location', 'rfid', 'last_seen', 'has_rails', 'archived'],
      order: [],
      sortKey: 'model',
      sortDir: 1,
    },
  };
  mount();
  // The serial never renders here — that's the point — so wait on the row.
  await waitFor(() => expect(document.querySelector('.dir-row')).not.toBeNull());

  expect(headerNames()).not.toContain('Serial / Name');
  expect(headerNames()).not.toContain('Serial');
  expect(headerNames()).not.toContain('Name');
  expect(document.querySelector('.dir-row .cell.cell-primary')).toBeNull();
});

it('each collapsed row carries an Actions menu with Full details and Edit', async () => {
  render(<MemoryRouter initialEntries={['/assets']}>
    <Routes>
      <Route path="/assets" element={<Assets />} />
      <Route path="/assets/:assetId" element={<div>ASSET PAGE</div>} />
    </Routes>
  </MemoryRouter>);
  const trigger = (await screen.findAllByRole('button', { name: /Actions/ }))[0];
  fireEvent.click(trigger);
  expect(await screen.findByText('Full details')).toBeTruthy();
  expect(screen.getByText('Edit')).toBeTruthy();
});

it('opening the Actions menu does not expand the row', async () => {
  render(<MemoryRouter><Assets /></MemoryRouter>);
  const trigger = (await screen.findAllByRole('button', { name: /Actions/ }))[0];
  fireEvent.click(trigger);
  expect(document.querySelector('.dir-row.open')).toBeNull();
});

it('Full details navigates to the asset page', async () => {
  render(<MemoryRouter initialEntries={['/assets']}>
    <Routes>
      <Route path="/assets" element={<Assets />} />
      <Route path="/assets/:assetId" element={<div>ASSET PAGE</div>} />
    </Routes>
  </MemoryRouter>);
  fireEvent.click((await screen.findAllByRole('button', { name: /Actions/ }))[0]);
  fireEvent.click(await screen.findByText('Full details'));
  expect(await screen.findByText('ASSET PAGE')).toBeTruthy();
});

it('Assets list: column floors, shared template + minimum, sideways-scroll card', async () => {
  mount();
  const row = (await screen.findByText('SN-ALPHA')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

const PLACED: AssetItem = {
  ...ASSETS[0], location_detail: 'Bay 3',
  container_id: 'c1', container_name: 'ATL1-W1M-DC-01', truck_id: 't1', truck_name: 'ATL1-T01 (Wave 1)',
};
const PLACED_TEXT = 'ATL1-W1M-DC-01 · on ATL1-T01 (Wave 1)';
const showLocation = () => {
  auth.listPrefs = { assets: { visible: ['primary', 'location'], order: [], sortKey: 'primary', sortDir: 1 } };
};

it('the Location cell links to the container and truck without opening the row', async () => {
  showLocation();
  api.listAssets.mockResolvedValue([PLACED]);
  mount();
  const row = (await screen.findByText('SN-ALPHA')).closest('.dir-row') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  const c = within(main).getByRole('link', { name: 'ATL1-W1M-DC-01' });
  const t = within(main).getByRole('link', { name: 'ATL1-T01 (Wave 1)' });
  expect(c.getAttribute('href')).toBe('/logistics/containers?open=c1');
  expect(t.getAttribute('href')).toBe('/logistics/trucks/t1');
  expect(c.closest('.cell-top.cell-line')?.getAttribute('title')).toBe(PLACED_TEXT);
  fireEvent.click(c);
  expect(row.classList.contains('open')).toBe(false);
});

it('the expanded row shows the same Location links', async () => {
  showLocation();
  api.listAssets.mockResolvedValue([PLACED]);
  mount();
  const row = (await screen.findByText('SN-ALPHA')).closest('.dir-row') as HTMLElement;
  fireEvent.click(row.querySelector('.row-main') as HTMLElement);
  await waitFor(() => expect(row.classList.contains('open')).toBe(true));
  const dd = Array.from(row.querySelectorAll('dt')).find((d) => d.textContent === 'Location')!
    .nextElementSibling as HTMLElement;
  expect(within(dd).getByRole('link', { name: 'ATL1-W1M-DC-01' }).getAttribute('href'))
    .toBe('/logistics/containers?open=c1');
  expect(within(dd).getByRole('link', { name: 'ATL1-T01 (Wave 1)' }).getAttribute('href'))
    .toBe('/logistics/trucks/t1');
});

it('search and sort use the shown placement text', async () => {
  showLocation();
  auth.listPrefs = { assets: { visible: ['primary', 'location'], order: [], sortKey: 'location', sortDir: 1 } };
  const other: AssetItem = { ...ASSETS[0], id: 'a2', serial_number: 'SN-BETA', location_detail: 'Bay 1' };
  api.listAssets.mockResolvedValue([other, PLACED]);
  mount();
  await screen.findByText('SN-ALPHA');
  const serials = () => Array.from(document.querySelectorAll('.dir-row .cell-primary'))
    .map((c) => c.textContent);
  // 'ATL1-…' sorts before 'Bay 1' by the placement text (by the raw 'Bay 3' vs 'Bay 1' it would not).
  expect(serials()[0]).toContain('SN-ALPHA');
  await userEvent.type(screen.getByPlaceholderText('Filter this list…'), 'wave 1');
  await waitFor(() => expect(screen.queryByText('SN-BETA')).toBeNull());
  expect(screen.queryByText('SN-ALPHA')).not.toBeNull();
});
