// @vitest-environment jsdom
/** Asset Lookup against stubbed lookup endpoints and a real (fake)
 *  IndexedDB for the offline half: one match, several, none, the worker
 *  and admin cards, scan history, the next scan, Clear, and that nothing
 *  is ever written. */
import 'fake-indexeddb/auto';
import {
  cleanup, render, screen, waitFor, within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  lookupAssets: vi.fn(),
  fetchAssetDetail: vi.fn(),
  fetchAssetScans: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...api };
});

const auth = vi.hoisted(() => ({ isAdmin: false }));
vi.mock('../auth/KioskAuthContext', () => ({
  useKioskAuth: () => ({
    status: 'authed', person: { display_name: 'Alex Worker' }, can: () => true,
    isAdmin: auth.isAdmin,
  }),
}));

import type { AssetScanRow } from '@portal/lib/api';

import {
  ApiError, type KioskAssetDetail, type KioskAssetFull, type KioskLookupMatch,
} from '../lib/api';
import { scanWhenText, type LocalAsset } from '../lib/assetLookup';
import { getIdentity } from '../lib/identity';
import { writeKioskSetup } from '../lib/kioskSetup';
import { closeDb, getAll, replaceAll } from '../lib/localDb';
import AssetLookup from './AssetLookup';

const SETUP = {
  initiativeId: 'm1', initiativeName: 'ATL1 Move',
  siteId: 'site-1', siteName: 'ATL1', siteRole: 'source' as const,
  scanStatus: 'cage_exit', scanLabel: 'RFID 1 - Cage Exit',
};

const match = (
  id: string, name: string, over: Partial<KioskLookupMatch> = {},
): KioskLookupMatch => ({
  id, name, asset_tag: '', serial_number: null, matched: ['name'], ...over,
});

const detail = (over: Partial<KioskAssetDetail> = {}): KioskAssetDetail => ({
  id: 'a-web', name: 'atl1-web-001', make: 'Dell', model: 'PowerEdge R640',
  make_model: 'Dell PowerEdge R640', asset_tag: '102466', serial_number: 'SN-WEB-001',
  rfid: '0'.repeat(12) + 'E28011700000',
  routes: [{
    initiative_id: 'm1', initiative_name: 'ATL1 Move',
    source: { site_name: 'ATL1', pod: 'P1', rack: 'R12', ru: '14', position: null },
    destination: { site_name: 'DAL2', pod: 'P7', rack: 'R40', ru: '22', position: null },
  }],
  full: null,
  ...over,
});

const FULL: KioskAssetFull = {
  status: 'packed', status_label: 'Packed', status_color: '#2e7d32',
  moves: [{
    initiative_id: 'm1', initiative_name: 'ATL1 Move',
    status: 'in_progress', status_label: 'In progress', status_color: '#1565c0',
  }],
  container_name: 'ATL1-W1M-DC-01', truck_name: 'ATL1-T01', location_detail: 'Row 4',
};

const SCANNED_AT = '2026-11-08T15:42:00Z';
const SCAN: AssetScanRow = {
  id: 'sc-1', scanned_value: '102466',
  scan_type: 'rfid', scan_type_label: 'RFID', scan_type_color: '#6a1b9a',
  status: 'packed', status_label: 'Packed', status_color: '#2e7d32',
  scanned_at: SCANNED_AT, processed_at: SCANNED_AT,
  device_id: 'KIOSK-ATL1-01', operator_id: 'p1', operator_name: 'Alex Worker',
  site_id: 'site-1', site_name: 'ATL1', location_detail: '', source: 'kiosk',
  off_move: true,
};

const WEB: LocalAsset = {
  id: 'a-web', asset_id: '102466', name: 'atl1-web-001', rfid: '0'.repeat(12) + 'E28011700000',
  serial_number: 'SN-WEB-001', make: 'Dell', model: 'PowerEdge R640',
  make_model: 'Dell PowerEdge R640', container_id: 'c1',
  source_pod: 'P1', source_rack: 'R12', source_ru: '14', source_position: null,
  destination_pod: 'P7', destination_rack: 'R40', destination_ru: '22', destination_position: null,
  asset_status: 'packed', asset_status_label: 'Packed', location_detail: 'Row 4',
};

