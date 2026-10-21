/**
 * Parse and validate label element-model JSON (labels/model.py): the one
 * validator the compiler consumes. Coordinates are inches; only the
 * compiler converts them to dots. Problems are collected per element
 * (prefixed with the element id); any problem throws DesignError.
 *
 * Schema 1 is the original model (text whose content carries {tokens},
 * barcodes and QR codes with token data, lines and boxes). Schema 2 is the
 * label builder's: `field` elements bound to a field key, optionally one
 * piece of the field's Split, each with its own rules, font and inverted
 * flag; static `text` with a font and a baseline; barcodes and QR codes
 * bound to a field or holding static data; lines; boxes that can be
 * filled. Schema 3 is schema 2 plus `image` elements; they parse here as
 * model.py parses them, but the generator never prints a picture.
 *
 * Geometry, schema 2 and 3: x, y is the top-left of the element's
 * footprint; w runs along the element's own text direction and h across
 * it, so at rotation 90 or 270 the footprint is h wide and w tall.
 *
 * The input is read as Python reads `json.loads` output: pass the
 * number-preserving reader's tree (pyjson.ts) to keep int and float apart
 * (`"lines": 2.0` is refused, as it is in Python). A plain JSON.parse tree
 * also works; there a whole number always reads as an int. Pure: no DOM,
 * no Intl, no Node.
 */

import { DesignError } from './errors';
import { isBlank, piece as splitPiece, applyRules, type FieldRules } from './fieldRules';
import { DEFAULT_FAMILY, FAMILIES, WEIGHTS } from './fonts';
import { pyRepr, reprString } from './py';
import { isPyDict, isPyNumber, type PyDict, type PyValue } from './pyjson';
import {
  asPy, get, getOr, intOf, isInt, isNum, isOneOf, numberOf, pyTruthy, toFloat,
} from './pyValue';

export { DesignError };

export const ROTATIONS = [0, 90, 180, 270] as const;
export const SYMBOLOGIES = ['code128', 'code39'] as const;
export const ALIGNS = ['left', 'center', 'right'] as const;
export const SCHEMAS = [1, 2, 3] as const;
export const DISPLAYS = ['text', 'number', 'barcode', 'qr'] as const;
export const TRIMS = ['front', 'rear'] as const;
export const STRIP_WHERES = ['front', 'rear', 'anywhere'] as const;
export const IMAGE_SOURCES = ['photo', 'logo', 'static'] as const;
export const FITS = ['cover', 'contain'] as const;
// labels/dither.py: the modes and the inclusive ranges of an image's settings
export const MODES = ['dither', 'threshold'] as const;
export const BRIGHTNESS: readonly [number, number] = [-100, 100];
export const CONTRAST: readonly [number, number] = [0, 300];
export const THRESHOLD: readonly [number, number] = [1, 254];
// a photo fills its box and is dithered; a logo or a static image fits
// inside it and is thresholded
const IMAGE_DEFAULTS: Readonly<Record<ImageSource, readonly [Fit, Mode]>> = {
  photo: ['cover', 'dither'], logo: ['contain', 'threshold'], static: ['contain', 'threshold'],
};
// ceilings on what a request can make the compile allocate (model.py)
export const MAX_COUNT = 64;
export const MAX_LINES = 50;
export const MAX_ELEMENTS = 500;
export const MAX_IMAGE_ELEMENTS = 8;

export type Rotation = (typeof ROTATIONS)[number];
export type Symbology = (typeof SYMBOLOGIES)[number];
export type Align = (typeof ALIGNS)[number];
export type Schema = (typeof SCHEMAS)[number];
export type Display = (typeof DISPLAYS)[number];
export type Trim = (typeof TRIMS)[number];
export type StripWhere = (typeof STRIP_WHERES)[number];
export type ImageSource = (typeof IMAGE_SOURCES)[number];
export type Fit = (typeof FITS)[number];
export type Mode = (typeof MODES)[number];

/** A family slug from fonts.ts and a weight (regular | bold). */
export interface Font {
  readonly family: string;
  readonly weight: string;
}

