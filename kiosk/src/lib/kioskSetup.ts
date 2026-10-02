/**
 * The kiosk's saved setup selection: which move, site, and scan type it
 * was set up for, kiosk-local (mirrors `devMode.ts`/`setupState.ts`'s
 * store/hook shape). The server is the source of truth for the Device
 * row itself (current_initiative_id/site_id/scan_status); this is only a
 * local cache of the names so the summary card and footer can render
 * without an extra fetch. Stored in localStorage with the same try/catch
 * idiom — a blocked or full store just leaves the selection unset.
 */

import { useSyncExternalStore } from 'react';

const KEY = 'ss.kiosk.setup';

export interface KioskSetupSelection {
  initiativeId: string;
  initiativeName: string;
  siteId: string;
  siteName: string;
  siteRole: 'source' | 'destination';
  scanStatus: string;
  scanLabel: string;
  /** What the laptop station is. Absent in web mode and in selections
   *  saved before station types existed — both stay valid. */
  stationType?: StationType;
  /** The paired reader, for an RFID station. */
  reader?: ReaderSummary;
}

export type StationType = 'label' | 'rfid';

export interface ReaderSummary { ip: string; serial: string; model: string }

/** "RFID · Laptop" / "Label Station · Laptop"; the bare mode label when no
 *  station type was saved. */
export function stationLabel(stationType: StationType | undefined, modeLabel: string): string {
  if (stationType === 'rfid') return `RFID · ${modeLabel}`;
  if (stationType === 'label') return `Label Station · ${modeLabel}`;
  return modeLabel;
}

/** "FX9600 1234ABCD at 10.0.0.5" */
export function readerLabel(reader: ReaderSummary): string {
  return `${reader.model} ${reader.serial} at ${reader.ip}`;
}

function isReader(value: unknown): value is ReaderSummary {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.ip === 'string' && typeof v.serial === 'string' && typeof v.model === 'string';
}

/** Drops a stored station type or reader this build doesn't understand,
 *  keeping the rest of the selection. */
function normalize(selection: KioskSetupSelection): KioskSetupSelection {
  const { stationType, reader, ...rest } = selection;
  const out: KioskSetupSelection = { ...rest };
  if (stationType === 'label' || stationType === 'rfid') out.stationType = stationType;
  if (out.stationType === 'rfid' && isReader(reader)) out.reader = reader;
  return out;
}

type Listener = () => void;

const listeners = new Set<Listener>();

function isSelection(value: unknown): value is KioskSetupSelection {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.initiativeId === 'string' && typeof v.initiativeName === 'string'
    && typeof v.siteId === 'string' && typeof v.siteName === 'string'
    && (v.siteRole === 'source' || v.siteRole === 'destination')
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
      if (isSelection(parsed)) cachedSelection = normalize(parsed);
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
