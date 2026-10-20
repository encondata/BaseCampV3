/**
 * Canvas geometry in inches: snapping, keeping elements on the label,
 * hit-testing, marquee selection, and the eight resize handles with each
 * element type's rule (spec §4.2 Resizing):
 *  - text (static text, a field shown as text or a number): the height
 *    scales the font size and the baseline. On a box that is one line of
 *    the font (metrics.ts `textBoxFor`) the size is the one whose line is
 *    that tall; any other box (one stopping at the baseline as the seeded
 *    templates' do, several lines, or no metrics yet) scales both in
 *    proportion to its own height. The width follows the expected length
 *    when one is set, else it is free;
 *  - barcode: the height is the bar height; the width snaps to whole
 *    narrow modules (the printer's ^BY, in dots at the DPI);
 *  - QR code: square, in whole magnification steps of the symbol the value
 *    needs (qr.ts), capped at the printer's 10;
 *  - line and box: free.
 *
 * Handles act on the footprint the element covers on the label: at
 * rotation 90 or 270 that is h wide and w tall (model.ts). A locked element
 * never moves or resizes.
 */

import { DEFAULT_FAMILY, glyphWidthScale, type FontRef } from './fonts';
import { reservedWidthIn, sizePtForHeight, textBoxFor, type FontMetrics } from './metrics';
import type { Display, ElementV2 } from './model';
import { qrMagnification, qrModules } from './qr';
import { pyRound, toDots } from './units';

export type Handle = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

type Placed = Pick<ElementV2, 'x' | 'y' | 'w' | 'h' | 'rotation'>;

export interface ResizeContext {
  /** The DPI on screen: barcode modules and QR steps are whole dots at it. */
  dpi: number;
  /** A text element's font metrics, once loaded; without them text scales
   *  in proportion. */
  metricsFor?: (el: ElementV2) => FontMetrics | null | undefined;
  /** The value a QR code shows (its sample or static data), for its size. */
  valueFor?: (el: ElementV2) => string;
  /** ⇧-resize: keep the footprint's proportions. */
  keepRatio?: boolean;
}

/** The label area an element covers: w and h swap at 90 and 270. */
export function footprint(el: Placed): Rect {
  const turned = el.rotation === 90 || el.rotation === 270;
  return { x: el.x, y: el.y, w: turned ? el.h : el.w, h: turned ? el.w : el.h };
}

/** `v` to the nearest multiple of `step`; no step leaves it alone. A step
 *  that is 1/n of an inch (a dot, a grid of 1/16) divides by n, so the
 *  result is exact (0.35, not 0.35000000000000003). */
export function snap(v: number, step: number): number {
  if (!(step > 0)) return v;
  const per = 1 / step;
  const n = Math.round(per);
  if (Math.abs(per - n) < 1e-9) return Math.round(v * n) / n;
  return Math.round(v / step) * step;
}

export function move<T extends ElementV2>(el: T, dx: number, dy: number): T {
  if (el.locked) return el;
  return { ...el, x: el.x + dx, y: el.y + dy };
}

/** Moves the element so its footprint lies on the label (top-left first
 *  when it is bigger than the label). */
export function clampToLabel<T extends ElementV2>(el: T, size: { w: number; h: number }): T {
  if (el.locked) return el;
  const fp = footprint(el);
  const x = Math.min(Math.max(el.x, 0), Math.max(0, size.w - fp.w));
  const y = Math.min(Math.max(el.y, 0), Math.max(0, size.h - fp.h));
  return x === el.x && y === el.y ? el : { ...el, x, y };
}

function contains(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

function inflate(r: Rect, by: number): Rect {
  return { x: r.x - by, y: r.y - by, w: r.w + 2 * by, h: r.h + 2 * by };
}

function normalize(r: Rect): Rect {
  return {
    x: Math.min(r.x, r.x + r.w), y: Math.min(r.y, r.y + r.h), w: Math.abs(r.w), h: Math.abs(r.h),
  };
}

/** The id of the topmost element whose footprint, grown by `tolerance`
 *  inches on every side (a hairline has no area), holds the point. */
export function hitTest(elements: readonly ElementV2[], point: Point, tolerance = 0): string | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    if (contains(inflate(footprint(elements[i]), tolerance), point)) return elements[i].id;
  }
  return null;
}

/** The ids, in stacking order, of the elements the marquee touches
 *  (`intersect`) or holds entirely (`contain`). The rectangle may have been
 *  dragged in any direction. */
export function marqueeSelect(elements: readonly ElementV2[], rect: Rect,
  mode: 'intersect' | 'contain' = 'intersect'): string[] {
  const m = normalize(rect);
  return elements.filter((el) => {
    const f = footprint(el);
    if (mode === 'contain') {
      return f.x >= m.x && f.y >= m.y && f.x + f.w <= m.x + m.w && f.y + f.h <= m.y + m.h;
    }
    return f.x <= m.x + m.w && f.x + f.w >= m.x && f.y <= m.y + m.h && f.y + f.h >= m.y;
  }).map((el) => el.id);
}

/** The narrow-module width a barcode prints with, in dots: the compiler's
 *  ^BY (2 when no width is set, else the width at `dpi`, 1 to 10). */
