/**
 * One element on the builder canvas, drawn in printer dots at the viewed
 * DPI the way the v2 compiler (labels/zpl.py) prints it, every edge on the
 * dot the compiler rounds it to (`_dots`, units.ts toDots):
 *  - text (static text, a field shown as text or a number) in its own frame
 *    (w along the text, h across it), turned about the footprint for 90 /
 *    180 / 270 (model.ts). The reserved box is outlined; the text starts at
 *    the compiler's ^FT point (`_origin`), at the printer's font height,
 *    aligned inside the box, in the loaded face, stretched to the width the
 *    printer's metrics give (`textLength`), so spacing is exact even under
 *    the resident font's stand-in. Past the box the text's extent shows in
 *    red. Inverted: the black block is the box plus its pad, stopped at the
 *    label's top and left edges (`_invert_box`), and the text is white.
 *    Faux bold overprints one dot along the text;
 *  - a barcode: stripes in its narrow module over the box, the
 *    human-readable line under the bars;
 *  - a QR code: a placeholder symbol where and as big as the printer puts
 *    it (qr.ts qrLayout: centered, whole magnification steps, capped at 10),
 *    always upright, as ^BQ prints;
 *  - a line or box: the compiler's ^GB, a border of the stroke width (solid
 *    when that fills it).
 * An element that prints nothing (hide-when-empty with a blank value, or
 * inverted with nothing to reverse) keeps only its outline, dimmed.
 */

import { memo } from 'react';

import { faceFile, fauxBold, glyphWidthScale } from '../../../labels/builder/fonts';
import { barcodeModuleDots } from '../../../labels/builder/geometry';
import { cssFamilyOf, textWidthIn, type LoadedFont } from '../../../labels/builder/metrics';
import { invertPadOf, type ElementV2, type FieldElement, type TextElement } from '../../../labels/builder/model';
import { qrLayout, type QrLayout } from '../../../labels/builder/qr';
import { pyRound, toDots } from '../../../labels/builder/units';
import { DEFAULT_FONT } from './canvasActions';

export type ElementKind = 'text' | 'barcode' | 'qr' | 'shape';

export function kindOf(el: ElementV2): ElementKind {
  switch (el.type) {
    case 'text': return 'text';
    case 'barcode': return 'barcode';
    case 'qr': return 'qr';
    case 'line':
    case 'box': return 'shape';
    case 'field': return el.display === 'barcode' ? 'barcode' : el.display === 'qr' ? 'qr' : 'text';
  }
}

/** A box in printer dots. */
export interface DotRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The element's x, y, w (along) and h (across) in whole dots, as the
 *  compiler rounds each one. */
export function dotBox(el: ElementV2, dpi: number): DotRect {
  return { x: toDots(el.x, dpi), y: toDots(el.y, dpi), w: toDots(el.w, dpi), h: toDots(el.h, dpi) };
}

/** What the element covers on the label, in dots (h wide and w tall at
 *  90 and 270). */
export function dotFootprint(el: ElementV2, dpi: number): DotRect {
  const b = dotBox(el, dpi);
  return el.rotation === 90 || el.rotation === 270 ? { x: b.x, y: b.y, w: b.h, h: b.w } : b;
}

/** The element's frame: local (0, 0) at its top-left before turning, u
 *  along the text and v across it; the footprint's top-left stays at (x, y). */
export function frameTransform(el: ElementV2, dpi: number): string {
  const { x, y, w, h } = dotBox(el, dpi);
  switch (el.rotation) {
    case 90: return `translate(${x + h} ${y}) rotate(90)`;
    case 180: return `translate(${x + w} ${y + h}) rotate(180)`;
    case 270: return `translate(${x} ${y + w}) rotate(270)`;
    default: return `translate(${x} ${y})`;
  }
}

/** A label point in dots, in the element's frame (frameTransform's inverse). */
export function toFrame(el: ElementV2, dpi: number, p: { x: number; y: number }): { u: number; v: number } {
  const b = dotBox(el, dpi);
  switch (el.rotation) {
    case 90: return { u: p.y - b.y, v: b.x + b.h - p.x };
    case 180: return { u: b.x + b.w - p.x, v: b.y + b.h - p.y };
    case 270: return { u: b.y + b.w - p.y, v: p.x - b.x };
    default: return { u: p.x - b.x, v: p.y - b.y };
  }
}

/** The compiler's ^FT point for a baseline `baselineIn` below the top of
 *  the text, in label dots (labels/zpl.py `_origin`). */