const render_ = () => render(<MemoryRouter><AssetLookup /></MemoryRouter>);

beforeEach(async () => {
  localStorage.clear();
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  writeKioskSetup(SETUP);
  auth.isAdmin = false;
  api.lookupAssets.mockReset().mockResolvedValue({
    matches: [match('a-web', 'atl1-web-001', { asset_tag: '102466', matched: ['asset_tag'] })],
    truncated: false,
  });
  api.fetchAssetDetail.mockReset().mockResolvedValue(detail());
  api.fetchAssetScans.mockReset().mockResolvedValue([SCAN]);
});

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const input = () => screen.getByLabelText('Asset lookup value') as HTMLInputElement;

async function lookup(value: string): Promise<void> {
  const user = userEvent.setup();
  await user.type(input(), `${value}{Enter}`);
}

it('shows the header with the kiosk move and site', () => {
  render_();
  expect(screen.getByText('Kiosk · Asset Lookup')).toBeTruthy();
  expect(screen.getByRole('heading', { level: 1, name: 'Asset Lookup' })).toBeTruthy();
  expect(screen.getByText('ATL1 Move · ATL1')).toBeTruthy();
  expect(input().placeholder).toBe('Scan or type an asset tag, serial, RFID, or name');
});

it('one match opens the details', async () => {
  render_();
  await lookup('102466');
  expect(await screen.findByRole('heading', { name: 'atl1-web-001' })).toBeTruthy();
  expect(api.lookupAssets).toHaveBeenCalledWith(getIdentity().serial, '102466');
  expect(api.fetchAssetDetail).toHaveBeenCalledWith(getIdentity().serial, 'a-web');
  expect(screen.getByText('Dell PowerEdge R640')).toBeTruthy();
  expect(screen.getByText('SN-WEB-001')).toBeTruthy();
  expect(screen.getByText('E28011700000')).toBeTruthy();
  // A hit empties the box and keeps it focused for the next scan.
  await waitFor(() => expect(document.activeElement).toBe(input()));
  expect(input().value).toBe('');
});

it('several matches show the list, and tapping one opens it', async () => {
  const user = userEvent.setup();
  api.lookupAssets.mockResolvedValue({
    matches: [match('a-1', 'atl1-web-001'), match('a-3', 'atl1-web-003')],
    truncated: false,
  });
  api.fetchAssetDetail.mockResolvedValue(detail({ id: 'a-3', name: 'atl1-web-003' }));
  render_();
  await lookup('atl1-web');

  const table = await screen.findByRole('table');
  expect(within(table).getAllByRole('row').slice(1)).toHaveLength(2);
  expect(within(table).queryByText('Matched on')).toBeNull();
  expect(api.fetchAssetDetail).not.toHaveBeenCalled();

  await user.click(within(table).getByRole('button', { name: 'atl1-web-003' }));
  expect(await screen.findByRole('heading', { name: 'atl1-web-003' })).toBeTruthy();
  expect(api.fetchAssetDetail).toHaveBeenCalledWith(getIdentity().serial, 'a-3');
});

it('exact hits on different devices show what each matched on', async () => {
  api.lookupAssets.mockResolvedValue({
    matches: [
      match('a-web', 'atl1-web-001', { asset_tag: '102466', matched: ['asset_tag'] }),
      match('a-twin', 'twin', { asset_tag: '555', matched: ['rfid'] }),
    ],
    truncated: false,
  });
  render_();
  await lookup('102466');

  const table = await screen.findByRole('table');
  expect(within(table).getByText('Matched on')).toBeTruthy();
  const rows = within(table).getAllByRole('row').slice(1);
  expect(within(rows[0]).getByText('Asset tag')).toBeTruthy();
  expect(within(rows[1]).getByText('RFID')).toBeTruthy();
});

it('more than 25 matches say Refine your search', async () => {
  api.lookupAssets.mockResolvedValue({
    matches: Array.from({ length: 25 }, (_, i) => match(`a-${i}`, `atl1-web-${i}`)),
    truncated: true,
  });
  render_();
  await lookup('atl1');
  expect(await screen.findByText('Refine your search')).toBeTruthy();
});

