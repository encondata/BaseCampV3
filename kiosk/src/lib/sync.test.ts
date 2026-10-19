// @vitest-environment jsdom
/** runSync against fake-indexeddb with a mocked API layer. */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  fetchAssetsSync: vi.fn(),
  fetchPeopleSync: vi.fn(),
  fetchContainersSync: vi.fn(),
  fetchTrucksSync: vi.fn(),
  fetchLabelTemplatesSync: vi.fn(),
}));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return {
    ...actual,
    fetchAssetsSync: apiMock.fetchAssetsSync,
    fetchPeopleSync: apiMock.fetchPeopleSync,
    fetchContainersSync: apiMock.fetchContainersSync,
    fetchTrucksSync: apiMock.fetchTrucksSync,
    fetchLabelTemplatesSync: apiMock.fetchLabelTemplatesSync,
  };
});

import { ApiError } from './api';
import { clearDb, closeDb, count, getAll, readMeta, replaceAll, writeMeta } from './localDb';
import { clearKioskSetup, writeKioskSetup } from './kioskSetup';
import { getLabelTemplates } from './labelTemplates';
import { readSyncStatus, resetSyncStatus, runSync } from './sync';

const ASSETS = {
  initiative_id: 'i-1', initiative_name: 'NAP11 Hall Migration (demo)',
  generated_at: '2026-09-13T12:00:00Z',
  assets: [
    {
      id: 'a-1', asset_id: '10482', name: 'core-sw-01', rfid: 'E280', serial_number: 'C7X',
      make: 'Cisco', model: 'Nexus', make_model: 'Cisco Nexus',
      label: { asset_id: '10482', move_name: 'NAP11 Hall Migration (demo)' },
    },
    {
      id: 'a-2', asset_id: '10483', name: 'core-sw-02', rfid: 'E281', serial_number: 'C7Y',
      make: 'Cisco', model: 'Nexus', make_model: 'Cisco Nexus', label: { asset_id: '10483' },
    },
  ],
};

const CONTAINERS = {
  initiative_id: 'i-1', generated_at: '2026-09-13T12:00:00Z',
  containers: [
    {
      id: 'c-1', name: 'SC-DAL_PAL-001', rfid_tag: 'E290', label_tag: 'priority',
      container_type: 'shipping_container', status: 'available',
      status_label: 'Available', site_id: 's-1', site_name: 'ACC4', asset_count: 2,
    },
    {
      id: 'c-2', name: 'SC-DAL_PAL-002', rfid_tag: null, label_tag: null,
      container_type: 'pelican_case', status: 'available', status_label: 'Available',
      site_id: null, site_name: null, asset_count: 0,
    },
  ],
};

const TRUCKS = {
  initiative_id: 'i-1', generated_at: '2026-09-13T12:00:00Z',
  trucks: [
    {
      id: 't-1', name: 'TRUCK-1', load_number: 'L-1042', status: 'in_transit',
      status_label: 'In Transit', driver_name: 'Dana Driver',
      start_site_id: 's-1', start_site_name: 'NAP11',
      end_site_id: 's-2', end_site_name: 'ACC4', container_count: 3,
    },
    {
      id: 't-2', name: 'TRUCK-2', load_number: 'L-1043', status: 'created',
      status_label: 'Created', driver_name: null,
      start_site_id: null, start_site_name: null,
      end_site_id: null, end_site_name: null, container_count: 0,
    },
  ],
};

function template(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id, name, label_type: 'top', size_key: '4x6', dpi_key: '203', language_key: 'zpl',
    version: 1, updated_at: '2026-10-19T12:00:00Z', move_site_names: [], reasons: ['generic'],
    code: '^XA^FD{asset_name}^FS^XZ', generation_rules: {}, width_in: 4, height_in: 6,
    dots: 203, error: null, ...extra,
  };
}

const LABEL_TEMPLATES = {
  initiative_id: 'i-1', generated_at: '2026-10-19T12:00:00Z',
  templates: [
    template('lt-1', 'Container Label 4x6 203dpi', { label_type: 'container', reasons: ['container'] }),
    template('lt-2', 'Generic Rack and RU', { reasons: ['fallback', 'generic'] }),
  ],
};

const PEOPLE = {
  generated_at: '2026-09-13T12:00:00Z',
  people: [
    { id: 'p-1', display_name: 'Wanda Worker', rfid_tag: 'W-1', is_worker: true, has_account: false },
  ],
};