/** An inverted element's padding in inches: x along the text, y across. */
export interface Pad {
  readonly x: number;
  readonly y: number;
}

interface Base {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly rotation: Rotation;
}

export interface TextEl extends Base {
  readonly type: 'text';
  readonly content: string;
  readonly fontSizePt: number;
  readonly bold: boolean;
  readonly align: Align;
  /** ZPL ^FR (knockout text on a filled bar). Schema 1 only. */
  readonly reverse: boolean;
  /** The ^FB line count. */
  readonly lines: number;
  // schema 2 only (null/false on a schema 1 design): static text, no tokens
  readonly font: Font | null;
  readonly baselineIn: number | null;
  readonly inverted: boolean;
  readonly invertPad: Pad | null;
}

export interface BarcodeEl extends Base {
  readonly type: 'barcode';
  readonly symbology: Symbology;
  readonly data: string;
  readonly showText: boolean;
  /** Narrow-module width in inches; null keeps the historical ^BY2. */
  readonly moduleIn: number | null;
  /** Schema 2: bound to a field key (then `data` is ''), else static data. */
  readonly field: string | null;
  readonly hideWhenEmpty: boolean;
}

export interface QrEl extends Base {
  readonly type: 'qr';
  readonly data: string;
  readonly field: string | null;
  readonly hideWhenEmpty: boolean;
}

export interface LineEl extends Base {
  readonly type: 'line';
  readonly strokeIn: number;
}

export interface BoxEl extends Base {
  readonly type: 'box';
  readonly strokeIn: number;
  readonly fill: boolean;
}

/** Schema 2: one placement of a field, with its own formatting. */
export interface FieldEl extends Base {
  readonly type: 'field';
  readonly field: string;
  /** 0-based piece of the field's Split; null = the whole value. */
  readonly piece: number | null;
  readonly display: Display;
  readonly font: Font;
  readonly fontSizePt: number;
  readonly baselineIn: number;
  readonly align: Align;
  readonly inverted: boolean;
  readonly invertPad: Pad;
  readonly hideWhenEmpty: boolean;
  readonly expectedLength: number | null;
  readonly maxChars: number | null;
  readonly trim: Trim | null;
  readonly strip: string | null;
  readonly stripWhere: StripWhere | null;
  // display === 'barcode'
  readonly symbology: Symbology;
  readonly moduleIn: number | null;
  readonly showText: boolean;
  /** model.py's `bold` property. */
  readonly bold: boolean;
  /** model.py's `rules` property: the set rules, snake_case keys. */
  readonly rules: FieldRules;
}

/** Schema 3: a picture. Parsed for model.py's rules; never printed here. */
export interface ImageEl extends Base {
  readonly type: 'image';
  readonly source: ImageSource;
  readonly imageId: string | null;
  readonly fit: Fit;
  readonly mode: Mode;
  readonly brightness: number;
  readonly contrast: number;
  readonly threshold: number;
  readonly invert: boolean;
  readonly hideWhenEmpty: boolean;
}

export type Element = TextEl | BarcodeEl | QrEl | LineEl | BoxEl | FieldEl | ImageEl;

export interface Design {
  readonly widthIn: number;
  readonly heightIn: number;
  readonly elements: readonly Element[];
  readonly schema: Schema;
  /** Schema 2 and 3: field key -> the piece names of its Split. */
  readonly splits: ReadonlyMap<string, readonly string[]>;
}

// --- values -------------------------------------------------------------------

const own = (values: Readonly<Record<string, string>>, key: string): string => (
  Object.prototype.hasOwnProperty.call(values, key) ? values[key] : ''
);

function rawValue(el: FieldEl, values: Readonly<Record<string, string>>): string {
  const raw = own(values, el.field) || '';
  return el.piece === null ? raw : splitPiece(raw, el.piece);
}

/** The text a schema 2 element prints: a field's value through Split and
 *  its rules, a static text's content, a barcode's or QR code's field
 *  value or static data. Values are never token-expanded. */
