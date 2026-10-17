/**
 * Show only the rows that fit: the RFID Reader dashboard's panels never
 * scroll (Jimmy, 2026-10-17). The container clips (`overflow: hidden`); this
 * hides the first row that would be cut off and every row after it, so the
 * panel never shows half a row. Rows are the container's `[data-fit-row]`
 * elements, in document order. `visibility` (not `display`) keeps the layout
 * still, so hiding a row never moves another one back into view and re-runs
 * the check.
 */

import { useLayoutEffect, type RefObject } from 'react';

export function fitRows(container: HTMLElement): void {
  const bottom = container.getBoundingClientRect().bottom;
  let cut = false;
  container.querySelectorAll<HTMLElement>('[data-fit-row]').forEach((row) => {
    if (!cut && row.getBoundingClientRect().bottom > bottom + 0.5) cut = true;
    row.style.visibility = cut ? 'hidden' : '';
  });
}

export function useFitRows(ref: RefObject<HTMLElement | null>, deps: readonly unknown[]): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    fitRows(el);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => fitRows(el));
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
}