beforeEach(() => {
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  resetSyncStatus();
  apiMock.fetchAssetsSync.mockReset();
  apiMock.fetchPeopleSync.mockReset();
  apiMock.fetchContainersSync.mockReset();
  apiMock.fetchTrucksSync.mockReset();
  apiMock.fetchLabelTemplatesSync.mockReset();
  apiMock.fetchLabelTemplatesSync.mockResolvedValue(LABEL_TEMPLATES);
});

it('writes all four stores and the meta row, and reports done with counts', async () => {
  apiMock.fetchAssetsSync.mockResolvedValue(ASSETS);
  apiMock.fetchPeopleSync.mockResolvedValue(PEOPLE);
  apiMock.fetchContainersSync.mockResolvedValue(CONTAINERS);
  apiMock.fetchTrucksSync.mockResolvedValue(TRUCKS);

  await runSync('i-1', 'NAP11 Hall Migration (demo)');

  expect(apiMock.fetchAssetsSync).toHaveBeenCalledWith('i-1');
  expect(apiMock.fetchContainersSync).toHaveBeenCalledWith('i-1');
  expect(apiMock.fetchTrucksSync).toHaveBeenCalledWith('i-1');
  expect(await count('assets')).toBe(2);
  expect(await count('people')).toBe(1);
  expect(await count('containers')).toBe(2);
  expect(await count('trucks')).toBe(2);
  expect((await getAll('trucks')).map((r) => (r as { name: string }).name).sort())
    .toEqual(['TRUCK-1', 'TRUCK-2']);
  expect(await readMeta('sync')).toMatchObject({
    key: 'sync', initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
    assets: 2, people: 1, containers: 2, trucks: 2,
  });
  const status = readSyncStatus();
  expect(status.phase).toBe('done');
  expect(status.assets).toBe(2);
  expect(status.people).toBe(1);
  expect(status.containers).toBe(2);
  expect(status.trucks).toBe(2);
  expect(status.syncedAt).toBeTruthy();
});

it('a failed assets fetch reports the ApiError code and leaves cached rows alone', async () => {
  await replaceAll('assets', [{ id: 'old', asset_id: '1', rfid: 'X' }]);
  apiMock.fetchAssetsSync.mockRejectedValue(new ApiError(500, 'server_error'));
  apiMock.fetchPeopleSync.mockResolvedValue(PEOPLE);
  apiMock.fetchContainersSync.mockResolvedValue(CONTAINERS);
  apiMock.fetchTrucksSync.mockResolvedValue(TRUCKS);

  await runSync('i-1', 'A Move');

  expect(readSyncStatus()).toMatchObject({ phase: 'error', error: 'server_error' });
  expect((await getAll('assets')).map((r) => (r as { id: string }).id)).toEqual(['old']);
  expect(await count('people')).toBe(0);
  expect(await count('containers')).toBe(0);
  expect(await count('trucks')).toBe(0);
  expect(await readMeta('sync')).toBeNull();
});

it('a storage failure reports error "storage"', async () => {
  apiMock.fetchAssetsSync.mockResolvedValue(ASSETS);
  apiMock.fetchPeopleSync.mockResolvedValue(PEOPLE);
  apiMock.fetchContainersSync.mockResolvedValue(CONTAINERS);
  apiMock.fetchTrucksSync.mockResolvedValue(TRUCKS);
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory | undefined }).indexedDB = undefined;

  await runSync('i-1', 'A Move');

  expect(readSyncStatus()).toMatchObject({ phase: 'error', error: 'storage' });
});

it('reports counts from the store, not the fetched payload length', async () => {
  // Two rows sharing the same `id` collapse to one record in the store —
  // the status/meta counts must reflect that, not `assets.length`.
  const dupAssets = { ...ASSETS, assets: [ASSETS.assets[0], { ...ASSETS.assets[0] }] };
  apiMock.fetchAssetsSync.mockResolvedValue(dupAssets);
  apiMock.fetchPeopleSync.mockResolvedValue(PEOPLE);
  apiMock.fetchContainersSync.mockResolvedValue(CONTAINERS);
  apiMock.fetchTrucksSync.mockResolvedValue(TRUCKS);

  await runSync('i-1', 'A Move');

  expect(await count('assets')).toBe(1);
  expect(readSyncStatus()).toMatchObject({
    phase: 'done', assets: 1, people: 1, containers: 2, trucks: 2,
  });
});

