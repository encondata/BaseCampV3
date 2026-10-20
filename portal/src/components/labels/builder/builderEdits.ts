/**
 * The edits the builder's panels make (field panel, + picker, placed-fields
 * table, properties): placing a field or a shape, patching the selection
 * with each property going only to the elements that have it, changing a
 * placement's display type, and turning a placement into its Split's
 * pieces. Every function returns a new design (or the same one when nothing
 * changes) for the page's history.
 *
 * A text-set element (static text, or a field shown as text or a number) is
 * refit after any typography change, so its box stays what the canvas and
 * the compiler work from: one line of the font tall (metrics.ts textBoxFor)
 * and, with an expected length, exactly the width it reserves
 * (reservedWidthIn), since the canvas measures overflow against `w`.
 * Without the font's metrics yet, a size change scales the box instead.
 */

import { clampToLabel, type Point } from '../../../labels/builder/geometry';
import { glyphWidthScale, metricsFile, type FontRef } from '../../../labels/builder/fonts';
import { IMAGE_SIZES } from '../../../labels/builder/image';
import { reservedWidthIn, textBoxFor, textWidthIn, type FontMetrics } from '../../../labels/builder/metrics';
import {
  addElement, addSplit, IMAGE_DEFAULTS, invertPadOf, nextId, type DesignV2, type Display, type ElementPatch,
  type ElementV2, type FieldElement, type ImageSource, type TextElement,
} from '../../../labels/builder/model';
import { piece as splitPiece, splitValue } from '../../../labels/fieldRules';
import type { MetricsFor } from './Canvas';
import { DEFAULT_FONT, newElement } from './canvasActions';
import { pieceNames, sampleOf, type FieldKind } from './fieldCatalog';

/** A display type as the panels offer it: Split turns a placement into
 *  its pieces (model.ts keeps Split as `splits` plus `piece` per element). */
export type DisplayChoice = Display | 'split';

export const NEW_SIZE_PT = 12;
/** Where the first new element goes; each one placed on top of another
 *  steps this far down and right. */
const FIRST_SPOT = 0.1;
const SPOT_STEP = 0.05;
/** A new field with no sample yet. */
const EMPTY_FIELD_W = 0.75;
const MIN_TEXT_W = 0.1;
const QR_SIDE = 0.5;
const MIN_BARCODE_H = 0.3;

export type Typeset = FieldElement | TextElement;

export function isTypeset(el: ElementV2): el is Typeset {
  return el.type === 'text' || (el.type === 'field' && (el.display === 'text' || el.display === 'number'));
}

export function fontOf(el: ElementV2): FontRef {
  return (el.type === 'text' || el.type === 'field') && el.font ? el.font : DEFAULT_FONT;
}

function metricsOf(el: ElementV2, metricsFor: MetricsFor): FontMetrics | null {
  const f = fontOf(el);
  return metricsFor(f.family, f.weight)?.metrics ?? null;
}

function lineCount(el: ElementV2): number {
  return el.type === 'text' ? Math.max(1, el.lines ?? 1) : 1;
}

/** What sets a text box's height: the file measured, the size, the lines. */
function heightKey(el: ElementV2): string {
  const f = metricsFile(fontOf(el));
  return JSON.stringify([f.family, f.weight, 'sizePt' in el ? el.sizePt : null, lineCount(el)]);
}

/** What sets a text box's width besides its height. */
function widthKey(el: ElementV2): string {
  if (el.type !== 'field') return '';
  return JSON.stringify([el.font?.family, el.font?.weight, el.inverted ?? false, el.expectedLength ?? null, el.display]);
}

/** The width a field reserves at its font and size, or null when it
 *  reserves none (no expected length, or not text or a number). */
export function reservedOf(el: Typeset, m: FontMetrics): number | null {
  if (el.type !== 'field') return null;
  return reservedWidthIn(m, el.sizePt ?? 0, el.expectedLength, el.display, glyphWidthScale(fontOf(el), !!el.inverted));
}

/** `el`'s box after a typography change from `before` (null: a new
 *  element): its height one line of the font when the measured file, size
 *  or line count changed, its width the reserved width when it reserves
 *  one, else scaled with the size. */
