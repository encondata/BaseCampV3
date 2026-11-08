/**
 * The kiosk's local database — a small typed wrapper over IndexedDB (no
 * library, same hand-rolled shape as the portal's `labelCache.ts`). It
 * holds the move's data downloaded after Kiosk Setup, so a kiosk can
 * recognize an asset or a person without the API.
 *
 * Database `serversherpa-kiosk` v8, twelve stores:
 *   - `assets` (keyPath `id`; indexes `rfid`, `asset_id`, `serial_number`)
 *   - `people` (keyPath `id`; index `rfid_tag`)
 *   - `meta`   (keyPath `key`) — the `sync` row: which move, the counts,
 *     and when it was downloaded.
 *   - `outbox` (keyPath `client_scan_id`; index `status`) — v2: scans
 *     waiting to reach the API (see `outbox.ts`).
 *   - `sounds` (keyPath `id`) — v3: sound files uploaded on the Sound
 *     tab (`sound.ts`) or downloaded from the portal, blob and all: the
 *     offline copies of portal sounds, keyed by portal id.
 *   - `containers` (keyPath `id`; indexes `rfid_tag`, `name`) — v4: the
 *     move's crates, so the Containers screen can recognize a scanned
 *     container without a round trip (`containerMatch.ts`).
 *   - `trucks` (keyPath `id`; indexes `name`, `load_number`) — v5: the
 *     move's trucks, so the Trucks screen's card picker can list and
 *     filter them without a round trip (`truckMatch.ts`). Indexed on the
 *     two things a truck is identified by; it carries no RFID tag.
 *   - `label_templates` (keyPath `id`) — v6: the move's label template
 *     set (`/kiosk/sync/label-templates`), so the kiosk can fill in and
 *     print a label without the portal (`labelTemplates.ts`).
 *   - `assets_raw` and `label_templates_raw` (keyPath `key`) — v7: the
 *     last assets and label-template responses as TEXT, one row each,
 *     `{ key: 'body', initiativeId, text }`. The shared label generator
 *     (`labelgen`) reads the bodies exactly as the API wrote them, so a
 *     value like `2.0` is never rewritten by a parse-and-stringify round
 *     trip; the parsed rows in `assets` and `label_templates` serve every
 *     other screen. Separate stores (not `meta` rows) so `replaceAllMulti`
 *     can replace each beside its parsed rows in the one sync transaction.
 *   - `labels` (keyPath `asset_id`) — v7: the generated label for each
 *     asset (written by the web label generator, not by sync), with the
 *     build's `labels` row in `meta` (`writeLabelSet`).
 *
 * Older databases upgrade in place: `onupgradeneeded` only creates the
 * stores that are missing, so a kiosk at v1 through v7 keeps its
 * downloaded move (and its queued scans) and simply gains what it lacks.
 *
 * Unlike the portal's cache, failures here are NOT swallowed: every call
 * is promise-based and a missing IndexedDB, a blocked open, or a failed
 * transaction rejects. `sync.ts` turns that into a visible `'storage'`
 * error rather than a kiosk that silently believes it has data.
 */

const DB_NAME = 'serversherpa-kiosk';
const DB_VERSION = 8;

export type StoreName =
  'assets' | 'people' | 'containers' | 'trucks' | 'label_templates' | 'meta' | 'outbox'
  | 'sounds' | 'assets_raw' | 'label_templates_raw' | 'labels' | 'label_bundles';

/** The downloaded move — what "Clear local data" empties. `containers`,
 *  `trucks` and `label_templates` join it for exactly the reason `assets` and `people` are
 *  here: each is a cached copy of the move, re-downloadable from Kiosk
 *  Setup, and leaving a stale crate or truck list behind after a wipe
 *  would be the one thing that still recognized the previous move. The
 *  raw response texts and the generated `labels` are copies of the move
 *  too — a wipe that left them would still print the previous move.
 *  `outbox` and `sounds` are deliberately NOT here: clearing the cached
 *  roster must never throw away scans that have not reached the API yet,
 *  nor this kiosk's offline copies of its sounds. */
export const STORES: StoreName[] = [
  'assets', 'people', 'containers', 'trucks', 'label_templates', 'assets_raw',
  'label_templates_raw', 'labels', 'label_bundles', 'meta',
];

export const ALL_STORES: StoreName[] = [...STORES, 'outbox', 'sounds'];

export interface MetaRow {
  key: string;
  [field: string]: unknown;
}

/** One stored response body (`assets_raw`, `label_templates_raw`): the
 *  text exactly as the API wrote it, and the move it was downloaded for. */
