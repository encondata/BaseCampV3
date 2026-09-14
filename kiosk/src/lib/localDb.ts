/**
 * The kiosk's local database — a small typed wrapper over IndexedDB (no
 * library, same hand-rolled shape as the portal's `labelCache.ts`). It
 * holds the move's data downloaded after Kiosk Setup, so a kiosk can
 * recognize an asset or a person without the API.
 *
 * Database `serversherpa-kiosk` v4, six stores:
 *   - `assets` (keyPath `id`; indexes `rfid`, `asset_id`, `serial_number`)
 *   - `people` (keyPath `id`; index `rfid_tag`)
 *   - `meta`   (keyPath `key`) — the `sync` row: which move, the counts,
 *     and when it was downloaded.
 *   - `outbox` (keyPath `client_scan_id`; index `status`) — v2: scans
 *     waiting to reach the API (see `outbox.ts`).
 *   - `sounds` (keyPath `id`) — v3: sound files uploaded on the Sound
 *     tab (`sound.ts`), blob and all. They live on this kiosk only.
 *   - `containers` (keyPath `id`; indexes `rfid_tag`, `name`) — v4: the
 *     move's crates, so the Containers screen can recognize a scanned
 *     container without a round trip (`containerMatch.ts`).
 *
 * Older databases upgrade in place: `onupgradeneeded` only creates the
 * stores that are missing, so a kiosk at v1, v2, or v3 keeps its
 * downloaded move (and its queued scans) and simply gains what it lacks.
 *
 * Unlike the portal's cache, failures here are NOT swallowed: every call
 * is promise-based and a missing IndexedDB, a blocked open, or a failed
 * transaction rejects. `sync.ts` turns that into a visible `'storage'`
 * error rather than a kiosk that silently believes it has data.
 */

const DB_NAME = 'serversherpa-kiosk';
const DB_VERSION = 4;

export type StoreName = 'assets' | 'people' | 'containers' | 'meta' | 'outbox' | 'sounds';

/** The downloaded move — what "Clear local data" empties. `containers`
 *  joins it for exactly the reason `assets` and `people` are here: it is
 *  a cached copy of the move, re-downloadable from Kiosk Setup, and
 *  leaving a stale crate list behind after a wipe would be the one thing
 *  that still recognized the previous move. `outbox` and `sounds` are
 *  deliberately NOT here: clearing the cached roster must never throw
 *  away scans that have not reached the API yet, nor the sound files
 *  someone uploaded to this kiosk. */
export const STORES: StoreName[] = ['assets', 'people', 'containers', 'meta'];

export const ALL_STORES: StoreName[] = [...STORES, 'outbox', 'sounds'];

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
      if (!db.objectStoreNames.contains('outbox')) {
        db.createObjectStore('outbox', { keyPath: 'client_scan_id' }).createIndex('status', 'status');
      }
      if (!db.objectStoreNames.contains('sounds')) db.createObjectStore('sounds', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('containers')) {
        const containers = db.createObjectStore('containers', { keyPath: 'id' });
        containers.createIndex('rfid_tag', 'rfid_tag');
        containers.createIndex('name', 'name');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab (or this kiosk's next version) asking for a higher
      // version is blocked for as long as this connection stays open —
      // which, on a kiosk left on a screen for weeks, is forever. Yield
      // the connection instead: the next call reopens at the new
      // version. Found live: three stale tabs pinned the database at v1
      // and the Scanning page simply never became usable.
      db.onversionchange = () => {
        // Drop the cached promise BEFORE closing: an `openDb()` call
        // arriving in the gap between `close()` and some later cleanup
        // must not hand back a connection already on its way out —
        // it needs to see nothing cached and open a fresh one.
        dbPromise = null;
        db.close();
      };
      resolve(db);
    };
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
 *  auto-commits early is still observed. `done` gets a no-op `.catch`
 *  right away so an aborted transaction never surfaces as an
 *  `unhandledrejection`: when `fn` itself throws, execution never reaches
 *  `await done` below, and without this the later rejection (fired once
 *  IDB actually aborts the transaction) would have no observer at all. */
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
  done.catch(() => undefined);
  let result: T;
  try {
    result = await fn(tx);
  } catch (err) {
    // `fn` can throw synchronously — e.g. `put()` on a keyPath store
    // throws immediately (not via `onerror`) when a row is missing its
    // key — without the transaction itself ever hearing about it; left
    // alone, it would just commit whatever had already been queued.
    // Abort explicitly so a mid-write failure rolls back every store in
    // this transaction together, not just the write that failed.
    try { tx.abort(); } catch { /* already finished */ }
    await done.catch(() => undefined);
    throw err;
  }
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
    // Issue every put without awaiting it individually — awaiting each one
    // in turn works but is needlessly slow, and the transaction stays open
    // only as long as every await it sees resolves via an IDB request of
    // its own (not some other microtask/timer), so keeping this loop
    // synchronous is what keeps IDB from committing early. A put that
    // fails still surfaces: it aborts the transaction, which rejects
    // `done` above — the promise `withStores`' caller awaits.
    for (const row of rows) os.put(row);
  });
}

/** Writes several stores' rows (and, when given, one `meta` row) in ONE
 *  transaction — used to keep `assets`, `people`, and the `sync` meta
 *  pointer consistent as a group: a failure in any of them aborts the
 *  whole write, so a reader never sees a new `people` list paired with
 *  the previous move's `assets` (or a `meta` row pointing at data that
 *  never landed). Resolves with each store's row count, read via
 *  `count()` inside the same transaction — after that store's puts, so it
 *  reflects what actually landed (duplicate keys collapse) rather than
 *  the length of the array the caller passed in. */
export function replaceAllMulti(
  entries: { store: StoreName; rows: readonly unknown[] }[],
  meta?: { key: string; value: Record<string, unknown> },
): Promise<Partial<Record<StoreName, number>>> {
  const stores = entries.map((e) => e.store);
  const txStores = meta ? [...stores, 'meta' as StoreName] : stores;
  return withStores(txStores, 'readwrite', async (tx) => {
    const counts: Partial<Record<StoreName, number>> = {};
    for (const { store, rows } of entries) {
      const os = tx.objectStore(store);
      await request(os.clear());
      for (const row of rows) os.put(row);
      counts[store] = await request(os.count());
    }
    if (meta) tx.objectStore('meta').put({ ...meta.value, key: meta.key });
    return counts;
  });
}

/** Writes rows without clearing the store first — the outbox's update
 *  path, where every write is an upsert of a handful of known keys and
 *  the rest of the queue must survive it. One transaction, so a batch
 *  that moves ten rows to `sending` either all moves or none does. */
export function putRows(store: StoreName, rows: readonly unknown[]): Promise<void> {
  return withStores([store], 'readwrite', async (tx) => {
    const os = tx.objectStore(store);
    for (const row of rows) os.put(row);
  });
}

/** Deletes rows by key, in one transaction (the outbox's "Clear sent"). */
export function deleteRows(store: StoreName, keys: readonly IDBValidKey[]): Promise<void> {
  return withStores([store], 'readwrite', async (tx) => {
    const os = tx.objectStore(store);
    for (const key of keys) os.delete(key);
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