export function refit<T extends Typeset>(el: T, before: ElementV2 | null, metricsFor: MetricsFor): T {
  const size = el.sizePt ?? NEW_SIZE_PT;
  const prevSize = before && (before.type === 'text' || before.type === 'field') ? before.sizePt ?? 0 : 0;
  const ratio = before && isTypeset(before) && prevSize > 0 ? size / prevSize : 1;
  const tall = !before || !isTypeset(before) || heightKey(before) !== heightKey(el);
  const m = metricsOf(el, metricsFor);
  let { w, h, baselineIn } = el;
  if (m) {
    if (tall) {
      const box = textBoxFor(m, size);
      h = box.h + (lineCount(el) - 1) * (size / 72);
      baselineIn = box.baselineIn;
    }
    w = reservedOf(el, m) ?? w * ratio;
  } else if (ratio !== 1) {
    w *= ratio;
    h *= ratio;
    baselineIn = (baselineIn ?? 0) * ratio;
  }
  return { ...el, sizePt: size, w, h, baselineIn };
}

const ANY = () => true;
const TYPESET_PARTS = (el: ElementV2) => el.type === 'text' || el.type === 'field';
const FIELD_ONLY = (el: ElementV2) => el.type === 'field';
/** A barcode, or a field placement shown as one. */
const BARCODE_PARTS = (el: ElementV2) => el.type === 'barcode' || (el.type === 'field' && el.display === 'barcode');
const SOURCE_PARTS = (el: ElementV2) => el.type === 'barcode' || el.type === 'qr';
const IMAGE_ONLY = (el: ElementV2) => el.type === 'image';

/** Which elements hold each property (model.ts ElementV2). */
const HOLDERS: Record<string, (el: ElementV2) => boolean> = {
  x: ANY, y: ANY, w: ANY, h: ANY, rotation: ANY, locked: ANY,
  font: TYPESET_PARTS, sizePt: TYPESET_PARTS, align: TYPESET_PARTS, inverted: TYPESET_PARTS,
  invertPad: TYPESET_PARTS, baselineIn: TYPESET_PARTS,
  content: (el) => el.type === 'text', lines: (el) => el.type === 'text',
  display: FIELD_ONLY, expectedLength: FIELD_ONLY, maxChars: FIELD_ONLY, trim: FIELD_ONLY,
  strip: FIELD_ONLY, stripWhere: FIELD_ONLY,
  hideWhenEmpty: (el) => el.type === 'field' || el.type === 'barcode' || el.type === 'qr' || el.type === 'image',
  symbology: BARCODE_PARTS, moduleIn: BARCODE_PARTS, showText: BARCODE_PARTS,
  field: SOURCE_PARTS, data: SOURCE_PARTS,
  strokeIn: (el) => el.type === 'line' || el.type === 'box',
  fill: (el) => el.type === 'box',
  source: IMAGE_ONLY, imageId: IMAGE_ONLY, fit: IMAGE_ONLY, mode: IMAGE_ONLY,
  brightness: IMAGE_ONLY, contrast: IMAGE_ONLY, threshold: IMAGE_ONLY, invert: IMAGE_ONLY,
};

export function holds(el: ElementV2, key: string): boolean {
  return HOLDERS[key]?.(el) ?? false;
}

/** A patch for every selected element, or one worked out per element
 *  (null: leave it). */
export type Patch = ElementPatch | ((el: ElementV2) => ElementPatch | null);

function typographyChanged(before: ElementV2, after: ElementV2): boolean {
  return !isTypeset(before) || heightKey(before) !== heightKey(after) || widthKey(before) !== widthKey(after);
}

/** Applies `patch` to each element in `ids` that holds the property (as
 *  patched: a placement turned into a barcode takes a symbology), and
 *  refits the text-set ones whose typography changed. */
export function patchElements(design: DesignV2, ids: readonly string[], patch: Patch,
  metricsFor: MetricsFor): DesignV2 {
  const wanted = new Set(ids);
  let changed = false;
  const elements = design.elements.map((el) => {
    if (!wanted.has(el.id)) return el;
    const raw = typeof patch === 'function' ? patch(el) : patch;
    if (!raw) return el;
    const candidate = { ...el, ...raw } as ElementV2;
    const applied = Object.fromEntries(Object.entries(raw).filter(([key]) => holds(candidate, key)));
    if (!Object.keys(applied).length) return el;
    let next = { ...el, ...applied } as ElementV2;
    if (isTypeset(next) && typographyChanged(el, next)) next = refit(next, el, metricsFor);
    if (JSON.stringify(next) === JSON.stringify(el)) return el;
    changed = true;
    return next;
  });
  return changed ? { ...design, elements } : design;
}

