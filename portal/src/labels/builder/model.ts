/**
 * The label builder's design: schema 2 of the label element model, exactly
 * the JSON the API's labels/model.py `parse_design` reads (camelCase keys as
 * stored). Every edit returns a new design and never mutates its input, so
 * the undo history can keep each state as is.
 *
 * Geometry (model.py): x, y is the top-left of the element's footprint on
 * the label, in inches. w runs along the element's own text direction and h
 * across it, so at rotation 90 or 270 the footprint is h wide and w tall.
 * A text element's `baselineIn` is the distance from its top edge (in its
 * own frame) to the baseline; the browser computes it from the font's
 * metrics and the compiler never measures text.
 *
 * Stacking order is the element order: later elements draw on top.
 */

import { applyRules, isBlank, piece as splitPiece, splitValue, type FieldRules } from '../fieldRules';
import { familyInfo, type FontRef } from './fonts';

export type Rotation = 0 | 90 | 180 | 270;
export type Align = 'left' | 'center' | 'right';
export type Display = 'text' | 'number' | 'barcode' | 'qr';
export type Symbology = 'code128' | 'code39';
export type Trim = 'front' | 'rear';
export type StripWhere = 'front' | 'rear' | 'anywhere';

/** An inverted element's padding in inches: x along the text, y across. */
export interface Pad {
  x: number;
  y: number;
}

interface ElementBase {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  rotation: Rotation;
  /** The canvas won't move or resize a locked element (the compiler ignores it). */
  locked?: boolean;
}

/** One placement of a field, with its own formatting. */
export interface FieldElement extends ElementBase {
  type: 'field';
  /** A catalog key or an `ft:<header>` From-To column; keys are opaque. */
  field: string;
  /** 0-based piece of the field's Split; absent or null prints the whole value. */
  piece?: number | null;
  display: Display;
  hideWhenEmpty?: boolean;
  // typesetting: required for display text/number, unused by barcode/qr
  font?: FontRef;
  sizePt?: number;
  baselineIn?: number;
  align?: Align;
  inverted?: boolean;
  invertPad?: Pad;
  // rules (labels/field_rules.py, ../fieldRules.ts)
  expectedLength?: number | null;
  maxChars?: number | null;
  trim?: Trim | null;
  strip?: string | null;
  stripWhere?: StripWhere | null;
  // display barcode
  symbology?: Symbology;
  moduleIn?: number | null;
  showText?: boolean;
}

export interface TextElement extends ElementBase {
  type: 'text';
  content: string;
  font?: FontRef;
  sizePt: number;
  baselineIn: number;
  align?: Align;
  inverted?: boolean;
  invertPad?: Pad;
  /** ^FB line count: multi-line static text. */
  lines?: number;
}

/** Bound to a field or holding static data, never both. */
export interface BarcodeElement extends ElementBase {
  type: 'barcode';
  field?: string;
  data?: string;
  symbology: Symbology;
  /** Narrow-module width in inches; absent keeps the printer's ^BY2. */
  moduleIn?: number | null;
  showText?: boolean;
  hideWhenEmpty?: boolean;
}

/** Bound to a field or holding static data, never both. */
export interface QrElement extends ElementBase {
  type: 'qr';
  field?: string;
  data?: string;
  hideWhenEmpty?: boolean;
}

export interface LineElement extends ElementBase {
  type: 'line';
  strokeIn: number;
}

export interface BoxElement extends ElementBase {
  type: 'box';
  strokeIn: number;
  fill?: boolean;
}

export type ElementV2 =
  | FieldElement | TextElement | BarcodeElement | QrElement | LineElement | BoxElement;
export type ElementType = ElementV2['type'];

export interface DesignV2 {
  schema: 2;
  size: { w: number; h: number };
  /** Field key → the names of its Split's pieces (one Split per field). */
  splits?: Record<string, { pieces: string[] }>;
  elements: ElementV2[];
}

/** Any element's editable properties; id and type never change. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type ElementPatch = Partial<DistributiveOmit<ElementV2, 'id' | 'type'>>;

export interface Problem {
  /** The element at fault (its id, or `element <index>`); null for the design. */
  elementId: string | null;
  message: string;
}

export class DesignError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'DesignError';
  }
}

