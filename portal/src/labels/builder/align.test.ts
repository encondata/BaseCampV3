import { describe, expect, it } from 'vitest';

import vegas from '../../../../api/src/serversherpa/labels/fixtures/vegas_v2.json';
import { align, distribute, matchSize } from './align';
import { footprint } from './geometry';
import { parseDesign, type BoxElement, type ElementV2, type FieldElement, type QrElement } from './model';

const VEGAS = parseDesign(vegas);
const byId = <T extends ElementV2>(id: string) => VEGAS.elements.find((e) => e.id === id) as T;
const LABEL = { w: 4, h: 2 };

function box(id: string, x: number, y: number, w: number, h: number, extra: Partial<BoxElement> = {}): BoxElement {
  return { id, type: 'box', x, y, w, h, rotation: 0, strokeIn: 0.01, ...extra };
}

const A = box('a', 0.5, 0.2, 1, 0.5);   // 0.5..1.5 × 0.2..0.7
const B = box('b', 1.2, 0.6, 0.5, 0.2); // 1.2..1.7 × 0.6..0.8

function xs(els: ElementV2[]) { return els.map((e) => e.x); }
function ys(els: ElementV2[]) { return els.map((e) => e.y); }

describe('align', () => {
  const round = (vs: number[]) => vs.map((v) => +v.toFixed(10));

  it('lines the others up on the first selected, which stays put', () => {
    // A first: 0.5..1.5 × 0.2..0.7
    expect(round(xs(align([A, B], 'left', LABEL)))).toEqual([0.5, 0.5]);
    expect(round(xs(align([A, B], 'right', LABEL)))).toEqual([0.5, 1]);
    expect(round(xs(align([A, B], 'center', LABEL)))).toEqual([0.5, 0.75]);
    expect(round(ys(align([A, B], 'top', LABEL)))).toEqual([0.2, 0.2]);
    expect(round(ys(align([A, B], 'bottom', LABEL)))).toEqual([0.2, 0.5]);
    expect(round(ys(align([A, B], 'middle', LABEL)))).toEqual([0.2, 0.35]);
  });

  it('the anchor is the first selected, not the leftmost or the topmost', () => {
    // B first: 1.2..1.7 × 0.6..0.8
    expect(round(xs(align([B, A], 'left', LABEL)))).toEqual([1.2, 1.2]);
    expect(round(xs(align([B, A], 'right', LABEL)))).toEqual([1.2, 0.7]);
    expect(round(xs(align([B, A], 'center', LABEL)))).toEqual([1.2, 0.95]);
    expect(round(ys(align([B, A], 'top', LABEL)))).toEqual([0.6, 0.6]);
    expect(round(ys(align([B, A], 'bottom', LABEL)))).toEqual([0.6, 0.3]);
    expect(round(ys(align([B, A], 'middle', LABEL)))).toEqual([0.6, 0.45]);
    // and only the one axis moves
    expect(ys(align([B, A], 'left', LABEL))).toEqual([0.6, 0.2]);
    expect(xs(align([B, A], 'top', LABEL))).toEqual([1.2, 0.5]);
  });

  it('aligns every other element to the first, by footprint, leaving the locked ones', () => {
    const C = box('c', 3, 1, 0.4, 0.4);
    const locked = box('l', 2, 1.5, 0.2, 0.2, { locked: true });
    const out = align([C, A, locked, B], 'right', LABEL);
    expect(round(xs(out))).toEqual([3, 2.4, 2, 2.9]);
    expect(out[0]).toBe(C);
    expect(out[2]).toBe(locked);
    // a locked anchor is still the anchor
    const lockedFirst = { ...B, locked: true };
    expect(round(xs(align([lockedFirst, A], 'left', LABEL)))).toEqual([1.2, 1.2]);
    // a turned element lines up by what it covers
    const side = byId<FieldElement>('side-site');      // 270: 0.108 wide
    expect(align([A, side], 'right', LABEL)[1].x).toBeCloseTo(1.5 - 0.108, 10);
  });

  it('aligns one element to the label', () => {
    expect(align([A], 'left', LABEL)[0].x).toBe(0);
    expect(align([A], 'center', LABEL)[0].x).toBe(1.5);
    expect(align([A], 'right', LABEL)[0].x).toBe(3);
    expect(align([A], 'top', LABEL)[0].y).toBe(0);
    expect(align([A], 'middle', LABEL)[0].y).toBe(0.75);
    expect(align([A], 'bottom', LABEL)[0].y).toBe(1.5);
  });

  it('aligns a turned element by its footprint', () => {
    const side = byId<FieldElement>('side-site');      // 270: 0.108 wide on the label
    expect(align([side], 'right', LABEL)[0].x).toBeCloseTo(4 - 0.108, 10);
    expect(align([side], 'bottom', LABEL)[0].y).toBeCloseTo(2 - 0.8333, 10);
  });

  it('changes nothing but the position', () => {
    const [out] = align([A], 'right', LABEL);
    expect(out).toEqual({ ...A, x: 3 });
    expect(A.x).toBe(0.5);
  });
});

