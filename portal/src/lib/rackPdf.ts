/**
 * Export PDF for the rack view: the same one-page sheet Print layout
 * produces (lib/rackPrint.ts) — heading, the elevation frames on screen
 * (captioned when there is more than one), the device list beside them
 * and the legend — drawn straight into a downloaded PDF in the browser.
 * jsPDF draws the text and swatches; svg2pdf.js draws each elevation SVG
 * as vector line-work, so the rack stays sharp and its labels selectable.
 *
 * Both libraries are loaded with dynamic import() so they stay out of the
 * main bundle until someone actually exports.
 *
 * The layout math lives in `rackPdfLayout`, a pure function with no jsPDF
 * dependency, so it is unit-testable. It mirrors the print sheet's CSS
 * box model in points and relies on Courier being fixed-width (every
 * glyph advances 0.6 em) to measure text exactly. Like the print sheet's
 * zoom guard, the whole sheet scales down to fit 7.2in wide by at most
 * 9.3in tall, which fits both Letter and A4 with 0.5in+ margins.
 */
import type { jsPDF } from 'jspdf';

import type { DeviceListRow, LegendCategory } from './initiatives';
import { UNCATEGORIZED_FILL } from './initiatives';
import { RACK_LINE_WORK } from './rackPrint';

/* ── file name ─────────────────────────────────────────────── */

const ILLEGAL_FILE_CHARS = '/\\:*?"<>|';

function cleanFilePart(s: string): string {
  return [...s.trim()]
    .map((c) => {
      const code = c.charCodeAt(0);
      return code < 32 || code === 127 || ILLEGAL_FILE_CHARS.includes(c) ? '-' : c;
    })
    .join('');
}

/** `<Move name> - <Rack name> (<Source|Destination>).pdf`. Characters a
 *  file name can't hold become `-`; each part is trimmed; a blank move
 *  name falls back to `Move`. */
export function rackPdfFileName(moveName: string, rackName: string, sideLabel: string): string {
  const move = cleanFilePart(moveName) || 'Move';
  return `${move} - ${cleanFilePart(rackName)} (${cleanFilePart(sideLabel)}).pdf`;
}

/* ── layout (pure) ─────────────────────────────────────────── */

const IN = 72; // points per inch
const PX = 0.75; // points per CSS px
const LINE = 1.2; // CSS line-height: normal, near enough for Courier
const COURIER_ADVANCE = 0.6; // em per glyph, every Courier glyph
// Courier's (ascender - |descender|) / 2 in em: how far the alphabetic
// baseline sits below the middle of a line box.
const BASELINE_BELOW_MIDDLE = (0.629 - 0.157) / 2;

export const PDF_CONTENT_WIDTH = 7.2 * IN;
export const PDF_HEIGHT_BUDGET = 9.3 * IN;
const PAGE_WIDTH = 8.5 * IN; // Letter
const PAGE_TOP = 0.5 * IN;
const PAGE_LEFT = (PAGE_WIDTH - PDF_CONTENT_WIDTH) / 2;

// Print sheet values (rackPrint.ts SHEET_CSS), in points.
const TITLE_SIZE = 14;
const TITLE_GAP = 0.1 * IN;
const ELEVATIONS_HEIGHT = 8.7 * IN;
const FRAME_GAP = 0.2 * IN;
const CAPTION_SIZE = 8;
const SHEET_GAP = 0.25 * IN;
const LIST_SIZE = 8;
const GROUP_SIZE = 7;
const GROUP_MARGIN_TOP = 0.08 * IN;
const GROUP_MARGIN_BOTTOM = 0.03 * IN;
const LETTER_SPACING = 0.08; // em, captions and group headings
const ROW_PAD = 2 * PX;
const ROW_BORDER = 1 * PX;
const SWATCH = 8 * PX;
const SWATCH_COL = 10 * PX;
const COL_GAP = 6 * PX;
const CHILD_INDENT = 10 * PX;
const RU_MIN_WIDTH = 0.4 * IN;
const LEGEND_TOP = 0.12 * IN;
const LEGEND_SIZE = 8;
const LEGEND_GAP = 0.2 * IN;
const LEGEND_SWATCH_GAP = 4 * PX;

const TEXT = '#111827';
const MODEL_TEXT = '#374151';
const GROUP_TEXT = '#6b7280';
const ROW_RULE = '#d7dce2';
// rgba(17,24,39,0.35) over white
const SWATCH_BORDER = '#acaeb3';

