/**
 * What the builder canvas does to a design, composed from the builder core
 * (labels/builder: geometry, align, model, metrics): moving a selection,
 * sizing it by a dot, aligning, stepping through elements, the new element
 * each tool places, and the zoom steps. Every function returns a new design
 * (or the same one when nothing changes), so the caller can push it to the
 * history as is.
 */

import { align, distribute, matchSize, type AlignEdge } from '../../../labels/builder/align';
import { DEFAULT_FAMILY, type FontRef } from '../../../labels/builder/fonts';
import { footprint, move, resize, type Handle, type Point, type ResizeContext } from '../../../labels/builder/geometry';
import { IMAGE_SIZES } from '../../../labels/builder/image';
import { textBoxFor, textWidthIn, type FontMetrics } from '../../../labels/builder/metrics';
import {
  duplicate, IMAGE_DEFAULTS, removeElements, reorder, replaceElements, type DesignV2, type ElementV2, type ImageElement,
  type ImageSource, type ReorderMove,
} from '../../../labels/builder/model';

/** `image` is offered on ID badge templates in ZPL only (spec
 *  2026-10-20-badge-templates §4.10). */
export type CanvasTool = 'select' | 'text' | 'barcode' | 'qr' | 'box' | 'line' | 'image';

export type AlignOp = AlignEdge | 'distributeH' | 'distributeV' | 'matchW' | 'matchH';

/** Screen pixels per printer dot, or `fit` to follow the canvas's size. */
export type Zoom = number | 'fit';

/** How the canvas shows the label; the page keeps it (and may remember it). */
export interface CanvasView {
  zoom: Zoom;
  grid: boolean;
  snap: boolean;
  rulers: boolean;
  /** Sample values (the default) or field names. */
  showSamples: boolean;
}

export const DEFAULT_VIEW: CanvasView = { zoom: 'fit', grid: true, snap: true, rulers: true, showSamples: true };

/** The grid, and the step a drag snaps to when Snap is on. */
export const DEFAULT_GRID_IN = 0.05;

export const DEFAULT_FONT: FontRef = { family: DEFAULT_FAMILY, weight: 'regular' };

/** The zoom buttons' and ⌘= / ⌘-'s stops; 1 is true size (a dot a pixel). */
export const ZOOM_STEPS: readonly number[] = [0.1, 0.125, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.5, 2, 3, 4, 6, 8];
export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

/** The next stop in or out from `z`. */
export function stepZoom(z: number, dir: 'in' | 'out'): number {
  if (dir === 'in') return ZOOM_STEPS.find((s) => s > z * 1.001) ?? MAX_ZOOM;
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < z / 1.001) return ZOOM_STEPS[i];
  return MIN_ZOOM;
}

/** The zoom that shows the whole label in `avail` px with a margin all round;
 *  half a pixel a dot until the canvas has been measured. */
export function fitZoom(label: { w: number; h: number }, avail: { w: number; h: number }, margin = 24): number {
  if (avail.w <= 2 * margin || avail.h <= 2 * margin) return 0.5;
  return clampZoom(Math.min((avail.w - 2 * margin) / label.w, (avail.h - 2 * margin) / label.h));
}

/** The selected elements, in selection order. */
export function selected(d: DesignV2, ids: readonly string[]): ElementV2[] {
  const byId = new Map(d.elements.map((e) => [e.id, e]));
  return ids.map((id) => byId.get(id)).filter((e): e is ElementV2 => e !== undefined);
}

/** True when `next` holds the very element objects of `d`, in order. */
export function sameElements(d: DesignV2, next: DesignV2): boolean {
  return d.elements.length === next.elements.length && d.elements.every((e, i) => e === next.elements[i]);
}

function changed(d: DesignV2, els: readonly ElementV2[]): DesignV2 {
  const next = replaceElements(d, els);
  return sameElements(d, next) ? d : next;
}

/** Moves the selection's unlocked elements by (dx, dy) inches together, the
 *  delta held so the group stays on the label (a group already past an edge
 *  is not pulled back). */
export function moveSelection(d: DesignV2, ids: readonly string[], dx: number, dy: number): DesignV2 {
  const moving = selected(d, ids).filter((e) => !e.locked);
  if (!moving.length || (dx === 0 && dy === 0)) return d;
  const fps = moving.map(footprint);
  const left = Math.min(...fps.map((f) => f.x));
  const top = Math.min(...fps.map((f) => f.y));
  const right = Math.max(...fps.map((f) => f.x + f.w));
  const bottom = Math.max(...fps.map((f) => f.y + f.h));
  const cdx = Math.min(Math.max(dx, Math.min(0, -left)), Math.max(0, d.size.w - right));
  const cdy = Math.min(Math.max(dy, Math.min(0, -top)), Math.max(0, d.size.h - bottom));
  if (cdx === 0 && cdy === 0) return d;
  return changed(d, moving.map((e) => move(e, cdx, cdy)));
}

/** Drags `handle` of every unlocked selected element by (dx, dy) inches,
 *  through each type's resize rule. */
export function resizeSelection(d: DesignV2, ids: readonly string[], handle: Handle, dx: number, dy: number,
  ctx: ResizeContext): DesignV2 {
  const sizing = selected(d, ids).filter((e) => !e.locked);
  if (!sizing.length) return d;
  return changed(d, sizing.map((e) => resize(e, handle, dx, dy, ctx)));
}

