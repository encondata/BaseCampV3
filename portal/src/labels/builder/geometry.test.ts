import { describe, expect, it } from 'vitest';

import vegas from '../../../../api/src/serversherpa/labels/fixtures/vegas_v2.json';
import {
  barcodeModuleDots, clampToLabel, footprint, hitTest, marqueeSelect, move, resize, snap,
  type ResizeContext,
} from './geometry';
import { reservedWidthIn, textBoxFor, type FontMetrics } from './metrics';
import {
  parseDesign, type BarcodeElement, type BoxElement, type ElementV2, type FieldElement,
  type QrElement, type TextElement,
} from './model';

const VEGAS = parseDesign(vegas);
const byId = <T extends ElementV2>(id: string) => VEGAS.elements.find((e) => e.id === id) as T;

const METRICS: FontMetrics = {
  unitsPerEm: 1000, ascent: 720, descent: 200, advances: { '0': 500, '8': 550, W: 900 },
};

function box(id: string, x: number, y: number, w = 0.5, h = 0.25, extra: Partial<BoxElement> = {}): BoxElement {
  return { id, type: 'box', x, y, w, h, rotation: 0, strokeIn: 0.01, ...extra };
}

const CTX: ResizeContext = { dpi: 300 };

describe('snap', () => {
  it('rounds to the nearest step, leaving the value alone for no step', () => {
    expect(snap(0.37, 0.05)).toBe(0.35);
    expect(snap(0.38, 0.05)).toBe(0.4);
    expect(snap(0.123, 0)).toBe(0.123);
    expect(snap(1 / 3, 1 / 300)).toBeCloseTo(100 / 300, 12);
  });
});

describe('footprint, move, clamp', () => {
  it('swaps w and h at 90 and 270 (model.py geometry)', () => {
    expect(footprint(byId('side-site'))).toEqual({ x: 3.6253, y: 1.1, w: 0.108, h: 0.8333 });
    expect(footprint(byId('banner-pod'))).toEqual({ x: 1.3333, y: 0.0933, w: 0.5, h: 0.24 });
  });

  it('moves an element, never a locked one', () => {
    expect(move(box('a', 1, 1), 0.25, -0.5)).toMatchObject({ x: 1.25, y: 0.5 });
    const locked = box('a', 1, 1, 0.5, 0.25, { locked: true });
    expect(move(locked, 1, 1)).toBe(locked);
  });

  it('keeps the footprint on the label', () => {
    const size = { w: 4, h: 2 };
    expect(clampToLabel(box('a', 3.8, -0.1), size)).toMatchObject({ x: 3.5, y: 0 });
    expect(clampToLabel(box('a', 1, 1), size)).toMatchObject({ x: 1, y: 1 });
    expect(clampToLabel({ ...byId<FieldElement>('side-site'), y: 1.5 }, size)).toMatchObject({ y: 2 - 0.8333 });
    expect(clampToLabel(box('a', 1, 1, 5, 3), size)).toMatchObject({ x: 0, y: 0 });
  });
});

describe('hitTest and marqueeSelect', () => {
  const els = [box('under', 0, 0, 2, 1), box('over', 1, 0.5, 1, 1), byId<FieldElement>('side-site'), byId('rule')];

  it('returns the topmost element under the point', () => {
    expect(hitTest(els, { x: 1.5, y: 0.75 })).toBe('over');
    expect(hitTest(els, { x: 0.5, y: 0.5 })).toBe('under');
    expect(hitTest(els, { x: 3.65, y: 1.8 })).toBe('side-site');      // inside the turned footprint
    expect(hitTest(els, { x: 3.9, y: 0.1 })).toBeNull();
  });

  it('reaches a hairline with a tolerance', () => {
    expect(hitTest(els, { x: 2.5, y: 0.99 })).toBeNull();
    expect(hitTest(els, { x: 2.5, y: 0.99 }, 0.01)).toBe('rule');
  });

  it('selects what the marquee touches, or only what it contains', () => {
    expect(marqueeSelect(els, { x: 1.5, y: 0.25, w: 1, h: 0.5 })).toEqual(['under', 'over']);
    expect(marqueeSelect(els, { x: 2.5, y: 1.75, w: -2, h: -1.5 }, 'contain')).toEqual(['over']);
    expect(marqueeSelect(els, { x: 0, y: 0.9, w: 4, h: 0.2 }, 'contain')).toEqual(['rule']);
  });
});

