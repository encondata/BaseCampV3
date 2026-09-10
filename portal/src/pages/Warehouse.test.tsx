// @vitest-environment jsdom
/**
 * /logistics/warehouse — the site selector + persisted choice, the four
 * KPI tiles, the kind-filter segmented control, expanding a container
 * row to reveal its contents, the + Add stock → StockLineModal → save
 * → refetch round trip, and archiving a loose stock line.
 * Generic toolbar/column-menu/reorder/CSV behavior is covered by
 * lib/listTools.test.tsx and lib/columnMenu.test.tsx; StockLineModal's
 * own validation/error-mapping is covered by its own test file.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type {
  AssetItem, AssetRef, SiteItem, StockLine, UiPreferences, WarehouseContainer, WarehouseInventory,
  WarehouseSite,
} from '../lib/api';

const auth = vi.hoisted(() => ({ can: (_r: string, _a?: string): boolean => true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: true, sound: 'chime' },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  listWarehouseSites: vi.fn(),
  getWarehouseInventory: vi.fn(),
  createStockLine: vi.fn(),
  updateStockLine: vi.fn(),
  archiveStockLine: vi.fn(),
  getAsset: vi.fn(),
  listContainerStatuses: vi.fn(),
  listContainerTypes: vi.fn(),
  listSites: vi.fn(),
  listAssetStatuses: vi.fn(),
  listClients: vi.fn(),
  listAssetModels: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const SITE_A: WarehouseSite = {
  id: 's1', name: 'ACC4 Storage', code: null, city: null, region: null,
  status: 'active', status_label: 'Active', status_color: '#178a4c',
  container_count: 1, asset_count: 2, stock_line_count: 2, stock_units: 64,
};
const SITE_B: WarehouseSite = {
  id: 's2', name: 'DA11 Storage', code: null, city: null, region: null,
  status: 'active', status_label: 'Active', status_color: '#178a4c',
  container_count: 0, asset_count: 0, stock_line_count: 0, stock_units: 0,
};

const CONTAINER_ASSET: AssetRef = {
  id: 'ca1', legacy_id: null, serial_number: 'SN-IN', name: null, model_name: 'APC AP8941',
  status: 'in_storage', status_label: 'In storage', status_color: '#8a8f98', location_detail: '',
};
const CONTAINER_STOCK: StockLine = {
  id: 'cs1', site_id: 's1', site_name: 'ACC4 Storage', container_id: 'c1', container_name: 'Pallet A-01',
  model_id: null, model_make: null, model_model: null,
  description: 'PDU, 30A', quantity: 24, unit: 'each', location_detail: '', notes: '',
  archived_at: null, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};
const CONTAINER: WarehouseContainer = {
  id: 'c1', name: 'Pallet A-01', rfid_tag: null,
  container_type: 'pallet', type_label: 'Pallet', type_color: '#a36207',
  status: 'available', status_label: 'Available', status_color: '#178a4c',
  location_detail: '', updated_at: '2026-08-01T00:00:00Z',
  assets: [CONTAINER_ASSET], stock: [CONTAINER_STOCK],
};
const LOOSE_ASSET: AssetRef = {
  id: 'a2', legacy_id: null, serial_number: 'SN-LOOSE', name: null, model_name: null,
  status: 'in_storage', status_label: 'In storage', status_color: '#8a8f98', location_detail: 'Floor',
};
const LOOSE_STOCK: StockLine = {
  id: 's3', site_id: 's1', site_name: 'ACC4 Storage', container_id: null, container_name: null,
  model_id: null, model_make: null, model_model: null,
  description: 'Cage nuts M6', quantity: 40, unit: 'bag', location_detail: 'Shelf B', notes: '',
  archived_at: null, created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
};
const INVENTORY_A: WarehouseInventory = {
  site: SITE_A, containers: [CONTAINER], loose_assets: [LOOSE_ASSET], loose_stock: [LOOSE_STOCK],
};
const INVENTORY_B: WarehouseInventory = {
  site: SITE_B, containers: [], loose_assets: [], loose_stock: [],
};
const SITE_ITEM_A: SiteItem = {
  id: 's1', name: 'ACC4 Storage', code: null,
  site_type: null, type_label: null, type_color: null,
  status: 'active', status_label: 'Active', status_color: '#178a4c',
  address_line1: null, address_line2: null, city: null, region: null, postal_code: null,
  country: 'US', latitude: null, longitude: null, timezone: null, dc_provider: null,
  partner_id: null, partner_name: null, notes: null, archived_at: null,
  created_at: '2026-08-01T00:00:00Z', clients: [],
};

// jsdom doesn't implement Element.scrollIntoView — ComboBox calls it when
// the active option changes (e.g. hovering a non-first item while
// switching sites below), which would otherwise throw.
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { default: Warehouse } = await import('./Warehouse');

function renderPage() {
  return render(<MemoryRouter><Warehouse /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Site selection persists to localStorage — clear it so one test's
  // choice of site doesn't leak into the next test's initial render.
  try { localStorage.clear(); } catch { /* ignore */ }
  auth.can = () => true;
  api.listWarehouseSites.mockResolvedValue([SITE_A, SITE_B]);
  api.getWarehouseInventory.mockImplementation(async (id: string) =>
    (id === 's1' ? INVENTORY_A : INVENTORY_B));
  api.listContainerStatuses.mockResolvedValue([]);
  api.listContainerTypes.mockResolvedValue([]);
  api.listSites.mockResolvedValue([]);
  api.listAssetStatuses.mockResolvedValue([]);
  api.listClients.mockResolvedValue([]);
  api.listAssetModels.mockResolvedValue([]);
  api.createStockLine.mockResolvedValue({ ...LOOSE_STOCK, id: 'new1' });
  api.updateStockLine.mockResolvedValue(LOOSE_STOCK);
  api.archiveStockLine.mockResolvedValue(undefined);
  api.getAsset.mockResolvedValue({} as AssetItem);
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('selects the first warehouse site and loads its inventory', async () => {
  renderPage();

  expect(await screen.findByDisplayValue('ACC4 Storage')).not.toBeNull();
  expect(await screen.findByText('Pallet A-01')).not.toBeNull();
  expect(screen.getByText('SN-LOOSE')).not.toBeNull();
  expect(screen.getByText('Cage nuts M6')).not.toBeNull();
});