/** The toolbar's align group over the selection (selection order: Match
 *  size follows the first selected). One element aligns to the label. */
export function alignSelection(d: DesignV2, ids: readonly string[], op: AlignOp, ctx: ResizeContext): DesignV2 {
  const els = selected(d, ids);
  if (!els.length) return d;
  let out: ElementV2[];
  switch (op) {
    case 'distributeH': out = distribute(els, 'h'); break;
    case 'distributeV': out = distribute(els, 'v'); break;
    case 'matchW': out = matchSize(els, 'w', ctx); break;
    case 'matchH': out = matchSize(els, 'h', ctx); break;
    default: out = align(els, op, d.size);
  }
  return changed(d, out);
}

/** Whether `op` can run on a selection of `count` elements. */
export function canAlign(op: AlignOp, count: number): boolean {
  if (op === 'distributeH' || op === 'distributeV') return count >= 3;
  if (op === 'matchW' || op === 'matchH') return count >= 2;
  return count >= 1;
}

/** Tab / ⇧Tab: the element after the selection's last (or before its
 *  first) in stacking order, wrapping round. */
export function stepSelection(d: DesignV2, ids: readonly string[], dir: 1 | -1): string[] {
  const order = d.elements.map((e) => e.id);
  if (!order.length) return [];
  const anchor = ids.length ? order.indexOf(ids[dir > 0 ? ids.length - 1 : 0]) : -1;
  const i = anchor < 0 ? (dir > 0 ? 0 : order.length - 1) : (anchor + dir + order.length) % order.length;
  return [order[i]];
}

/** Removes the selection's unlocked elements. */
export function deleteSelection(d: DesignV2, ids: readonly string[]): DesignV2 {
  const gone = selected(d, ids).filter((e) => !e.locked).map((e) => e.id);
  return gone.length ? removeElements(d, gone) : d;
}

export function duplicateSelection(d: DesignV2, ids: readonly string[], offsetIn?: number):
  { design: DesignV2; ids: string[] } {
  return duplicate(d, ids, offsetIn);
}

export function arrangeSelection(d: DesignV2, ids: readonly string[], to: ReorderMove): DesignV2 {
  if (!ids.length) return d;
  const next = reorder(d, ids, to);
  return sameElements(d, next) ? d : next;
}

/** ⌘L: locks the selection, or unlocks it when every element is locked. */
export function toggleLock(d: DesignV2, ids: readonly string[]): DesignV2 {
  const els = selected(d, ids);
  if (!els.length) return d;
  const locked = !els.every((e) => e.locked);
  return replaceElements(d, els.map((e) => ({ ...e, locked })));
}

const NEW_TEXT = 'Text';
const NEW_SIZE_PT = 12;
const NEW_DATA = '12345678';

/** A new image of `source` with its top-left at `at` (inches): the
 *  source's fit and look (a photo fills its box and is dithered, a logo or
 *  a static picture fits inside it and is thresholded), its box
 *  (image.ts IMAGE_SIZES), the default brightness, contrast and threshold,
 *  and hidden when the person has no picture. A static image has no
 *  picture until one is picked. */
export function newImage(source: ImageSource, at: Point): ImageElement {
  const { fit, mode } = IMAGE_DEFAULTS[source];
  const { w, h } = IMAGE_SIZES[source];
  return {
    id: '', type: 'image', source, x: at.x, y: at.y, w, h, rotation: 0, locked: false,
    fit, mode, brightness: 0, contrast: 100, threshold: 128, invert: false, hideWhenEmpty: true,
  };
}

/** The element a tool places with its top-left at `at` (inches); the id is
 *  left for addElement. New text is one line of its font tall
 *  (metrics.ts textBoxFor) once the default font's metrics are loaded; the
 *  Image tool places a photo. */
export function newElement(tool: Exclude<CanvasTool, 'select'>, at: Point,
  metrics: FontMetrics | null): ElementV2 {
  const base = { id: '', x: at.x, y: at.y, rotation: 0 as const, locked: false };
  switch (tool) {
    case 'text': {
      const box = metrics ? textBoxFor(metrics, NEW_SIZE_PT) : { h: NEW_SIZE_PT / 72, baselineIn: (0.75 * NEW_SIZE_PT) / 72 };
      const w = metrics ? textWidthIn(metrics, NEW_SIZE_PT, NEW_TEXT) : 0.5;
      return {
        ...base, type: 'text', content: NEW_TEXT, font: { ...DEFAULT_FONT }, sizePt: NEW_SIZE_PT,
        w, h: box.h, baselineIn: box.baselineIn, align: 'left', inverted: false, lines: 1,
      };
    }
    case 'barcode':
      return { ...base, type: 'barcode', data: NEW_DATA, symbology: 'code128', moduleIn: 0.01, showText: true, w: 1.2, h: 0.3 };
    case 'qr':
      return { ...base, type: 'qr', data: NEW_DATA, w: 0.5, h: 0.5 };
    case 'box':
      return { ...base, type: 'box', strokeIn: 0.01, fill: false, w: 1, h: 0.5 };
    case 'line':
      return { ...base, type: 'line', strokeIn: 0.01, w: 1, h: 0 };
    case 'image':
      return newImage('photo', at);
  }
}
