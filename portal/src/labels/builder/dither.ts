/**
 * Black and white for a thermal printer: an 8-bit gray raster to packed
 * 1-bit rows, bit for bit what api/src/serversherpa/labels/dither.py gives
 * for the same raster, so the canvas draws exactly the dots the printer
 * prints (spec 2026-10-20-badge-templates §4.5). labels/fixtures/dither.json
 * pins the two (dither.test.ts, api/tests/test_label_dither.py).
 *
 * Integer arithmetic only, as Python does it:
 * - table: v' = clamp(((v - 128) * contrast) // 100 + 128
 *   + brightness * 255 // 100, 0, 255), where `//` floors (Math.floor, never
 *   truncation: a negative quotient would be one level off)
 * - threshold: black when v' < threshold
 * - dither: Atkinson in raster order (no serpentine) on an Int32
 *   accumulator; black when it is below 128; (acc - (black ? 0 : 255)) >> 3
 *   (an arithmetic shift, which floors like Python's) goes to each of
 *   (+1, 0), (+2, 0), (-1, +1), (0, +1), (+1, +1) and (0, +2)
 * - invert flips each dot after that (never the pad bits)
 * - pack: MSB = leftmost dot, 1 = black, ceil(width / 8) bytes a row, pad
 *   bits 0.
 */

export type DitherMode = 'dither' | 'threshold';

export interface DitherParams {
  /** -100..100 */
  brightness: number;
  /** 0..300, a percent */
  contrast: number;
  /** 1..254: the threshold mode's cut */
  threshold: number;
  /** `dither` for a photo, `threshold` for a logo. */
  mode: DitherMode;
  invert: boolean;
}

/** dither.py's inclusive ranges (dither.test.ts reads them from there). */
export const BRIGHTNESS = [-100, 100] as const;
export const CONTRAST = [0, 300] as const;
export const THRESHOLD = [1, 254] as const;
const MODES: readonly string[] = ['dither', 'threshold'];

export function bytesPerRow(width: number): number {
  return (width + 7) >> 3;
}

function whole(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

/** Python's `a // b` for integers and b > 0. The quotients here stay far
 *  below 2^53, so the division is exact enough to floor correctly. */
function floorDiv(a: number, b: number): number {
  return Math.floor(a / b);
}

function checkParams(p: DitherParams): void {
  const ranges: [keyof DitherParams, readonly [number, number]][] = [
    ['brightness', BRIGHTNESS], ['contrast', CONTRAST], ['threshold', THRESHOLD],
  ];
  for (const [name, [lo, hi]] of ranges) {
    const v = p[name];
    if (!whole(v) || v < lo || v > hi) throw new RangeError(`${name} must be a whole number from ${lo} to ${hi}`);
  }
  if (!MODES.includes(p.mode)) throw new RangeError('mode must be dither or threshold');
}

/** The brightness/contrast table: level v prints as lut[v]. */
export function ditherLut(brightness: number, contrast: number): Uint8Array {
  const lift = floorDiv(brightness * 255, 100);
  const out = new Uint8Array(256);
  for (let v = 0; v < 256; v++) {
    out[v] = Math.max(0, Math.min(255, floorDiv((v - 128) * contrast, 100) + 128 + lift));
  }
  return out;
}

function atkinson(acc: Int32Array, width: number, height: number): Uint8Array {
  const black = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const below = y + 1 < height;
    const below2 = y + 2 < height;
    for (let x = 0; x < width; x++) {
      const i = row + x;
      const a = acc[i];
      const dot = a < 128;
      black[i] = dot ? 1 : 0;
      const err = (a - (dot ? 0 : 255)) >> 3;
      if (err === 0) continue;
      if (x + 1 < width) {
        acc[i + 1] += err;
        if (x + 2 < width) acc[i + 2] += err;
      }
      if (below) {
        const j = i + width;
        if (x > 0) acc[j - 1] += err;
        acc[j] += err;
        if (x + 1 < width) acc[j + 1] += err;
      }
      if (below2) acc[i + 2 * width] += err;
    }
  }
  return black;
}

/** `gray` (row-major 8-bit levels, 0 black, 255 white) as packed 1-bit rows
 *  (MSB = leftmost dot, 1 = black, pad bits 0). Never changes `gray`. */
export function ditherBitmap(gray: Uint8Array, width: number, height: number, p: DitherParams): Uint8Array {
  if (!whole(width) || !whole(height) || width < 0 || height < 0) {
    throw new RangeError('width and height must be whole numbers of 0 or more');
  }
  if (gray.length !== width * height) {
    throw new RangeError(`a ${width} x ${height} raster has ${width * height} levels, not ${gray.length}`);
  }
  checkParams(p);
  const table = ditherLut(p.brightness, p.contrast);
  let black: Uint8Array;
  if (p.mode === 'threshold') {
    black = new Uint8Array(gray.length);
    for (let i = 0; i < gray.length; i++) black[i] = table[gray[i]] < p.threshold ? 1 : 0;
  } else {
    const acc = new Int32Array(gray.length);
    for (let i = 0; i < gray.length; i++) acc[i] = table[gray[i]];
    black = atkinson(acc, width, height);
  }
  const invert = p.invert ? 1 : 0;
  const stride = bytesPerRow(width);
  const out = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    const base = y * stride;
    for (let x = 0; x < width; x++) {
      if (black[row + x] !== invert) out[base + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return out;
}
