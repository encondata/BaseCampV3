/**
 * Font measurement for the canvas, from the metrics the API reads out of the
 * library file (`GET /labels/fonts/{id}/metrics`, labels/font_metrics.py),
 * never from a <canvas>: widths and baselines come out the same in a test
 * as in the browser, and the resident Swiss cut — drawn with a stand-in
 * face — still measures as the printer's file (spec §4.2, §4.4).
 *
 * Every metric is in font units; a size in points scales them by
 * size / 72 / unitsPerEm to inches.
 */

import { faceFile, familyInfo, metricsFile, type FontRef, type FontWeight } from './fonts';
import type { Display } from './model';

export interface FontMetrics {
  unitsPerEm: number;
  /** Above the baseline, positive (hhea). */
  ascent: number;
  /** Below the baseline, positive (hhea). */
  descent: number;
  /** Advance width per character; covers printable ASCII. */
  advances: Record<string, number>;
}

/** How the builder reaches the font library; the caller resolves a family
 *  and weight to its library file (`GET /labels/fonts`). */
export interface FontSource {
  /** `GET /labels/fonts/{id}/metrics` of the file. */
  metrics(family: string, weight: FontWeight): Promise<FontMetrics>;
  /** `GET /labels/fonts/{id}/content` of the file (never a resident one). */
  bytes(family: string, weight: FontWeight): Promise<ArrayBuffer>;
}

export interface LoadedFont {
  /** The loaded face, added to `document.fonts`; null where the browser has
   *  no FontFace (tests). */
  face: FontFace | null;
  metrics: FontMetrics;
  /** The CSS font-family the face is registered under. */
  cssFamily: string;
}

const DIGITS = '0123456789';

function inchesPerUnit(m: FontMetrics, sizePt: number): number {
  return sizePt / 72 / m.unitsPerEm;
}

function widestAdvance(m: FontMetrics, chars?: string): number {
  const pool = chars === undefined
    ? Object.values(m.advances)
    : Array.from(chars, (c) => m.advances[c]).filter((a) => a !== undefined);
  return pool.reduce((a, b) => Math.max(a, b), 0);
}

/** The top of the text box to its baseline. */
export function baselineIn(m: FontMetrics, sizePt: number): number {
  return m.ascent * inchesPerUnit(m, sizePt);
}

/** Ascent plus descent: one line of the font, top to bottom. */
export function lineHeightIn(m: FontMetrics, sizePt: number): number {
  return (m.ascent + m.descent) * inchesPerUnit(m, sizePt);
}

/** A text element's box across its text: one line of the font tall, the
 *  baseline at the ascent. New and retyped text gets this box; a hand-made
 *  one (the Vegas fixture stops its boxes at the baseline) stays valid. */
export function textBoxFor(m: FontMetrics, sizePt: number): { h: number; baselineIn: number } {
  return { h: lineHeightIn(m, sizePt), baselineIn: baselineIn(m, sizePt) };
}

/** The font size whose line (`textBoxFor`) is `heightIn` tall. */
export function sizePtForHeight(m: FontMetrics, heightIn: number): number {
  return (heightIn * 72 * m.unitsPerEm) / (m.ascent + m.descent);
}

/** The width `text` prints at `sizePt`. A character outside the metrics
 *  (they cover printable ASCII) counts as the widest glyph, so the canvas
 *  errs toward showing an overflow. `widthScale` widens every glyph
 *  (fonts.ts `glyphWidthScale`). */
export function textWidthIn(m: FontMetrics, sizePt: number, text: string, widthScale = 1): number {
  const widest = widestAdvance(m);
  const units = Array.from(text).reduce((sum, c) => sum + (m.advances[c] ?? widest), 0);
  return units * inchesPerUnit(m, sizePt) * widthScale;
}

/** The width a field reserves for `expectedLength` characters, so a value of
 *  1 or 10 keeps its neighbors where they are: the widest glyph for text
 *  (a monospace font's cell), the widest digit for a number. Null with no
 *  expected length (the width is free) or for a barcode or QR code. */
export function reservedWidthIn(m: FontMetrics, sizePt: number, expectedLength: number | null | undefined,
  display: Display, widthScale = 1): number | null {
  if (!expectedLength || expectedLength < 1) return null;
  if (display !== 'text' && display !== 'number') return null;
  const widest = widestAdvance(m, display === 'number' ? DIGITS : undefined);
  return expectedLength * widest * inchesPerUnit(m, sizePt) * widthScale;
}

/** The CSS family a library file's face is registered under. */
export function cssFamilyOf(file: FontRef): string {
  return `label-builder-${file.family}-${file.weight}`;
}

/** Loads one family and weight for the canvas: the metrics of the file the
 *  printer prints with, and the face to draw — that same file, or for a
 *  resident family the Roboto Regular stand-in. The face is fetched
 *  only where the browser can use it. */
export async function loadFont(family: string, weight: FontWeight, source: FontSource): Promise<LoadedFont> {
  if (!familyInfo(family)) throw new Error(`unknown font family: ${family}`);
  const font: FontRef = { family, weight };
  const measured = metricsFile(font);
  const drawn = faceFile(font);
  const cssFamily = cssFamilyOf(drawn);
  const canDraw = typeof FontFace !== 'undefined';
  const [metrics, bytes] = await Promise.all([
    source.metrics(measured.family, measured.weight),
    canDraw ? source.bytes(drawn.family, drawn.weight) : Promise.resolve(null),
  ]);
  if (!bytes) return { face: null, metrics, cssFamily };
  const face = await new FontFace(cssFamily, bytes).load();
  if (typeof document !== 'undefined') document.fonts?.add(face);
  return { face, metrics, cssFamily };
}