describe('resize: shapes', () => {
  it('drags any of the eight handles freely, anchoring the opposite side', () => {
    const b = box('b', 1, 1, 0.5, 0.25);
    expect(resize(b, 'se', 0.1, 0.05, CTX)).toMatchObject({ x: 1, y: 1, w: 0.6, h: 0.3 });
    const nw = resize(b, 'nw', -0.1, -0.05, CTX);
    expect(nw.x).toBeCloseTo(0.9, 10);
    expect(nw.y).toBeCloseTo(0.95, 10);
    expect(nw.w).toBeCloseTo(0.6, 10);
    expect(nw.h).toBeCloseTo(0.3, 10);
    expect(resize(b, 'n', 5, -0.05, CTX)).toMatchObject({ x: 1, w: 0.5 });
    expect(resize(b, 'e', 0.25, 5, CTX)).toMatchObject({ w: 0.75, h: 0.25 });
  });

  it('never shrinks past one dot, and keeps the far side where it was', () => {
    const w = resize(box('b', 1, 1, 0.5, 0.25), 'w', 2, 0, CTX);
    expect(w.w).toBeCloseTo(1 / 300, 10);
    expect(w.x + w.w).toBeCloseTo(1.5, 10);
  });

  it('keeps proportions with ⇧', () => {
    const out = resize(box('b', 1, 1, 0.5, 0.25), 'se', 0.5, 0.05, { ...CTX, keepRatio: true });
    expect(out.w).toBeCloseTo(1, 10);
    expect(out.h).toBeCloseTo(0.5, 10);
  });

  it('leaves a locked element alone', () => {
    const locked = box('b', 1, 1, 0.5, 0.25, { locked: true });
    expect(resize(locked, 'se', 1, 1, CTX)).toBe(locked);
  });

  it('turns the handles with the element', () => {
    // a line at 90: its footprint is h wide and w tall; dragging s lengthens it
    const line = { ...byId('rule'), rotation: 90 as const };
    expect(resize(line, 's', 0, 0.5, CTX)).toMatchObject({ w: 3.7333 + 0.5, h: 0 });
  });
});

describe('resize: text', () => {
  const pod = byId<FieldElement>('banner-pod');           // expected length 3, 24 pt, h 0.24
  const caption = byId<TextElement>('caption-name');      // static, 10.08 pt, h 0.1008

  /** `pod` refit to one line of the font: the box new and retyped text gets. */
  const fitted = (): FieldElement => ({ ...pod, ...textBoxFor(METRICS, 24) });

  it('sets the font size from the height of a one-line box, the width from the expected length', () => {
    // 0.48 in = (720 + 200)/1000 em → 0.48 × 72 / 0.92 pt
    const size = (0.48 * 72) / 0.92;
    const one = fitted();
    const out = resize(one, 's', 0, 0.48 - one.h, { ...CTX, metricsFor: () => METRICS });
    expect(out.sizePt).toBeCloseTo(size, 10);
    expect(out.h).toBeCloseTo(0.48, 10);
    expect(out.h).toBeCloseTo(textBoxFor(METRICS, out.sizePt!).h, 10);
    expect(out.baselineIn).toBeCloseTo(textBoxFor(METRICS, size).baselineIn, 10);
    expect(out.w).toBeCloseTo(reservedWidthIn(METRICS, size, 3, 'text')!, 10);
    expect(out.y).toBe(pod.y);
  });

  it('scales a box that stops at the baseline (0.72 em) from its own height: +1 dot is about the same size', () => {
    // the seeded templates' text boxes are h = baseline = 0.72 em: read as
    // one line of the font, a one-dot drag would drop 24 pt to ≈ 19 pt
    const ctx = { ...CTX, metricsFor: () => METRICS };
    const dot = 1 / 300;
    const out = resize(pod, 's', 0, dot, ctx);
    expect(out.sizePt).toBeCloseTo(24 * ((0.24 + dot) / 0.24), 10);
    expect(out.sizePt! - 24).toBeLessThan(0.5);
    expect(out.h).toBeCloseTo(0.24 + dot, 10);
    expect(out.baselineIn).toBeCloseTo(out.h, 10);           // still stops at the baseline
    const back = resize(out, 's', 0, -dot, ctx);
    expect(back.sizePt).toBeCloseTo(24, 10);
    expect(back.h).toBeCloseTo(0.24, 10);
  });

  it('scales a multi-line box in proportion, so its box and its lines still agree', () => {
    // 3 lines of 12 pt: one line of the font plus two more of 12 pt each
    const size = 12;
    const line = textBoxFor(METRICS, size);
    const three: TextElement = {
      ...caption, sizePt: size, lines: 3, h: line.h + 2 * (size / 72), baselineIn: line.baselineIn,
    };
    const dot = 1 / 300;
    const out = resize(three, 's', 0, dot, { ...CTX, metricsFor: () => METRICS });
    const want = size * ((three.h + dot) / three.h);
    expect(out.sizePt).toBeCloseTo(want, 10);
    expect(out.sizePt! - size).toBeLessThan(0.2);
    expect(out.h).toBeCloseTo(three.h + dot, 10);
    // the box is still three lines of the new size
    expect(out.h).toBeCloseTo(textBoxFor(METRICS, out.sizePt!).h + 2 * (out.sizePt! / 72), 10);
    expect(out.baselineIn).toBeCloseTo(textBoxFor(METRICS, out.sizePt!).baselineIn, 10);
  });

  it('keeps a hand-made box (h = baseline) until its height is dragged', () => {
    // the Vegas fixture's text boxes stop at the baseline; a width drag leaves them be
    const out = resize(pod, 'e', 0.3, 0, { ...CTX, metricsFor: () => METRICS });
    expect(out.h).toBe(pod.h);
    expect(out.baselineIn).toBe(pod.baselineIn);
    expect(out.sizePt).toBe(pod.sizePt);
  });

  it('scales everything in proportion while the font metrics are not loaded', () => {
    const out = resize(pod, 'n', 0, -0.12, CTX);
    expect(out.sizePt).toBeCloseTo(36, 10);
    expect(out.baselineIn).toBeCloseTo(0.36, 10);
    expect(out.w).toBeCloseTo(0.75, 10);
    expect(out.y + out.h).toBeCloseTo(pod.y + pod.h, 10);   // n handle: the bottom stays
  });

  it('holds the width of a field with an expected length', () => {
    expect(resize(pod, 'e', 0.3, 0, CTX).w).toBe(pod.w);
    const synced = resize(pod, 'e', 0.3, 0, { ...CTX, metricsFor: () => METRICS });
    expect(synced.w).toBeCloseTo(reservedWidthIn(METRICS, 24, 3, 'text')!, 10);
    expect(synced.sizePt).toBe(24);
  });

  it('frees the width of text with no expected length', () => {
    const wider = resize(caption, 'e', 0.2, 0, CTX);
    expect(wider.w).toBeCloseTo(0.6667, 10);
    expect(wider.sizePt).toBe(10.08);
    const taller = resize(caption, 's', 0, 0.1008, CTX);
    expect(taller.sizePt).toBeCloseTo(20.16, 10);
    expect(taller.w).toBe(caption.w);
  });

  it('reads the height across the text when it is turned', () => {
    const side = byId<FieldElement>('side-site');          // 270: footprint 0.108 wide
    const out = resize(side, 'e', 0.108, 0, CTX);
    expect(out.sizePt).toBeCloseTo(21.6, 10);
    expect(out.h).toBeCloseTo(0.216, 10);
    expect(out.w).toBe(side.w);
  });
});

