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

// In-memory copy of the record, so once-only / ack / notice still hold for
// this session when storage is blocked or full (otherwise the same id would
// re-apply on every beat and the re-beats would loop). Storage stays the
// source of truth whenever it works.
let memory: SetupClearRecord | null = null;
let storageFailed = false;

function read(): SetupClearRecord | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return memory;
  }
  if (!raw) return storageFailed ? memory : null;
  try {
    const v = JSON.parse(raw) as Partial<SetupClearRecord>;
    return typeof v.id === 'string'
      ? { id: v.id, acked: v.acked === true, notice: v.notice === true } : null;
  } catch {
    return null;
  }
}

function write(rec: SetupClearRecord): void {
  memory = rec;
  try {
    localStorage.setItem(KEY, JSON.stringify(rec));
    storageFailed = false;
  } catch {
    storageFailed = true;   // blocked storage: reads fall back to `memory`
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

/** Called after each beat with the ack that beat carried (`sentAck`) and the
 *  reply's `clear_setup`. Only a beat that actually sent our id can show it
 *  landed: once such a beat's reply no longer asks for it (null or a
 *  different id), the acknowledgment is done. */
export function settleAck(sentAck: string | null, replyId: string | null): void {
  const rec = read();
  if (rec && !rec.acked && sentAck === rec.id && replyId !== rec.id) {
    write({ ...rec, acked: true });
  }
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
