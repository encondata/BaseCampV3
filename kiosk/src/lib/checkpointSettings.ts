/**
 * The checkpoints this kiosk's non-scanning screens record — kiosk-local,
 * like `devMode.ts` (same store/hook shape, same try/catch around a
 * localStorage that may be blocked or full).
 *
 * Each one is a key from the portal's asset status vocabulary, the same
 * list Kiosk Setup's scan-type step offers (`getSetupOptions()`'s
 * `scan_types`). There are three today and they differ only in their
 * storage key, their default, and their label, so they share one module
 * rather than three near-copies of it:
 *
 *   - `enroll` — RFID Enroll, default `pre_stage` ("we have the tag, the
 *     asset is ready to move", which is what enrollment means).
 *   - `containerPack` — Containers › Pack, default `in_container`.
 *   - `containerUnpack` — Containers › Unpack, default `un_pack`.
 *
 * The rows that set them live on Settings › Admin on purpose: each
 * decides what every scan of its kind on this kiosk records, and a
 * worker should not be able to change what the move's data says without
 * an admin knowing.
 *
 * A stored key can go stale (a checkpoint renamed or retired in the
 * portal); `effectiveCheckpoint` falls back to that checkpoint's own
 * default rather than offering a key the server would now refuse.
 */

import { useSyncExternalStore } from 'react';

export type CheckpointId = 'enroll' | 'containerPack' | 'containerUnpack';

interface CheckpointDef {
  /** The localStorage key. `enroll`'s predates this module and is kept
   *  verbatim so a kiosk already configured does not silently revert. */
  storageKey: string;
  fallback: string;
}

const DEFS: Record<CheckpointId, CheckpointDef> = {
  enroll: { storageKey: 'ss.kiosk.enrollStatus', fallback: 'pre_stage' },
  containerPack: { storageKey: 'ss.kiosk.containerPackStatus', fallback: 'in_container' },
  containerUnpack: { storageKey: 'ss.kiosk.containerUnpackStatus', fallback: 'un_pack' },
};

export function defaultCheckpoint(id: CheckpointId): string {
  return DEFS[id].fallback;
}

type Listener = () => void;

const listeners = new Set<Listener>();

export function readCheckpoint(id: CheckpointId): string {
  const def = DEFS[id];
  try {
    return localStorage.getItem(def.storageKey) || def.fallback;
  } catch {
    return def.fallback;
  }
}

/** Persists the choice and notifies subscribers; false when storage
 *  refuses. Every subscriber is notified, not just this checkpoint's —
 *  there are three keys and a handful of listeners, so a precise
 *  fan-out would cost more than the re-read it saves. */
export function writeCheckpoint(id: CheckpointId, key: string): boolean {
  try {
    localStorage.setItem(DEFS[id].storageKey, key);
  } catch {
    return false;
  }
  listeners.forEach((fn) => fn());
  return true;
}

export function subscribeCheckpoints(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The stored key, or this checkpoint's default when the portal no
 *  longer offers it. An empty `offered` means the options have not
 *  loaded yet — not that everything was retired — so the stored key
 *  stands. */
export function effectiveCheckpoint(
  id: CheckpointId, stored: string, offered: readonly string[],
): string {
  if (offered.length === 0) return stored;
  return offered.includes(stored) ? stored : DEFS[id].fallback;
}

export function useCheckpoint(id: CheckpointId): [string, (key: string) => boolean] {
  const key = useSyncExternalStore(subscribeCheckpoints, () => readCheckpoint(id));
  return [key, (next: string) => writeCheckpoint(id, next)];
}
