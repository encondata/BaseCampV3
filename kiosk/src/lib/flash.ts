/**
 * The full-screen scan flash: a one-shot store `<ScanFlash />` paints.
 *
 * A module-level store rather than React state because the trigger is a
 * scan handler deep in the Scanning page while the overlay is rendered
 * once in `KioskShell` — the two never share a component tree. Each
 * flash carries its own `id` so a scan fired while the previous flash is
 * still fading remounts the overlay (restarting the animation) instead
 * of letting React reuse a mid-fade element, and so a superseded flash's
 * clear-timer can tell it no longer owns the screen.
 */

export interface FlashState { id: number; color: string; ms: number }

type Listener = () => void;

const listeners = new Set<Listener>();

let current: FlashState | null = null;
let nextId = 0;
let timer: ReturnType<typeof setTimeout> | null = null;

function emit(): void {
  listeners.forEach((fn) => fn());
}

export function readFlash(): FlashState | null {
  return current;
}

export function subscribeFlash(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Paints the whole screen `color` for `ms`, then clears itself. */
export function flash(color: string, ms = 350): void {
  if (timer !== null) clearTimeout(timer);
  current = { id: ++nextId, color, ms };
  emit();
  const mine = current.id;
  timer = setTimeout(() => {
    timer = null;
    if (current?.id !== mine) return;   // a newer flash owns the screen
    current = null;
    emit();
  }, ms);
}

/** Test/unmount helper: drops any flash in flight without waiting. */
export function clearFlash(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (current === null) return;
  current = null;
  emit();
}
