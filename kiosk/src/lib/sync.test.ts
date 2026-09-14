// @vitest-environment jsdom
/** runSync against fake-indexeddb with a mocked API layer. */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  fetchAssetsSync: vi.fn(),
  fetchPeopleSync: vi.fn(),
}));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, fetchAssetsSync: apiMock.fetchAssetsSync, fetchPeopleSync: apiMock.fetchPeopleSync };
});

import { ApiError } from './api';
import { clearDb, closeDb, count, getAll, readMeta, replaceAll } from './localDb';
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
});

it('writes both stores and the meta row, and reports done with counts', async () => {
  apiMock.fetchAssetsSync.mockResolvedValue(ASSETS);
  apiMock.fetchPeopleSync.mockResolvedValue(PEOPLE);

  await runSync('i-1', 'NAP11 Hall Migration (demo)');

  expect(apiMock.fetchAssetsSync).toHaveBeenCalledWith('i-1');
  expect(await count('assets')).toBe(2);
  expect(await count('people')).toBe(1);
  expect(await readMeta('sync')).toMatchObject({
    key: 'sync', initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration (demo)',
    assets: 2, people: 1,
  });
  const status = readSyncStatus();
  expect(status.phase).toBe('done');
  expect(status.assets).toBe(2);
  expect(status.people).toBe(1);
  expect(status.syncedAt).toBeTruthy();
});

it('a failed assets fetch reports the ApiError code and leaves cached rows alone', async () => {
  await replaceAll('assets', [{ id: 'old', asset_id: '1', rfid: 'X' }]);
  apiMock.fetchAssetsSync.mockRejectedValue(new ApiError(500, 'server_error'));
  apiMock.fetchPeopleSync.mockResolvedValue(PEOPLE);

  await runSync('i-1', 'A Move');

  expect(readSyncStatus()).toMatchObject({ phase: 'error', error: 'server_error' });
  expect((await getAll('assets')).map((r) => (r as { id: string }).id)).toEqual(['old']);
  expect(await count('people')).toBe(0);
  expect(await readMeta('sync')).toBeNull();
});

it('a storage failure reports error "storage"', async () => {
  apiMock.fetchAssetsSync.mockResolvedValue(ASSETS);
  apiMock.fetchPeopleSync.mockResolvedValue(PEOPLE);
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory | undefined }).indexedDB = undefined;

  await runSync('i-1', 'A Move');

  expect(readSyncStatus()).toMatchObject({ phase: 'error', error: 'storage' });
});

it('clearing the local data resets the status to idle', async () => {
  apiMock.fetchAssetsSync.mockResolvedValue(ASSETS);
  apiMock.fetchPeopleSync.mockResolvedValue(PEOPLE);
  await runSync('i-1', 'A Move');
  expect(readSyncStatus().phase).toBe('done');

  await clearDb();
  resetSyncStatus();

  expect(readSyncStatus()).toEqual({ phase: 'idle' });
  expect(await count('assets')).toBe(0);
});