const ELEMENT_TYPES: readonly ElementType[] = ['field', 'text', 'barcode', 'qr', 'line', 'box'];
const ROTATIONS: readonly number[] = [0, 90, 180, 270];
const ALIGNS: readonly string[] = ['left', 'center', 'right'];
const DISPLAYS: readonly string[] = ['text', 'number', 'barcode', 'qr'];
const SYMBOLOGIES: readonly string[] = ['code128', 'code39'];
const TRIMS: readonly string[] = ['front', 'rear'];
const STRIP_WHERES: readonly string[] = ['front', 'rear', 'anywhere'];
const WEIGHTS: readonly string[] = ['regular', 'bold'];

type Raw = Record<string, unknown>;

function isObject(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Python's repr() of a JSON scalar, for messages that match model.py's. */
function repr(v: unknown): string {
  if (typeof v === 'string') return `'${v}'`;
  if (v === null || v === undefined) return 'None';
  return String(v);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

/** `obj[key]` only when `obj` holds `key` itself: a field key is opaque
 *  text, so `constructor` or `__proto__` must read as missing, never as
 *  Object.prototype's. */
function own<V>(obj: Readonly<Record<string, V>> | undefined, key: string): V | undefined {
  return obj !== undefined && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

// ---- parse / serialize ---------------------------------------------------

/** The smallest unused `<prefix>-<n>` id. */
export function nextId(d: DesignV2, prefix: string): string {
  return freshId(new Set(d.elements.map((e) => e.id)), prefix);
}

function freshId(used: Set<string>, prefix: string): string {
  for (let n = 1; ; n++) {
    const id = `${prefix}-${n}`;
    if (!used.has(id)) return id;
  }
}

/** A stored schema 2 design as the builder's model: a deep copy, with every
 *  key kept as stored. Throws DesignError only for what the builder cannot
 *  hold (not a schema 2 design, no size, an element that isn't one); every
 *  other fault is left for `validate`. An element with a missing or
 *  repeated id gets a fresh `<type>-<n>` one, since selection needs ids. */
export function parseDesign(raw: unknown): DesignV2 {
  if (!isObject(raw)) throw new DesignError(['design must be an object']);
  if (raw.schema !== 2) throw new DesignError([`schema must be 2, not ${repr(raw.schema)}`]);
  const size = raw.size;
  if (!isObject(size) || !positive(size.w) || !positive(size.h)) {
    throw new DesignError(['size must hold positive numbers w and h']);
  }
  if (!Array.isArray(raw.elements)) throw new DesignError(['elements must be a list']);
  const problems: string[] = [];
  raw.elements.forEach((el, i) => {
    if (!isObject(el)) problems.push(`element ${i}: must be an object`);
    else if (!ELEMENT_TYPES.includes(el.type as ElementType)) {
      problems.push(`${typeof el.id === 'string' ? el.id : `element ${i}`}: unknown type ${repr(el.type)}`);
    }
  });
  if (problems.length) throw new DesignError(problems);

  const design = clone(raw) as unknown as DesignV2;
  const used = new Set<string>();
  const seen = new Set<string>(design.elements.map((e) => e.id).filter((id) => typeof id === 'string'));
  for (const el of design.elements) {
    if (typeof el.id !== 'string' || el.id === '' || used.has(el.id)) {
      el.id = freshId(new Set([...seen, ...used]), el.type);
    }
    used.add(el.id);
  }
  return design;
}

/** The design as JSON to store: a deep copy without undefined keys. */
export function serializeDesign(d: DesignV2): DesignV2 {
  return clone(d);
}

// ---- edits ---------------------------------------------------------------

export function newDesign(size: { w: number; h: number }): DesignV2 {
  return { schema: 2, size: { w: size.w, h: size.h }, splits: {}, elements: [] };
}

/** Adds `el` on top of the stack. An element with no id gets `<type>-<n>`;
 *  an id already in use is a programming error. */
export function addElement(d: DesignV2, el: ElementV2): DesignV2 {
  if (el.id && d.elements.some((e) => e.id === el.id)) {
    throw new Error(`element id ${el.id} is already in use`);
  }
  const placed = el.id ? el : { ...el, id: nextId(d, el.type) };
  return { ...d, elements: [...d.elements, placed] };
}

export function updateElement(d: DesignV2, id: string, patch: ElementPatch): DesignV2 {
  const i = d.elements.findIndex((e) => e.id === id);
  if (i < 0) return d;
  const el = d.elements[i];
  const elements = [...d.elements];
  elements[i] = { ...el, ...patch, id: el.id, type: el.type } as ElementV2;
  return { ...d, elements };
}

/** Puts each of `changed` in place of the element with its id. */
export function replaceElements(d: DesignV2, changed: readonly ElementV2[]): DesignV2 {
  const byId = new Map(changed.map((e) => [e.id, e]));
  return { ...d, elements: d.elements.map((e) => byId.get(e.id) ?? e) };
}

/** Removes the elements; a field's Split stays for its next placement. */
export function removeElements(d: DesignV2, ids: readonly string[]): DesignV2 {
  const gone = new Set(ids);
  return { ...d, elements: d.elements.filter((e) => !gone.has(e.id)) };
}

/** Copies the elements `offsetIn` down and right, on top of the stack in
 *  their stacking order, and returns the copies' ids in that order. */
export function duplicate(d: DesignV2, ids: readonly string[], offsetIn = 0.05):
  { design: DesignV2; ids: string[] } {
  const wanted = new Set(ids);
  let design = d;
  const copies: string[] = [];
  for (const el of d.elements) {
    if (!wanted.has(el.id)) continue;
    const id = nextId(design, el.type);
    design = addElement(design, { ...clone(el), id, x: el.x + offsetIn, y: el.y + offsetIn });
    copies.push(id);
  }
  return { design, ids: copies };
}

export type ReorderMove = 'back' | 'forward' | 'toBack' | 'toFront';

/** Moves elements in the stacking order: one step back or forward (past the
 *  next element that isn't moving), or all the way to the back or front.
 *  Several elements keep their order among themselves. */
export function reorder(d: DesignV2, ids: string | readonly string[], move: ReorderMove): DesignV2 {
  const moving = new Set(typeof ids === 'string' ? [ids] : ids);
  const els = [...d.elements];
  const picked = (e: ElementV2) => moving.has(e.id);
  if (move === 'toFront') return { ...d, elements: [...els.filter((e) => !picked(e)), ...els.filter(picked)] };
  if (move === 'toBack') return { ...d, elements: [...els.filter(picked), ...els.filter((e) => !picked(e))] };
  if (move === 'forward') {
    for (let i = els.length - 2; i >= 0; i--) {
      if (picked(els[i]) && !picked(els[i + 1])) [els[i], els[i + 1]] = [els[i + 1], els[i]];
    }
  } else {
    for (let i = 1; i < els.length; i++) {
      if (picked(els[i]) && !picked(els[i - 1])) [els[i], els[i - 1]] = [els[i - 1], els[i]];
    }
  }
  return { ...d, elements: els };
}

// ---- Split ---------------------------------------------------------------

/** Defines `fieldKey`'s Split from its sample: one piece per `.`-separated
 *  piece, named `Piece 1`..`Piece n`. A field has one Split per template, so
 *  a field that already has one keeps it (placing it again reuses it). */
export function addSplit(d: DesignV2, fieldKey: string, sample: string): DesignV2 {
  if (own(d.splits, fieldKey)) return d;
  const pieces = splitValue(sample).map((_, i) => `Piece ${i + 1}`);
  return { ...d, splits: { ...d.splits, [fieldKey]: { pieces } } };
}

export function renamePiece(d: DesignV2, fieldKey: string, index: number, name: string): DesignV2 {
  const split = own(d.splits, fieldKey);
  if (!split || index < 0 || index >= split.pieces.length) {
    throw new RangeError(`no piece ${index} in ${fieldKey}'s Split`);
  }
  const pieces = split.pieces.map((p, i) => (i === index ? name : p));
  return { ...d, splits: { ...d.splits, [fieldKey]: { pieces } } };
}

/** Every element bound to `fieldKey`: its placements, Split pieces and
 *  barcodes or QR codes included, in stacking order. */
export function placementsOf(d: DesignV2, fieldKey: string): ElementV2[] {
  return d.elements.filter((e) => 'field' in e && e.field === fieldKey);
}

// ---- what an element prints (model.py element_value / element_hidden) -------

/** A field placement's rules for ../fieldRules.ts (model.py `FieldEl.rules`). */
export function fieldRules(el: FieldElement): FieldRules {
  const rules: FieldRules = { display: el.display };
  if (el.expectedLength != null) rules.expectedLength = el.expectedLength;
  if (el.maxChars != null) rules.maxChars = el.maxChars;
  if (el.trim != null) rules.trim = el.trim;
  if (el.strip) rules.strip = el.strip;
  if (el.stripWhere != null) rules.stripWhere = el.stripWhere;
  return rules;
}

function rawValue(el: FieldElement, values: Readonly<Record<string, string>>): string {
  const raw = own(values, el.field) || '';
  return el.piece == null ? raw : splitPiece(raw, el.piece);
}

/** The text an element prints: a field's value through its Split piece and
 *  rules, static text's content, a barcode's or QR code's field value or
 *  static data. Values are never token-expanded. */
export function elementValue(el: ElementV2, values: Readonly<Record<string, string>>): string {
  switch (el.type) {
    case 'field': return applyRules(rawValue(el, values), fieldRules(el));
    case 'text': return el.content;
    case 'barcode':
    case 'qr': return el.field != null ? own(values, el.field) || '' : el.data ?? '';
    default: return '';
  }
}

/** An element that prints nothing at all: hide-when-empty with a value
 *  blank after Strip and trim, or inverted with nothing to reverse. */
export function elementHidden(el: ElementV2, values: Readonly<Record<string, string>>): boolean {
  switch (el.type) {
    case 'field':
      return isBlank(rawValue(el, values), fieldRules(el)) && (!!el.hideWhenEmpty || !!el.inverted);
    case 'text': return !!el.inverted && el.content === '';
    case 'barcode':
    case 'qr': return !!el.hideWhenEmpty && elementValue(el, values) === '';
    default: return false;
  }
}

// ---- validate (model.py parse_design, schema 2) ----------------------------

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function positive(v: unknown): v is number {
  return num(v) && v > 0;
}

function int(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v);
}

function present(v: unknown): boolean {
  return v !== null && v !== undefined;
}

type Check = (el: Raw, p: string[]) => void;

/** model.py reads these with a default (`el.get(key, default)`): only a
 *  missing key takes it, and null is a fault. */
function withDefault(v: unknown, fallback: unknown): unknown {
  return v === undefined ? fallback : v;
}

const needNum = (key: string): Check => (el, p) => {
  const v = el[key];
  if (!num(v) || v < 0) p.push(`${key} must be a non-negative number`);
};

const checkAlign: Check = (el, p) => {
  if (!ALIGNS.includes(withDefault(el.align, 'left') as string)) p.push('align must be left/center/right');
};

const checkLines: Check = (el, p) => {
  const lines = withDefault(el.lines, 1);
  if (!int(lines) || lines < 1) p.push('lines must be an integer of 1 or more');
};

const checkSymbology: Check = (el, p) => {
  if (!SYMBOLOGIES.includes(el.symbology as string)) p.push('symbology must be code128 or code39');
};

const checkModule: Check = (el, p) => {
  if (present(el.moduleIn) && !positive(el.moduleIn)) p.push('moduleIn must be a positive number');
};

const checkStroke: Check = (el, p) => {
  if (!positive(el.strokeIn)) p.push('strokeIn must be a positive number');
};

const checkFont: Check = (el, p) => {
  const font = el.font;
  if (!present(font)) return;
  const weight = isObject(font) ? withDefault(font.weight, 'regular') : undefined;
  if (!isObject(font) || typeof font.family !== 'string' || !familyInfo(font.family)
    || !WEIGHTS.includes(weight as string)) {
    p.push('font must name a known family and a weight of regular or bold');
  }
};

/** Font, size and baseline; a field shown as a barcode or QR code may leave
 *  size and baseline out. */
function checkTypeset(el: Raw, p: string[], required: boolean): void {
  checkFont(el, p);
  if ((required || present(el.sizePt)) && !positive(el.sizePt)) p.push('sizePt must be a positive number');
  if ((required || present(el.baselineIn)) && (!num(el.baselineIn) || el.baselineIn < 0)) {
    p.push('baselineIn must be a non-negative number');
  }
}

const checkPad: Check = (el, p) => {
  const pad = el.invertPad;
  if (!present(pad)) return;
  if (!isObject(pad) || !num(pad.x) || pad.x < 0 || !num(pad.y) || pad.y < 0) {
    p.push('invertPad must hold non-negative numbers x and y');
  }
};

const optCount = (key: string): Check => (el, p) => {
  const v = el[key];
  if (present(v) && (!int(v) || v < 1)) p.push(`${key} must be a whole number of 1 or more`);
};

const optChoice = (key: string, choices: readonly string[]): Check => (el, p) => {
  if (present(el[key]) && !choices.includes(el[key] as string)) {
    p.push(`${key} must be one of ${choices.join('/')}`);
  }
};

/** A barcode or QR code holds a field key or static data, never both. */
const checkSource: Check = (el, p) => {
  const hasField = present(el.field);
  if (hasField === present(el.data)) {
    p.push('needs exactly one of field or data');
  } else if (hasField) {
    if (typeof el.field !== 'string' || !el.field) p.push('field must be a non-empty string');
  } else if (typeof el.data !== 'string' || !el.data) {
    p.push('data must be a non-empty string');
  }
};

function checkField(el: Raw, p: string[], splits: ReadonlyMap<string, string[]>): void {
  const key = typeof el.field === 'string' ? el.field : '';
  if (!key) p.push('field must be a non-empty string');
  const piece = el.piece;
  if (present(piece)) {
    if (!int(piece) || piece < 0) p.push('piece must be a whole number of 0 or more');
    else if (!splits.has(key)) p.push(`piece ${piece} needs a Split defined for ${repr(key)}`);
    else if (piece >= splits.get(key)!.length) {
      p.push(`piece ${piece} is beyond ${repr(key)}'s Split (${splits.get(key)!.length} pieces)`);
    }
  }
  let display = withDefault(el.display, 'text');
  if (!DISPLAYS.includes(display as string)) {
    p.push(`display must be one of ${DISPLAYS.join('/')}`);
    display = 'text';
  }
  checkTypeset(el, p, display === 'text' || display === 'number');
  if (present(el.strip) && typeof el.strip !== 'string') p.push('strip must be a string');
  if (display === 'barcode') {
    checkSymbology(el, p);
    checkModule(el, p);
  }
  checkAlign(el, p);
  checkPad(el, p);
  optCount('expectedLength')(el, p);
  optCount('maxChars')(el, p);
  optChoice('trim', TRIMS)(el, p);
  optChoice('stripWhere', STRIP_WHERES)(el, p);
}

function checkElement(el: Raw, p: string[], splits: ReadonlyMap<string, string[]>): void {
  for (const key of ['x', 'y', 'w', 'h']) needNum(key)(el, p);
  if (!ROTATIONS.includes(withDefault(el.rotation, 0) as number)) {
    p.push('rotation must be one of 0/90/180/270');
  }
  switch (el.type) {
    case 'field':
      checkField(el, p, splits);
      return;
    case 'text':
      if (typeof el.content !== 'string') p.push('content must be a string');
      checkTypeset(el, p, true);
      checkAlign(el, p);
      checkLines(el, p);
      checkPad(el, p);
      return;
    case 'barcode':
      checkSource(el, p);
      checkSymbology(el, p);
      checkModule(el, p);
      return;
    case 'qr':
      checkSource(el, p);
      return;
    case 'line':
    case 'box':
      checkStroke(el, p);
      return;
    default:
      p.push(`unknown type ${repr(el.type)}`);
  }
}

/** Every fault the API's parse_design would refuse the design for, with
 *  model.py's messages, plus ids the builder needs unique. Empty = savable. */
export function validate(d: DesignV2): Problem[] {
  const problems: Problem[] = [];
  const raw = d as unknown as Raw;
  const size = raw.size;
  if (!isObject(size) || !positive(size.w) || !positive(size.h)) {
    problems.push({ elementId: null, message: 'size must hold positive numbers w and h' });
  }
  const splits = new Map<string, string[]>();
  if (present(raw.splits)) {
    if (!isObject(raw.splits)) {
      problems.push({ elementId: null, message: 'splits must be an object' });
    } else {
      for (const [key, spec] of Object.entries(raw.splits)) {
        const pieces = isObject(spec) ? spec.pieces : undefined;
        if (!Array.isArray(pieces) || !pieces.length || !pieces.every((n) => typeof n === 'string')) {
          problems.push({ elementId: null, message: `splits: ${repr(key)} must hold a non-empty list of piece names` });
        } else {
          splits.set(key, pieces as string[]);
        }
      }
    }
  }
  const seen = new Set<string>();
  d.elements.forEach((el, i) => {
    const raw = el as unknown as Raw;
    const id = typeof raw.id === 'string' ? raw.id : `element ${i}`;
    const p: string[] = [];
    checkElement(raw, p, splits);
    if (seen.has(id)) p.push('id is used by another element');
    seen.add(id);
    problems.push(...p.map((message) => ({ elementId: id, message })));
  });
  return problems;
}