export function textOrigin(el: ElementV2, dpi: number, baselineIn: number): { x: number; y: number } {
  const { x, y, w, h } = el;
  const b = baselineIn;
  const [ox, oy] = el.rotation === 90 ? [x + h - b, y]
    : el.rotation === 180 ? [x + w, y + h - b]
      : el.rotation === 270 ? [x + b, y + w] : [x, y + b];
  return { x: toDots(ox, dpi), y: toDots(oy, dpi) };
}

/** The printer's font height in dots (^A@'s h: round(size × dpi / 72)). */
export function fontDots(sizePt: number, dpi: number): number {
  return pyRound((sizePt * dpi) / 72);
}

/** An inverted element's block in label dots: its box plus the pad (x along
 *  the text, y across), turned with it and stopped at the label's top and
 *  left edges (labels/zpl.py `_invert_box`). */
export function invertBlock(el: FieldElement | TextElement, dpi: number): DotRect {
  const pad = invertPadOf(el);
  const px = toDots(pad.x, dpi);
  const py = toDots(pad.y, dpi);
  const b = dotBox(el, dpi);
  const along = b.w + 2 * px;
  const across = b.h + 2 * py;
  const turned = el.rotation === 90 || el.rotation === 270;
  let [x, y, w, h] = turned ? [b.x - py, b.y - px, across, along] : [b.x - px, b.y - py, along, across];
  if (x < 0) [w, x] = [w + x, 0];
  if (y < 0) [h, y] = [h + y, 0];
  return { x, y, w: Math.max(1, w), h: Math.max(1, h) };
}

// a hair under a dot: what counts as spilling past the box
const SPILL = 0.01;

export interface TextLayout {
  lines: string[];
  /** Each line's width in dots as drawn, or null until the font's metrics load. */
  widths: (number | null)[];
  /** Each line's start after alignment, from the ^FT point along the text. */
  starts: number[];
  /** The font size drawn, as a share of the element's (names shrink to fit). */
  scale: number;
  overflow: boolean;
}

/** How small a field name may shrink to fit its box before it condenses. */
const NAME_MIN_SCALE = 0.5;

/** Greedy word wrap for multi-line static text (^FB wraps at spaces);
 *  whatever doesn't fit stays on the last line. */
function wrap(text: string, lines: number, widthDots: number, measure: ((s: string) => number) | null): string[] {
  if (lines <= 1 || !measure) return [text];
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    const next = line ? `${line} ${word}` : word;
    if (line && out.length < lines - 1 && measure(next) > widthDots) {
      out.push(line);
      line = word;
    } else {
      line = next;
    }
  }
  out.push(line);
  return out;
}

/** Where a text element's lines sit in its frame, and whether any spills.
 *  A field name (`names`) is no print: it shrinks, then condenses, to stay
 *  inside the box, so neighbors stay readable and white text on an
 *  inverted block never runs onto the white label. */
export function layoutText(el: FieldElement | TextElement, text: string, dpi: number,
  font: LoadedFont | null, names = false): TextLayout {
  const ref = el.font ?? DEFAULT_FONT;
  const sizePt = el.sizePt ?? 0;
  const w = toDots(el.w, dpi);
  const scale = glyphWidthScale(ref, !!el.inverted);
  const measure = font ? (s: string) => textWidthIn(font.metrics, sizePt, s, scale) * dpi : null;
  const lines = wrap(text, el.type === 'text' ? el.lines ?? 1 : 1, w, measure);
  let widths = lines.map((line) => (measure ? measure(line) : null));
  let fit = 1;
  if (names && w > 0) {
    const widest = Math.max(0, ...widths.map((lw) => lw ?? 0));
    if (widest > w) fit = Math.max(NAME_MIN_SCALE, w / widest);
    widths = widths.map((lw) => (lw === null ? null : Math.min(lw * fit, w)));
  }
  const align = el.align ?? 'left';
  const starts = widths.map((lw) => {
    if (lw === null || align === 'left') return 0;
    return align === 'center' ? (w - lw) / 2 : w - lw;
  });
  const overflow = !names && widths.some((lw, i) => lw !== null && (starts[i] < -SPILL || starts[i] + lw > w + SPILL));
  return { lines, widths, starts, scale: fit, overflow };
}

export interface CanvasElementProps {
  el: ElementV2;
  dpi: number;
  /** What the element shows: its printed value, or its field's name. */
  text: string;
  /** Showing field names rather than sample values. */
  names: boolean;
  /** Prints nothing with these values (only its outline shows). */
  hidden: boolean;
  /** A text element's loaded font; null until it loads. */
  font: LoadedFont | null;
  /** What a QR code encodes, which sets its size. */
  qrValue: string;
  /** Dots per screen pixel, for hairlines that stay one pixel at any zoom. */
  px: number;
  /** A prefix for the SVG ids this element defines, unique on the page. */
  uid: string;
}

