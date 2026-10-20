/**
 * The alignment tools for a selection (spec §4.5): align edges or centers,
 * distribute, match width or height. Every tool works on footprints (what
 * an element covers on the label, geometry.ts), returns the elements in the
 * order given (the selection's, the order they were picked), and leaves a
 * locked element where it is. Align and match size take the first one
 * picked as the anchor.
 */

import { footprint, resize, type Rect, type ResizeContext } from './geometry';
import type { ElementV2 } from './model';

export type AlignEdge = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';

function place<T extends ElementV2>(el: T, x: number, y: number): T {
  if (el.locked || (x === el.x && y === el.y)) return el;
  return { ...el, x, y };
}

/** Lines every element up on the first one's edge or center (the anchor,
 *  which stays put); one element alone aligns to the label. */
export function align<T extends ElementV2>(elements: readonly T[], edge: AlignEdge,
  labelSize: { w: number; h: number }): T[] {
  const rects = elements.map(footprint);
  const b = elements.length === 1 ? { x: 0, y: 0, ...labelSize } : rects[0];
  return elements.map((el, i) => {
    if (i === 0 && elements.length > 1) return el;
    const r = rects[i];
    switch (edge) {
      case 'left': return place(el, b.x, el.y);
      case 'right': return place(el, b.x + b.w - r.w, el.y);
      case 'center': return place(el, b.x + (b.w - r.w) / 2, el.y);
      case 'top': return place(el, el.x, b.y);
      case 'bottom': return place(el, el.x, b.y + b.h - r.h);
      case 'middle': return place(el, el.x, b.y + (b.h - r.h) / 2);
    }
  });
}

/** Evens out the gaps between three or more elements, horizontally or
 *  vertically; the first and last stay put. */
export function distribute<T extends ElementV2>(elements: readonly T[], axis: 'h' | 'v'): T[] {
  if (elements.length < 3) return [...elements];
  const h = axis === 'h';
  const start = (r: Rect) => (h ? r.x : r.y);
  const length = (r: Rect) => (h ? r.w : r.h);
  const order = elements
    .map((el, i) => ({ el, i, r: footprint(el) }))
    .sort((a, b) => start(a.r) - start(b.r));
  const first = order[0].r;
  const last = order[order.length - 1].r;
  const total = order.reduce((sum, o) => sum + length(o.r), 0);
  const gap = (start(last) + length(last) - start(first) - total) / (order.length - 1);
  const out = [...elements];
  let cursor = start(first);
  order.forEach(({ el, i, r }, k) => {
    if (k > 0 && k < order.length - 1) out[i] = place(el, h ? cursor : el.x, h ? el.y : cursor);
    cursor += length(r) + gap;
  });
  return out;
}

/** Gives every element the first one's footprint width or height, through
 *  each type's resize rule (a QR code stays square, text scales its font,
 *  an expected length holds a field's width). */
export function matchSize<T extends ElementV2>(elements: readonly T[], dim: 'w' | 'h',
  ctx: ResizeContext = { dpi: 300 }): T[] {
  if (elements.length < 2) return [...elements];
  const target = footprint(elements[0])[dim];
  return elements.map((el, i) => {
    if (i === 0) return el;
    const r = footprint(el);
    return dim === 'w' ? resize(el, 'e', target - r.w, 0, ctx) : resize(el, 's', 0, target - r.h, ctx);
  });
}
