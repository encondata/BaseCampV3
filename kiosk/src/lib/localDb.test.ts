// @vitest-environment jsdom
/** The kiosk's local IndexedDB store, against fake-indexeddb. */
import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { beforeEach, expect, it } from 'vitest';

import {
  clearDb, closeDb, count, deleteRows, getAll, getByIndex, openDb, putRows, readMeta, replaceAll,
  replaceAllMulti, writeMeta,
} from './localDb';

const asset = (id: string, rfid: string) => ({
  id, asset_id: `10${id}`, name: `asset-${id}`, rfid, serial_number: `SN-${id}`,
  make: 'Cisco', model: 'Nexus', make_model: 'Cisco Nexus', label: { asset_id: `10${id}` },
});

const person = (id: string, tag: string) => ({
  id, display_name: `Person ${id}`, rfid_tag: tag, is_worker: true, has_account: false,
});

const container = (id: string, name: string, tag: string | null) => ({
  id, name, rfid_tag: tag, label_tag: null, container_type: 'shipping_container',
  status: 'available', status_label: 'Available', site_id: null, site_name: null,
  asset_count: 0,
});

const truck = (id: string, name: string, loadNumber: string | null) => ({
  id, name, load_number: loadNumber, status: 'in_transit', status_label: 'In Transit',
  driver_name: null, start_site_id: null, start_site_name: null,
  end_site_id: null, end_site_name: null, container_count: 0,
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
  await replaceAll('containers', [container('c-1', 'SC-DAL_PAL-001', 'R-1')]);
  await replaceAll('trucks', [truck('t-1', 'TRUCK-1', 'L-1042')]);
  await writeMeta('sync', { assets: 1, people: 1, containers: 1, trucks: 1 });

  await clearDb();

  expect(await count('assets')).toBe(0);
  expect(await count('people')).toBe(0);
  // Containers and trucks are cached move data like the roster, so a wipe
  // takes them too — otherwise a stale list would outlive the move.
  expect(await count('containers')).toBe(0);
  expect(await count('trucks')).toBe(0);
  expect(await readMeta('sync')).toBeNull();
});

it('rejects when IndexedDB is unavailable', async () => {
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory | undefined }).indexedDB = undefined;
  await expect(count('assets')).rejects.toThrow();
});

it('replaceAllMulti writes several stores and a meta row in one go', async () => {
  const counts = await replaceAllMulti(
    [
      { store: 'assets', rows: [asset('a', 'R1'), asset('b', 'R2')] },
      { store: 'people', rows: [person('p1', 'W-1')] },
    ],
    { key: 'sync', value: { initiativeId: 'i-1', syncedAt: '2026-09-13T12:00:00Z' } },
  );
  expect(counts).toEqual({ assets: 2, people: 1 });
  expect(await count('assets')).toBe(2);
  expect(await count('people')).toBe(1);
  expect(await readMeta('sync')).toMatchObject({ initiativeId: 'i-1' });
});

it('replaceAllMulti aborts every store together when one write is invalid', async () => {
  await replaceAll('assets', [asset('old', 'R0')]);

  await expect(replaceAllMulti(
    [
      { store: 'assets', rows: [asset('a', 'R1')] },
      // No `id`: keyPath 'id' makes this an invalid key, which aborts the
      // whole transaction — the `assets` put above must not survive it.
      { store: 'people', rows: [{ display_name: 'No id' }] },
    ],
    { key: 'sync', value: { initiativeId: 'i-1' } },
  )).rejects.toThrow();

  expect((await getAll('assets')).map((r) => (r as { id: string }).id)).toEqual(['old']);
  expect(await count('people')).toBe(0);
  expect(await readMeta('sync')).toBeNull();
});

it('v5 carries the outbox, the sounds, the containers, and the trucks store', async () => {
  const db = await openDb();
  expect(db.version).toBe(5);
  expect([...db.objectStoreNames].sort())
    .toEqual(['assets', 'containers', 'meta', 'outbox', 'people', 'sounds', 'trucks']);
});