function CanvasElement(props: CanvasElementProps) {
  const { el, dpi, names, hidden } = props;
  const kind = kindOf(el);
  const layout = kind === 'text' && (el.type === 'field' || el.type === 'text')
    ? layoutText(el, props.text, dpi, props.font, names) : null;
  const overflow = !!layout && layout.overflow && !hidden;
  const inverted = (el.type === 'field' || el.type === 'text') && !!el.inverted && kind === 'text';
  const cls = ['lbc-el', `lbc-el-${kind}`];
  if (hidden) cls.push('is-hidden');
  if (inverted) cls.push('is-inverted');
  if (overflow) cls.push('is-overflow');
  if (names) cls.push('is-names');
  if (el.locked) cls.push('is-locked');
  return (
    <g data-el-id={el.id} className={cls.join(' ')}>
      {kind === 'text' && layout && (el.type === 'field' || el.type === 'text') && (
        <TextBody {...props} el={el} layout={layout} overflow={overflow} />
      )}
      {kind === 'barcode' && <BarcodeBody {...props} />}
      {kind === 'qr' && <QrBody {...props} />}
      {kind === 'shape' && (el.type === 'line' || el.type === 'box') && <ShapeBody {...props} />}
    </g>
  );
}

export default memo(CanvasElement);

function Outline({ w, h, px }: { w: number; h: number; px: number }) {
  return (
    <rect className="lbc-box" x={0} y={0} width={w} height={Math.max(h, px)}
      strokeWidth={px} strokeDasharray={`${3 * px} ${2 * px}`} />
  );
}

function TextBody({ el, dpi, hidden, font, px, layout, overflow }: CanvasElementProps & {
  el: FieldElement | TextElement; layout: TextLayout; overflow: boolean;
}) {
  const ref = el.font ?? DEFAULT_FONT;
  const em = fontDots(el.sizePt ?? 0, dpi);
  const drawn = em * layout.scale;
  const { w, h } = dotBox(el, dpi);
  // the first line's ^FT point in the frame; the lines sit one font height apart
  const o = toFrame(el, dpi, textOrigin(el, dpi, el.baselineIn ?? 0));
  const align = el.align ?? 'left';
  const anchor = align === 'center' ? 'middle' : align === 'right' ? 'end' : 'start';
  const ax = o.u + (align === 'center' ? w / 2 : align === 'right' ? w : 0);
  const family = `${font?.cssFamily ?? cssFamilyOf(faceFile(ref))}, sans-serif`;
  // faux bold overprints one dot along the text; inverted widens instead
  const overprint = fauxBold(ref) && !el.inverted;
  const block = el.inverted && !hidden ? invertBlock(el, dpi) : null;
  return (
    <>
      {block && <rect className="lbc-invert" x={block.x} y={block.y} width={block.w} height={block.h} />}
      <g className="lbc-frame" transform={frameTransform(el, dpi)}>
        <Outline w={w} h={h} px={px} />
        {!hidden && layout.lines.map((line, i) => {
          const lw = layout.widths[i];
          const fit = lw !== null && lw > 0 ? { textLength: lw, lengthAdjust: 'spacingAndGlyphs' as const } : {};
          const y = o.v + i * em;
          return (
            <g key={i}>
              <text className="lbc-text" x={ax} y={y} fontFamily={family} fontSize={drawn}
                textAnchor={anchor} {...fit}>{line}</text>
              {overprint && (
                <text className="lbc-text lbc-overprint" x={ax + 1} y={y} fontFamily={family} fontSize={drawn}
                  textAnchor={anchor} {...fit}>{line}</text>
              )}
            </g>
          );
        })}
        {overflow && layout.lines.map((_, i) => {
          const lw = layout.widths[i];
          if (lw === null) return null;
          const start = o.u + layout.starts[i];
          const end = start + lw;
          const right = o.u + w;
          // the first line spans the box; each later one is a font height tall
          const top = i * em;
          const tall = i === 0 ? Math.max(h, px) : em;
          return (
            <g key={`spill-${i}`}>
              {end > right + SPILL && (
                <rect className="lbc-overflow" x={right} y={top} width={end - right} height={tall} />
              )}
              {start < o.u - SPILL && (
                <rect className="lbc-overflow" x={start} y={top} width={Math.min(o.u, end) - start} height={tall} />
              )}
            </g>
          );
        })}
      </g>
    </>
  );
}

