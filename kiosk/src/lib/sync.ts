/**
 * Downloading the move's data into the kiosk's local database, and the
 * status store the UI watches while it happens.
 *
 * `runSync(initiativeId, initiativeName)` fetches all three sync
 * endpoints in parallel and only then writes `assets`, `people`, and
 * `containers` — a fetch that fails leaves the previously cached rows
 * exactly as they were, so a kiosk that loses the network keeps the move
 * it already has. The meta `sync` row records which move, the three
 * counts, and when, which is also how a reloaded kiosk shows `done` with
 * real counts before anything is fetched again (`hydrateSyncStatus`).
 *
 * The store/hook shape mirrors `setupState.ts` (`useSyncExternalStore`
 * over a module-level snapshot + listener set). Sync outcomes never
 * touch `kiosk_setup_complete`: a kiosk is set up whether or not its
 * local copy downloaded.
 */

import { useEffect, useSyncExternalStore } from 'react';

import { ApiError, fetchAssetsSync, fetchContainersSync, fetchPeopleSync } from './api';
import { count, readMeta, replaceAllMulti } from './localDb';

export type SyncPhase = 'idle' | 'running' | 'done' | 'error';

export interface SyncStatus {
  phase: SyncPhase;
  assets?: number;
  people?: number;
  containers?: number;
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
      // A kiosk that last synced before containers shipped has no count
      // in its meta row; 0 is the honest answer until it syncs again.
      containers: typeof row.containers === 'number' ? row.containers : 0,
      syncedAt: typeof row.syncedAt === 'string' ? row.syncedAt : undefined,
    });
  } catch {
    /* no local database yet (or storage refused): stay idle */
  }
}

// Bumped on every call so a superseded run can tell it no longer owns the
// screen: `runSync` closes over the value it read at entry (`myRun`) and
// checks it against this counter before every status update and before
// writing anything, so a slow older run can never clobber a newer one's
// result (see the module docstring's re-entrancy rule).
let currentRun = 0;

/**
 * Fetch all three endpoints, then replace all three stores. Failure modes:
 * a fetch error reports the `ApiError` code, a database error reports
 * `'storage'`; either way the cached rows are untouched and the status
 * keeps the counts it had so the footer doesn't blink.
 *
 * Re-entrancy: calling this again (e.g. "Sync again" tapped while a sync
 * is still running) starts a new run and makes every earlier run's
 * eventual completion a no-op — it writes nothing and reports nothing,
 * so only the newest run's outcome is ever visible.
 */
export async function runSync(initiativeId: string, initiativeName: string): Promise<void> {
  const myRun = ++currentRun;
  const previous = status;
  if (myRun !== currentRun) return;
  setStatus({ ...previous, phase: 'running', error: undefined });

  let assets: Awaited<ReturnType<typeof fetchAssetsSync>>;
  let people: Awaited<ReturnType<typeof fetchPeopleSync>>;
  let containers: Awaited<ReturnType<typeof fetchContainersSync>>;
  try {
    [assets, people, containers] = await Promise.all([
      fetchAssetsSync(initiativeId), fetchPeopleSync(), fetchContainersSync(initiativeId),
    ]);
  } catch (err) {
    if (myRun !== currentRun) return;
    setStatus({
      ...previous,
      phase: 'error',
      error: err instanceof ApiError ? err.code : 'unknown_error',
    });
    return;
  }

  if (myRun !== currentRun) return;
  try {
    const syncedAt = new Date().toISOString();
    // assets, people, containers, and the meta pointer land in ONE
    // transaction — see `replaceAllMulti` — so a reader (or a reload)
    // never sees them half-updated.
    await replaceAllMulti(
      [
        { store: 'assets', rows: assets.assets },
        { store: 'people', rows: people.people },
        { store: 'containers', rows: containers.containers },
      ],
      {
        key: META_KEY,
        value: {
          initiativeId, initiativeName,
          assets: assets.assets.length, people: people.people.length,
          containers: containers.containers.length, syncedAt,
        },
      },
    );
    if (myRun !== currentRun) return;
    // Counts come from the store itself, not the fetched payloads' lengths
    // — what actually landed is what the kiosk should report.
    const [assetsCount, peopleCount, containersCount] = await Promise.all([
      count('assets'), count('people'), count('containers'),
    ]);
    if (myRun !== currentRun) return;
    hydrated = true;
    setStatus({
      phase: 'done', assets: assetsCount, people: peopleCount,
      containers: containersCount, syncedAt,
    });
  } catch {
    if (myRun !== currentRun) return;
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
