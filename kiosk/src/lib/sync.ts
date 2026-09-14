/**
 * Downloading the move's data into the kiosk's local database, and the
 * status store the UI watches while it happens.
 *
 * `runSync(initiativeId, initiativeName)` fetches both sync endpoints in
 * parallel and only then writes `assets` and `people` — a fetch that
 * fails leaves the previously cached rows exactly as they were, so a
 * kiosk that loses the network keeps the move it already has. The meta
 * `sync` row records which move, the two counts, and when, which is also
 * how a reloaded kiosk shows `done` with real counts before anything is
 * fetched again (`hydrateSyncStatus`).
 *
 * The store/hook shape mirrors `setupState.ts` (`useSyncExternalStore`
 * over a module-level snapshot + listener set). Sync outcomes never
 * touch `kiosk_setup_complete`: a kiosk is set up whether or not its
 * local copy downloaded.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { ApiError, fetchAssetsSync, fetchPeopleSync } from './api';
import { readMeta, replaceAll, writeMeta } from './localDb';

export type SyncPhase = 'idle' | 'running' | 'done' | 'error';

export interface SyncStatus {
  phase: SyncPhase;
  assets?: number;
  people?: number;
  syncedAt?: string;
  error?: string;
}

const META_KEY = 'sync';

let status: SyncStatus = { phase: 'idle' };
const listeners = new Set<() => void>();

function setStatus(next: SyncStatus): void {
  status = next;
  listeners.forEach((fn) => fn());
}

export function readSyncStatus(): SyncStatus {
  return status;
}

export function subscribeSyncStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Back to `idle` with no counts — the Developer tab's "Clear local
 *  data" pairs this with `clearDb()`. */
export function resetSyncStatus(): void {
  hydrated = false;
  setStatus({ phase: 'idle' });
}

let hydrated = false;

/** Reads the persisted meta row once per page load so a reload shows
 *  `done` + the counts without re-fetching. Never disturbs a sync that
 *  is already running or finished in this session. */
export async function hydrateSyncStatus(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const row = await readMeta(META_KEY);
    if (!row || status.phase !== 'idle') return;
    setStatus({
      phase: 'done',
      assets: typeof row.assets === 'number' ? row.assets : 0,
      people: typeof row.people === 'number' ? row.people : 0,
      syncedAt: typeof row.syncedAt === 'string' ? row.syncedAt : undefined,
    });
  } catch {
    /* no local database yet (or storage refused): stay idle */
  }
}

/**
 * Fetch both endpoints, then replace both stores. Failure modes:
 * a fetch error reports the `ApiError` code, a database error reports
 * `'storage'`; either way the cached rows are untouched and the status
 * keeps the counts it had so the footer doesn't blink.
 */
export async function runSync(initiativeId: string, initiativeName: string): Promise<void> {
  const previous = status;
  setStatus({ ...previous, phase: 'running', error: undefined });

  let assets: Awaited<ReturnType<typeof fetchAssetsSync>>;
  let people: Awaited<ReturnType<typeof fetchPeopleSync>>;
  try {
    [assets, people] = await Promise.all([fetchAssetsSync(initiativeId), fetchPeopleSync()]);
  } catch (err) {
    setStatus({
      ...previous,
      phase: 'error',
      error: err instanceof ApiError ? err.code : 'unknown_error',
    });
    return;
  }

  try {
    await replaceAll('assets', assets.assets);
    await replaceAll('people', people.people);
    const syncedAt = new Date().toISOString();
    await writeMeta(META_KEY, {
      initiativeId, initiativeName,
      assets: assets.assets.length, people: people.people.length, syncedAt,
    });
    hydrated = true;
    setStatus({
      phase: 'done', assets: assets.assets.length, people: people.people.length, syncedAt,
    });
  } catch {
    setStatus({ ...previous, phase: 'error', error: 'storage' });
  }
}

/** The status snapshot, hydrating from the meta row on first mount. */
export function useSyncStatus(): SyncStatus {
  const snapshot = useSyncExternalStore(subscribeSyncStatus, readSyncStatus);
  useEffect(() => { void hydrateSyncStatus(); }, []);
  return snapshot;
}

/** "synced 2:14 PM" — the time alone; the kiosk syncs per shift, so a
 *  date would be noise on the summary card. */
export function formatSyncedAt(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}
