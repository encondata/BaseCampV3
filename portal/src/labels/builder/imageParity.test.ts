/**
 * The canvas draws exactly the dots the printer prints (spec
 * 2026-10-20-badge-templates §4.5, §4.12): for three image elements at 203,
 * 300 and 600 DPI, unturned and turned 90 degrees, the builder's own path
 * — the element's box in dots (image.ts), its dither settings with the
 * source's defaults (model.ts imageParams) and dither.ts — gives the bits
 * the Python label core gives (fixtures/image_parity.json, written by
 * fixtures/image_parity.py from labels/model.py, zpl.py and dither.py).
 *
 * The gray pictures are integer formulas mirrored from image_parity.py,
 * turned the way the server's prep turns a picture (exact transposition).
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { bytesPerRow, ditherBitmap } from './dither';
import fixture from './fixtures/image_parity.json';
import { EMPTY_IMAGE_STROKE_DOTS, imageBoxDots, imageRasterSize } from './image';
import { imageParams, parseDesign, type ImageElement } from './model';

const ZPL_PY = join(__dirname, '../../../../api/src/serversherpa/labels/zpl.py');

interface Case {
  name: string;
  kind: string;
  element: Record<string, unknown>;
  dpi: number;
  box: number[];
  width: number;
  height: number;
  black: number;
  sha256: string;
  head: string;
}

const lcg = (state: number) => (Math.imul(state, 1103515245) + 12345) & 0x7fffffff;

/** image_parity.py `gray`: a w x h picture from integers only. */
function gray(kind: string, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  let state = 2026 + w * 7 + h;
  for (let v = 0; v < h; v++) {
    for (let u = 0; u < w; u++) {
      state = lcg(state);
      const noise = ((state >> 16) % 49) - 24;
      let level: number;
      if (kind === 'portrait') {
        const ramp = Math.floor((Math.floor((u * 255) / Math.max(w - 1, 1)) + Math.floor((v * 255) / Math.max(h - 1, 1))) / 2);
        const du = 2 * u - w;
        const dv = 2 * v - h;
        const ring = du * du + dv * dv < Math.floor((Math.min(w, h) * Math.min(w, h)) / 3) ? 70 : 0;
        level = ramp - ring + noise;
      } else if (kind === 'bars') {
        level = (Math.floor((u * 9) / Math.max(w, 1)) + Math.floor((v * 5) / Math.max(h, 1))) % 2 === 0 ? 20 : 230;
        level += Math.floor(noise / 3);
      } else {
        const r = Math.floor((u * 255) / Math.max(w - 1, 1));
        level = v * 3 < h * 2 ? r : 255 - r;
      }
      out[v * w + u] = Math.max(0, Math.min(255, level));
    }
  }
  return out;
}

/** image_parity.py `turned`: 90 degrees clockwise, h wide and w tall. */
function turned(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < w; y++) {
    for (let x = 0; x < h; x++) out[y * h + x] = src[(h - 1 - x) * w + y];
  }
  return out;
}

function blackDots(bits: Uint8Array): number {
  let n = 0;
  for (const b of bits) for (let v = b; v; v &= v - 1) n++;
  return n;
}

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const cases = (fixture as { cases: Case[] }).cases;

describe('image parity with the Python label core (fixtures/image_parity.json)', () => {
  it('covers three pictures at 203, 300 and 600 DPI, turned 0 and 90', () => {
    expect(cases).toHaveLength(18);
    expect(new Set(cases.map((c) => c.kind))).toEqual(new Set(['portrait', 'bars', 'ramp']));
    expect(new Set(cases.map((c) => c.dpi))).toEqual(new Set([203, 300, 600]));
    expect(new Set(cases.map((c) => c.element.rotation))).toEqual(new Set([0, 90]));
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const el = parseDesign({ schema: 3, size: { w: 4, h: 3 }, elements: [c.element] }).elements[0] as ImageElement;
    // the box the server fits the picture to (zpl.py image_box_dots)
    const box = imageBoxDots(el, c.dpi);
    expect([box.w, box.h]).toEqual(c.box);
    // the raster comes turned: what the canvas draws and the printer prints
    const size = imageRasterSize(el, c.dpi);
    expect([size.width, size.height]).toEqual([c.width, c.height]);
    const picture = gray(c.kind, box.w, box.h);
    const raster = el.rotation === 90 ? turned(picture, box.w, box.h) : picture;
    const bits = ditherBitmap(raster, size.width, size.height, imageParams(el));
    expect(bits.length).toBe(bytesPerRow(size.width) * size.height);
    expect(hex(bits.subarray(0, 24))).toBe(c.head);
    expect(blackDots(bits)).toBe(c.black);
    expect(createHash('sha256').update(bits).digest('hex')).toBe(c.sha256);
  });

  it('outlines an empty picture with the stroke zpl.py prints', () => {
    const m = /^EMPTY_IMAGE_STROKE = (\d+)$/m.exec(readFileSync(ZPL_PY, 'utf8'));
    expect(m && Number(m[1])).toBe(EMPTY_IMAGE_STROKE_DOTS);
  });
});
