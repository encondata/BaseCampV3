/**
 * What a WEB kiosk prints, kept on the kiosk. A laptop keeps its Label
 * Station settings in the edge's shared setup (`getLabelStation` /
 * `putLabelStation`); a web kiosk has no edge, so the same
 * `LabelStationSettings` shape lives in localStorage under
 * `ss.kiosk.labelPrinting`, with the store/hook shape of `kioskSetup.ts`
 * and the same try/catch idiom — a blocked or full store reads as the
 * defaults and never throws. Saving a printer is the exception: a save
 * the storage refuses, or one without a positive whole-number DPI, throws
 * (`ApiError` `storage` / `bad_dpi`), so the printer step says it wasn't
 * saved instead of moving on as if it were.
 *
 * Two things are kept, and they arrive at different times:
 *   - the label KIND (Top or Front), chosen in Kiosk Setup's last step.
 *     It is always readable: `readWebLabelKind()` is `'top'` until one is
 *     saved.
 *   - the PRINTER (model, serial, dpi, offsets, peel), saved by the
 *     Printing Station's printer step. `readWebLabelSettings()` is `null`
 *     until a printer and a positive whole-number dpi are both saved —
 *     "settings" means a kiosk that can actually print.
 *
 * A web kiosk reaches its printer over WebUSB only, so a stored printer
 * is always `type: 'usb'` with no `ip`, whatever the caller passed:
 * the network transport is the laptop edge's.
 */

import { useSyncExternalStore } from 'react';

import { ApiError, type LabelKind, type LabelStationSettings } from './api';

const KEY = 'ss.kiosk.labelPrinting';

type Listener = () => void;

const listeners = new Set<Listener>();

interface Parsed {
  kind: LabelKind;
  settings: LabelStationSettings | null;
}

const DEFAULTS: Parsed = { kind: 'top', settings: null };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function wholeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : 0;
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function parse(raw: string | null): Parsed {
  if (!raw) return DEFAULTS;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return DEFAULTS;   // malformed stored JSON reads as the defaults
  }
  if (!isRecord(value)) return DEFAULTS;
  const kind: LabelKind = value.label_kind === 'front' ? 'front' : 'top';
  const { printer, dpi } = value;
  if (!isRecord(printer) || typeof dpi !== 'number' || !Number.isInteger(dpi) || dpi <= 0) {
    return { kind, settings: null };
  }
  return {
    kind,
    settings: {
      label_kind: kind,
      printer: {
        type: 'usb', ip: null, model: textOrNull(printer.model), serial: textOrNull(printer.serial),
      },
      dpi,
      offset_x: wholeNumber(value.offset_x),
      offset_y: wholeNumber(value.offset_y),
      peel: value.peel === true,
    },
  };
}

// useSyncExternalStore requires a referentially stable snapshot when
// nothing changed, or it re-renders forever; cache the parsed value
// against the raw string it came from.
let cachedRaw: string | null | undefined;
let cached: Parsed = DEFAULTS;

function load(): Parsed {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return DEFAULTS;
  }
  if (raw === cachedRaw) return cached;
  cachedRaw = raw;
  cached = parse(raw);
  return cached;
}

/** Stores the record and tells subscribers; false, with nothing changed
 *  (so nobody is told), when storage refuses. */
function persist(record: Record<string, unknown>): boolean {
  try {
    localStorage.setItem(KEY, JSON.stringify(record));
  } catch {
    return false;
  }
  listeners.forEach((fn) => fn());
  return true;
}

/** What this kiosk prints, `'top'` until a kind is saved. */
export function readWebLabelKind(): LabelKind {
  return load().kind;
}

/** Saves the kind and keeps any saved printer, so changing Top to Front in
 *  Kiosk Setup never forgets which printer the kiosk uses. */
export function writeWebLabelKind(kind: LabelKind): void {
  let current: unknown = null;
  try {
    const raw = localStorage.getItem(KEY);
    current = raw ? JSON.parse(raw) : null;
  } catch {
    current = null;   // unreadable: start the record fresh
  }
  persist({ ...(isRecord(current) ? current : {}), label_kind: kind });
}

/** The saved kind and printer, or null until a printer and a positive
 *  whole-number dpi are both saved. */
export function readWebLabelSettings(): LabelStationSettings | null {
  return load().settings;
}

/** Saves the kind and printer together and returns what was stored: always
 *  a USB printer with no address, offsets in whole dots. Throws `ApiError`
 *  `bad_dpi` (nothing written) unless the DPI is a positive whole number —
 *  the reader would take such a save for no printer at all — and `storage`
 *  when the browser refuses the write. */
export function writeWebLabelSettings(settings: LabelStationSettings): LabelStationSettings {
  if (typeof settings.dpi !== 'number' || !Number.isInteger(settings.dpi) || settings.dpi <= 0) {
    throw new ApiError(422, 'bad_dpi');
  }
  const stored: LabelStationSettings = {
    label_kind: settings.label_kind,
    printer: {
      type: 'usb', ip: null,
      model: settings.printer.model ?? null, serial: settings.printer.serial ?? null,
    },
    dpi: settings.dpi,
    offset_x: wholeNumber(settings.offset_x),
    offset_y: wholeNumber(settings.offset_y),
    peel: settings.peel === true,
  };
  if (!persist({ ...stored })) throw new ApiError(507, 'storage');
  return stored;
}

export function subscribeWebLabelSettings(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useWebLabelSettings(): LabelStationSettings | null {
  return useSyncExternalStore(subscribeWebLabelSettings, readWebLabelSettings);
}