/** The first free spot on the label: a step down and right for each
 *  element already sitting exactly there. */
export function freeSpot(design: DesignV2): Point {
  for (let i = 0; i < 40; i++) {
    const p = { x: FIRST_SPOT + i * SPOT_STEP, y: FIRST_SPOT + i * SPOT_STEP };
    if (p.x >= design.size.w || p.y >= design.size.h) break;
    const taken = design.elements.some((e) => Math.abs(e.x - p.x) < 1e-6 && Math.abs(e.y - p.y) < 1e-6);
    if (!taken) return p;
  }
  return { x: FIRST_SPOT, y: FIRST_SPOT };
}

/** The design with `el` added on top, and the id it got. */
function added(design: DesignV2, el: ElementV2): { design: DesignV2; id: string } {
  const next = addElement(design, clampToLabel(el, design.size));
  return { design: next, id: next.elements[next.elements.length - 1].id };
}

/** A new placement of `key` (or of one of its Split's pieces) at the next
 *  free spot: the default font at 12 pt, a number field as Number, as
 *  wide as its sample, one line of the font tall. */
export function placeField(design: DesignV2, key: string, kind: FieldKind,
  samples: Readonly<Record<string, string>>, metricsFor: MetricsFor, piece: number | null = null):
  { design: DesignV2; id: string } {
  const font = { ...DEFAULT_FONT };
  const m = metricsFor(font.family, font.weight)?.metrics ?? null;
  const sample = sampleOf(samples, key);
  const value = piece == null ? sample : splitPiece(sample, piece);
  const box = m ? textBoxFor(m, NEW_SIZE_PT) : { h: NEW_SIZE_PT / 72, baselineIn: (0.75 * NEW_SIZE_PT) / 72 };
  const w = value && m ? Math.max(textWidthIn(m, NEW_SIZE_PT, value), MIN_TEXT_W) : EMPTY_FIELD_W;
  const at = freeSpot(design);
  const el: FieldElement = {
    id: '', type: 'field', field: key, ...(piece == null ? {} : { piece }),
    display: kind === 'number' ? 'number' : 'text',
    x: at.x, y: at.y, w, h: box.h, rotation: 0, locked: false, hideWhenEmpty: false,
    font, sizePt: NEW_SIZE_PT, baselineIn: box.baselineIn, align: 'left', inverted: false,
  };
  return added(design, el);
}

/** An image switched to `source`: that source's fit and look (a photo
 *  fills and dithers, a logo or a static picture fits and thresholds), its
 *  box while the old source's new box is untouched (a photo placed, then
 *  made a logo, turns landscape; a box sized by hand stays), and no
 *  library picture off a static image. Null for anything else, or no
 *  change. */
export function imageSourcePatch(el: ElementV2, source: ImageSource): ElementPatch | null {
  if (el.type !== 'image' || el.source === source) return null;
  const was = IMAGE_SIZES[el.source];
  const untouched = !!was && Math.abs(el.w - was.w) < 1e-9 && Math.abs(el.h - was.h) < 1e-9;
  return {
    source, ...IMAGE_DEFAULTS[source],
    ...(untouched ? IMAGE_SIZES[source] : {}),
    ...(source === 'static' ? {} : { imageId: undefined }),
  };
}

/** Static text, a line or a box from the picker, at the next free spot. */
export function placeShape(design: DesignV2, tool: 'text' | 'line' | 'box', metricsFor: MetricsFor):
  { design: DesignV2; id: string } {
  const m = metricsFor(DEFAULT_FONT.family, DEFAULT_FONT.weight)?.metrics ?? null;
  return added(design, newElement(tool, freeSpot(design), m));
}

/** What a field placement needs to show as `display`. */
function displayPatch(el: FieldElement, display: Display): ElementPatch | null {
  if (el.display === display) return null;
  switch (display) {
    case 'barcode':
      return { display, symbology: el.symbology ?? 'code128', showText: el.showText ?? true, h: Math.max(el.h, MIN_BARCODE_H) };
    case 'qr':
      return { display, w: QR_SIDE, h: QR_SIDE };
    default:
      return { display, font: el.font ?? { ...DEFAULT_FONT }, sizePt: el.sizePt ?? NEW_SIZE_PT, align: el.align ?? 'left' };
  }
}

