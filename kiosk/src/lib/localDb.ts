/**
 * The kiosk's local database — a small typed wrapper over IndexedDB (no
 * library, same hand-rolled shape as the portal's `labelCache.ts`). It
 * holds the move's data downloaded after Kiosk Setup, so a kiosk can
 * recognize an asset or a person without the API.
 *
 * Database `serversherpa-kiosk` v1, three stores:
 *   - `assets` (keyPath `id`; indexes `rfid`, `asset_id`, `serial_number`)
 *   - `people` (keyPath `id`; index `rfid_tag`)
 *   - `meta`   (keyPath `key`) — the `sync` row: which move, the counts,
 *     and when it was downloaded.
 *
 * Unlike the portal's cache, failures here are NOT swallowed: every call
 * is promise-based and a missing IndexedDB, a blocked open, or a failed
 * transaction rejects. `sync.ts` turns that into a visible `'storage'`
 * error rather than a kiosk that silently believes it has data.
 */

const DB_NAME = 'serversherpa-kiosk';
const DB_VERSION = 1;

export type StoreName = 'assets' | 'people' | 'meta';

export const STORES: StoreName[] = ['assets', 'people', 'meta'];

export interface MetaRow {
  key: string;
  [field: string]: unknown;
}

function factory(): IDBFactory {
  const f = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
  if (!f) throw new Error('IndexedDB is unavailable');
  return f;
}

// One long-lived connection: the kiosk reads this database on every scan,
// and reopening per call costs a round trip each time. `closeDb()` drops
// it (tests swap in a fresh fake-indexeddb factory between cases).
let dbPromise: Promise<IDBDatabase> | null = null;

export function closeDb(): void {
  const pending = dbPromise;
  dbPromise = null;
  if (pending) void pending.then((db) => db.close()).catch(() => undefined);
}

export function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory().open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('assets')) {
        const assets = db.createObjectStore('assets', { keyPath: 'id' });
        assets.createIndex('rfid', 'rfid');
        assets.createIndex('asset_id', 'asset_id');
        assets.createIndex('serial_number', 'serial_number');
      }
      if (!db.objectStoreNames.contains('people')) {
        db.createObjectStore('people', { keyPath: 'id' }).createIndex('rfid_tag', 'rfid_tag');
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB open blocked'));
  }).catch((err) => {
    dbPromise = null;            // a failed open must not be cached
    throw err;
  });
  return dbPromise;
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** Runs `fn` inside one transaction and resolves once it commits. The
 *  completion promise is created before `fn` runs so a transaction that
 *  auto-commits early is still observed. */
async function withStores<T>(
  stores: StoreName[], mode: IDBTransactionMode, fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  const tx = db.transaction(stores, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
  const result = await fn(tx);
  await done;
  return result;
}

/** Clear + write, in ONE transaction: the store never sits empty as far
 *  as any other reader is concerned, and a write that fails part-way
 *  aborts the clear with it. */
export function replaceAll(store: StoreName, rows: readonly unknown[]): Promise<void> {
  return withStores([store], 'readwrite', async (tx) => {
    const os = tx.objectStore(store);
    await request(os.clear());
    for (const row of rows) await request(os.put(row));
  });
}

export function count(store: StoreName): Promise<number> {
  return withStores([store], 'readonly', (tx) => request(tx.objectStore(store).count()));
}

export function getAll<T = unknown>(store: StoreName): Promise<T[]> {
  return withStores([store], 'readonly', (tx) =>
    request(tx.objectStore(store).getAll()) as Promise<T[]>);
}

export function getByIndex<T = unknown>(
  store: StoreName, index: string, value: IDBValidKey,
): Promise<T[]> {
  return withStores([store], 'readonly', (tx) =>
    request(tx.objectStore(store).index(index).getAll(value)) as Promise<T[]>);
}

export async function readMeta(key: string): Promise<MetaRow | null> {
  const row = await withStores(['meta'], 'readonly', (tx) =>
    request(tx.objectStore('meta').get(key)) as Promise<MetaRow | undefined>);
  return row ?? null;
}

export function writeMeta(key: string, value: Record<string, unknown>): Promise<void> {
  return withStores(['meta'], 'readwrite', async (tx) => {
    await request(tx.objectStore('meta').put({ ...value, key }));
  });
}

/** Empties every store (the Developer tab's "Clear local data"). */
export function clearDb(): Promise<void> {
  return withStores(STORES, 'readwrite', async (tx) => {
    for (const store of STORES) await request(tx.objectStore(store).clear());
  });
}