function BarcodeBody({ el, dpi, text, hidden, px, uid }: CanvasElementProps) {
  const moduleIn = el.type === 'barcode' || el.type === 'field' ? el.moduleIn : null;
  const showText = el.type === 'barcode' || el.type === 'field' ? el.showText ?? true : true;
  const m = barcodeModuleDots(moduleIn, dpi);
  const { w, h } = dotBox(el, dpi);
  const hri = Math.max(8, 9 * m);
  const id = `${uid}-bars`;
  return (
    <g className="lbc-frame" transform={frameTransform(el, dpi)}>
      <Outline w={w} h={h} px={px} />
      {!hidden && (
        <>
          <defs>
            <pattern id={id} patternUnits="userSpaceOnUse" width={11 * m} height={Math.max(h, 1)}>
              <rect x={0} width={2 * m} height={Math.max(h, 1)} />
              <rect x={3 * m} width={m} height={Math.max(h, 1)} />
              <rect x={6 * m} width={2 * m} height={Math.max(h, 1)} />
              <rect x={9 * m} width={m} height={Math.max(h, 1)} />
            </pattern>
          </defs>
          <rect className="lbc-bars" x={0} y={0} width={w} height={h} fill={`url(#${id})`} />
          {showText && (
            <text className="lbc-hri" x={w / 2} y={h + hri} fontSize={hri} fontFamily="monospace"
              textAnchor="middle">{text}</text>
          )}
        </>
      )}
    </g>
  );
}

function QrSymbol({ layout, uid }: { layout: QrLayout; uid: string }) {
  const { x, y, side, magnification: m } = layout;
  const id = `${uid}-qr`;
  const finders: [number, number][] = [[x, y], [x + side - 7 * m, y], [x, y + side - 7 * m]];
  return (
    <g className={`lbc-qr-symbol${layout.capped ? ' is-capped' : ''}`}>
      <defs>
        <pattern id={id} patternUnits="userSpaceOnUse" x={x} y={y} width={2 * m} height={2 * m}>
          <rect width={m} height={m} />
          <rect x={m} y={m} width={m} height={m} />
        </pattern>
      </defs>
      <rect className="lbc-qr-data" x={x} y={y} width={side} height={side} fill={`url(#${id})`} />
      {finders.map(([fx, fy], i) => (
        <g key={i}>
          <rect className="lbc-qr-light" x={fx - (i === 1 ? m : 0)} y={fy - (i === 2 ? m : 0)} width={8 * m} height={8 * m} />
          <rect className="lbc-qr-dark" x={fx} y={fy} width={7 * m} height={7 * m} />
          <rect className="lbc-qr-light" x={fx + m} y={fy + m} width={5 * m} height={5 * m} />
          <rect className="lbc-qr-dark" x={fx + 2 * m} y={fy + 2 * m} width={3 * m} height={3 * m} />
        </g>
      ))}
      {layout.capped && (
        <title>The printer caps a QR code at 10 dots per module, so at this DPI it prints smaller, centered in its box.</title>
      )}
    </g>
  );
}

function QrBody({ el, dpi, hidden, qrValue, px, uid }: CanvasElementProps) {
  const fp = dotFootprint(el, dpi);
  let layout: QrLayout | null = null;
  try {
    layout = qrLayout(el, qrValue, dpi);
  } catch {
    layout = null;
  }
  return (
    <>
      <g transform={`translate(${fp.x} ${fp.y})`}>
        <Outline w={fp.w} h={fp.h} px={px} />
        {!hidden && !layout && (
          <rect className="lbc-qr-bad" x={0} y={0} width={fp.w} height={fp.h}>
            <title>Too long for a QR code (version 10 at error correction M).</title>
          </rect>
        )}
      </g>
      {!hidden && layout && <QrSymbol layout={layout} uid={uid} />}
    </>
  );
}

/** The compiler's ^GB: a border of the stroke width, solid when that (or
 *  a box's fill) fills it. */
function ShapeBody({ el, dpi }: CanvasElementProps) {
  if (el.type !== 'line' && el.type !== 'box') return null;
  const fp = dotFootprint(el, dpi);
  const t = Math.max(1, toDots(el.strokeIn, dpi));
  const { x, y } = fp;
  const w = Math.max(t, fp.w);
  const h = Math.max(t, fp.h);
  const border = el.type === 'box' && el.fill ? Math.min(w, h) : t;
  if (2 * border >= Math.min(w, h)) {
    return <rect className="lbc-shape" x={x} y={y} width={w} height={h} />;
  }
  const d = `M${x} ${y}h${w}v${h}h${-w}Z`
    + `M${x + border} ${y + border}v${h - 2 * border}h${w - 2 * border}v${-(h - 2 * border)}Z`;
  return <path className="lbc-shape" d={d} fillRule="evenodd" />;
}