describe('resize: barcodes and QR codes', () => {
  it('snaps a barcode to whole modules and lets the height go free', () => {
    const bc = byId<BarcodeElement>('barcode');            // moduleIn 0.0133 → 4 dots at 300
    expect(barcodeModuleDots(bc.moduleIn, 300)).toBe(4);
    expect(barcodeModuleDots(null, 300)).toBe(2);          // the historical ^BY2
    expect(barcodeModuleDots(0.1, 300)).toBe(10);          // the printer's cap
    const out = resize(bc, 'e', 0.05, 0, CTX);             // 355 dots → 89 modules → 356 dots
    expect(out.w).toBeCloseTo(356 / 300, 10);
    expect(resize(bc, 's', 0, 0.1, CTX).h).toBeCloseTo(0.2667, 10);
    expect(resize(bc, 'w', 5, 0, CTX).w).toBeCloseTo(4 / 300, 10);   // one module at least
  });

  it('keeps a QR code square, in whole magnification steps for the DPI', () => {
    const qr = byId<QrElement>('qr');                      // 0.49 in = 7 × 21 modules at 300
    const ctx = { ...CTX, valueFor: () => '100000' };
    const out = resize(qr, 'se', 0.1, 0.05, ctx);          // 0.59 in → 177 dots → 8 × 21 = 168
    expect(out.w).toBeCloseTo(168 / 300, 10);
    expect(out.h).toBe(out.w);
    expect(resize(qr, 'se', 1, 1, ctx).w).toBeCloseTo(210 / 300, 10);       // capped at 10
    expect(resize(qr, 'se', -1, -1, ctx).w).toBeCloseTo(21 / 300, 10);     // at least 1
    const nw = resize(qr, 'nw', -0.1, -0.1, ctx);
    expect(nw.x + nw.w).toBeCloseTo(qr.x + qr.w, 10);
    expect(nw.y + nw.h).toBeCloseTo(qr.y + qr.h, 10);
    // a longer value needs more modules: 25 at 300 → 0.59 in → 7 × 25 = 175
    expect(resize(qr, 'e', 0.1, 0, { ...CTX, valueFor: () => 'sample-server-1' }).w).toBeCloseTo(175 / 300, 10);
  });

  it('treats a field shown as a QR code the same way', () => {
    const field = { ...byId<FieldElement>('banner-pod'), display: 'qr' as const, w: 0.49, h: 0.49 };
    const out = resize(field, 's', 0, 0.1, { ...CTX, valueFor: () => '100000' });
    expect(out.w).toBeCloseTo(168 / 300, 10);
    expect(out.h).toBe(out.w);
  });
});
