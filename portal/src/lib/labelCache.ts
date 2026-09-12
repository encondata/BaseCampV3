/**
 * Print Labels' offline cache — a small typed wrapper over IndexedDB (no
 * library). Two stores: `initiatives` (the initiative item + its asset
 * roster, keyed by initiative id) and `bundles` (one generated-label
 * bundle per initiative + label type, keyed `${initiativeId}:${labelType}`).
 * Every call degrades to a no-op/null when IndexedDB is unavailable
 * (private mode, jsdom without fake-indexeddb) so the page never depends
 * on it. Behavior contract: the spec's "Offline mechanics" section.
 */
import type { GeneratedLabelBundle, InitiativeAssetRow, InitiativeItem } from './api';

const DB_NAME = 'basecamp-labels';
const DB_VERSION = 1;
const STORE_INITIATIVES = 'initiatives';
const STORE_BUNDLES = 'bundles';

export interface CachedInitiative {
  initiative: InitiativeItem;
  roster: InitiativeAssetRow[];
  cached_at: string;
}

export interface CachedBundle extends GeneratedLabelBundle {
  initiative_name: string;
  cached_at: string;
}

/** Summary of a cached bundle — counts only, no ZPL `code` strings — for
 *  UI that only needs to render a count and an age (the header button,
 *  the Offline cache modal's table). */
export interface CachedBundleSummary {
  initiative_id: string;
  initiative_name: string;
  label_type: string;
  cached_at: string;
  label_count: number;
}

type StoredInitiative = CachedInitiative & { id: string };
type StoredBundle = CachedBundle & { key: string };

export function bundleKey(initiativeId: string, labelType: string): string {
  return `${initiativeId}:${labelType}`;
}

function factory(): IDBFactory | null {
  try {
    const f = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
    return f ?? null;
  } catch {
    return null;
  }
}

export function cacheAvailable(): boolean {
  return factory() !== null;
}

function openDb(): Promise<IDBDatabase | null> {
  const f = factory();
  if (!f) return Promise.resolve(null);
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = f.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_INITIATIVES)) db.createObjectStore(STORE_INITIATIVES, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(STORE_BUNDLES)) db.createObjectStore(STORE_BUNDLES, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Run `fn` inside a transaction over `stores`; resolves `fallback` when
 *  IndexedDB is unavailable or the transaction fails. The completion
 *  promise is created before `fn` runs so a transaction that
 *  auto-commits before `oncomplete` is attached is still observed. */
async function withStore<T>(
  stores: string[], mode: IDBTransactionMode, fallback: T,
  fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  const db = await openDb();
  if (!db) return fallback;
  try {
    const tx = db.transaction(stores, mode);
    const done = new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    const result = await fn(tx);
    await done;
    return result;
  } catch {
    return fallback;
  } finally {
    db.close();
  }
}

const stamp = () => new Date().toISOString();

export function putInitiative(entry: Omit<CachedInitiative, 'cached_at'>): Promise<void> {
  const stored: StoredInitiative = { ...entry, id: entry.initiative.id, cached_at: stamp() };
  return withStore([STORE_INITIATIVES], 'readwrite', undefined, async (tx) => {
    await request(tx.objectStore(STORE_INITIATIVES).put(stored));
  });
}

export function getInitiative(initiativeId: string): Promise<CachedInitiative | null> {
  return withStore([STORE_INITIATIVES], 'readonly', null, async (tx) => {
    const got = (await request(tx.objectStore(STORE_INITIATIVES).get(initiativeId))) as StoredInitiative | undefined;
    return got ?? null;
  });
}

export function listInitiatives(): Promise<CachedInitiative[]> {
  return withStore([STORE_INITIATIVES], 'readonly', [], async (tx) =>
    (await request(tx.objectStore(STORE_INITIATIVES).getAll())) as StoredInitiative[]);
}

export function putBundle(bundle: GeneratedLabelBundle, initiativeName: string): Promise<void> {
  const stored: StoredBundle = {
    ...bundle, initiative_name: initiativeName, cached_at: stamp(),
    key: bundleKey(bundle.initiative_id, bundle.label_type),
  };
  return withStore([STORE_BUNDLES], 'readwrite', undefined, async (tx) => {
    await request(tx.objectStore(STORE_BUNDLES).put(stored));
  });
}

export function getBundle(initiativeId: string, labelType: string): Promise<CachedBundle | null> {
  return withStore([STORE_BUNDLES], 'readonly', null, async (tx) => {
    const got = (await request(tx.objectStore(STORE_BUNDLES).get(bundleKey(initiativeId, labelType)))) as StoredBundle | undefined;
    return got ?? null;
  });
}

export function listBundles(): Promise<CachedBundle[]> {
  return withStore([STORE_BUNDLES], 'readonly', [], async (tx) =>
    (await request(tx.objectStore(STORE_BUNDLES).getAll())) as StoredBundle[]);
}

/** Like `listBundles`, but drops each bundle's `labels` (the ZPL `code`
 *  strings) down to a count — nothing large stays referenced once the
 *  returned promise resolves and `all` goes out of scope. */
export function listBundleSummaries(): Promise<CachedBundleSummary[]> {
  return withStore([STORE_BUNDLES], 'readonly', [], async (tx) => {
    const all = (await request(tx.objectStore(STORE_BUNDLES).getAll())) as StoredBundle[];
    return all.map((b) => ({
      initiative_id: b.initiative_id,
      initiative_name: b.initiative_name,
      label_type: b.label_type,
      cached_at: b.cached_at,
      label_count: b.labels.length,
    }));
  });
}

export function deleteBundle(initiativeId: string, labelType: string): Promise<void> {
  return withStore([STORE_BUNDLES], 'readwrite', undefined, async (tx) => {
    await request(tx.objectStore(STORE_BUNDLES).delete(bundleKey(initiativeId, labelType)));
  });
}

export function deleteInitiative(initiativeId: string): Promise<void> {
  return withStore([STORE_INITIATIVES, STORE_BUNDLES], 'readwrite', undefined, async (tx) => {
    await request(tx.objectStore(STORE_INITIATIVES).delete(initiativeId));
    const bundles = tx.objectStore(STORE_BUNDLES);
    const all = (await request(bundles.getAll())) as StoredBundle[];
    for (const b of all) {
      if (b.initiative_id === initiativeId) await request(bundles.delete(b.key));
    }
  });
}

export function clearAll(): Promise<void> {
  return withStore([STORE_INITIATIVES, STORE_BUNDLES], 'readwrite', undefined, async (tx) => {
    await request(tx.objectStore(STORE_INITIATIVES).clear());
    await request(tx.objectStore(STORE_BUNDLES).clear());
  });
}
