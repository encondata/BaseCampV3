/** The full-screen scan feedback flash, rendered once in `KioskShell`
 *  and driven by `lib/flash.ts`. It sits over everything, takes no
 *  pointer events, and fades 0.85 → 0 across the flash's duration so a
 *  person facing the kiosk from across a cage reads the outcome as
 *  color, not text.
 *
 *  `prefers-reduced-motion` gets a short solid flash instead of the
 *  fade — the point is the color, and a 350 ms opacity ramp is exactly
 *  the kind of motion that setting asks us to drop. The overlay is
 *  keyed on the flash id so back-to-back scans restart the animation
 *  rather than reusing a mid-fade element. */

import { useSyncExternalStore } from 'react';

import { readFlash, subscribeFlash } from '../lib/flash';

const REDUCED_MS = 150;

function prefersReducedMotion(): boolean {
  try {
    return globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
  } catch {
    return false;
  }
}

export default function ScanFlash() {
  const state = useSyncExternalStore(subscribeFlash, readFlash, readFlash);
  if (!state) return null;
  const reduced = prefersReducedMotion();
  return (
    <div
      key={state.id}
      className={`scan-flash${reduced ? ' is-reduced' : ''}`}
      aria-hidden="true"
      style={{
        background: state.color,
        animationDuration: `${reduced ? REDUCED_MS : state.ms}ms`,
      }}
    />
  );
}