export function elementValue(el: Element, values: Readonly<Record<string, string>>): string {
  if (el.type === 'field') return applyRules(rawValue(el, values), el.rules);
  if (el.type === 'text') return el.content;
  if (el.type === 'barcode' || el.type === 'qr') {
    return el.field !== null ? (own(values, el.field) || '') : el.data;
  }
  return '';
}

/** A schema 2 element that prints nothing at all: hide-when-empty with a
 *  value that is blank after Strip and trim, or an inverted element with
 *  nothing to reverse (no box either). */
export function elementHidden(el: Element, values: Readonly<Record<string, string>>): boolean {
  if (el.type === 'field') {
    const blank = isBlank(rawValue(el, values), el.rules);
    return blank && (el.hideWhenEmpty || el.inverted);
  }
  if (el.type === 'text') return el.inverted && el.content === '';
  if (el.type === 'barcode' || el.type === 'qr') {
    return el.hideWhenEmpty && elementValue(el, values) === '';
  }
  return false;
}

// --- element parts --------------------------------------------------------------

type Problems = string[];

function needNum(el: PyDict, field: string, p: Problems, allowZero = true): number {
  const v = get(el, field);
  const n = isNum(v) ? toFloat(v) : NaN;
  if (!isNum(v) || n < 0 || (n === 0 && !allowZero)) {
    p.push(allowZero ? `${field} must be a non-negative number` : `${field} must be a positive number`);
    return 0;
  }
  return n;
}

function align(el: PyDict, p: Problems): Align {
  const a = getOr(el, 'align', 'left');
  if (!isOneOf(a, ALIGNS)) {
    p.push('align must be left/center/right');
    return 'left';
  }
  return a;
}

function lines(el: PyDict, p: Problems): number {
  const v = getOr(el, 'lines', numberOf(1));
  if (!isInt(v) || intOf(v) < 1) {
    p.push('lines must be an integer of 1 or more');
    return 1;
  }
  if (intOf(v) > MAX_LINES) {
    p.push(`lines must be at most ${MAX_LINES}`);
    return 1;
  }
  return intOf(v);
}

function symbology(el: PyDict, p: Problems): Symbology {
  const sym = get(el, 'symbology');
  if (!isOneOf(sym, SYMBOLOGIES)) {
    p.push('symbology must be code128 or code39');
    return 'code128';
  }
  return sym;
}

function moduleIn(el: PyDict, p: Problems): number | null {
  const v = get(el, 'moduleIn');
  if (v === null || v === undefined) return null;
  if (!isNum(v) || toFloat(v) <= 0) {
    p.push('moduleIn must be a positive number');
    return null;
  }
  return toFloat(v);
}

function barcodeOpts(el: PyDict, p: Problems): [Symbology, number | null, boolean] {
  const sym = symbology(el, p);
  const mod = moduleIn(el, p);
  return [sym, mod, pyTruthy(getOr(el, 'showText', true))];
}

function stroke(el: PyDict, p: Problems): number {
  const v = get(el, 'strokeIn');
  if (!isNum(v) || toFloat(v) <= 0) {
    p.push('strokeIn must be a positive number');
    return 0.01;
  }
  return toFloat(v);
}

function flag(el: PyDict, key: string, dflt: boolean): boolean {
  return pyTruthy(getOr(el, key, dflt));
}

function contentOf(el: PyDict, p: Problems): string {
  const content = get(el, 'content');
  if (typeof content !== 'string') {
    p.push('content must be a string');
    return '';
  }
  return content;
}

function staticData(el: PyDict, p: Problems): string {
  const data = get(el, 'data');
  if (typeof data !== 'string' || !data) {
    p.push('data must be a non-empty string');
    return '';
  }
  return data;
}