export interface PdfText {
  text: string; x: number; y: number; // x = left edge, y = alphabetic baseline
  width: number; size: number; bold: boolean; color: string; charSpace: number;
}
export interface PdfBox {
  x: number; y: number; w: number; h: number; radius: number;
  fill: string; stroke: string; lineWidth: number; dash: number[] | null;
}
export interface PdfLine { x1: number; y1: number; x2: number; y2: number; color: string; lineWidth: number; }
export interface PdfFrameBox { x: number; y: number; width: number; height: number; }

export interface RackPdfLayout {
  /** content box on the page, in points */
  left: number; top: number; width: number; height: number;
  scale: number;
  texts: PdfText[]; boxes: PdfBox[]; lines: PdfLine[];
  /** one per input frame, in input order */
  frames: PdfFrameBox[];
}

const textWidth = (text: string, size: number, spacing = 0) =>
  [...text].length * size * (COURIER_ADVANCE + spacing);

/** Positions every piece of the sheet on a Letter page, in points. Frames
 *  carry their SVG viewBox size so each keeps its aspect ratio. */
export function rackPdfLayout(input: {
  title: string;
  frames: { heading: string; width: number; height: number }[];
  listRows: DeviceListRow[]; grouped: boolean; legend: LegendCategory[];
}): RackPdfLayout {
  // Everything is laid out at natural size from (0,0), then scaled and
  // moved onto the page at the end.
  const texts: PdfText[] = [];
  const boxes: PdfBox[] = [];
  const lines: PdfLine[] = [];
  const frames: PdfFrameBox[] = [];
  const text = (t: string, x: number, lineTop: number, size: number,
    opts: { bold?: boolean; color?: string; spacing?: number } = {}) => {
    texts.push({
      text: t, x, y: lineTop + (size * LINE) / 2 + size * BASELINE_BELOW_MIDDLE,
      width: textWidth(t, size, opts.spacing), size, bold: opts.bold ?? false,
      color: opts.color ?? TEXT, charSpace: size * (opts.spacing ?? 0),
    });
  };
  const swatch = (x: number, y: number, kind: 'fill' | 'verified' | 'planned', color = '') => {
    const lineWidth = kind === 'verified' ? 2 * PX : kind === 'planned' ? 1.5 * PX : 1 * PX;
    // CSS border-box: the stroke sits inside the 8px square
    boxes.push({
      x: x + lineWidth / 2, y: y + lineWidth / 2,
      w: SWATCH - lineWidth, h: SWATCH - lineWidth, radius: 2 * PX,
      fill: kind === 'fill' ? color : '#ffffff',
      stroke: kind === 'verified' ? '#15803d' : kind === 'planned' ? TEXT : SWATCH_BORDER,
      lineWidth, dash: kind === 'planned' ? [2, 1.5] : null,
    });
  };

  // heading
  text(input.title, 0, 0, TITLE_SIZE, { bold: true });
  const sheetTop = TITLE_SIZE * LINE + TITLE_GAP;

  // elevation frames, each in its own column with an optional caption
  const captioned = input.frames.length > 1;
  const captionHeight = captioned ? CAPTION_SIZE * LINE : 0;
  const svgHeight = ELEVATIONS_HEIGHT - captionHeight;
  let x = 0;
  input.frames.forEach((f, i) => {
    const svgWidth = svgHeight * (f.width / f.height);
    const captionWidth = captioned ? textWidth(f.heading, CAPTION_SIZE, LETTER_SPACING) : 0;
    const colWidth = Math.max(svgWidth, captionWidth);
    if (i > 0) x += FRAME_GAP;
    if (captioned) {
      text(f.heading, x + (colWidth - captionWidth) / 2, sheetTop, CAPTION_SIZE,
        { bold: true, spacing: LETTER_SPACING });
    }
    frames.push({ x: x + (colWidth - svgWidth) / 2, y: sheetTop + captionHeight,
      width: svgWidth, height: svgHeight });
    x += colWidth;
  });
  const listLeft = x + SHEET_GAP;

  // device list: measure first (width and height), then place
  const rowHeight = LIST_SIZE * LINE + ROW_PAD * 2 + ROW_BORDER;
  const groupHeight = GROUP_MARGIN_TOP + GROUP_SIZE * LINE + GROUP_MARGIN_BOTTOM;
  type Item = { group: string } | { row: DeviceListRow; name: string; ruWidth: number };
  const items: Item[] = [];
  let lastGroup: string | null = null;
  let listNeeded = 0;
  let listHeight = 0;
  for (const r of input.listRows) {
    if (input.grouped && r.group !== lastGroup) {
      items.push({ group: r.group });
      listNeeded = Math.max(listNeeded, textWidth(r.group, GROUP_SIZE, LETTER_SPACING));
      listHeight += groupHeight;
    }
    lastGroup = r.group;
    const name = r.orphan ? `! ${r.name}` : r.name;
    const ruWidth = Math.max(RU_MIN_WIDTH, textWidth(r.ruText, LIST_SIZE));
    items.push({ row: r, name, ruWidth });
    listNeeded = Math.max(listNeeded, SWATCH_COL + COL_GAP * 3 + (r.indent ? CHILD_INDENT : 0)
      + textWidth(name, LIST_SIZE) + textWidth(r.makeModel, LIST_SIZE) + ruWidth);
    listHeight += rowHeight;
  }
  const listWidth = Math.max(listNeeded, PDF_CONTENT_WIDTH - listLeft);
  const naturalWidth = listLeft + listWidth;
  const listRight = listLeft + listWidth;
  const sheetHeight = Math.max(ELEVATIONS_HEIGHT, listHeight);
  // the list sits at the bottom of the sheet (justify-content: flex-end)
  let y = sheetTop + sheetHeight - listHeight;
  for (const item of items) {
    if ('group' in item) {
      text(item.group, listLeft, y + GROUP_MARGIN_TOP, GROUP_SIZE,
        { bold: true, color: GROUP_TEXT, spacing: LETTER_SPACING });
      y += groupHeight;
      continue;
    }
    const { row, name, ruWidth } = item;
    const lineTop = y + ROW_PAD;
    const middle = lineTop + (LIST_SIZE * LINE) / 2;
    swatch(listLeft, middle - SWATCH / 2, 'fill', row.categoryColor ?? UNCATEGORIZED_FILL);
    text(name, listLeft + SWATCH_COL + COL_GAP + (row.indent ? CHILD_INDENT : 0), lineTop, LIST_SIZE);
    const ruText = textWidth(row.ruText, LIST_SIZE);
    text(row.ruText, listRight - ruText, lineTop, LIST_SIZE);
    const modelLeft = listRight - ruWidth - COL_GAP - textWidth(row.makeModel, LIST_SIZE);
    if (row.makeModel) text(row.makeModel, modelLeft, lineTop, LIST_SIZE, { color: MODEL_TEXT });
    const ruleY = y + LIST_SIZE * LINE + ROW_PAD * 2 + ROW_BORDER / 2;
    lines.push({ x1: listLeft, y1: ruleY, x2: listRight, y2: ruleY, color: ROW_RULE, lineWidth: ROW_BORDER });
    y += rowHeight;
  }

  // legend: wrapping row of swatch + label items under the sheet
  const legendItems: { label: string; kind: 'fill' | 'verified' | 'planned'; color?: string }[] = [
    ...input.legend.map((c) => ({ label: c.label, kind: 'fill' as const, color: c.color })),
    { label: 'Verified', kind: 'verified' },
    { label: 'Planned', kind: 'planned' },
  ];
  const legendLine = LEGEND_SIZE * LINE;
  let lx = 0;
  let ly = sheetTop + sheetHeight + LEGEND_TOP;
  for (const item of legendItems) {
    const w = SWATCH + LEGEND_SWATCH_GAP + textWidth(item.label, LEGEND_SIZE);
    if (lx > 0 && lx + w > naturalWidth) {
      lx = 0;
      ly += legendLine + LEGEND_GAP;
    }
    swatch(lx, ly + (legendLine - SWATCH) / 2, item.kind, item.color);
    text(item.label, lx + SWATCH + LEGEND_SWATCH_GAP, ly, LEGEND_SIZE);
    lx += w + LEGEND_GAP;
  }
  const naturalHeight = ly + legendLine;

  // scale to fit, then onto the page
  const scale = Math.min(1, PDF_CONTENT_WIDTH / naturalWidth, PDF_HEIGHT_BUDGET / naturalHeight);
  const px = (v: number) => PAGE_LEFT + v * scale;
  const py = (v: number) => PAGE_TOP + v * scale;
  return {
    left: PAGE_LEFT, top: PAGE_TOP, width: naturalWidth * scale, height: naturalHeight * scale,
    scale,
    texts: texts.map((t) => ({ ...t, x: px(t.x), y: py(t.y), width: t.width * scale,
      size: t.size * scale, charSpace: t.charSpace * scale })),
    boxes: boxes.map((b) => ({ ...b, x: px(b.x), y: py(b.y), w: b.w * scale, h: b.h * scale,
      radius: b.radius * scale, lineWidth: b.lineWidth * scale,
      dash: b.dash && b.dash.map((d) => d * scale) })),
    lines: lines.map((l) => ({ ...l, x1: px(l.x1), y1: py(l.y1), x2: px(l.x2), y2: py(l.y2),
      lineWidth: l.lineWidth * scale })),
    frames: frames.map((f) => ({ x: px(f.x), y: py(f.y), width: f.width * scale,
      height: f.height * scale })),
  };
}