it('no match says so and keeps the value', async () => {
  api.lookupAssets.mockResolvedValue({ matches: [], truncated: false });
  render_();
  await lookup('nothing-here');
  expect((await screen.findByRole('alert')).textContent).toBe('No asset matches nothing-here.');
  expect(input().value).toBe('nothing-here');
  await waitFor(() => expect(document.activeElement).toBe(input()));
});

it('after a miss the next scan replaces the value', async () => {
  const user = userEvent.setup();
  api.lookupAssets.mockResolvedValueOnce({ matches: [], truncated: false });
  render_();
  await lookup('nothing-here');
  await screen.findByText('No asset matches nothing-here.');
  await waitFor(() => expect(document.activeElement).toBe(input()));

  await user.keyboard('102466{Enter}');
  await waitFor(() => expect(api.lookupAssets).toHaveBeenCalledTimes(2));
  expect(api.lookupAssets).toHaveBeenLastCalledWith(getIdentity().serial, '102466');
  expect(await screen.findByRole('heading', { name: 'atl1-web-001' })).toBeTruthy();
  expect(screen.queryByText('No asset matches nothing-here.')).toBeNull();
});

it('a worker sees source and destination only', async () => {
  render_();
  await lookup('102466');
  await screen.findByRole('heading', { name: 'atl1-web-001' });

  const source = screen.getByRole('group', { name: 'Source' });
  expect(within(source).getByText('ATL1')).toBeTruthy();
  expect(within(source).getByText('P1')).toBeTruthy();
  expect(within(source).getByText('R12')).toBeTruthy();
  expect(within(source).getByText('14')).toBeTruthy();
  const destination = screen.getByRole('group', { name: 'Destination' });
  expect(within(destination).getByText('DAL2')).toBeTruthy();
  expect(within(destination).getByText('R40')).toBeTruthy();

  expect(screen.queryByText('Status')).toBeNull();
  expect(screen.queryByText('Current location')).toBeNull();
  expect(screen.queryByText('Scan history')).toBeNull();
  expect(api.fetchAssetScans).not.toHaveBeenCalled();
});

it('a blank RU with a position set is labeled Position', async () => {
  api.fetchAssetDetail.mockResolvedValue(detail({
    routes: [{
      initiative_id: 'm1', initiative_name: 'ATL1 Move',
      source: { site_name: 'ATL1', pod: null, rack: 'R12', ru: null, position: 'N.2' },
      destination: { site_name: null, pod: null, rack: null, ru: null, position: null },
    }],
  }));
  render_();
  await lookup('102466');
  await screen.findByRole('heading', { name: 'atl1-web-001' });

  const source = screen.getByRole('group', { name: 'Source' });
  expect(within(source).getByText('Position')).toBeTruthy();
  expect(within(source).getByText('N.2')).toBeTruthy();
  expect(within(source).queryByText('RU')).toBeNull();
  const destination = screen.getByRole('group', { name: 'Destination' });
  expect(within(destination).getByText('RU')).toBeTruthy();
  expect(within(destination).getAllByText('—')).toHaveLength(4);
});

it('two routes each sit under their move name', async () => {
  const base = detail().routes[0];
  api.fetchAssetDetail.mockResolvedValue(detail({
    routes: [base, { ...base, initiative_id: 'm2', initiative_name: 'DAL2 Move' }],
  }));
  render_();
  await lookup('102466');
  expect(await screen.findByRole('heading', { level: 3, name: 'ATL1 Move' })).toBeTruthy();
  expect(screen.getByRole('heading', { level: 3, name: 'DAL2 Move' })).toBeTruthy();
  expect(screen.getAllByRole('group', { name: 'Source' })).toHaveLength(2);
});

it('a blank name reads Unnamed asset and blank facts read —', async () => {
  api.fetchAssetDetail.mockResolvedValue(detail({
    name: null, asset_tag: '', serial_number: null, rfid: null,
  }));
  render_();
  await lookup('102466');
  expect(await screen.findByRole('heading', { name: 'Unnamed asset' })).toBeTruthy();
});

