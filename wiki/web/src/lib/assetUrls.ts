/** Presigned URLs for page assets (images, embedded files), resolved in
 *  batches: every id asked for in the same tick goes out in one
 *  `POST /wiki/assets/urls` (at most 200 per request), and answers are
 *  kept for 8 minutes — well inside the URLs' lifetime. An id the API
 *  leaves out isn't viewable and resolves to null. */
import { getAssetUrls } from './wikiApi';

const TTL_MS = 8 * 60_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_BATCH = 200;

interface Waiter {
  resolve: (url: string | null) => void;
  reject: (err: unknown) => void;
}

const cache = new Map<string, { url: string | null; at: number }>();
let pending = new Map<string, Waiter[]>();
let scheduled = false;

async function flush(): Promise<void> {
  scheduled = false;
  const batch = pending;
  pending = new Map();
  const ids = [...batch.keys()];
  for (let i = 0; i < ids.length; i += MAX_BATCH) {
    const chunk = ids.slice(i, i + MAX_BATCH);
    try {
      const urls = await getAssetUrls(chunk);
      const at = Date.now();
      for (const id of chunk) {
        const url = urls[id] ?? urls[id.toLowerCase()] ?? null;
        cache.set(id, { url, at });
        batch.get(id)?.forEach((w) => w.resolve(url));
      }
    } catch (err) {
      for (const id of chunk) batch.get(id)?.forEach((w) => w.reject(err));
    }
  }
}

/** The asset's URL, or null when it's gone or not viewable. */
export function resolveAssetUrl(id: string): Promise<string | null> {
  // documents are client-written: a malformed id would fail its whole batch
  if (!UUID.test(id)) return Promise.resolve(null);
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit.url);
  return new Promise((resolve, reject) => {
    const waiters = pending.get(id) ?? [];
    waiters.push({ resolve, reject });
    pending.set(id, waiters);
    if (!scheduled) {
      scheduled = true;
      setTimeout(() => { void flush(); }, 0);
    }
  });
}

/** Forget every cached URL (tests; sign-out). */
export function clearAssetUrls(): void {
  cache.clear();
}
