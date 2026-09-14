/**
 * Developer mode: a kiosk-local flag (not tied to the signed-in person)
 * that reveals diagnostics and developer tools on this kiosk. Stored in
 * localStorage like `identity.ts`, with the same try/catch idiom — a
 * blocked or full store just leaves the flag off. `subscribeDevMode` lets
 * every consumer (the Settings switch, the shell footer) stay in sync
 * with a write from any of them, via `useDevMode`'s `useSyncExternalStore`.
 */

import { useSyncExternalStore } from 'react';

const KEY = 'ss.kiosk.devMode';

type Listener = () => void;

const listeners = new Set<Listener>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === 'true';
  } catch {
    return false;
  }
}

export function readDevMode(): boolean {
  return read();
}

/** Persists the flag and notifies subscribers; false when storage refuses. */
export function writeDevMode(on: boolean): boolean {
  try {
    localStorage.setItem(KEY, on ? 'true' : 'false');
  } catch {
    return false;
  }
  listeners.forEach((fn) => fn());
  return true;
}

export function subscribeDevMode(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useDevMode(): [boolean, (on: boolean) => void] {
  const on = useSyncExternalStore(subscribeDevMode, readDevMode);
  return [on, writeDevMode];
}
