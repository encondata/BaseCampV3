import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FontWeight } from './fonts';
import {
  baselineIn, lineHeightIn, loadFont, reservedWidthIn, textWidthIn, type FontMetrics, type FontSource,
} from './metrics';

// 1000 units per em; the widest glyph is W (950), the widest digit 8 (560)
const METRICS: FontMetrics = {
  unitsPerEm: 1000,
  ascent: 900,
  descent: 300,
  advances: { ' ': 250, '0': 500, '1': 300, '7': 480, '8': 560, A: 600, W: 950, '.': 200 },
};

describe('measurement', () => {
  it('reserves expected length × the widest glyph for text, × the widest digit for a number', () => {
    // 3 × 950/1000 em × 24/72 in
    expect(reservedWidthIn(METRICS, 24, 3, 'text')).toBeCloseTo(0.95, 10);
    // 3 × 560/1000 em × 24/72 in
    expect(reservedWidthIn(METRICS, 24, 3, 'number')).toBeCloseTo(0.56, 10);
  });

  it('reserves nothing without an expected length or for a barcode or QR code', () => {
    expect(reservedWidthIn(METRICS, 24, null, 'text')).toBeNull();
    expect(reservedWidthIn(METRICS, 24, 0, 'text')).toBeNull();
    expect(reservedWidthIn(METRICS, 24, 3, 'barcode')).toBeNull();
    expect(reservedWidthIn(METRICS, 24, 3, 'qr')).toBeNull();
  });

  it('places the baseline ascent below the top', () => {
    expect(baselineIn(METRICS, 24)).toBeCloseTo(0.3, 10);       // 900/1000 × 24/72
    expect(lineHeightIn(METRICS, 24)).toBeCloseTo(0.4, 10);     // (900+300)/1000 × 24/72
  });

  it('measures text by its advances, a character outside the table as the widest glyph', () => {
    expect(textWidthIn(METRICS, 24, '01')).toBeCloseTo(0.8 / 3, 10);
    expect(textWidthIn(METRICS, 24, '')).toBe(0);
    expect(textWidthIn(METRICS, 24, 'é')).toBeCloseTo(0.95 / 3, 10);
  });

  it('scales widths for a widened face (faux bold on an inverted element)', () => {
    expect(textWidthIn(METRICS, 24, 'W', 1.15)).toBeCloseTo(1.15 * 0.95 / 3, 10);
    expect(reservedWidthIn(METRICS, 24, 2, 'number', 1.15)).toBeCloseTo(1.15 * 2 * 0.56 / 3, 10);
  });
});

describe('loadFont', () => {
  const calls: string[] = [];
  const source: FontSource = {
    metrics: async (family: string, weight: FontWeight) => {
      calls.push(`metrics ${family} ${weight}`);
      return METRICS;
    },
    bytes: async (family: string, weight: FontWeight) => {
      calls.push(`bytes ${family} ${weight}`);
      return new ArrayBuffer(4);
    },
  };

  afterEach(() => {
    calls.length = 0;
    vi.unstubAllGlobals();
  });

  it('draws the resident family with Roboto Condensed Bold and measures it with its own file', async () => {
    const out = await loadFont('swiss721-cond-bold', 'bold', source);
    expect(out.metrics).toBe(METRICS);
    expect(out.face).toBeNull();                 // no FontFace here (node): never fetches the face
    expect(out.cssFamily).toBe('label-builder-roboto-condensed-bold');
    expect(calls).toEqual(['metrics swiss721-cond-bold regular']);
  });

  it('loads and registers the face where the browser has FontFace', async () => {
    const added: unknown[] = [];
    class FakeFace {
      constructor(public family: string, public source: ArrayBuffer) {}
      async load() { return this; }
    }
    vi.stubGlobal('FontFace', FakeFace);
    vi.stubGlobal('document', { fonts: { add: (f: unknown) => added.push(f) } });

    const swiss = await loadFont('swiss721-cond-bold', 'regular', source);
    expect(calls).toEqual(['metrics swiss721-cond-bold regular', 'bytes roboto-condensed bold']);
    expect((swiss.face as unknown as FakeFace).family).toBe('label-builder-roboto-condensed-bold');
    expect(added).toEqual([swiss.face]);

    calls.length = 0;
    const mono = await loadFont('roboto-mono', 'bold', source);
    expect(calls).toEqual(['metrics roboto-mono bold', 'bytes roboto-mono bold']);
    expect(mono.cssFamily).toBe('label-builder-roboto-mono-bold');
  });

  it('refuses a family the builder does not offer', async () => {
    await expect(loadFont('comic-sans', 'regular', source)).rejects.toThrow(/unknown font family/);
  });
});
