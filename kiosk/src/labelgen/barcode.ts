/**
 * Barcode widths for the v2 ZPL compiler (labels/barcode.py): how many
 * narrow modules a value prints as, and the Code 128 subset the compiler
 * starts it in. fixtures/barcode_modules.json pins it to the Python.
 *
 * Code 128 (`^BC`, mode N): digits only, an even count of 2 or more, go in
 * subset C (`>;`, two digits a character); anything else in subset B
 * (`>:`). A character is 11 modules, plus start and check (11 each) and
 * stop (13); a value counts as its UTF-8 bytes. Code 39 (`^B3`): 16
 * modules a character, plus start and stop, less the last gap. An empty
 * value is 0 modules.
 *
 * Ported rather than imported from the portal's builder/barcode.ts, which
 * uses TextEncoder: the Android bundle's engine has none. Pure: no DOM, no
 * Intl, no Node.
 */

import { cpLength, floorDiv, utf8Length } from './py';

const START = { B: '>:', C: '>;' } as const;

/** "C" for ASCII digits only, an even count of 2 or more; else "B". */
export function code128Subset(data: string): 'B' | 'C' {
  const n = cpLength(data);
  return n >= 2 && n % 2 === 0 && /^[0-9]+$/.test(data) ? 'C' : 'B';
}

/** The narrow modules `data` prints as in `symbology` (code128 | code39). */
export function barcodeModules(symbology: string, data: string): number {
  if (!data) return 0;
  const n = utf8Length(data);
  if (symbology === 'code39') return 16 * (n + 2) - 1;
  const chars = code128Subset(data) === 'C' ? floorDiv(n, 2) : n;
  return 11 * (chars + 2) + 13;
}

/** Code 128 ^FD data: a literal `>` as `>0`, behind the start code of the
 *  subset `code128Subset` picks. `fd` may already be ^FH-escaped (escaping
 *  never makes a digit or a `>`). Empty stays empty. */
export function code128Data(fd: string): string {
  if (!fd) return '';
  return START[code128Subset(fd)] + fd.split('>').join('>0');
}