function v1Element(el: PyDict, base: Base, p: Problems): Element | null {
  const etype = get(el, 'type');
  if (etype === 'text') {
    const content = contentOf(el, p);
    const fs = get(el, 'fontSizePt');
    let size = 10;
    if (!isNum(fs) || toFloat(fs) <= 0) p.push('fontSizePt must be a positive number');
    else size = toFloat(fs);
    const bold = flag(el, 'bold', false);
    const al = align(el, p);
    const reverse = flag(el, 'reverse', false);
    const ln = lines(el, p);
    return {
      ...base, type: 'text', content, fontSizePt: size, bold, align: al, reverse, lines: ln,
      font: null, baselineIn: null, inverted: false, invertPad: null,
    };
  }
  if (etype === 'barcode') {
    const sym = symbology(el, p);
    const data = staticData(el, p);
    const showText = flag(el, 'showText', true);
    return {
      ...base, type: 'barcode', symbology: sym, data, showText, moduleIn: moduleIn(el, p),
      field: null, hideWhenEmpty: false,
    };
  }
  if (etype === 'qr') {
    return { ...base, type: 'qr', data: staticData(el, p), field: null, hideWhenEmpty: false };
  }
  if (etype === 'line') return { ...base, type: 'line', strokeIn: stroke(el, p) };
  if (etype === 'box') return { ...base, type: 'box', strokeIn: stroke(el, p), fill: false };
  p.push(`unknown type ${pyRepr(etype)}`);
  return null;
}

/** `x in FAMILIES` (a dict): a list or dict can't be hashed. */
function isFamily(v: PyValue | undefined): boolean {
  if (Array.isArray(v) || isPyDict(v)) throw new TypeError('unhashable type');
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(FAMILIES, v);
}

function font(el: PyDict, p: Problems): Font {
  const raw = get(el, 'font');
  if (raw === null || raw === undefined) return { family: DEFAULT_FAMILY, weight: 'regular' };
  if (!isPyDict(raw) || !isFamily(get(raw, 'family'))
      || !isOneOf(getOr(raw, 'weight', 'regular'), WEIGHTS)) {
    p.push('font must name a known family and a weight of regular or bold');
    return { family: DEFAULT_FAMILY, weight: 'regular' };
  }
  return { family: get(raw, 'family') as string, weight: getOr(raw, 'weight', 'regular') as string };
}

/** Font, size in points and baseline in inches. A field displayed as a
 *  barcode or QR code needs none of them (defaults when absent). */
function typeset(el: PyDict, p: Problems, required = true): [Font, number, number] {
  const f = font(el, p);
  const sizeRaw = get(el, 'sizePt');
  let size: number;
  if ((sizeRaw === null || sizeRaw === undefined) && !required) {
    size = 0;
  } else if (!isNum(sizeRaw) || toFloat(sizeRaw) <= 0) {
    p.push('sizePt must be a positive number');
    size = 10;
  } else {
    size = toFloat(sizeRaw);
  }
  const baseRaw = get(el, 'baselineIn');
  let baseline: number;
  if ((baseRaw === null || baseRaw === undefined) && !required) {
    baseline = 0;
  } else if (!isNum(baseRaw) || toFloat(baseRaw) < 0) {
    p.push('baselineIn must be a non-negative number');
    baseline = 0;
  } else {
    baseline = toFloat(baseRaw);
  }
  return [f, size, baseline];
}

/** Default: a quarter of the font size along the text, a tenth across. */
function invertPad(el: PyDict, p: Problems, sizePt: number): Pad {
  const dflt = { x: (0.25 * sizePt) / 72, y: (0.10 * sizePt) / 72 };
  const raw = get(el, 'invertPad');
  if (raw === null || raw === undefined) return dflt;
  const x = isPyDict(raw) ? get(raw, 'x') : undefined;
  const y = isPyDict(raw) ? get(raw, 'y') : undefined;
  if (!isNum(x) || toFloat(x) < 0 || !isNum(y) || toFloat(y) < 0) {
    p.push('invertPad must hold non-negative numbers x and y');
    return dflt;
  }
  return { x: toFloat(x), y: toFloat(y) };
}

function optCount(el: PyDict, key: string, p: Problems): number | null {
  const v = get(el, key);
  if (v === null || v === undefined) return null;
  if (!isInt(v) || intOf(v) < 1) {
    p.push(`${key} must be a whole number of 1 or more`);
    return null;
  }
  if (intOf(v) > MAX_COUNT) {
    p.push(`${key} must be at most ${MAX_COUNT}`);
    return null;
  }
  return intOf(v);
}