export function barcodeModuleDots(moduleIn: number | null | undefined, dpi: number): number {
  if (moduleIn == null) return 2;
  return Math.max(1, Math.min(10, toDots(moduleIn, dpi)));
}

type Kind = 'text' | 'barcode' | 'qr' | 'free';

function kindOf(el: ElementV2): Kind {
  if (el.type === 'text') return 'text';
  if (el.type === 'barcode' || el.type === 'qr') return el.type;
  if (el.type === 'field') return el.display === 'text' || el.display === 'number' ? 'text' : el.display;
  return 'free';
}

const EPS = 1e-12;
/** How close a box's height must be to one line of its font (textBoxFor)
 *  to count as one: float noise, far below a dot. */
const ONE_LINE_EPS = 1e-9;

/** The element `el` becomes when `handle` is dragged by (dx, dy) inches. */
export function resize<T extends ElementV2>(el: T, handle: Handle, dx: number, dy: number,
  ctx: ResizeContext): T {
  if (el.locked) return el;
  const minIn = 1 / ctx.dpi;
  const fp = footprint(el);
  const east = handle.includes('e');
  const west = handle.includes('w');
  const south = handle.includes('s');
  const north = handle.includes('n');
  let fw = fp.w;
  let fh = fp.h;
  if (east) fw = Math.max(minIn, fp.w + dx);
  if (west) fw = Math.max(minIn, fp.w - dx);
  if (south) fh = Math.max(minIn, fp.h + dy);
  if (north) fh = Math.max(minIn, fp.h - dy);
  const across = east || west;
  const down = north || south;
  if (ctx.keepRatio && fp.w > 0 && fp.h > 0) {
    const f = across && down ? Math.max(fw / fp.w, fh / fp.h) : across ? fw / fp.w : fh / fp.h;
    fw = fp.w * f;
    fh = fp.h * f;
  }

  let next: T;
  if (kindOf(el) === 'qr') {
    const side = qrSide(el, across && down ? Math.max(fw, fh) : across ? fw : fh, ctx);
    next = { ...el, w: side, h: side };
  } else {
    const turned = el.rotation === 90 || el.rotation === 270;
    next = sized(el, turned ? fh : fw, turned ? fw : fh, ctx);
  }
  const out = footprint(next);
  return {
    ...next,
    x: west ? fp.x + fp.w - out.w : fp.x,
    y: north ? fp.y + fp.h - out.h : fp.y,
  };
}

function qrSide(el: ElementV2, wantIn: number, ctx: ResizeContext): number {
  let modules: number;
  try {
    modules = qrModules(ctx.valueFor?.(el) ?? '');
  } catch {
    modules = 57;   // past version 10: the compiler refuses it; size as the largest
  }
  return (modules * qrMagnification(toDots(wantIn, ctx.dpi), modules)) / ctx.dpi;
}

/** `el` with its own w (along) and h (across) asked to be `along` and
 *  `across`, under its type's rule. */
function sized<T extends ElementV2>(el: T, along: number, across: number, ctx: ResizeContext): T {
  const kind = kindOf(el);
  if (kind === 'barcode') {
    if (Math.abs(along - el.w) <= EPS) return { ...el, h: across };
    const module = barcodeModuleDots('moduleIn' in el ? el.moduleIn : null, ctx.dpi);
    const modules = Math.max(1, pyRound(toDots(along, ctx.dpi) / module));
    return { ...el, w: (modules * module) / ctx.dpi, h: across };
  }
  if (kind !== 'text' || (el.type !== 'text' && el.type !== 'field')) return { ...el, w: along, h: across };

  const sizePt = el.sizePt ?? 0;
  const metrics = ctx.metricsFor?.(el) ?? null;
  const proportional = el.h > 0 && sizePt > 0;
  // the font's own line sets the size only on a box that is one line of it;
  // any other box (one stopping at the baseline, several lines) scales from
  // its own height, and refit normalizes it on the next typography change
  const oneLine = metrics !== null && (el.type !== 'text' || (el.lines ?? 1) <= 1)
    && (!proportional || Math.abs(el.h - textBoxFor(metrics, sizePt).h) <= ONE_LINE_EPS);
  const scaled = Math.abs(across - el.h) > EPS && (oneLine || proportional);
  let nextSize = sizePt;
  let baseline = el.baselineIn;
  if (scaled && oneLine) {
    nextSize = sizePtForHeight(metrics, across);
    baseline = textBoxFor(metrics, nextSize).baselineIn;
  } else if (scaled) {
    nextSize = sizePt * (across / el.h);
    baseline = (el.baselineIn ?? 0) * (across / el.h);
  }
  const expected = el.type === 'field' ? el.expectedLength : null;
  let w = along;
  if (expected) {
    const display: Display = el.type === 'field' ? el.display : 'text';
    const font: FontRef = el.font ?? { family: DEFAULT_FAMILY, weight: 'regular' };
    const reserved = metrics
      ? reservedWidthIn(metrics, nextSize, expected, display, glyphWidthScale(font, !!el.inverted))
      : null;
    w = reserved ?? (sizePt > 0 ? el.w * (nextSize / sizePt) : el.w);
  }
  return { ...el, w, h: across, sizePt: scaled ? nextSize : el.sizePt, baselineIn: baseline };
}
