import 'fake-indexeddb/auto';
import { beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from './api';
import * as api from './api';
import {
  assetDetail, findAssets, loadLocalLookup, localDetail, matchLocal, scanWhenText,
  type LocalAsset, type LocalLookupData,
} from './assetLookup';
import { closeDb, replaceAllMulti } from './localDb';

vi.mock('./api', async (orig) => ({
  ...(await orig<typeof import('./api')>()),
  lookupAssets: vi.fn(),
  fetchAssetDetail: vi.fn(),
}));

const row = (over: Partial<LocalAsset> & { id: string }): LocalAsset => ({
  asset_id: '', name: null, rfid: null, serial_number: null, make: null, model: null,
  make_model: '', container_id: null,
  source_pod: null, source_rack: null, source_ru: null, source_position: null,
  destination_pod: null, destination_rack: null, destination_ru: null, destination_position: null,
  asset_status: null, asset_status_label: null, location_detail: null, ...over,
});
const WEB = row({
  id: 'a-web', asset_id: '102466', name: 'atl1-web-001', serial_number: 'SN-WEB-001',
  rfid: '0'.repeat(12) + 'E28011700000', container_id: 'c1',
  source_rack: 'A1', source_ru: '14', asset_status: 'packed', asset_status_label: 'Packed',
  location_detail: 'Row 4',
});
const TWIN = row({ id: 'a-twin', asset_id: '555', name: 'twin', rfid: '0'.repeat(18) + '102466' });

const DATA: LocalLookupData = {
  assets: [WEB, TWIN], containerNames: new Map([['c1', 'ATL1-W1M-DC-01']]),
  moveId: 'm1', moveName: 'Move 1', sourceSite: 'ATL1', destinationSite: 'DAL2',
};

beforeEach(() => {
  vi.mocked(api.lookupAssets).mockReset();
  vi.mocked(api.fetchAssetDetail).mockReset();
});

it('matchLocal finds each exact key ignoring case and spaces', () => {
  const r1 = matchLocal([WEB], ' sn-web-001 ');
  expect(r1.matches).toMatchObject([{ id: 'a-web', matched: ['serial'] }]);
  const r2 = matchLocal([WEB], 'e28011700000');
  expect(r2.matches).toMatchObject([{ id: 'a-web', matched: ['rfid'] }]);
});

it("matchLocal returns both devices when an asset tag is another device's RFID", () => {
  const r = matchLocal([WEB, TWIN], '102466');
  expect(r.matches).toMatchObject([
    { id: 'a-web', matched: ['asset_tag'] }, { id: 'a-twin', matched: ['rfid'] },
  ]);
});

it('matchLocal never matches a padded RFID to an asset tag', () => {
  const r = matchLocal([WEB, TWIN], '0'.repeat(18) + '102466');
  expect(r.matches.map((m) => m.id)).toEqual(['a-twin']);
});

it('matchLocal falls back to part of a name and caps at 25', () => {
  const bulk = Array.from({ length: 30 }, (_, i) =>
    row({ id: `b${i}`, name: `bulk-rack-${String(i + 1).padStart(2, '0')}` }));
  const r = matchLocal([...bulk].reverse(), 'BULK');
  expect(r.matches).toHaveLength(25);
  expect(r.truncated).toBe(true);
  expect(r.matches[0].name).toBe('bulk-rack-01');
});

it('localDetail hides the full card below admin and names the container for an admin', () => {
  const admin = localDetail(WEB, DATA, true);
  expect(admin.full?.container_name).toBe('ATL1-W1M-DC-01');
  expect(admin.full?.moves).toEqual([]);
  expect(admin.full?.truck_name).toBeNull();
  expect(localDetail(WEB, DATA, false).full).toBeNull();
  expect(admin.routes[0].source.site_name).toBe('ATL1');
  expect(admin.routes[0].destination.site_name).toBe('DAL2');
  expect(admin.routes[0].source.rack).toBe('A1');
});

async function seed() {
  closeDb();
  globalThis.indexedDB = new IDBFactory();
  await replaceAllMulti(
    [
      { store: 'assets', rows: [WEB, TWIN] },
      { store: 'assets_raw', rows: [{
        key: 'body', initiativeId: 'm1',
        text: JSON.stringify({ label_context: { source_site: 'ATL1', destination_site: 'DAL2' } }),
      }] },
      { store: 'containers', rows: [{ id: 'c1', name: 'ATL1-W1M-DC-01' }] },
    ],
    { key: 'sync', value: { initiativeId: 'm1', initiativeName: 'Move 1' } },
  );
}

it('loadLocalLookup reads the synced move', async () => {
  await seed();
  const d = await loadLocalLookup();
  expect(d.assets).toHaveLength(2);
  expect(d.containerNames.get('c1')).toBe('ATL1-W1M-DC-01');
  expect([d.moveId, d.moveName, d.sourceSite, d.destinationSite])
    .toEqual(['m1', 'Move 1', 'ATL1', 'DAL2']);
});

it('loadLocalLookup is empty before any sync', async () => {
  closeDb();
  globalThis.indexedDB = new IDBFactory();
  const d = await loadLocalLookup();
  expect(d.assets).toEqual([]);
  expect(d.sourceSite).toBeNull();
});

it('falls back to the synced devices when the network is down', async () => {
  await seed();
  vi.mocked(api.lookupAssets).mockRejectedValue(new ApiError(0, 'network'));
  const r = await findAssets('k1', 'sn-web-001');
  expect(r.offline).toBe(true);
  expect(r.result.matches[0].id).toBe('a-web');
});

it('falls back to the synced devices when the cloud needs a sign-in', async () => {
  await seed();
  vi.mocked(api.lookupAssets).mockRejectedValue(new ApiError(403, 'cloud_sign_in_required'));
  const r = await findAssets('k1', 'sn-web-001');
  expect(r.offline).toBe(true);
});

it('other errors are not hidden', async () => {
  vi.mocked(api.lookupAssets).mockRejectedValue(new ApiError(500, 'unknown_error'));
  await expect(findAssets('k1', 'x')).rejects.toBeInstanceOf(ApiError);
});

it('answers online when the server does', async () => {
  vi.mocked(api.lookupAssets).mockResolvedValue({ matches: [], truncated: false });
  expect(await findAssets('k1', 'x')).toEqual({ offline: false, result: { matches: [], truncated: false } });
});

it('assetDetail uses the synced data offline and null for an unknown asset', async () => {
  await seed();
  const hit = await assetDetail('k1', 'a-web', true, true);
  expect(hit.offline).toBe(true);
  expect(hit.detail?.full?.container_name).toBe('ATL1-W1M-DC-01');
  expect((await assetDetail('k1', 'nope', true, true)).detail).toBeNull();
  expect(api.fetchAssetDetail).not.toHaveBeenCalled();
});

it('assetDetail falls back when the online call fails offline-style', async () => {
  await seed();
  vi.mocked(api.fetchAssetDetail).mockRejectedValue(new ApiError(0, 'network'));
  const r = await assetDetail('k1', 'a-web', false, false);
  expect(r.offline).toBe(true);
  expect(r.detail?.full).toBeNull();
});

it('scanWhenText is 24-hour', () => {
  const t = scanWhenText('2026-11-08T23:05:00Z');
  expect(t).toMatch(/\d{2}:\d{2}/);
  expect(t).not.toMatch(/AM|PM/i);
});