it('an admin sees the full card', async () => {
  auth.isAdmin = true;
  api.fetchAssetDetail.mockResolvedValue(detail({ full: FULL }));
  render_();
  await lookup('102466');
  await screen.findByRole('heading', { name: 'atl1-web-001' });

  expect(screen.getByText('Status', { selector: 'dt' })).toBeTruthy();
  expect(screen.getByText('Moves')).toBeTruthy();
  expect(screen.getByText('ATL1 Move')).toBeTruthy();
  expect(screen.getByText('In progress')).toBeTruthy();
  expect(screen.getByText('Current location')).toBeTruthy();
  expect(screen.getByText('ATL1-W1M-DC-01 · on ATL1-T01')).toBeTruthy();

  expect(screen.getByRole('heading', { name: 'Scan history' })).toBeTruthy();
  const history = await screen.findByRole('table', { name: 'Scan history' });
  expect(api.fetchAssetScans).toHaveBeenCalledWith(getIdentity().serial, 'a-web', 50);
  expect(within(history).getByText('Off move')).toBeTruthy();
  const when = scanWhenText(SCANNED_AT);
  expect(within(history).getByText(when)).toBeTruthy();
  expect(when).not.toMatch(/AM|PM/i);
  expect(within(history).getByText('KIOSK-ATL1-01')).toBeTruthy();
  expect(within(history).getByText('Alex Worker')).toBeTruthy();
  expect(within(history).getByText('—')).toBeTruthy();     // blank location
  expect(screen.queryByText('Latest 50 scans shown.')).toBeNull();
});

it('a status with no color is a plain chip', async () => {
  auth.isAdmin = true;
  api.fetchAssetDetail.mockResolvedValue(detail({ full: { ...FULL, status_color: '' } }));
  api.fetchAssetScans.mockResolvedValue([]);
  render_();
  await lookup('102466');
  await screen.findByRole('heading', { name: 'atl1-web-001' });
  const statusFact = screen.getByText('Status', { selector: 'dt' }).parentElement as HTMLElement;
  const chip = within(statusFact).getByText('Packed');
  expect(chip.className).toBe('chip tag');
  expect(chip.getAttribute('style')).toBeNull();
});

it('scan history says when there are 50 rows, none, or an error', async () => {
  auth.isAdmin = true;
  api.fetchAssetDetail.mockResolvedValue(detail({ full: FULL }));
  api.fetchAssetScans.mockResolvedValueOnce(
    Array.from({ length: 50 }, (_, i) => ({ ...SCAN, id: `sc-${i}` })));
  render_();
  await lookup('102466');
  expect(await screen.findByText('Latest 50 scans shown.')).toBeTruthy();

  api.fetchAssetScans.mockResolvedValueOnce([]);
  await lookup('102466');
  expect(await screen.findByText('No scans recorded for this asset.')).toBeTruthy();

  api.fetchAssetScans.mockRejectedValueOnce(new ApiError(500, 'server_error'));
  await lookup('102466');
  expect(await screen.findByText('Could not load scan history.')).toBeTruthy();
});

