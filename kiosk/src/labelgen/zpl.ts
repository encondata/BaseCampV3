/**
 * ZPL II compiler for the label element model (labels/zpl.py): Design +
 * dpi (+ substitutions) -> ZPL. It must print exactly what the laptop's
 * Python prints, so every rounding is `pyRound` and every `//` `floorDiv`,
 * in Python's order of operations.
 *
 * Schema 1: substitutions null/undefined leaves {tokens} intact; a record
 * substitutes values. Literal text rides behind ^FH_ hex escaping so ^ ~ _
 * and non-ASCII survive. Bold is a 1.2x glyph width (font 0 has no weight).
 *
 * Schema 2 (and 3) compile only with values: text sits on its baseline
 * with z`^FT` in a named TrueType font (z`^A@…,E:<object>`); center/right
 * alignment is a one-line z`^FB` over the element's w; Bold on a family with
 * no Bold file overprints one dot along the reading direction, or on an
 * inverted element widens the glyphs 15%; inverted text is a filled z`^GB`
 * (the element box plus its pad) under z`^FR` text; each field value goes
 * through Split and its rules first. Barcodes, QR codes and shapes are
 * placed top-left with z`^FO`; Code 128 data starts in the subset
 * barcode.ts counts.
 *
 * Images: this port has no pictures (zpl.py with `images=None`): an image
 * element prints nothing, or the 2-dot outline of its footprint when its
 * hideWhenEmpty is off. Pure: no DOM, no Intl, no Node.
 */

import { code128Data } from './barcode';
import { fontObject } from './fonts';
import {
  elementHidden, elementValue, type BarcodeEl, type BoxEl, type Design, type Element,
  type FieldEl, type ImageEl, type LineEl, type QrEl, type Rotation, type TextEl,
} from './model';
import { floorDiv, pyRound, utf8Encode } from './py';
import { QrTooLong, qrFoOffsetDots, qrModules } from './qr';
import { TOKEN_RE } from './tokens';

type Values = Readonly<Record<string, string>>;

const ROT: Readonly<Record<Rotation, string>> = { 0: 'N', 90: 'R', 180: 'I', 270: 'B' };
const JUST = { left: 'L', center: 'C', right: 'R' } as const;

const own = (values: Values, key: string): string => (
  Object.prototype.hasOwnProperty.call(values, key) ? values[key] : ''
);

/** An int as Python prints it: every digit, never an exponent (a double
 *  past 1e21 would print as `3e+32`). Ints past 2^53 can still differ from
 *  Python's exact arithmetic, but only for coordinates no label has. */
function intText(n: number): string {
  return Number.isSafeInteger(n) ? String(n) : BigInt(n).toString();
}

/** ZPL text: every number in it printed with `intText`. */
function z(strings: TemplateStringsArray, ...args: (string | number)[]): string {
  let out = strings[0];
  args.forEach((arg, i) => {
    out += (typeof arg === 'number' ? intText(arg) : arg) + strings[i + 1];
  });
  return out;
}

function dots(v: number, dpi: number): number {
  return pyRound(v * dpi);
}

/** zpl.py `_esc`: z`^ ~ _ \` and anything outside 32..126 become `_xx`, one
 *  per UTF-8 byte, lowercase hex. Code points, never UTF-16 units. */
export function esc(literal: string): string {
  let out = '';
  for (const ch of literal) {
    const cp = ch.codePointAt(0)!;
    if ('^~_\\'.includes(ch) || cp < 32 || cp > 126) {
      for (const b of utf8Encode(ch)) out += `_${b.toString(16).padStart(2, '0')}`;
    } else {
      out += ch;
    }
  }
  return out;
}

/** Schema 1 ^FD data: literal runs escaped; a token kept as it is (no
 *  substitutions) or replaced by its escaped value (unknown -> ''). */
function fd(value: string, subs: Values | null): string {
  let out = '';
  let pos = 0;
  for (const m of value.matchAll(TOKEN_RE)) {
    out += esc(value.slice(pos, m.index));
    out += subs === null ? m[0] : esc(own(subs, m[1]));
    pos = m.index! + m[0].length;
  }
  return out + esc(value.slice(pos));
}

function text(el: TextEl, dpi: number, subs: Values | null): string {
  const h = pyRound((el.fontSizePt * dpi) / 72);
  const w = el.bold ? pyRound(h * 1.2) : h;
  let line = z`^FO${dots(el.x, dpi)},${dots(el.y, dpi)}`;
  // a ^FB for justification OR wrapping; left-aligned single lines get none
  if (el.align !== 'left' || el.lines > 1) {
    line += z`^FB${dots(el.w, dpi)},${el.lines},0,${JUST[el.align]},0`;
  }
  line += z`^A0${ROT[el.rotation]},${h},${w}`;
  if (el.reverse) line += '^FR';
  return `${line}^FH_^FD${fd(el.content, subs)}^FS`;
}

/** A barcode field around already-escaped data `data`. In Code 128 a `>`
 *  starts an invocation code, so a literal one goes as `>0`. With `start`
 *  (schema 2, whose data is a value) the data also opens with its subset's
 *  start code; schema 1 data may hold {tokens}, so it has none. */
