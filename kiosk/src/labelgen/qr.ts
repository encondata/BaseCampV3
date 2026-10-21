/**
 * QR code sizing for the v2 ZPL compiler (labels/qr.py): how many modules a
 * value needs at error correction M, and how far below its ^FO the printer
 * draws a ^BQ symbol.
 *
 * Ported rather than imported from the portal's builder/qr.ts, which uses
 * TextEncoder: the Android bundle's engine has none. Pure: no DOM, no Intl,
 * no Node.
 */

import { DesignError } from './errors';
import { pyRound, utf8Length } from './py';

/** A QR value no level-M symbol up to version 10 holds: a problem with the
 *  design's data, not a crash. */
export class QrTooLong extends DesignError {
  constructor(message: string) {
    super([message]);
    this.name = 'QrTooLong';
  }
}

/** Data capacity at error correction M for versions 1-10, as
 *  [numeric digits, alphanumeric characters, bytes]. */
export const CAPACITY_M: readonly (readonly [number, number, number])[] = [
  [34, 20, 14], [63, 38, 26], [101, 61, 42], [149, 90, 62], [202, 122, 84],
  [255, 154, 106], [293, 178, 122], [365, 221, 152], [432, 262, 180],
  [513, 311, 213],
];

/** How far below its ^FO y the printer draws a ^BQ symbol's top edge, in
 *  inches (measured at 300 dpi; the other DPIs scale it). */
export const QR_FO_OFFSET_IN = 0.2;

/** The printer's ^BQ offset below ^FO at `dpi`, in dots. */
export function qrFoOffsetDots(dpi: number): number {
  return pyRound(QR_FO_OFFSET_IN * dpi);
}

const NUMERIC = /^[0-9]*$/;
// the QR alphanumeric set: digits, upper-case letters, space and $ % * + - . / :
const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]*$/;
const MODE_NAMES = ['digits', 'characters', 'bytes'] as const;

/** Modules per side (17 + 4 x version) of the smallest version whose
 *  level-M capacity holds `value`: numeric when it is ASCII digits only,
 *  alphanumeric when every character is in the QR alphanumeric set, else
 *  byte mode counting UTF-8 bytes. Throws QrTooLong past version 10. */
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
    length = utf8Length(value);
  }
  for (let version = 1; version <= CAPACITY_M.length; version += 1) {
    if (length <= CAPACITY_M[version - 1][mode]) return 17 + 4 * version;
  }
  throw new QrTooLong('QR data too long for version 10 at error correction M '
    + `(${length} ${MODE_NAMES[mode]})`);
}
