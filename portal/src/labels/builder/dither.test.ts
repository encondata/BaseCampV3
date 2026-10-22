import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import fixture from '../../../../api/src/serversherpa/labels/fixtures/dither.json';
import {
  BRIGHTNESS, CONTRAST, THRESHOLD, bytesPerRow, ditherBitmap, ditherLut, type DitherParams,
} from './dither';

const DITHER_PY = join(__dirname, '../../../../api/src/serversherpa/labels/dither.py');

interface Case {
  name: string;
  width: number;
  height: number;
  params: DitherParams;
  gray: string;
  bits: string;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const DEFAULTS: DitherParams = { brightness: 0, contrast: 100, threshold: 128, mode: 'dither', invert: false };
const flat = (v: number, n: number) => new Uint8Array(n).fill(v);

interface Lut {
  brightness: number;
  contrast: number;
  table: string;
}

describe('ditherLut (labels/dither.py lut, whole tables from dither.json)', () => {
  const luts = (fixture as { luts: Lut[] }).luts;

  it('reads every table', () => {
    expect(luts.length).toBeGreaterThanOrEqual(13);
  });

  it.each(luts.map((t) => [`brightness ${t.brightness} contrast ${t.contrast}`, t] as const))('%s', (_name, t) => {
    expect(toHex(ditherLut(t.brightness, t.contrast))).toBe(t.table);
  });
});

describe('ditherBitmap (bit for bit labels/dither.py, through labels/fixtures/dither.json)', () => {
  const cases = (fixture as { cases: Case[] }).cases;

  it('reads every case', () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
  });

  it.each(cases.map((c) => [c.name, c] as const))('%s', (_name, c) => {
    const bits = ditherBitmap(fromHex(c.gray), c.width, c.height, c.params);
    expect(toHex(bits)).toBe(c.bits);
    expect(bits.length).toBe(bytesPerRow(c.width) * c.height);
  });
});

describe('worked by hand (the same values test_label_dither.py checks)', () => {
  it('packs MSB first with pad bits 0, inverted or not', () => {
    expect(toHex(ditherBitmap(flat(0, 26), 13, 2, DEFAULTS))).toBe('fff8fff8');
    expect(toHex(ditherBitmap(flat(255, 13), 13, 1, { ...DEFAULTS, invert: true }))).toBe('fff8');
    expect(toHex(ditherBitmap(flat(0, 13), 13, 1, { ...DEFAULTS, invert: true }))).toBe('0000');
  });

  it('diffuses Atkinson error along a row of 100s', () => {
    expect(toHex(ditherBitmap(flat(100, 5), 5, 1, DEFAULTS))).toBe('e8');
  });

  it('thresholds: black below the cut, white at it', () => {
    const gray = Uint8Array.from([127, 128, 0, 255]);
    expect(toHex(ditherBitmap(gray, 4, 1, { ...DEFAULTS, mode: 'threshold' }))).toBe('a0');
  });

  it('floors the table like Python, never truncating', () => {
    expect(ditherLut(0, 133)[100]).toBe(90);
    expect(ditherLut(-55, 100)[200]).toBe(59);
    expect(ditherLut(37, 100)[0]).toBe(94);
    expect(Array.from(ditherLut(0, 100))).toEqual(Array.from({ length: 256 }, (_, i) => i));
    expect(new Set(ditherLut(0, 0))).toEqual(new Set([128]));
    expect(ditherLut(0, 300)[127]).toBe(125);
  });

  it('refuses a raster of the wrong size and settings out of range', () => {
    expect(() => ditherBitmap(new Uint8Array(5), 2, 2, DEFAULTS)).toThrow(RangeError);
    expect(() => ditherBitmap(new Uint8Array(0), -1, 0, DEFAULTS)).toThrow(RangeError);
    for (const bad of [{ brightness: 101 }, { contrast: -1 }, { contrast: 301 }, { threshold: 0 },
      { threshold: 255 }, { brightness: 1.5 }, { mode: 'halftone' }]) {
      expect(() => ditherBitmap(flat(0, 1), 1, 1, { ...DEFAULTS, ...bad } as DitherParams)).toThrow(RangeError);
    }
    expect(ditherBitmap(new Uint8Array(0), 0, 0, DEFAULTS)).toEqual(new Uint8Array(0));
  });

  it('leaves its input alone', () => {
    const gray = Uint8Array.from([100, 100, 100, 100, 100]);
    ditherBitmap(gray, 5, 1, DEFAULTS);
    expect(Array.from(gray)).toEqual([100, 100, 100, 100, 100]);
  });

  it('mirrors the ranges in labels/dither.py', () => {
    const src = readFileSync(DITHER_PY, 'utf8');
    const range = (name: string) => {
      const m = new RegExp(`^${name} = \\((-?\\d+), (-?\\d+)\\)$`, 'm').exec(src);
      return m ? [Number(m[1]), Number(m[2])] : null;
    };
    expect(range('BRIGHTNESS')).toEqual([...BRIGHTNESS]);
    expect(range('CONTRAST')).toEqual([...CONTRAST]);
    expect(range('THRESHOLD')).toEqual([...THRESHOLD]);
  });
});