function optChoice<T extends string>(el: PyDict, key: string, choices: readonly T[], p: Problems): T | null {
  const v = get(el, key);
  if (v === null || v === undefined) return null;
  if (!isOneOf(v, choices)) {
    p.push(`${key} must be one of ${choices.join('/')}`);
    return null;
  }
  return v;
}

/** A barcode or QR code holds a field key or static data, never both. */
function source(el: PyDict, p: Problems): [string | null, string] {
  const fieldRaw = get(el, 'field');
  const data = get(el, 'data');
  const noField = fieldRaw === null || fieldRaw === undefined;
  const noData = data === null || data === undefined;
  if (noField === noData) {
    p.push('needs exactly one of field or data');
    return [null, ''];
  }
  if (!noField) {
    if (typeof fieldRaw !== 'string' || !fieldRaw) {
      p.push('field must be a non-empty string');
      return [null, ''];
    }
    return [fieldRaw, ''];
  }
  if (typeof data !== 'string' || !data) {
    p.push('data must be a non-empty string');
    return [null, ''];
  }
  return [null, data];
}

function fieldRulesOf(display: Display, expectedLength: number | null, maxChars: number | null,
  trim: Trim | null, strip: string | null, stripWhere: StripWhere | null): FieldRules {
  const rules: FieldRules = { display };
  if (expectedLength !== null) rules.expected_length = expectedLength;
  if (maxChars !== null) rules.max_chars = maxChars;
  if (trim !== null) rules.trim = trim;
  if (strip !== null) rules.strip = strip;
  if (stripWhere !== null) rules.strip_where = stripWhere;
  return rules;
}

function v2Field(el: PyDict, base: Base, p: Problems, splits: Map<string, string[]>): FieldEl {
  const keyRaw = get(el, 'field');
  let key = '';
  if (typeof keyRaw !== 'string' || !keyRaw) p.push('field must be a non-empty string');
  else key = keyRaw;
  const pieceRaw = get(el, 'piece');
  let piece: number | null = null;
  if (pieceRaw !== null && pieceRaw !== undefined) {
    if (!isInt(pieceRaw) || intOf(pieceRaw) < 0) {
      p.push('piece must be a whole number of 0 or more');
    } else {
      piece = intOf(pieceRaw);
      const names = splits.get(key);
      if (names === undefined) {
        p.push(`piece ${pyRepr(pieceRaw)} needs a Split defined for ${reprString(key)}`);
      } else if (piece >= names.length) {
        p.push(`piece ${pyRepr(pieceRaw)} is beyond ${reprString(key)}'s Split (${names.length} pieces)`);
      }
    }
  }
  let display = getOr(el, 'display', 'text');
  if (!isOneOf(display, DISPLAYS)) {
    p.push(`display must be one of ${DISPLAYS.join('/')}`);
    display = 'text';
  }
  const disp = display as Display;
  const [f, size, baseline] = typeset(el, p, disp === 'text' || disp === 'number');
  let strip = get(el, 'strip');
  if (strip !== null && strip !== undefined && typeof strip !== 'string') {
    p.push('strip must be a string');
    strip = null;
  }
  const [sym, mod, showText]: [Symbology, number | null, boolean] = disp === 'barcode'
    ? barcodeOpts(el, p) : ['code128', null, true];
  const al = align(el, p);
  const inverted = flag(el, 'inverted', false);
  const pad = invertPad(el, p, size);
  const hideWhenEmpty = flag(el, 'hideWhenEmpty', false);
  const expectedLength = optCount(el, 'expectedLength', p);
  const maxChars = optCount(el, 'maxChars', p);
  const trim = optChoice(el, 'trim', TRIMS, p);
  const stripText = typeof strip === 'string' && strip ? strip : null;
  const stripWhere = optChoice(el, 'stripWhere', STRIP_WHERES, p);
  return {
    ...base, type: 'field', field: key, piece, display: disp, font: f, fontSizePt: size,
    baselineIn: baseline, align: al, inverted, invertPad: pad, hideWhenEmpty, expectedLength,
    maxChars, trim, strip: stripText, stripWhere, symbology: sym, moduleIn: mod, showText,
    bold: f.weight === 'bold',
    rules: fieldRulesOf(disp, expectedLength, maxChars, trim, stripText, stripWhere),
  };
}