it('shows the KPI tile counts from the loaded inventory', async () => {
  renderPage();
  await screen.findByText('Pallet A-01');

  const tile = (label: string) => screen.getByText(label, { selector: '.dash-kpi-label' }).closest('.dash-kpi');
  expect(tile('Containers')?.textContent).toContain('1');
  expect(tile('Tagged assets')?.textContent).toContain('2');
  expect(tile('Stock lines')?.textContent).toContain('2');
  expect(tile('Units in stock')?.textContent).toContain('64');
});

it('the Stock kind pill leaves only stock rows visible', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Pallet A-01');

  await user.click(screen.getByRole('button', { name: /^Stock/ }));

  expect(screen.queryByText('Pallet A-01')).toBeNull();
  expect(screen.queryByText('SN-LOOSE')).toBeNull();
  expect(screen.getByText('Cage nuts M6')).not.toBeNull();
});

it('expanding a container row reveals its asset and stock contents', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Pallet A-01');

  await user.click(screen.getByText('Pallet A-01'));

  expect(await screen.findByText('SN-IN')).not.toBeNull();
  expect(screen.getByText('PDU, 30A')).not.toBeNull();
});

it('+ Add stock opens the modal, posts the expected payload, and refetches', async () => {
  const user = userEvent.setup();
  renderPage();
  await screen.findByText('Pallet A-01');
  const sitesCallsBefore = api.listWarehouseSites.mock.calls.length;

  await user.click(screen.getByRole('button', { name: '+ Add stock' }));
  await screen.findByText('Add stock · ACC4 Storage');
  const pfInputs = document.querySelectorAll<HTMLInputElement>('.pf-form input');
  await user.type(pfInputs[0], 'Cage nuts');
  await user.type(pfInputs[1], '24');
  await user.click(screen.getByRole('button', { name: /^add stock$/i }));

  await waitFor(() => expect(api.createStockLine).toHaveBeenCalledWith(expect.objectContaining({
    site_id: 's1', description: 'Cage nuts', quantity: 24, unit: 'each',
    container_id: null, model_id: null, location_detail: '', notes: '',
  })));
  await waitFor(() => expect(api.listWarehouseSites.mock.calls.length).toBeGreaterThan(sitesCallsBefore));
});

it('archiving a loose stock line confirms and calls archiveStockLine', async () => {
  const user = userEvent.setup();
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  renderPage();
  await screen.findByText('Cage nuts M6');

  const row = screen.getByText('Cage nuts M6').closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: /archive/i }));

  expect(confirmSpy).toHaveBeenCalled();
  await waitFor(() => expect(api.archiveStockLine).toHaveBeenCalledWith('s3', true));
});

it('shows the empty state copy when no site is typed Warehouse', async () => {
  api.listWarehouseSites.mockResolvedValue([]);
  renderPage();

  expect(await screen.findByText(/No sites are typed Warehouse yet\./)).not.toBeNull();
});

it('ignores a stale getWarehouseInventory response for a previously-selected site after switching', async () => {
  const user = userEvent.setup();
  let resolveA!: (v: WarehouseInventory) => void;
  let resolveB!: (v: WarehouseInventory) => void;
  api.getWarehouseInventory.mockImplementation((id: string) => new Promise((res) => {
    if (id === 's1') resolveA = res; else resolveB = res;
  }));

  renderPage();
  await waitFor(() => expect(api.getWarehouseInventory).toHaveBeenCalledWith('s1'));

  // Switch from the default site (A) to site B before A's request resolves.
  await user.click(screen.getByRole('combobox'));
  await user.click(screen.getByText('DA11 Storage'));
  await waitFor(() => expect(api.getWarehouseInventory).toHaveBeenCalledWith('s2'));

  // B's response (the currently-selected site) lands first...
  resolveB(INVENTORY_B);
  await waitFor(() => expect(screen.getByDisplayValue('DA11 Storage')).not.toBeNull());

  // ...then A's stale, late response for the site the user navigated away
  // from arrives — it must never overwrite what's on screen.
  resolveA(INVENTORY_A);
  await new Promise((r) => setTimeout(r, 0));

  expect(screen.queryByText('Pallet A-01')).toBeNull();
  expect(screen.queryByText('SN-LOOSE')).toBeNull();
  expect(screen.getByDisplayValue('DA11 Storage')).not.toBeNull();
});

it('+ New container preselects the currently selected warehouse site', async () => {
  const user = userEvent.setup();
  api.listSites.mockResolvedValue([SITE_ITEM_A]);
  renderPage();
  await screen.findByText('Pallet A-01');

  await user.click(screen.getByRole('button', { name: '+ New container' }));

  const modal = (await screen.findByText('New container')).closest('.modal-card') as HTMLElement;
  expect(within(modal).getByDisplayValue('ACC4 Storage')).not.toBeNull();
});