it('scan history shows only when the device is on a move', async () => {
  auth.isAdmin = true;
  api.fetchAssetDetail.mockResolvedValue(detail({ full: { ...FULL, moves: [] } }));
  render_();
  await lookup('102466');
  await screen.findByRole('heading', { name: 'atl1-web-001' });
  expect(screen.getByText('Current location')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Scan history' })).toBeNull();
  expect(api.fetchAssetScans).not.toHaveBeenCalled();
});

async function seedOffline(): Promise<void> {
  await replaceAll('assets', [WEB]);
  await replaceAll('containers', [{
    id: 'c1', name: 'ATL1-W1M-DC-01', rfid_tag: null, label_tag: null, container_type: null,
    status: 'open', status_label: 'Open', site_id: 'site-1', site_name: 'ATL1', asset_count: 1,
  }]);
  api.lookupAssets.mockRejectedValue(new ApiError(0, 'network'));
  api.fetchAssetDetail.mockRejectedValue(new ApiError(0, 'network'));
}

it('offline, the lookup searches the synced devices and shows its notice', async () => {
  await seedOffline();
  render_();
  await lookup('SN-WEB-001');

  expect((await screen.findByRole('status')).textContent)
    .toBe('Offline — showing this move\'s devices only.');
  expect(await screen.findByRole('heading', { name: 'atl1-web-001' })).toBeTruthy();
  expect(within(screen.getByRole('group', { name: 'Source' })).getByText('R12')).toBeTruthy();
  expect(screen.queryByText('Status')).toBeNull();
  expect(api.fetchAssetScans).not.toHaveBeenCalled();
});

it('offline, an admin also sees the container and that scan history needs a connection', async () => {
  auth.isAdmin = true;
  await seedOffline();
  render_();
  await lookup('SN-WEB-001');

  await screen.findByRole('heading', { name: 'atl1-web-001' });
  expect(screen.getByText('Offline — showing this move\'s devices only.')).toBeTruthy();
  expect(screen.getByText('ATL1-W1M-DC-01')).toBeTruthy();
  expect(screen.getByText('Scan history needs a connection.')).toBeTruthy();
  // The synced status has no color of its own: a plain chip.
  const statusFact = screen.getByText('Status', { selector: 'dt' }).parentElement as HTMLElement;
  expect(within(statusFact).getByText('Packed').className).toBe('chip tag');
  expect(api.fetchAssetScans).not.toHaveBeenCalled();
});

it('the next scan replaces the result', async () => {
  render_();
  await lookup('102466');
  await screen.findByRole('heading', { name: 'atl1-web-001' });

  api.lookupAssets.mockResolvedValue({
    matches: [match('a-db', 'atl1-db-002', { asset_tag: '102467', matched: ['asset_tag'] })],
    truncated: false,
  });
  api.fetchAssetDetail.mockResolvedValue(detail({ id: 'a-db', name: 'atl1-db-002' }));
  await lookup('102467');
  expect(await screen.findByRole('heading', { name: 'atl1-db-002' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'atl1-web-001' })).toBeNull();
});

it('a slow first answer never replaces the second', async () => {
  let resolveFirst: (v: unknown) => void = () => {};
  api.lookupAssets
    .mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }))
    .mockResolvedValueOnce({
      matches: [match('a-db', 'atl1-db-002', { matched: ['asset_tag'] })], truncated: false,
    });
  api.fetchAssetDetail.mockImplementation(async (_s: string, id: string) => (
    id === 'a-db' ? detail({ id: 'a-db', name: 'atl1-db-002' }) : detail()));
  render_();
  await lookup('102466');
  await lookup('102467');
  await screen.findByRole('heading', { name: 'atl1-db-002' });

  resolveFirst({
    matches: [match('a-web', 'atl1-web-001', { matched: ['asset_tag'] })], truncated: false,
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(screen.getByRole('heading', { name: 'atl1-db-002' })).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'atl1-web-001' })).toBeNull();
});

it('the Search button looks up what is in the box', async () => {
  const user = userEvent.setup();
  render_();
  await user.type(input(), '102466');
  await user.click(screen.getByRole('button', { name: 'Search' }));
  expect(await screen.findByRole('heading', { name: 'atl1-web-001' })).toBeTruthy();
  expect(api.lookupAssets).toHaveBeenCalledWith(getIdentity().serial, '102466');
  await waitFor(() => expect(document.activeElement).toBe(input()));
});

it('Clear empties the screen', async () => {
  const user = userEvent.setup();
  render_();
  await lookup('102466');
  await screen.findByRole('heading', { name: 'atl1-web-001' });
  await user.type(input(), 'half');

  await user.click(screen.getByRole('button', { name: 'Clear' }));
  expect(screen.queryByRole('heading', { name: 'atl1-web-001' })).toBeNull();
  expect(input().value).toBe('');
  await waitFor(() => expect(document.activeElement).toBe(input()));
});

it('nothing is ever written to the outbox', async () => {
  render_();
  await lookup('102466');
  await screen.findByRole('heading', { name: 'atl1-web-001' });

  api.lookupAssets.mockResolvedValueOnce({ matches: [], truncated: false });
  await lookup('nothing-here');
  await screen.findByText('No asset matches nothing-here.');

  await seedOffline();
  const user = userEvent.setup();
  await user.clear(input());
  await lookup('SN-WEB-001');
  await screen.findByText('Offline — showing this move\'s devices only.');

  expect(await getAll('outbox')).toEqual([]);
});