function wholeIn(el: PyDict, key: string, dflt: number, bounds: readonly [number, number],
  p: Problems): number {
  const v = getOr(el, key, numberOf(dflt));
  const [lo, hi] = bounds;
  if (!isInt(v) || !(lo <= intOf(v) && intOf(v) <= hi)) {
    p.push(`${key} must be a whole number from ${lo} to ${hi}`);
    return dflt;
  }
  return intOf(v);
}

function v2Image(el: PyDict, base: Base, p: Problems): ImageEl {
  let src = get(el, 'source');
  if (!isOneOf(src, IMAGE_SOURCES)) {
    p.push(`source must be one of ${IMAGE_SOURCES.join('/')}`);
    src = 'static';
  }
  const source_ = src as ImageSource;
  let imageId: string | null = null;
  const idRaw = get(el, 'imageId');
  if (source_ === 'static' && idRaw !== null && idRaw !== undefined) {
    if (typeof idRaw !== 'string' || !idRaw) p.push('imageId must be a non-empty string');
    else imageId = idRaw;
  }
  const [fitDefault, modeDefault] = IMAGE_DEFAULTS[source_];
  let fit = getOr(el, 'fit', fitDefault);
  if (!isOneOf(fit, FITS)) {
    p.push('fit must be cover or contain');
    fit = fitDefault;
  }
  let mode = getOr(el, 'mode', modeDefault);
  if (!isOneOf(mode, MODES)) {
    p.push('mode must be dither or threshold');
    mode = modeDefault;
  }
  const brightness = wholeIn(el, 'brightness', 0, BRIGHTNESS, p);
  const contrast = wholeIn(el, 'contrast', 100, CONTRAST, p);
  const threshold = wholeIn(el, 'threshold', 128, THRESHOLD, p);
  if (base.w <= 0 || base.h <= 0) p.push('an image needs a positive w and h');
  return {
    ...base, type: 'image', source: source_, imageId, fit: fit as Fit, mode: mode as Mode,
    brightness, contrast, threshold, invert: flag(el, 'invert', false),
    hideWhenEmpty: flag(el, 'hideWhenEmpty', true),
  };
}

function v2Element(el: PyDict, base: Base, p: Problems, splits: Map<string, string[]>,
  schema: Schema): Element | null {
  const etype = get(el, 'type');
  if (etype === 'image') {
    if (schema < 3) p.push('an image element needs schema 3');
    return v2Image(el, base, p);
  }
  if (etype === 'field') return v2Field(el, base, p, splits);
  if (etype === 'text') {
    const content = contentOf(el, p);
    const [f, size, baseline] = typeset(el, p);
    const al = align(el, p);
    const ln = lines(el, p);
    const inverted = flag(el, 'inverted', false);
    return {
      ...base, type: 'text', content, fontSizePt: size, bold: f.weight === 'bold', align: al,
      reverse: false, lines: ln, font: f, baselineIn: baseline, inverted,
      invertPad: invertPad(el, p, size),
    };
  }
  if (etype === 'barcode' || etype === 'qr') {
    const [field, data] = source(el, p);
    const hide = flag(el, 'hideWhenEmpty', false);
    if (etype === 'qr') return { ...base, type: 'qr', data, field, hideWhenEmpty: hide };
    const [sym, mod, showText] = barcodeOpts(el, p);
    return {
      ...base, type: 'barcode', symbology: sym, data, showText, moduleIn: mod, field,
      hideWhenEmpty: hide,
    };
  }
  if (etype === 'line') return { ...base, type: 'line', strokeIn: stroke(el, p) };
  if (etype === 'box') {
    return { ...base, type: 'box', strokeIn: stroke(el, p), fill: flag(el, 'fill', false) };
  }
  p.push(`unknown type ${pyRepr(etype)}`);
  return null;
}