it('finds a truck by name and by load_number', async () => {
  await replaceAll('trucks', [truck('t-1', 'TRUCK-1', 'L-1042'), truck('t-2', 'TRUCK-2', null)]);
  expect(await count('trucks')).toBe(2);
  expect((await getByIndex('trucks', 'name', 'TRUCK-2'))
    .map((r) => (r as { id: string }).id)).toEqual(['t-2']);
  expect((await getByIndex('trucks', 'load_number', 'L-1042'))
    .map((r) => (r as { id: string }).id)).toEqual(['t-1']);
});

it('finds a container by rfid_tag and by name', async () => {
  await replaceAll('containers', [
    container('c-1', 'SC-DAL_PAL-001', 'R-1'), container('c-2', 'SC-DAL_PAL-002', null),
  ]);
  expect(await count('containers')).toBe(2);
  expect((await getByIndex('containers', 'rfid_tag', 'R-1'))
    .map((r) => (r as { id: string }).id)).toEqual(['c-1']);
  expect((await getByIndex('containers', 'name', 'SC-DAL_PAL-002'))
    .map((r) => (r as { id: string }).id)).toEqual(['c-2']);
});

it('upgrades a v1 database in place, keeping its rows and adding the outbox', async () => {
  // Build a v1 database by hand — exactly what a kiosk that synced
  // before the outbox shipped has on disk.
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('serversherpa-kiosk', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('assets', { keyPath: 'id' }).createIndex('rfid', 'rfid');
      db.createObjectStore('people', { keyPath: 'id' }).createIndex('rfid_tag', 'rfid_tag');
      db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
  await replaceAll('assets', [asset('a', 'R1')]);
  closeDb();

  const db = await openDb();
  expect(db.version).toBe(5);
  expect(db.objectStoreNames.contains('outbox')).toBe(true);
  expect(db.objectStoreNames.contains('sounds')).toBe(true);
  expect(db.objectStoreNames.contains('containers')).toBe(true);
  expect(db.objectStoreNames.contains('trucks')).toBe(true);
  expect(await count('assets')).toBe(1);
});

it('upgrades a v2 database in place, keeping its outbox and adding sounds', async () => {
  // A kiosk that scanned before the Sound tab shipped: queued scans must
  // survive the upgrade that adds the sounds store.
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('serversherpa-kiosk', 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('assets', { keyPath: 'id' }).createIndex('rfid', 'rfid');
      db.createObjectStore('people', { keyPath: 'id' }).createIndex('rfid_tag', 'rfid_tag');
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('outbox', { keyPath: 'client_scan_id' }).createIndex('status', 'status');
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
  await putRows('outbox', [{ client_scan_id: 's1', status: 'queued' }]);
  closeDb();

  const db = await openDb();
  expect(db.version).toBe(5);
  expect(db.objectStoreNames.contains('sounds')).toBe(true);
  expect(db.objectStoreNames.contains('containers')).toBe(true);
  expect(db.objectStoreNames.contains('trucks')).toBe(true);
  expect(await count('outbox')).toBe(1);
});

it('upgrades a v3 database in place, keeping its data and adding containers', async () => {
  // A kiosk that synced before the Containers screen shipped: its
  // downloaded move and its queued scans must both survive.
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('serversherpa-kiosk', 3);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('assets', { keyPath: 'id' }).createIndex('rfid', 'rfid');
      db.createObjectStore('people', { keyPath: 'id' }).createIndex('rfid_tag', 'rfid_tag');
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('outbox', { keyPath: 'client_scan_id' }).createIndex('status', 'status');
      db.createObjectStore('sounds', { keyPath: 'id' });
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
  await replaceAll('assets', [asset('a', 'R1')]);
  await putRows('outbox', [{ client_scan_id: 's1', status: 'queued' }]);
  closeDb();

  const db = await openDb();
  expect(db.version).toBe(5);
  expect(db.objectStoreNames.contains('containers')).toBe(true);
  expect(db.objectStoreNames.contains('trucks')).toBe(true);
  expect(await count('assets')).toBe(1);
  expect(await count('outbox')).toBe(1);
  expect(await count('containers')).toBe(0);
  expect(await count('trucks')).toBe(0);
});

it('upgrades a v4 database in place, keeping its containers and adding trucks', async () => {
  // A kiosk that synced before the Trucks screen shipped: its downloaded
  // move — crates included — and its queued scans must all survive.
  await new Promise<void>((resolve, reject) => {
    const req = indexedDB.open('serversherpa-kiosk', 4);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore('assets', { keyPath: 'id' }).createIndex('rfid', 'rfid');
      db.createObjectStore('people', { keyPath: 'id' }).createIndex('rfid_tag', 'rfid_tag');
      db.createObjectStore('meta', { keyPath: 'key' });
      db.createObjectStore('outbox', { keyPath: 'client_scan_id' }).createIndex('status', 'status');
      db.createObjectStore('sounds', { keyPath: 'id' });
      const containers = db.createObjectStore('containers', { keyPath: 'id' });
      containers.createIndex('rfid_tag', 'rfid_tag');
      containers.createIndex('name', 'name');
    };
    req.onsuccess = () => { req.result.close(); resolve(); };
    req.onerror = () => reject(req.error);
  });
  await replaceAll('assets', [asset('a', 'R1')]);
  await replaceAll('containers', [container('c-1', 'SC-DAL_PAL-001', 'R-1')]);
  await putRows('outbox', [{ client_scan_id: 's1', status: 'queued' }]);
  closeDb();

  const db = await openDb();
  expect(db.version).toBe(5);
  expect(db.objectStoreNames.contains('trucks')).toBe(true);
  expect(await count('assets')).toBe(1);
  expect(await count('containers')).toBe(1);
  expect(await count('outbox')).toBe(1);
  expect(await count('trucks')).toBe(0);
});

it('putRows upserts without clearing, and deleteRows removes by key', async () => {
  await putRows('outbox', [
    { client_scan_id: 's1', status: 'queued' }, { client_scan_id: 's2', status: 'queued' },
  ]);
  await putRows('outbox', [{ client_scan_id: 's1', status: 'accepted' }]);
  const rows = await getAll<{ client_scan_id: string; status: string }>('outbox');
  expect(rows.map((r) => [r.client_scan_id, r.status]).sort())
    .toEqual([['s1', 'accepted'], ['s2', 'queued']]);

  await deleteRows('outbox', ['s1']);
  expect((await getAll('outbox')).length).toBe(1);
});

it('clearDb leaves the outbox and uploaded sounds alone — neither is local cache', async () => {
  await replaceAll('assets', [asset('a', 'R1')]);
  await replaceAll('containers', [container('c-1', 'SC-DAL_PAL-001', 'R-1')]);
  await replaceAll('trucks', [truck('t-1', 'TRUCK-1', 'L-1042')]);
  await putRows('outbox', [{ client_scan_id: 's1', status: 'queued' }]);
  await putRows('sounds', [{ id: 'snd-1', name: 'ding.wav', type: 'audio/wav', size: 3 }]);
  await clearDb();
  expect(await count('assets')).toBe(0);
  expect(await count('containers')).toBe(0);
  expect(await count('trucks')).toBe(0);
  expect(await count('outbox')).toBe(1);
  expect(await count('sounds')).toBe(1);   // an upload is the operator's file, not cache
});

it('closes its connection when another tab needs a higher version', async () => {
  await replaceAll('assets', [asset('a', 'R1')]);
  await openDb();

  // Exactly what a newer tab does: open the same database one version
  // up. Without the `versionchange` handler this rejects as blocked and
  // the newer tab hangs forever — which is what happened live, where
  // three stale tabs pinned the database at v1 and the Scanning page
  // never became usable.
  const upgraded = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('serversherpa-kiosk', 6);
    req.onupgradeneeded = () => req.result.createObjectStore('later', { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('blocked — the old connection never yielded'));
  });
  expect(upgraded.version).toBe(6);
  expect(upgraded.objectStoreNames.contains('assets')).toBe(true);
  upgraded.close();
});
