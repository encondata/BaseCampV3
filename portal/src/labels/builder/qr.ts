/**
 * QR code sizing, mirrored from the API's labels/qr.py and the v2 compiler's
 * `_v2_qr` (labels/zpl.py), so the canvas draws a QR code at the size and
 * place the printer prints it. Change them together; qr.test.ts pins the
 * capacity table to qr.py and shares its cases.
 *
 * The printer encodes at error correction M in automatic mode. A symbol is
 * 17 + 4 × version modules a side; the magnification (dots per module)
 * comes from the box width only, capped at the printer's 10, and the symbol
 * is centered on the box.
 */

import { toDots } from './units';

/** Data capacity at error correction M for versions 1-10, as
 *  [numeric digits, alphanumeric characters, bytes]. */
export const CAPACITY_M: readonly (readonly [number, number, number])[] = [
  [34, 20, 14], [63, 38, 26], [101, 61, 42], [149, 90, 62], [202, 122, 84],
  [255, 154, 106], [293, 178, 122], [365, 221, 152], [432, 262, 180],
  [513, 311, 213],
];

export const QR_MAX_MAGNIFICATION = 10;

const NUMERIC = /^[0-9]*$/;
// the QR alphanumeric set: digits, upper-case letters, space and $ % * + - . / :
const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]*$/;
const MODE_NAMES = ['digits', 'characters', 'bytes'] as const;

/** Modules per side of the smallest version whose level-M capacity holds
 *  `value`: numeric for ASCII digits only, alphanumeric when every character
 *  is in the QR alphanumeric set, else bytes counted as UTF-8. Throws a
 *  RangeError past version 10 (the compiler refuses the value too). */
export function qrModules(value: string): number {
  let mode: 0 | 1 | 2;
  let length: number;
  if (NUMERIC.test(value)) {
    mode = 0;
    length = value.length;
  } else if (ALPHANUMERIC.test(value)) {
    mode = 1;
    length = value.length;
  } else {
    mode = 2;
    length = new TextEncoder().encode(value).length;
  }
  const version = CAPACITY_M.findIndex((capacity) => length <= capacity[mode]);
  if (version < 0) {
    throw new RangeError(
      `QR data too long for version 10 at error correction M (${length} ${MODE_NAMES[mode]})`);
  }
  return 17 + 4 * (version + 1);
}

/** Dots per module for a box `wDots` wide: the compiler's
 *  min(10, max(1, round(w / modules))). */
export function qrMagnification(wDots: number, modules: number): number {
  return Math.min(QR_MAX_MAGNIFICATION, Math.max(1, Math.round(wDots / modules)));
}

export interface QrLayout {
  modules: number;
  magnification: number;
  /** The symbol's side in dots. */
  side: number;
  /** The symbol's top-left in dots (the compiler's `^FO`). */
  x: number;
  y: number;
  /** The box asks for more than the printer's magnification cap. */
  capped: boolean;
}

/** Where the printer puts a QR code whose box is `box` (inches) at `dpi`. */
export function qrLayout(box: { x: number; y: number; w: number; h: number }, value: string,
  dpi: number): QrLayout {
  const modules = qrModules(value);
  const wd = toDots(box.w, dpi);
  const hd = toDots(box.h, dpi);
  // modules is odd, so wd / modules is never a tie: Math.round is Python's round here
  const magnification = qrMagnification(wd, modules);
  const side = modules * magnification;
  return {
    modules,
    magnification,
    side,
    x: Math.max(0, toDots(box.x, dpi) + Math.floor((wd - side) / 2)),
    y: Math.max(0, toDots(box.y, dpi) + Math.floor((hd - side) / 2)),
    capped: Math.round(wd / modules) > QR_MAX_MAGNIFICATION,
  };
}
