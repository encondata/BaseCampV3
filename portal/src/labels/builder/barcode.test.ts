import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// The same cases pin the API's labels/barcode.py (tests/test_label_barcode.py),
// so the canvas draws a barcode exactly as wide as the printer prints it.
import fixture from '../../../../api/src/serversherpa/labels/fixtures/barcode_modules.json';
import { barcodeModules, code128Data, code128Subset } from './barcode';
import type { Symbology } from './model';

const BARCODE_PY = join(__dirname, '../../../../api/src/serversherpa/labels/barcode.py');

interface Case {
  name: string;
  symbology: Symbology;
  value: string;
  subset: 'B' | 'C' | null;
  modules: number;
  data?: string;
}

describe('barcode modules fixture', () => {
  it.each(fixture.cases as Case[])('$name', ({ symbology, value, subset, modules, data }) => {
    expect(barcodeModules(symbology, value)).toBe(modules);
    if (symbology === 'code128') expect(code128Subset(value)).toBe(subset);
    if (data !== undefined) expect(code128Data(value)).toBe(data);
  });
});

describe('barcodeModules', () => {
  it('follows each symbology for every length', () => {
    for (let n = 1; n < 12; n++) {
      const chars = n % 2 === 0 ? n / 2 : n;
      expect(barcodeModules('code128', '7'.repeat(n))).toBe(11 * (chars + 2) + 13);
      expect(barcodeModules('code128', 'x'.repeat(n))).toBe(11 * (n + 2) + 13);
      expect(barcodeModules('code39', 'X'.repeat(n))).toBe(16 * (n + 2) - 1);
    }
  });

  it('counts an astral character as its four UTF-8 bytes', () => {
    expect(barcodeModules('code128', '😀')).toBe(11 * 6 + 13);
  });

  it('uses the same start codes as labels/barcode.py', () => {
    const src = readFileSync(BARCODE_PY, 'utf8');
    expect(src).toContain('_START = {"B": ">:", "C": ">;"}');
    expect(code128Data('12')).toBe('>;12');
    expect(code128Data('A')).toBe('>:A');
  });
});