describe('distribute', () => {
  it('spaces the gaps evenly between the outermost elements, in input order', () => {
    const els = [box('m', 1.5, 0, 0.5, 0.1), box('l', 0, 0.2, 1, 0.1), box('r', 3, 0.4, 1, 0.1)];
    // span 0..4, widths 2.5 → gaps of 0.75: l 0, m 1.75, r 3
    expect(xs(distribute(els, 'h'))).toEqual([1.75, 0, 3]);
    expect(ys(distribute(els, 'h'))).toEqual([0, 0.2, 0.4]);
  });

  it('works vertically', () => {
    const els = [box('t', 0, 0, 1, 0.2), box('m', 0, 0.3, 1, 0.4), box('b', 0, 1.6, 1, 0.4)];
    // span 0..2, heights 1.0 → gaps of 0.5: m at 0.7
    expect(ys(distribute(els, 'v')).map((v) => +v.toFixed(10))).toEqual([0, 0.7, 1.6]);
  });

  it('needs three elements', () => {
    expect(distribute([A, B], 'h')).toEqual([A, B]);
  });
});

describe('matchSize', () => {
  it('sizes every element to the first one', () => {
    const out = matchSize([A, B, box('c', 2, 1, 0.1, 0.1)], 'w');
    expect(out.map((e) => +e.w.toFixed(10))).toEqual([1, 1, 1]);
    expect(out.map((e) => e.h)).toEqual([0.5, 0.2, 0.1]);
    expect(matchSize([A, B], 'h').map((e) => +e.h.toFixed(10))).toEqual([0.5, 0.5]);
    expect(matchSize([A, B], 'h')[1]).toMatchObject({ x: 1.2, y: 0.6 });
  });

  it('follows each type’s resize rule', () => {
    const qr = byId<QrElement>('qr');                   // square, 21 modules at 300
    const pod = byId<FieldElement>('banner-pod');       // width held by its expected length
    // 0.59 in → 177 dots → 8 × 21 modules
    const out = matchSize([box('big', 0, 0, 0.59, 0.59), qr, pod], 'w', { dpi: 300, valueFor: () => '100000' });
    expect(out[1].w).toBeCloseTo(168 / 300, 10);
    expect(out[1].h).toBe(out[1].w);
    expect(out[2].w).toBe(pod.w);
  });

  it('matches the footprint of a turned element', () => {
    const side = byId<FieldElement>('side-site');      // footprint 0.108 × 0.8333
    const out = matchSize([box('tall', 0, 0, 0.5, 1.6667), side], 'h');
    expect(footprint(out[1]).h).toBeCloseTo(1.6667, 10);
    expect(out[1].w).toBeCloseTo(1.6667, 10);
  });
});