/* ── SVG prep ──────────────────────────────────────────────── */

/** A copy of a live elevation SVG that svg2pdf can draw like the print
 *  sheet does: svg2pdf never sees app CSS, so the shared rack line-work
 *  styles go on as presentation attributes. */
export function prepareSvgForPdf(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  for (const [cls, props] of Object.entries(RACK_LINE_WORK)) {
    clone.querySelectorAll(`.${cls}`).forEach((el) => {
      for (const [name, value] of Object.entries(props)) el.setAttribute(name, value);
    });
  }
  // svg2pdf 2.8.1 reads alignment-baseline but ignores dominant-baseline,
  // which is what centers the U numbers and faceplate labels.
  clone.querySelectorAll('[dominant-baseline]').forEach((el) => {
    el.setAttribute('alignment-baseline', el.getAttribute('dominant-baseline') as string);
  });
  // the print sheet's SVG text inherits the body's monospace stack
  clone.setAttribute('font-family', 'ui-monospace, Menlo, Consolas, monospace');
  return clone;
}

function viewBoxSize(svg: SVGSVGElement): { width: number; height: number } {
  const [, , width, height] = (svg.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number);
  if (!(width > 0 && height > 0)) throw new Error('rack SVG has no usable viewBox');
  return { width, height };
}

