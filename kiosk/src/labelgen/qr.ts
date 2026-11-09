/**
 * QR code sizing for the v2 ZPL compiler (labels/qr.py): how many modules a
 * value needs, split into its shortest numeric, alphanumeric and byte
 * segments at error correction M.
 *
 * Ported rather than imported from the portal's builder/qr.ts, which uses
 * TextEncoder: the Android bundle's engine has none. Pure: no DOM, no Intl,
 * no Node.
 */

import { DesignError } from './errors';
import { utf8Length } from './py';

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

const NUMERIC = /^[0-9]*$/;
// the QR alphanumeric set: digits, upper-case letters, space and $ % * + - . / :
const ALPHANUMERIC = /^[0-9A-Z $%*+\-./:]*$/;
const MODE_NAMES = ['digits', 'characters', 'bytes'] as const;

/** A ^BQ symbol prints this many dots below its ^FO y (labels/qr.py
 *  QR_PRINT_DROP_DOTS): the compiler sets ^FO this far above the box. */
export const QR_PRINT_DROP_DOTS = 10;

/** Data bits at error correction M for versions 1-10 (data codewords x 8).
 *  CAPACITY_M is these for a value in one mode. */
export const DATA_BITS_M: readonly number[] = [128, 224, 352, 512, 688, 864, 992, 1232, 1456, 1728];

// Character count indicator bits (numeric, alphanumeric, byte): versions
// 1-9, then 10.
const COUNT_BITS: readonly (readonly [number, number, number])[] = [[10, 9, 8], [12, 11, 16]];
// the bits a numeric (0-2 digits) or alphanumeric (0-1 characters) remainder
// adds when its segment ends
const TAIL: readonly (readonly number[])[] = [[0, 4, 7], [0, 6], [0]];
const GROUP = [3, 2, 1];   // characters per full group: 10, 11 or 8 x bytes bits

function modesFor(ch: string): readonly number[] {
  if (NUMERIC.test(ch)) return [0, 1, 2];
  return ALPHANUMERIC.test(ch) ? [1, 2] : [2];
}

/** The fewest data bits `value` takes split into numeric, alphanumeric and
 *  byte segments, each with its 4-bit mode and its count indicator
 *  (`countBits` per mode): an exact dynamic program over (mode, characters
 *  left over in the current group), as labels/qr.py segmented_bits. */
export function segmentedBits(value: string, countBits: readonly [number, number, number]): number {
  if (value === '') return 0;
  const fresh = () => [[Infinity, Infinity, Infinity], [Infinity, Infinity], [Infinity]];
  const close = (cost: number[][]) => Math.min(
    ...cost.flatMap((row, m) => row.map((c, r) => c + TAIL[m][r])));
  let cost = fresh();
  let first = true;
  for (const ch of value) {
    const next = fresh();
    const byteBits = 8 * utf8Length(ch);
    const closed = first ? 0 : close(cost);
    for (const m2 of modesFor(ch)) {
      const start = closed + 4 + countBits[m2];
      if (m2 === 2) next[2][0] = Math.min(next[2][0], start + byteBits);
      else next[m2][1] = Math.min(next[m2][1], start);
      if (first) continue;
      cost[m2].forEach((c, r) => {
        if (c === Infinity) return;
        if (m2 === 2) next[2][0] = Math.min(next[2][0], c + byteBits);
        else if (r + 1 === GROUP[m2]) next[m2][0] = Math.min(next[m2][0], c + (m2 === 0 ? 10 : 11));
        else next[m2][r + 1] = Math.min(next[m2][r + 1], c);
      });
    }
    cost = next;
    first = false;
  }
  return close(cost);
}

/** Modules per side (17 + 4 x version) of the smallest version whose
 *  level-M data bits hold `value` split into its shortest segments
 *  (`segmentedBits`), as the printer's automatic mode encodes it. Throws
 *  QrTooLong past version 10, describing the value in one mode: digits when
 *  it is ASCII digits only, characters when every one is in the QR
 *  alphanumeric set, else UTF-8 bytes. */
export function qrModules(value: string): number {
  const short = segmentedBits(value, COUNT_BITS[0]);
  for (let version = 1; version <= DATA_BITS_M.length; version += 1) {
    const bits = version < 10 ? short : segmentedBits(value, COUNT_BITS[1]);
    if (bits <= DATA_BITS_M[version - 1]) return 17 + 4 * version;
  }
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
  throw new QrTooLong('QR data too long for version 10 at error correction M '
    + `(${length} ${MODE_NAMES[mode]})`);
}
