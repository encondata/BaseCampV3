/**
 * How many narrow modules a barcode value prints as, the mirror of the
 * API's labels/barcode.py (fixtures/barcode_modules.json pins both): the
 * printer draws modules × the ^BY module whatever the element's box says,
 * so the canvas sizes a barcode from its value (geometry.ts).
 *
 * Code 128: the compiler starts the data in the subset counted here —
 * digits only, an even count of 2 or more, in subset C (`>;`, two digits a
 * character); anything else in subset B (`>:`). A character is 11 modules,
 * plus start and check (11 each) and stop (13). A literal `>` goes as `>0`,
 * one character, and each byte the compiler hex-escapes is one character,
 * so a value counts as its UTF-8 bytes.
 *
 * Code 39 (^BY ratio 3.0): 16 modules a character, the value plus start and
 * stop, less the last gap. An empty value is 0 modules: nothing prints.
 */

import type { Symbology } from './model';

const START = { B: '>:', C: '>;' } as const;
const encoder = new TextEncoder();

/** "C" for ASCII digits only, an even count of 2 or more; else "B". */
export function code128Subset(data: string): 'B' | 'C' {
  return data.length >= 2 && data.length % 2 === 0 && /^[0-9]+$/.test(data) ? 'C' : 'B';
}

/** The narrow modules `data` prints as in `symbology`. */
export function barcodeModules(symbology: Symbology, data: string): number {
  if (!data) return 0;
  const n = encoder.encode(data).length;
  if (symbology === 'code39') return 16 * (n + 2) - 1;
  const chars = code128Subset(data) === 'C' ? n / 2 : n;
  return 11 * (chars + 2) + 13;
}

/** Code 128 ^FD data as the compiler sends it (before ^FH escaping): a
 *  literal `>` as `>0`, behind its subset's start code. Empty stays empty. */
export function code128Data(data: string): string {
  if (!data) return '';
  return START[code128Subset(data)] + data.replaceAll('>', '>0');
}