export interface RawBodyRow {
  key: 'body';
  initiativeId: string;
  text: string;
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
      if (!db.objectStoreNames.contains('trucks')) {
        const trucks = db.createObjectStore('trucks', { keyPath: 'id' });
        trucks.createIndex('name', 'name');
        trucks.createIndex('load_number', 'load_number');
      }
      if (!db.objectStoreNames.contains('label_templates')) {
        db.createObjectStore('label_templates', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('assets_raw')) {
        db.createObjectStore('assets_raw', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('label_templates_raw')) {
        db.createObjectStore('label_templates_raw', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('labels')) {
        db.createObjectStore('labels', { keyPath: 'asset_id' });
      }
      if (!db.objectStoreNames.contains('label_bundles')) {
        db.createObjectStore('label_bundles', { keyPath: 'key' });
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

/** One row by its key, or null when there is none — the web Printing
 *  Station's per-scan label read (one `get`, never the whole store). */
export async function getRow<T = unknown>(store: StoreName, key: IDBValidKey): Promise<T | null> {
  const row = await withStores([store], 'readonly', (tx) =>
    request(tx.objectStore(store).get(key)) as Promise<T | undefined>);
  return row ?? null;
}

export async function readMeta(key: string): Promise<MetaRow | null> {
  const row = await withStores(['meta'], 'readonly', (tx) =>
    request(tx.objectStore('meta').get(key)) as Promise<MetaRow | undefined>);
  return row ?? null;
}

/** The one stored response body for `store`, or null before the first
 *  sync (and after a wipe). */
export async function readRawBody(
  store: 'assets_raw' | 'label_templates_raw',
): Promise<RawBodyRow | null> {
  const row = await withStores([store], 'readonly', (tx) =>
    request(tx.objectStore(store).get('body')) as Promise<RawBodyRow | undefined>);
  return row ?? null;
}

/**
 * The web label build's one write (`webLabels/labelBuild.ts`): the changed
 * `labels` rows put, the removed ones deleted, and its `meta` row, all in
 * ONE transaction, so a reader never sees labels from one build beside
 * another build's meta.
 *
 * Only when the inputs are still there: both raw bodies are read inside
 * the same transaction and must still be exactly the rows the labels were
 * built from. A "Clear local data", or a sync that replaced a body, while
 * the build ran makes this write nothing and resolve false; otherwise a
 * wiped kiosk would get the previous move's labels back the moment a build
 * in flight finished.
 */
export function writeLabelSet(write: {
  builtFrom: { assets: RawBodyRow; templates: RawBodyRow };
  put: readonly unknown[];
  remove: readonly IDBValidKey[];
  meta: { key: string; value: Record<string, unknown> };
}): Promise<boolean> {
  const same = (row: RawBodyRow | undefined, want: RawBodyRow) =>
    row !== undefined && row.initiativeId === want.initiativeId && row.text === want.text;
  return withStores(['assets_raw', 'label_templates_raw', 'labels', 'meta'], 'readwrite', async (tx) => {
    const assets = await request(tx.objectStore('assets_raw').get('body')) as RawBodyRow | undefined;
    const templates = await request(
      tx.objectStore('label_templates_raw').get('body')) as RawBodyRow | undefined;
    if (!same(assets, write.builtFrom.assets) || !same(templates, write.builtFrom.templates)) {
      return false;
    }
    const labels = tx.objectStore('labels');
    for (const key of write.remove) labels.delete(key);
    for (const row of write.put) labels.put(row);
    tx.objectStore('meta').put({ ...write.meta.value, key: write.meta.key });
    return true;
  });
}

export function writeMeta(key: string, value: Record<string, unknown>): Promise<void> {
  return withStores(['meta'], 'readwrite', async (tx) => {
    await request(tx.objectStore('meta').put({ ...value, key }));
  });
}

/** Empties every store INCLUDING the outbox and uploaded sounds — the
 *  Developer tab's Clear Setup, which returns the kiosk to out-of-box for
 *  testing and so must not keep unsent scans or sounds either. The
 *  confirm step says how many unsent scans go with it. */
export function clearEverything(): Promise<void> {
  return withStores(ALL_STORES, 'readwrite', async (tx) => {
    for (const store of ALL_STORES) await request(tx.objectStore(store).clear());
  });
}

/** Empties the move stores (the Developer tab's "Clear local data"). */
export function clearDb(): Promise<void> {
  return withStores(STORES, 'readwrite', async (tx) => {
    for (const store of STORES) await request(tx.objectStore(store).clear());
  });
}