function parseSplits(raw: PyValue | undefined, problems: Problems): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (raw === null || raw === undefined) return out;
  if (!isPyDict(raw)) {
    problems.push('splits must be an object');
    return out;
  }
  for (const [key, spec] of raw) {
    const pieces = isPyDict(spec) ? get(spec, 'pieces') : undefined;
    if (!Array.isArray(pieces) || pieces.length === 0 || !pieces.every((n) => typeof n === 'string')) {
      problems.push(`splits: ${reprString(key)} must hold a non-empty list of piece names`);
      continue;
    }
    out.set(key, [...(pieces as string[])]);
  }
  return out;
}

/** `rotation in ROTATIONS`: Python compares with ==, so 90.0 is 90 and
 *  False is 0. */
function rotationOf(v: PyValue): Rotation | null {
  if (v === false) return 0;
  if (!isPyNumber(v)) return null;
  const n = Number(v.text);
  return (ROTATIONS as readonly number[]).includes(n) ? (n as Rotation) : null;
}

/** model.py `parse_design`. Throws DesignError listing every problem. */
export function parseDesign(input: unknown): Design {
  const raw = asPy(input);
  const problems: Problems = [];
  if (!isPyDict(raw)) throw new DesignError(['design must be an object']);
  const schemaRaw = getOr(raw, 'schema', numberOf(1));
  const schemaNum = isInt(schemaRaw) ? intOf(schemaRaw) : NaN;
  if (!(SCHEMAS as readonly number[]).includes(schemaNum)) {
    throw new DesignError([`schema must be 1, 2 or 3, not ${pyRepr(schemaRaw)}`]);
  }
  const schema = schemaNum as Schema;
  const size = get(raw, 'size');
  const sw = isPyDict(size) ? get(size, 'w') : undefined;
  const sh = isPyDict(size) ? get(size, 'h') : undefined;
  if (!isNum(sw) || !isNum(sh) || toFloat(sw) <= 0 || toFloat(sh) <= 0) {
    throw new DesignError(['size must hold positive numbers w and h']);
  }
  const elements = get(raw, 'elements');
  if (!Array.isArray(elements)) throw new DesignError(['elements must be a list']);
  if (elements.length > MAX_ELEMENTS) {
    throw new DesignError([`a design holds at most ${MAX_ELEMENTS} elements`]);
  }
  const splits = schema >= 2 ? parseSplits(get(raw, 'splits'), problems) : new Map<string, string[]>();

  const parsed: Element[] = [];
  const seen = new Set<string>();
  elements.forEach((el, i) => {
    if (!isPyDict(el)) {
      problems.push(`element ${i}: must be an object`);
      return;
    }
    const idRaw = get(el, 'id');
    const eid = typeof idRaw === 'string' ? idRaw : `element ${i}`;
    const p: Problems = [];
    const x = needNum(el, 'x', p);
    const y = needNum(el, 'y', p);
    const w = needNum(el, 'w', p);
    const h = needNum(el, 'h', p);
    let rotation = rotationOf(getOr(el, 'rotation', numberOf(0)));
    if (rotation === null) {
      p.push('rotation must be one of 0/90/180/270');
      rotation = 0;
    }
    const base: Base = { id: eid, x, y, w, h, rotation };
    const parsedEl = schema === 1 ? v1Element(el, base, p) : v2Element(el, base, p, splits, schema);
    if (parsedEl !== null) parsed.push(Object.freeze(parsedEl));
    if (schema === 3) {
      // images are resolved by element id: two elements sharing one would
      // share one picture
      if (seen.has(eid)) p.push('id is used by another element');
      seen.add(eid);
    }
    for (const msg of p) problems.push(`${eid}: ${msg}`);
  });
  const images = parsed.filter((e) => e.type === 'image').length;
  if (schema === 3 && images === 0) problems.push('a schema 3 design needs an image element');
  if (images > MAX_IMAGE_ELEMENTS) problems.push(`a design holds at most ${MAX_IMAGE_ELEMENTS} images`);

  if (problems.length) throw new DesignError(problems);
  return Object.freeze({
    widthIn: toFloat(sw), heightIn: toFloat(sh), elements: Object.freeze(parsed), schema,
    splits,
  });
}