it('a newer sync supersedes an older one: a superseded run writes and reports nothing', async () => {
  let resolveAAssets!: (v: typeof ASSETS) => void;
  let resolveAPeople!: (v: typeof PEOPLE) => void;
  let resolveAContainers!: (v: typeof CONTAINERS) => void;
  let resolveBAssets!: (v: typeof ASSETS) => void;
  let resolveBPeople!: (v: typeof PEOPLE) => void;
  let resolveBContainers!: (v: typeof CONTAINERS) => void;
  let resolveATrucks!: (v: typeof TRUCKS) => void;
  let resolveBTrucks!: (v: typeof TRUCKS) => void;

  apiMock.fetchAssetsSync
    .mockImplementationOnce(() => new Promise((res) => { resolveAAssets = res; }))
    .mockImplementationOnce(() => new Promise((res) => { resolveBAssets = res; }));
  apiMock.fetchPeopleSync
    .mockImplementationOnce(() => new Promise((res) => { resolveAPeople = res; }))
    .mockImplementationOnce(() => new Promise((res) => { resolveBPeople = res; }));
  apiMock.fetchContainersSync
    .mockImplementationOnce(() => new Promise((res) => { resolveAContainers = res; }))
    .mockImplementationOnce(() => new Promise((res) => { resolveBContainers = res; }));
  apiMock.fetchTrucksSync
    .mockImplementationOnce(() => new Promise((res) => { resolveATrucks = res; }))
    .mockImplementationOnce(() => new Promise((res) => { resolveBTrucks = res; }));

  const runA = runSync('i-1', 'Move A');
  const runB = runSync('i-2', 'Move B');

  resolveAAssets(ASSETS);
  resolveAPeople(PEOPLE);
  resolveAContainers(CONTAINERS);
  resolveATrucks(TRUCKS);
  await runA;

  // A's writes never happened — B is still in flight.
  expect(await count('assets')).toBe(0);
  expect(await count('people')).toBe(0);
  expect(await count('containers')).toBe(0);
  expect(await count('trucks')).toBe(0);
  expect(await readMeta('sync')).toBeNull();
  expect(readSyncStatus().phase).toBe('running');

  const assetsForB = { ...ASSETS, initiative_name: 'Move B', assets: [ASSETS.assets[0]] };
  resolveBAssets(assetsForB);
  resolveBPeople(PEOPLE);
  resolveBContainers({ ...CONTAINERS, containers: [CONTAINERS.containers[0]] });
  resolveBTrucks({ ...TRUCKS, trucks: [TRUCKS.trucks[0]] });
  await runB;

  expect(await count('assets')).toBe(1);
  expect(await count('containers')).toBe(1);
  expect(await count('trucks')).toBe(1);
  expect(await readMeta('sync')).toMatchObject({ initiativeId: 'i-2', initiativeName: 'Move B' });
  expect(readSyncStatus()).toMatchObject({
    phase: 'done', assets: 1, people: 1, containers: 1, trucks: 1,
  });
});

it('clearing the local data resets the status to idle', async () => {
  apiMock.fetchAssetsSync.mockResolvedValue(ASSETS);
  apiMock.fetchPeopleSync.mockResolvedValue(PEOPLE);
  apiMock.fetchContainersSync.mockResolvedValue(CONTAINERS);
  apiMock.fetchTrucksSync.mockResolvedValue(TRUCKS);
  await runSync('i-1', 'A Move');
  expect(readSyncStatus().phase).toBe('done');

  await clearDb();
  resetSyncStatus();

  expect(readSyncStatus()).toEqual({ phase: 'idle' });
  expect(await count('assets')).toBe(0);
  expect(await count('containers')).toBe(0);
  expect(await count('trucks')).toBe(0);
});


// ── the move's label template set (kiosk label templates download §4) ──

function mockMove(): void {
  apiMock.fetchAssetsSync.mockResolvedValue(ASSETS);
  apiMock.fetchPeopleSync.mockResolvedValue(PEOPLE);
  apiMock.fetchContainersSync.mockResolvedValue(CONTAINERS);
  apiMock.fetchTrucksSync.mockResolvedValue(TRUCKS);
}

it('stores the move\'s label templates with the sync', async () => {
  mockMove();
  await runSync('i-1', 'A Move');

  expect(apiMock.fetchLabelTemplatesSync).toHaveBeenCalledWith('i-1');
  expect(readSyncStatus().phase).toBe('done');
  const stored = await getLabelTemplates();
  expect(stored.map((t) => t.id)).toEqual(['lt-1', 'lt-2']);
  expect(stored[1]).toMatchObject({
    name: 'Generic Rack and RU', reasons: ['fallback', 'generic'],
    code: '^XA^FD{asset_name}^FS^XZ', dots: 203,
  });
});