/* ── export ────────────────────────────────────────────────── */

export interface RackPdfInput {
  moveName: string; rackName: string; sideLabel: string;
  frames: { heading: string; svg: SVGSVGElement }[];
  listRows: DeviceListRow[]; grouped: boolean; legend: LegendCategory[];
}

/** Builds the one-page rack sheet as a jsPDF document (not saved). */
export async function buildRackPdf(input: RackPdfInput): Promise<jsPDF> {
  const [{ jsPDF: JsPdf }] = await Promise.all([import('jspdf'), import('svg2pdf.js')]);
  const title = `Rack ${input.rackName} — ${input.sideLabel}`;
  const layout = rackPdfLayout({
    title,
    frames: input.frames.map((f) => ({ heading: f.heading, ...viewBoxSize(f.svg) })),
    listRows: input.listRows, grouped: input.grouped, legend: input.legend,
  });
  const doc = new JsPdf({ unit: 'pt', format: 'letter' });
  doc.setProperties({ title });
  for (const b of layout.boxes) {
    doc.setFillColor(b.fill);
    doc.setDrawColor(b.stroke);
    doc.setLineWidth(b.lineWidth);
    doc.setLineDashPattern(b.dash ?? [], 0);
    doc.roundedRect(b.x, b.y, b.w, b.h, b.radius, b.radius, 'FD');
  }
  doc.setLineDashPattern([], 0);
  for (const l of layout.lines) {
    doc.setDrawColor(l.color);
    doc.setLineWidth(l.lineWidth);
    doc.line(l.x1, l.y1, l.x2, l.y2);
  }
  for (const t of layout.texts) {
    doc.setFont('courier', t.bold ? 'bold' : 'normal');
    doc.setFontSize(t.size);
    doc.setTextColor(t.color);
    doc.text(t.text, t.x, t.y, { charSpace: t.charSpace || undefined });
  }
  for (let i = 0; i < input.frames.length; i++) {
    await doc.svg(prepareSvgForPdf(input.frames[i].svg), layout.frames[i]);
  }
  return doc;
}

/** Builds the sheet and downloads it as `rackPdfFileName(...)`. */
export async function exportRackPdf(input: RackPdfInput): Promise<void> {
  const doc = await buildRackPdf(input);
  doc.save(rackPdfFileName(input.moveName, input.rackName, input.sideLabel));
}