function barcodeField(el: BarcodeEl | FieldEl, dpi: number, data: string, start = false): string {
  let fdata = data;
  if (el.symbology === 'code128') fdata = start ? code128Data(data) : data.split('>').join('>0');
  const hd = dots(el.h, dpi);
  const flag = el.showText ? 'Y' : 'N';
  // null keeps the historical ^BY2; inches convert per dpi
  const module = el.moduleIn === null ? 2 : Math.max(1, Math.min(10, dots(el.moduleIn, dpi)));
  const cmd = el.symbology === 'code128'
    ? z`^BC${ROT[el.rotation]},${hd},${flag},N,N`
    : z`^B3${ROT[el.rotation]},N,${hd},${flag},N`;
  return z`^FO${dots(el.x, dpi)},${dots(el.y, dpi)}^BY${module}${cmd}^FH_^FD${fdata}^FS`;
}

function qr(el: QrEl, dpi: number, subs: Values | null): string {
  const mag = Math.min(10, Math.max(1, pyRound(dots(el.w, dpi) / 25)));
  return z`^FO${dots(el.x, dpi)},${dots(el.y, dpi)}^BQ${ROT[el.rotation]},2,${mag}`
    + z`^FH_^FDQA,${fd(el.data, subs)}^FS`;
}

function shape(el: LineEl | BoxEl, dpi: number): string {
  const t = Math.max(1, dots(el.strokeIn, dpi));
  const w = Math.max(t, dots(el.w, dpi));
  const h = Math.max(t, dots(el.h, dpi));
  return z`^FO${dots(el.x, dpi)},${dots(el.y, dpi)}^GB${w},${h},${t}^FS`;
}

// ---- schema 2 ---------------------------------------------------------------

// one dot along each rotation's reading direction (the faux-bold overprint)
const STEP: Readonly<Record<Rotation, readonly [number, number]>> = {
  0: [1, 0], 90: [0, 1], 180: [-1, 0], 270: [0, -1],
};

/** The ^FT point: the start of the baseline. x, y is the footprint's
 *  top-left; w runs along the text and h across it. */
function origin(el: TextEl | FieldEl, dpi: number, b: number): [number, number] {
  const { x, y, w, h } = el;
  let pos: [number, number];
  if (el.rotation === 90) pos = [x + h - b, y]; // reads down, glyph tops to the right
  else if (el.rotation === 180) pos = [x + w, y + h - b]; // upside down, starts at the right
  else if (el.rotation === 270) pos = [x + b, y + w]; // reads up, glyph tops to the left
  else pos = [x, y + b];
  return [dots(pos[0], dpi), dots(pos[1], dpi)];
}

/** The filled block under inverted text: the element box plus its pad (x
 *  along the text, y across), turned with the element. */
function invertBox(el: TextEl | FieldEl, dpi: number): string {
  const pad = el.invertPad!;
  const px = dots(pad.x, dpi);
  const py = dots(pad.y, dpi);
  const along = dots(el.w, dpi) + 2 * px;
  const across = dots(el.h, dpi) + 2 * py;
  const x = dots(el.x, dpi);
  const y = dots(el.y, dpi);
  let [bx, by, bw, bh] = el.rotation === 90 || el.rotation === 270
    ? [x - py, y - px, across, along]
    : [x - px, y - py, along, across];
  // a pad past the label's top or left edge stops at the edge
  if (bx < 0) [bw, bx] = [bw + bx, 0];
  if (by < 0) [bh, by] = [bh + by, 0];
  bw = Math.max(1, bw);
  bh = Math.max(1, bh);
  // thickness = the short side fills the box (a thicker border would grow it)
  return z`^FO${bx},${by}^GB${bw},${bh},${Math.min(bw, bh)}^FS`;
}

/** The escaped ^FD of a text: a newline typed into static text is the ^FB
 *  line break `\&` when the text has lines to break onto, and dropped on a
 *  one-line text. */
function textData(el: TextEl | FieldEl, value: string, lines: number): string {
  if (el.type !== 'text') return esc(value);
  const parts = value.split('\r\n').join('\n').split('\r').join('\n').split('\n');
  return parts.map(esc).join(lines > 1 ? '\\&' : '');
}

function v2Text(el: TextEl | FieldEl, value: string, dpi: number): string[] {
  const [obj, faux] = fontObject(el.font!.family, el.font!.weight);
  const h = pyRound((el.fontSizePt * dpi) / 72);
  const w = faux && el.inverted ? pyRound(h * 1.15) : h;
  const lines = el.type === 'text' ? el.lines : 1;
  // with a ^FB, ^FT marks the LAST line's baseline; lines sit one font
  // height apart (^FB line spacing 0)
  const [ox, oy] = origin(el, dpi, el.baselineIn! + ((lines - 1) * el.fontSizePt) / 72);
  const block = el.align !== 'left' || lines > 1
    ? z`^FB${dots(el.w, dpi)},${lines},0,${JUST[el.align]},0` : '';
  const rest = z`${block}^A@${ROT[el.rotation]},${h},${w},E:${obj}`
    + (el.inverted ? '^FR' : '') + z`^FH_^FD${textData(el, value, lines)}^FS`;
  const out = el.inverted ? [invertBox(el, dpi)] : [];
  out.push(z`^FT${ox},${oy}${rest}`);
  if (faux && !el.inverted) {
    const [dx, dy] = STEP[el.rotation];
    out.push(z`^FT${Math.max(0, ox + dx)},${Math.max(0, oy + dy)}${rest}`);
  }
  return out;
}