/** The display type of every selected field placement; Split turns each
 *  whole-value one into its pieces. Returns the selection to show next. */
export function setDisplay(design: DesignV2, ids: readonly string[], choice: DisplayChoice,
  samples: Readonly<Record<string, string>>, metricsFor: MetricsFor): { design: DesignV2; ids: string[] } {
  if (choice === 'split') return splitPlacements(design, ids, samples, metricsFor);
  const next = patchElements(design, ids, (el) => (el.type === 'field' ? displayPatch(el, choice) : null), metricsFor);
  return { design: next, ids: [...ids] };
}

/** Whether `el` can become Split pieces: a whole-value placement whose
 *  field's Split, or sample, has more than one piece. */
export function canSplit(design: DesignV2, el: ElementV2, samples: Readonly<Record<string, string>>): boolean {
  if (el.type !== 'field' || el.piece != null) return false;
  const pieces = pieceNames(design, el.field).length || splitValue(sampleOf(samples, el.field)).length;
  return pieces > 1;
}

/** Each selected whole-value placement becomes one placement per piece of
 *  its field's Split (defined from the sample when the field has none:
 *  model.ts addSplit), with the placement's own font, size, weight,
 *  inverted, alignment, hide-when-empty and lock, and no rules (they were
 *  the whole value's). The pieces run along the text from where the placement
 *  was, wrapping at the label's edge, and take its place in the stacking
 *  order. Returns the pieces' ids. */
export function splitPlacements(design: DesignV2, ids: readonly string[],
  samples: Readonly<Record<string, string>>, metricsFor: MetricsFor): { design: DesignV2; ids: string[] } {
  let d = design;
  const made: string[] = [];
  for (const id of ids) {
    const el = d.elements.find((e) => e.id === id);
    if (!el || !canSplit(d, el, samples) || el.type !== 'field') continue;
    const sample = sampleOf(samples, el.field);
    d = addSplit(d, el.field, sample);
    const names = pieceNames(d, el.field);
    const font = el.font ?? { ...DEFAULT_FONT };
    const size = el.sizePt ?? NEW_SIZE_PT;
    const m = metricsFor(font.family, font.weight)?.metrics ?? null;
    const scale = glyphWidthScale(font, !!el.inverted);
    const along = el.rotation === 90 || el.rotation === 270 ? 'y' : 'x';
    const limit = along === 'x' ? d.size.w : d.size.h;
    const gap = Math.max((0.25 * size) / 72, 0.02);
    let a = el[along];
    let b = along === 'x' ? el.y : el.x;
    const pieces: FieldElement[] = [];
    names.forEach((_, i) => {
      const value = splitPiece(sample, i) || 'X';
      const base: FieldElement = {
        id: '', type: 'field', field: el.field, piece: i,
        display: el.display === 'number' ? 'number' : 'text',
        x: 0, y: 0, w: 0, h: el.h, rotation: el.rotation, locked: el.locked ?? false,
        hideWhenEmpty: el.hideWhenEmpty ?? false,
        font, sizePt: size, baselineIn: el.baselineIn, align: el.align ?? 'left', inverted: el.inverted ?? false,
        ...(el.invertPad ? { invertPad: el.invertPad } : {}),
        expectedLength: null, maxChars: null, trim: null, strip: null, stripWhere: null,
      };
      const fitted = refit(base, null, metricsFor);
      const w = m ? Math.max(textWidthIn(m, size, value, scale), MIN_TEXT_W) : el.w / names.length;
      const pad = fitted.inverted ? 2 * invertPadOf(fitted).x : 0;
      if (i > 0 && a + w > limit) {
        a = el[along];
        b += fitted.h + gap + (fitted.inverted ? 2 * invertPadOf(fitted).y : 0);
      }
      const at = along === 'x' ? { x: a, y: b } : { x: b, y: a };
      const taken = { ...d, elements: [...d.elements, ...pieces] };
      pieces.push(clampToLabel({ ...fitted, ...at, w, id: nextId(taken, 'field') }, d.size));
      a += w + pad + gap;
    });
    d = { ...d, elements: d.elements.flatMap((e) => (e.id === el.id ? pieces : [e])) };
    made.push(...pieces.map((p) => p.id));
  }
  return { design: d, ids: made.length ? made : [...ids] };
}
