/**
 * Kiosk appearance colors — today, the three scan flashes. A good scan
 * flashes the whole screen `good_scan`; a scan that matched nothing in
 * the kiosk's local copy of the move flashes `not_found_scan`; a scan
 * that changed nothing — an asset already in this container, a container
 * already on this truck — flashes `duplicate_scan`. Two colors cannot
 * express three outcomes, and a repeat scan is neither a success nor a
 * miss: it is a nothing-happened event, and an operator sweeping a crate
 * has to be able to tell it from a real pack at arm's length. All three
 * are kiosk-local (localStorage, same store/hook idiom as `devMode.ts` and
 * `kioskSetup.ts`): the flash is about the person standing in front of
 * this screen, not about the signed-in account, and a kiosk in a dark
 * cage may need a very different color from one under office lights.
 *
 * Colors are stored as HSL channels rather than a hex string so the
 * Appearance tab's three sliders map straight onto the stored value and
 * a half-dragged hue never has to round-trip through a parser.
 *
 * `flash_ms` — how long that flash lasts — lives here too: a kiosk on a
 * loading dock, read from ten feet away, may want a full second where a
 * desk-height kiosk wants a blink.
 */

import { useSyncExternalStore } from 'react';

const KEY = 'ss.kiosk.appearance';

export interface Hsl { h: number; s: number; l: number }

export interface Appearance {
  good_scan: Hsl;
  not_found_scan: Hsl;
  /** A scan that changed nothing: the asset is already in this crate, or
   *  the crate is already on this truck. */
  duplicate_scan: Hsl;
  /** Flash duration in milliseconds, clamped to `FLASH_MS_RANGE`. */
  flash_ms: number;
}

export const FLASH_MS_RANGE = { min: 100, max: 2000, step: 50 } as const;

export const DEFAULT_APPEARANCE: Appearance = {
  good_scan: { h: 150, s: 60, l: 45 },
  not_found_scan: { h: 0, s: 70, l: 50 },
  // Amber, well clear of both the green and the red under dock lighting.
  duplicate_scan: { h: 38, s: 92, l: 50 },
  flash_ms: 350,
};

type Listener = () => void;

const listeners = new Set<Listener>();

function isHsl(value: unknown): value is Hsl {
  if (value === null || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  const inRange = (n: unknown, max: number) =>
    typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max;
  return inRange(v.h, 360) && inRange(v.s, 100) && inRange(v.l, 100);
}

/** Anything that isn't a usable number reads as the default; anything
 *  that is gets clamped, so neither a hand-edited file nor a future
 *  slider can hand the overlay a 0 ms (or 30 s) flash. */
function clampFlashMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_APPEARANCE.flash_ms;
  return Math.min(FLASH_MS_RANGE.max, Math.max(FLASH_MS_RANGE.min, Math.round(value)));
}

// useSyncExternalStore needs a referentially stable snapshot while
// nothing changes, so the parsed value is cached against the raw string
// it came from (the same trick as `kioskSetup.ts`).
let cachedRaw: string | null | undefined;
let cached: Appearance = DEFAULT_APPEARANCE;

function read(): Appearance {
  let stored: string | null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    return DEFAULT_APPEARANCE;
  }
  if (stored === cachedRaw) return cached;
  cachedRaw = stored;
  cached = DEFAULT_APPEARANCE;
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Record<string, unknown>;
      // Each channel falls back on its own: a stored file that only
      // carries one color (or one that someone hand-edited out of range)
      // still yields a usable set rather than nothing — which is also how
      // a kiosk stored before `duplicate_scan` existed reads it as its
      // default rather than as undefined.
      cached = {
        good_scan: isHsl(parsed?.good_scan) ? parsed.good_scan : DEFAULT_APPEARANCE.good_scan,
        not_found_scan: isHsl(parsed?.not_found_scan)
          ? parsed.not_found_scan : DEFAULT_APPEARANCE.not_found_scan,
        duplicate_scan: isHsl(parsed?.duplicate_scan)
          ? parsed.duplicate_scan : DEFAULT_APPEARANCE.duplicate_scan,
        flash_ms: clampFlashMs(parsed?.flash_ms),
      };
    } catch {
      /* malformed stored JSON reads as the defaults */
    }
  }
  return cached;
}

export function readAppearance(): Appearance {
  return read();
}

/** Merges `patch` over the stored colors and notifies subscribers;
 *  false when storage refuses (private window, full store). */
export function writeAppearance(patch: Partial<Appearance>): boolean {
  const next: Appearance = { ...read(), ...patch };
  next.flash_ms = clampFlashMs(next.flash_ms);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    return false;
  }
  listeners.forEach((fn) => fn());
  return true;
}

export function subscribeAppearance(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useAppearance(): [Appearance, (patch: Partial<Appearance>) => void] {
  const appearance = useSyncExternalStore(subscribeAppearance, readAppearance);
  return [appearance, writeAppearance];
}

/** `hsl(150 60% 45%)` — the modern space-separated form, which is what
 *  the swatch, the readout, and the flash overlay all render. */
export function hslCss({ h, s, l }: Hsl): string {
  return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`;
}
