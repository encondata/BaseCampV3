/**
 * QR code sizing, mirrored from the API's labels/qr.py and the v2 compiler's
 * `_v2_qr` (labels/zpl.py), so the canvas draws a QR code at the size and
 * place the printer prints it. Change them together; qr.test.ts pins the
 * capacity table to qr.py and shares its cases.
 *
 * The printer encodes at error correction M in automatic mode. A symbol is
 * 17 + 4 × version modules a side; the magnification (dots per module)
 * comes from the box width only, capped at the printer's 10, and the symbol
 * is centered on the box; ^BQ prints QR_PRINT_DROP_DOTS below its ^FO, so the
 * compiler's ^FO is that far above. `qrLayout` is where the symbol prints,
 * as Labelary renders it and the printer prints it. `qrMatrix` is the symbol itself, encoded as the printer encodes
 * it, so the canvas draws the real code for the sample value, as it draws
 * every other sample.
 */

import QRCode from 'qrcode';

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
    const byteBits = 8 * new TextEncoder().encode(ch).length;
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
  const mode = qrMode(value);
  const length = mode === 2 ? new TextEncoder().encode(value).length : value.length;
  throw new RangeError(
    `QR data too long for version 10 at error correction M (${length} ${MODE_NAMES[mode]})`);
}

/** 0 numeric (ASCII digits only), 1 alphanumeric (every character in the
 *  QR alphanumeric set), else 2 bytes (UTF-8). */
function qrMode(value: string): 0 | 1 | 2 {
  if (NUMERIC.test(value)) return 0;
  return ALPHANUMERIC.test(value) ? 1 : 2;
}

/** Dots per module for a box `wDots` wide: the compiler's
 *  min(10, max(1, round(w / modules))). */
export function qrMagnification(wDots: number, modules: number): number {
  return Math.min(QR_MAX_MAGNIFICATION, Math.max(1, Math.round(wDots / modules)));
}

/** How far below its ^FO y a ^BQ symbol prints, in dots: 10 at 203, 300
 *  and 600 DPI and magnification 2 to 10, with no sideways shift (Labelary,
 *  2026-11-09; the 203 DPI print matches the render). The compiler sets ^FO
 *  this far above the symbol's place (labels/qr.py QR_PRINT_DROP_DOTS), so
 *  it prints on its box. */
export const QR_PRINT_DROP_DOTS = 10;

export interface QrLayout {
  modules: number;
  magnification: number;
  /** The symbol's side in dots. */
  side: number;
  /** The symbol's top-left in dots, where it prints: centered on the box,
   *  never nearer the top than QR_PRINT_DROP_DOTS. */
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
    // the compiler's ^FO y is the drop above the centered top, never above 0
    y: Math.max(0, toDots(box.y, dpi) + Math.floor((hd - side) / 2) - QR_PRINT_DROP_DOTS) + QR_PRINT_DROP_DOTS,
    capped: Math.round(wd / modules) > QR_MAX_MAGNIFICATION,
  };
}

/** The symbol's dark modules for `value`, `modules` a side (from
 *  `qrModules`), encoded the way the printer does it. Matched module for
 *  module against Labelary (2026-11-09) for numeric, alphanumeric, byte,
 *  UTF-8 and mixed values at versions 1-6:
 *  - the value split into the shortest run of numeric, alphanumeric and
 *    byte segments (the encoder's own optimizer: "SN" + "0000001");
 *  - the version that mode needs at error correction M, then the highest
 *    level that still fits that version: H, Q, then M (the level in
 *    `^FDMA,` doesn't change it);
 *  - the mask with the lowest penalty, scored as ZXing scores it
 *    (`maskPenalty`), the lowest mask number winning a tie.
 *  Null when the value can't be encoded (the canvas falls back to a
 *  placeholder). Cached by value. */
export function qrMatrix(value: string, modules: number): boolean[][] | null {
  const key = `${modules}:${value}`;
  const hit = matrixCache.get(key);
  if (hit !== undefined) return hit;
  const out = encodeQr(value, modules);
  if (matrixCache.size >= MATRIX_CACHE_MAX) matrixCache.delete(matrixCache.keys().next().value!);
  matrixCache.set(key, out);
  return out;
}

function encodeQr(value: string, modules: number): boolean[][] | null {
  if (value === '') return null;
  const version = (modules - 17) / 4;
  for (const errorCorrectionLevel of ['H', 'Q', 'M'] as const) {
    const grids: boolean[][][] = [];
    try {
      for (let maskPattern = 0; maskPattern < 8; maskPattern++) {
        const { modules: m } = QRCode.create(value, {
          errorCorrectionLevel, version, maskPattern: maskPattern as QRCode.QRCodeMaskPattern });
        if (m.size !== modules) return null;
        grids.push(Array.from({ length: m.size }, (_, r) => Array.from({ length: m.size }, (_, c) => !!m.get(r, c))));
      }
    } catch {
      continue;   // too much data for this level at this version: try the next one down
    }
    let best = 0;
    let bestPenalty = Infinity;
    grids.forEach((g, i) => {
      const penalty = maskPenalty(g);
      if (penalty < bestPenalty) {
        best = i;
        bestPenalty = penalty;
      }
    });
    return grids[best];
  }
  return null;
}

/** ZXing's MaskUtil penalty: runs of five or more (3, +1 a module past
 *  five), 2 × 2 blocks (3 each), finder-like 1:1:3:1:1 runs with four light
 *  modules on either side, the edge counting as light (40 each), and the
 *  dark share's distance from half (10 per 5 %). */
export function maskPenalty(g: boolean[][]): number {
  const n = g.length;
  const at = (y: number, x: number) => y >= 0 && x >= 0 && y < n && x < n && g[y][x];
  let penalty = 0;
  for (const vertical of [false, true]) {
    for (let i = 0; i < n; i++) {
      let run = 0;
      let prev: boolean | null = null;
      for (let j = 0; j < n; j++) {
        const b = vertical ? g[j][i] : g[i][j];
        if (b === prev) {
          run++;
        } else {
          if (run >= 5) penalty += 3 + run - 5;
          run = 1;
          prev = b;
        }
      }
      if (run >= 5) penalty += 3 + run - 5;
    }
  }
  for (let y = 0; y < n - 1; y++) {
    for (let x = 0; x < n - 1; x++) {
      const v = g[y][x];
      if (v === g[y][x + 1] && v === g[y + 1][x] && v === g[y + 1][x + 1]) penalty += 3;
    }
  }
  const finder = [true, false, true, true, true, false, true];
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      for (const [dy, dx] of [[0, 1], [1, 0]]) {
        if (!finder.every((b, i) => at(y + dy * i, x + dx * i) === b)) continue;
        const lightBefore = [1, 2, 3, 4].every((i) => !at(y - dy * i, x - dx * i));
        const lightAfter = [7, 8, 9, 10].every((i) => !at(y + dy * i, x + dx * i));
        if (lightBefore || lightAfter) penalty += 40;
      }
    }
  }
  const dark = g.reduce((sum, row) => sum + row.filter(Boolean).length, 0);
  penalty += Math.floor((Math.abs(dark * 2 - n * n) * 10) / (n * n)) * 10;
  return penalty;
}

const MATRIX_CACHE_MAX = 200;
const matrixCache = new Map<string, boolean[][] | null>();
