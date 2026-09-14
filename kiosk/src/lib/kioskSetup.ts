/**
 * The kiosk's saved setup selection: which move and scan type it was set
 * up for, kiosk-local (mirrors `devMode.ts`/`setupState.ts`'s store/hook
 * shape). The server is the source of truth for the Device row itself
 * (current_initiative_id/scan_status); this is only a local cache of the
 * names so the summary card and footer can render without an extra
 * fetch. Stored in localStorage with the same try/catch idiom — a
 * blocked or full store just leaves the selection unset.
 */

import { useSyncExternalStore } from 'react';

const KEY = 'ss.kiosk.setup';

export interface KioskSetupSelection {
  initiativeId: string;
  initiativeName: string;
  scanStatus: string;
  scanLabel: string;
}

type Listener = () => void;

const listeners = new Set<Listener>();

function isSelection(value: unknown): value is KioskSetupSelection {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.initiativeId === 'string' && typeof v.initiativeName === 'string'
    && typeof v.scanStatus === 'string' && typeof v.scanLabel === 'string';
}

// useSyncExternalStore requires a referentially stable snapshot when
// nothing changed, or it re-renders forever; cache the parsed value
// against the raw string it came from.
let cachedRaw: string | null | undefined;
let cachedSelection: KioskSetupSelection | null = null;

function read(): KioskSetupSelection | null {
  let stored: string | null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    return null;
  }
  if (stored === cachedRaw) return cachedSelection;
  cachedRaw = stored;
  cachedSelection = null;
  if (stored) {
    try {
      const parsed: unknown = JSON.parse(stored);
      if (isSelection(parsed)) cachedSelection = parsed;
    } catch {
      /* malformed stored JSON reads as null */
    }
  }
  return cachedSelection;
}

export function readKioskSetup(): KioskSetupSelection | null {
  return read();
}

/** Persists the selection and notifies subscribers; false when storage refuses. */
export function writeKioskSetup(selection: KioskSetupSelection): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(selection));
  } catch {
    return false;
  }
  listeners.forEach((fn) => fn());
  return true;
}

/** Removes the saved selection and notifies subscribers; false when storage refuses. */
export function clearKioskSetup(): boolean {
  try {
    localStorage.removeItem(KEY);
  } catch {
    return false;
  }
  listeners.forEach((fn) => fn());
  return true;
}

export function subscribeKioskSetup(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useKioskSetup(): [
  KioskSetupSelection | null,
  (selection: KioskSetupSelection | null) => void,
] {
  const selection = useSyncExternalStore(subscribeKioskSetup, readKioskSetup);
  const setSelection = (next: KioskSetupSelection | null) => {
    if (next === null) clearKioskSetup();
    else writeKioskSetup(next);
  };
  return [selection, setSelection];
}
