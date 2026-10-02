/**
 * Clear Setup, kiosk side. The portal queues a request; the heartbeat
 * reply carries its id (`clear_setup`) until a later beat sends it back
 * (`setup_cleared`). This module is the kiosk-local memory of that
 * exchange, in localStorage like `setupState.ts` (same try/catch idiom):
 *
 *   { id, acked, notice }
 *   - id:     the last request applied — never applied twice, even
 *             across a reload;
 *   - acked:  false while the server may not know yet (keep sending it);
 *   - notice: the "an administrator cleared this kiosk's setup" banner
 *             is up (cleared when setup completes).
 *
 * Queued scans (outbox) and cached move data are deliberately untouched.
 */

import { useSyncExternalStore } from 'react';

import { clearKioskSetup } from './kioskSetup';
import { writeSetupState } from './setupState';

const KEY = 'ss.kiosk.setupClear';

export interface SetupClearRecord { id: string; acked: boolean; notice: boolean }

type Listener = () => void;
const listeners = new Set<Listener>();

function read(): SetupClearRecord | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SetupClearRecord>;
    return typeof v.id === 'string'
      ? { id: v.id, acked: v.acked === true, notice: v.notice === true } : null;
  } catch {
    return null;
  }
}

function write(rec: SetupClearRecord): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(rec));
  } catch {
    /* blocked storage: the clear still happened; it may re-apply after a reload */
  }
  listeners.forEach((fn) => fn());
}

export function readSetupClear(): SetupClearRecord | null {
  return read();
}

/** Applies a request id the kiosk hasn't applied before. True when it did. */
export function applySetupClear(id: string): boolean {
  if (read()?.id === id) return false;
  clearKioskSetup();
  writeSetupState('incomplete');
  write({ id, acked: false, notice: true });
  return true;
}

/** The id to send as `setup_cleared`, or null when nothing is owed. */
export function pendingAck(): string | null {
  const rec = read();
  return rec && !rec.acked ? rec.id : null;
}

/** Called with each reply's `clear_setup`: once the server stops asking
 *  for our id (null or a different id), our acknowledgment has landed. */
export function settleAck(replyId: string | null): void {
  const rec = read();
  if (rec && !rec.acked && replyId !== rec.id) write({ ...rec, acked: true });
}

export function dismissSetupClearNotice(): void {
  const rec = read();
  if (rec?.notice) write({ ...rec, notice: false });
}

function subscribe(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** True while the "administrator cleared this kiosk's setup" banner is up. */
export function useSetupClearNotice(): boolean {
  return useSyncExternalStore(subscribe, () => read()?.notice === true, () => false);
}
