/**
 * The checkpoint an RFID enrollment records — kiosk-local, like
 * `devMode.ts` (same store/hook shape, same try/catch around a
 * localStorage that may be blocked or full).
 *
 * It is one key from the portal's asset status vocabulary, the same
 * list Kiosk Setup's scan-type step offers (`getSetupOptions()`'s
 * `scan_types`), and it defaults to `pre_stage` — "we have the tag,
 * the asset is ready to move" — which is what enrollment means in
 * practice. The row that sets it lives on Settings › Admin on purpose:
 * it decides what every enrollment on this kiosk records, and a worker
 * should not be able to change what the move's data says without an
 * admin knowing.
 *
 * A stored key can go stale (a checkpoint renamed or retired in the
 * portal); `effectiveEnrollStatus` falls back to the default rather
 * than offering a key the server would now refuse.
 */

import { useSyncExternalStore } from 'react';

const KEY = 'ss.kiosk.enrollStatus';

export const DEFAULT_ENROLL_STATUS = 'pre_stage';

type Listener = () => void;

const listeners = new Set<Listener>();

function read(): string {
  try {
    return localStorage.getItem(KEY) || DEFAULT_ENROLL_STATUS;
  } catch {
    return DEFAULT_ENROLL_STATUS;
  }
}

export function readEnrollStatus(): string {
  return read();
}

/** Persists the choice and notifies subscribers; false when storage refuses. */
export function writeEnrollStatus(key: string): boolean {
  try {
    localStorage.setItem(KEY, key);
  } catch {
    return false;
  }
  listeners.forEach((fn) => fn());
  return true;
}

export function subscribeEnrollStatus(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The stored key, or the default when the portal no longer offers it.
 *  An empty `offered` means the options have not loaded yet — not that
 *  everything was retired — so the stored key stands. */
export function effectiveEnrollStatus(stored: string, offered: readonly string[]): string {
  if (offered.length === 0) return stored;
  return offered.includes(stored) ? stored : DEFAULT_ENROLL_STATUS;
}

export function useEnrollStatus(): [string, (key: string) => boolean] {
  const key = useSyncExternalStore(subscribeEnrollStatus, readEnrollStatus);
  return [key, writeEnrollStatus];
}