/** Error correction M, automatic input (`MA,`). Magnification fills the box
 *  for the symbol size the value needs, capped at 10; the symbol is
 *  centered on the box. The printer draws the symbol QR_FO_OFFSET_IN below
 *  its ^FO, so ^FO goes that far above (never above 0). ^BQ prints upright
 *  only (N). */
function v2Qr(el: QrEl | FieldEl, value: string, dpi: number): string {
  let modules: number;
  try {
    modules = qrModules(value);
  } catch (e) {
    if (e instanceof QrTooLong) throw new QrTooLong(`${el.id}: ${e.problems[0]}`);
    throw e;
  }
  const wd = dots(el.w, dpi);
  const hd = dots(el.h, dpi);
  const mag = Math.min(10, Math.max(1, pyRound(wd / modules)));
  const side = modules * mag;
  const x = Math.max(0, dots(el.x, dpi) + floorDiv(wd - side, 2));
  const top = dots(el.y, dpi) + floorDiv(hd - side, 2);
  const y = Math.max(0, top - qrFoOffsetDots(dpi));
  return z`^FO${x},${y}^BQN,2,${mag}^FH_^FDMA,${esc(value)}^FS`;
}

function v2Shape(el: LineEl | BoxEl, dpi: number): string {
  let t = Math.max(1, dots(el.strokeIn, dpi));
  const along = dots(el.w, dpi);
  const across = dots(el.h, dpi);
  let [w, h] = el.rotation === 90 || el.rotation === 270 ? [across, along] : [along, across];
  w = Math.max(t, w);
  h = Math.max(t, h);
  if (el.type === 'box' && el.fill) t = Math.min(w, h);
  return z`^FO${dots(el.x, dpi)},${dots(el.y, dpi)}^GB${w},${h},${t}^FS`;
}

// the outline an empty photo or logo prints when hideWhenEmpty is off
const EMPTY_IMAGE_STROKE = 2;

/** zpl.py `_v2_image` with no bitmap: nothing, or the footprint's outline. */
function v2Image(el: ImageEl, dpi: number): string[] {
  if (el.hideWhenEmpty) return [];
  const along = dots(el.w, dpi);
  const across = dots(el.h, dpi);
  const [w, h] = el.rotation === 90 || el.rotation === 270 ? [across, along] : [along, across];
  const t = EMPTY_IMAGE_STROKE;
  return [z`^FO${dots(el.x, dpi)},${dots(el.y, dpi)}^GB${Math.max(t, w)},${Math.max(t, h)},${t}^FS`];
}

function v2Element(el: Element, dpi: number, values: Values): string[] {
  if (el.type === 'image') return v2Image(el, dpi);
  if (el.type === 'line' || el.type === 'box') return [v2Shape(el, dpi)];
  if (elementHidden(el, values)) return [];
  const value = elementValue(el, values);
  const display = el.type === 'field' ? el.display : null;
  if (el.type === 'barcode' || (el.type === 'field' && display === 'barcode')) {
    return [barcodeField(el, dpi, esc(value), true)];
  }
  if (el.type === 'qr' || (el.type === 'field' && display === 'qr')) return [v2Qr(el, value, dpi)];
  return v2Text(el as TextEl | FieldEl, value, dpi);
}

/** zpl.py `compile_zpl` (no images): lines joined by `\n`, z`^XA` to z`^XZ`,
 *  no trailing newline. A schema 2 or 3 design needs `substitutions`. */
export function compileZpl(design: Design, dpi: number, substitutions?: Values | null): string {
  const lines = ['^XA', z`^PW${dots(design.widthIn, dpi)}`, z`^LL${dots(design.heightIn, dpi)}`, '^CI28'];
  const subs = substitutions ?? null;
  if (design.schema >= 2) {
    if (subs === null) throw new Error('v2 designs render with values');
    for (const el of design.elements) lines.push(...v2Element(el, dpi, subs));
    lines.push('^XZ');
    return lines.join('\n');
  }
  for (const el of design.elements) {
    if (el.type === 'text') lines.push(text(el, dpi, subs));
    else if (el.type === 'barcode') lines.push(barcodeField(el, dpi, fd(el.data, subs)));
    else if (el.type === 'qr') lines.push(qr(el, dpi, subs));
    else if (el.type === 'line' || el.type === 'box') lines.push(shape(el, dpi));
  }
  lines.push('^XZ');
  return lines.join('\n');
}
