// @vitest-environment jsdom
/** The kiosk's local IndexedDB store, against fake-indexeddb. */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, it } from 'vitest';

import {
  clearDb, closeDb, count, getAll, getByIndex, readMeta, replaceAll, writeMeta,
} from './localDb';

const asset = (id: string, rfid: string) => ({
  id, asset_id: `10${id}`, name: `asset-${id}`, rfid, serial_number: `SN-${id}`,
  make: 'Cisco', model: 'Nexus', make_model: 'Cisco Nexus', label: { asset_id: `10${id}` },
});

const person = (id: string, tag: string) => ({
  id, display_name: `Person ${id}`, rfid_tag: tag, is_worker: true, has_account: false,
});

beforeEach(() => {
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
});

it('replaceAll clears the store before writing the new rows', async () => {
  await replaceAll('assets', [asset('a', 'R1'), asset('b', 'R2')]);
  expect(await count('assets')).toBe(2);

  await replaceAll('assets', [asset('c', 'R3')]);
  expect(await count('assets')).toBe(1);
  expect((await getAll('assets')).map((r) => (r as { id: string }).id)).toEqual(['c']);
});

it('finds rows through the rfid / asset_id / serial_number indexes', async () => {
  await replaceAll('assets', [asset('a', 'R1'), asset('b', 'R2')]);
  const byRfid = await getByIndex('assets', 'rfid', 'R2');
  expect(byRfid.map((r) => (r as { id: string }).id)).toEqual(['b']);
  expect(await getByIndex('assets', 'asset_id', '10a')).toHaveLength(1);
  expect(await getByIndex('assets', 'serial_number', 'SN-a')).toHaveLength(1);
  expect(await getByIndex('assets', 'rfid', 'nope')).toEqual([]);
});

it('finds a person by rfid_tag', async () => {
  await replaceAll('people', [person('p1', 'W-1'), person('p2', 'W-2')]);
  expect(await count('people')).toBe(2);
  const found = await getByIndex('people', 'rfid_tag', 'W-2');
  expect(found.map((r) => (r as { id: string }).id)).toEqual(['p2']);
});

it('round-trips a meta row', async () => {
  expect(await readMeta('sync')).toBeNull();
  await writeMeta('sync', { initiativeId: 'i-1', assets: 15, people: 4 });
  expect(await readMeta('sync')).toEqual({ key: 'sync', initiativeId: 'i-1', assets: 15, people: 4 });
  await writeMeta('sync', { initiativeId: 'i-2', assets: 1, people: 1 });
  expect(await readMeta('sync')).toMatchObject({ initiativeId: 'i-2' });
});

it('clearDb empties every store', async () => {
  await replaceAll('assets', [asset('a', 'R1')]);
  await replaceAll('people', [person('p1', 'W-1')]);
  await writeMeta('sync', { assets: 1, people: 1 });

  await clearDb();

  expect(await count('assets')).toBe(0);
  expect(await count('people')).toBe(0);
  expect(await readMeta('sync')).toBeNull();
});

it('rejects when IndexedDB is unavailable', async () => {
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory | undefined }).indexedDB = undefined;
  await expect(count('assets')).rejects.toThrow();
});