it('a failed template fetch keeps the old set and the sync still succeeds', async () => {
  mockMove();
  await runSync('i-1', 'A Move');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  apiMock.fetchLabelTemplatesSync.mockRejectedValue(new ApiError(500, 'server_error'));
  apiMock.fetchAssetsSync.mockResolvedValue({ ...ASSETS, assets: [ASSETS.assets[0]] });

  await runSync('i-1', 'A Move');

  expect(readSyncStatus()).toMatchObject({ phase: 'done', assets: 1 });
  expect(await count('assets')).toBe(1);                 // the rest of the move landed
  expect((await getLabelTemplates()).map((t) => t.id)).toEqual(['lt-1', 'lt-2']);
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
});

it('a failed template fetch on the first sync leaves an empty set and still succeeds', async () => {
  mockMove();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  apiMock.fetchLabelTemplatesSync.mockRejectedValue(new TypeError('Failed to fetch'));

  await runSync('i-1', 'A Move');

  expect(readSyncStatus()).toMatchObject({ phase: 'done', assets: 2, trucks: 2 });
  expect(await getLabelTemplates()).toEqual([]);
  warn.mockRestore();
});

it('a failed template fetch for a different move drops the previous move\'s set', async () => {
  mockMove();
  await runSync('i-1', 'Move A');
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  apiMock.fetchLabelTemplatesSync.mockRejectedValue(new ApiError(500, 'server_error'));

  await runSync('i-2', 'Move B');

  expect(readSyncStatus().phase).toBe('done');
  expect(await getLabelTemplates()).toEqual([]);         // never Move A's templates on Move B
  warn.mockRestore();
});

it('a stale sync meta row never keeps another move\'s templates', async () => {
  mockMove();
  await runSync('i-1', 'Move A');
  // a crash after the move commit but before the template write
  await writeMeta('sync', { initiativeId: 'i-2', initiativeName: 'Move B' });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  apiMock.fetchLabelTemplatesSync.mockRejectedValue(new ApiError(500, 'server_error'));

  await runSync('i-2', 'Move B');

  expect(await getAll('label_templates')).toEqual([]);
  warn.mockRestore();
});

it('getLabelTemplates is empty when the set belongs to another move than the setup', async () => {
  mockMove();
  await runSync('i-1', 'Move A');
  const setup = {
    initiativeName: 'x', siteId: 's', siteName: 's', siteRole: 'source' as const,
    scanStatus: 'x', scanLabel: 'x',
  };
  try {
    writeKioskSetup({ ...setup, initiativeId: 'i-2' });
    expect(await getLabelTemplates()).toEqual([]);
    writeKioskSetup({ ...setup, initiativeId: 'i-1' });
    expect((await getLabelTemplates()).length).toBe(2);
  } finally {
    clearKioskSetup();
  }
});

it('a second sync replaces the set, removing a template that no longer matches', async () => {
  mockMove();
  await runSync('i-1', 'A Move');
  apiMock.fetchLabelTemplatesSync.mockResolvedValue({
    ...LABEL_TEMPLATES,
    templates: [template('lt-2', 'Generic Rack and RU', { version: 2, reasons: ['generic'] })],
  });

  await runSync('i-1', 'A Move');

  const stored = await getLabelTemplates();
  expect(stored.map((t) => [t.id, t.version])).toEqual([['lt-2', 2]]);
});

it('getLabelTemplates returns the set in natural name order', async () => {
  mockMove();
  apiMock.fetchLabelTemplatesSync.mockResolvedValue({
    ...LABEL_TEMPLATES,
    templates: [
      template('z', 'Rack 10'), template('a', 'Rack 9'), template('m', 'Front'),
    ],
  });
  await runSync('i-1', 'A Move');
  expect((await getLabelTemplates()).map((t) => t.name)).toEqual(['Front', 'Rack 9', 'Rack 10']);
});

it('a superseded run never writes its templates', async () => {
  mockMove();
  let resolveA!: (v: typeof LABEL_TEMPLATES) => void;
  apiMock.fetchLabelTemplatesSync
    .mockImplementationOnce(() => new Promise((res) => { resolveA = res; }))
    .mockResolvedValueOnce({ ...LABEL_TEMPLATES, templates: [template('b-1', 'B only')] });

  const runA = runSync('i-1', 'Move A');
  await vi.waitFor(() => expect(apiMock.fetchLabelTemplatesSync).toHaveBeenCalledTimes(1));
  await runSync('i-2', 'Move B');
  resolveA(LABEL_TEMPLATES);
  await runA;

  expect((await getLabelTemplates()).map((t) => t.id)).toEqual(['b-1']);
  expect(readSyncStatus().phase).toBe('done');
});

it('clearing the local data empties the template set', async () => {
  mockMove();
  await runSync('i-1', 'A Move');
  expect(await count('label_templates')).toBe(2);
  await clearDb();
  expect(await count('label_templates')).toBe(0);
});
