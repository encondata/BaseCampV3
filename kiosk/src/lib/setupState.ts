/**
 * Kiosk setup state: a kiosk-local flag (mirrors `devMode.ts`'s store/hook
 * shape) recording whether this kiosk has completed its setup flow. Until
 * it is `'complete'`, every launcher tile except Kiosk Setup and Settings
 * is greyed out (see `features.ts`'s `featureAvailable`).
 *
 * Storage is kiosk-local for now — a server-side Device field is deferred
 * so the portal can show it (see the spec). Stored in localStorage like
 * `devMode.ts`, with the same try/catch idiom — a blocked or full store
 * just leaves the state at its default, `'incomplete'`.
 */

import { useSyncExternalStore } from 'react';

const KEY = 'ss.kiosk.setupState';

export type KioskSetupState = 'incomplete' | 'complete' | 'failed';

export const SETUP_STATES: KioskSetupState[] = ['incomplete', 'complete', 'failed'];

type Listener = () => void;

const listeners = new Set<Listener>();

function isKioskSetupState(value: string | null): value is KioskSetupState {
  return value !== null && (SETUP_STATES as string[]).includes(value);
}

function read(): KioskSetupState {
  try {
    const stored = localStorage.getItem(KEY);
    return isKioskSetupState(stored) ? stored : 'incomplete';
  } catch {
    return 'incomplete';
  }
}

export function readSetupState(): KioskSetupState {
  return read();
}

/** Persists the state and notifies subscribers; false when storage refuses. */
export function writeSetupState(state: KioskSetupState): boolean {
  try {
    localStorage.setItem(KEY, state);
  } catch {
    return false;
  }
  listeners.forEach((fn) => fn());
  return true;
}

export function subscribeSetupState(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useKioskSetupState(): [KioskSetupState, (state: KioskSetupState) => void] {
  const state = useSyncExternalStore(subscribeSetupState, readSetupState);
  return [state, writeSetupState];
}

export function isSetupComplete(state: KioskSetupState): boolean {
  return state === 'complete';
}

export function setupStateLabel(state: KioskSetupState): string {
  switch (state) {
    case 'complete': return 'Complete';
    case 'failed': return 'Failed';
    default: return 'Incomplete';
  }
}
