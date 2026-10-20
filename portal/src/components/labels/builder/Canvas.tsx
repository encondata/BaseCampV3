/**
 * The label builder's canvas (spec §4.5): the toolbar over a stage that
 * shows the label as an SVG in printer dots at the DPI being viewed,
 * `zoom` screen pixels a dot, with rulers in dots, a grid and snap.
 *
 * It is controlled: the page holds the design, the selection and the view,
 * and gets every edit through `onChange`. A drag, a resize or a held arrow
 * key streams designs between `onGesture('begin')` and `onGesture('end')`,
 * so the page's history (labels/builder/history.ts) records each as one
 * step. The canvas adds no geometry of its own: it composes the builder
 * core (geometry, align, model, metrics) through canvasActions.ts.
 *
 * Pointer: click selects, ⇧-click adds or removes, a drag on empty space
 * draws a marquee (⇧ adds), dragging moves the selection (⇧ locks the axis,
 * ⌥ moves a copy), the eight handles resize one unlocked element (⇧ keeps
 * its proportions), Space-drag or the wheel pans, ⌘-wheel zooms about the
 * pointer. With Snap on a move goes in grid steps, else in whole dots.
 * One press at a time, from the primary pointer; a pointercancel ends the
 * gesture without selecting, and unmounting closes any gesture still open.
 * Pointer positions stay in exact inches; everything drawn is in whole
 * dots as the compiler rounds them (CanvasElement).
 * Keyboard (useBuilderShortcuts): tools, arrows (⇧ ten dots, ⌥ to resize),
 * Tab, ⌘A, Delete, ⌘D, stacking, ⌘L, the align keys, zoom and the view
 * toggles. Undo, the clipboard, Format and Workflow keys are the page's.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

import type { FontWeight } from '../../../labels/builder/fonts';
import {
  clampToLabel, hitTest, marqueeSelect, resize, snap, type Handle, type Point, type Rect, type ResizeContext,
} from '../../../labels/builder/geometry';
import type { LoadedFont } from '../../../labels/builder/metrics';
import {
  addElement, elementHidden, elementValue, replaceElements, type DesignV2, type ElementV2,
} from '../../../labels/builder/model';
import { detectPlatform, type Platform } from '../../../labels/builder/shortcuts';
import { toDots } from '../../../labels/builder/units';
import '../../../styles/directory.css';
import '../../../styles/labelBuilder.css';
import {
  alignSelection, arrangeSelection, canAlign, clampZoom, DEFAULT_FONT, DEFAULT_GRID_IN, deleteSelection,
  duplicateSelection, fitZoom, moveSelection, newElement, resizeSelection, selected, stepSelection, stepZoom,
  toggleLock, type AlignOp, type CanvasTool, type CanvasView, type Zoom,
} from './canvasActions';
import CanvasElement, { dotFootprint, kindOf } from './CanvasElement';
import CanvasToolbar from './CanvasToolbar';
import Rulers, { RULER_PX } from './Rulers';
import {
  isKeyboardControl, isTypingTarget, ownsKeys, useBuilderShortcuts, type ShortcutHandlers,
} from './useBuilderShortcuts';

export { DEFAULT_GRID_IN, DEFAULT_VIEW } from './canvasActions';
export type { AlignOp, CanvasTool, CanvasView, Zoom } from './canvasActions';

/** A family and weight's loaded font (metrics.ts loadFont), or null while it
 *  loads; the page caches them. */
export type MetricsFor = (family: string, weight: FontWeight) => LoadedFont | null;

export interface CanvasProps {
  design: DesignV2;
  /** The DPI being viewed: dots, rulers, barcode modules and QR steps. */
  dpi: number;
  view: CanvasView;
  onView: (view: CanvasView) => void;
  /** The template's sample values, by field key. */
  samples: Readonly<Record<string, string>>;
  /** Selected element ids, in the order they were picked. */
  selection: readonly string[];
  onSelect: (ids: string[]) => void;
  /** A new design; within a gesture, one per pointer move. */
  onChange: (design: DesignV2) => void;
  /** Brackets a drag, resize or held arrow (history begin/endGesture). */
  onGesture: (phase: 'begin' | 'end') => void;
  metricsFor: MetricsFor;
  /** A field key's display name, for Field names (default: the key). */
  fieldName?: (key: string) => string;
  /** The grid's spacing in inches (default 0.05). */
  gridIn?: number;
  /** An old version opened to look at: select, zoom and pan only. */
  readOnly?: boolean;
  /** Listen to the keyboard (default true). */
  keyboard?: boolean;
  platform?: Platform;
}

const HANDLES: [Handle, number, number][] = [
  ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0], ['e', 1, 0.5],
  ['se', 1, 1], ['s', 0.5, 1], ['sw', 0, 1], ['w', 0, 0.5],
];
const HANDLE_PX = 8;
/** How far a pointer may travel before a press becomes a drag. */
const DRAG_PX = 3;
/** How near a pointer must come to a hairline to hit it. */
const HIT_PX = 4;
/** The space round the label before the stage is measured. */
const MARGIN_PX = 24;

/** One pointer's press, from pointerdown to pointerup or pointercancel;
 *  every other pointer is ignored meanwhile. */
type Drag = { pointerId: number } & (
  | { kind: 'move'; start: Point; client: Point; base: DesignV2; ids: string[]; began: boolean;
      copy: boolean; frozen: boolean; clickSelect: string[] | null; last: string; shown: DesignV2 }
  | { kind: 'resize'; start: Point; client: Point; base: DesignV2; id: string; handle: Handle; began: boolean; last: string }
  | { kind: 'marquee'; start: Point; client: Point; additive: boolean; prior: string[]; began: boolean }
  | { kind: 'pan'; client: Point; pan: Point });

function fontOf(el: ElementV2) {
  return el.type === 'text' || el.type === 'field' ? el.font ?? DEFAULT_FONT : null;
}

/** What an element shows in Field names: a field's (or Split piece's) name,
 *  static text, a barcode's or QR code's static data. */
function nameOf(el: ElementV2, design: DesignV2, fieldName: (key: string) => string): string {
  switch (el.type) {
    case 'field': {
      if (el.piece == null) return fieldName(el.field);
      const split = design.splits && Object.hasOwn(design.splits, el.field) ? design.splits[el.field] : undefined;
      return split?.pieces[el.piece] ?? `${fieldName(el.field)} › ${el.piece + 1}`;
    }
    case 'text': return el.content;
    case 'barcode':
    case 'qr': return el.field != null ? fieldName(el.field) : el.data ?? '';
    default: return '';
  }
}

function inches(v: number): string {
  return String(Math.round(v * 1000) / 1000);
}

const identity = (key: string) => key;

export default function Canvas({
  design, dpi, view, onView, samples, selection, onSelect, onChange, onGesture, metricsFor,
  fieldName = identity, gridIn = DEFAULT_GRID_IN, readOnly = false, keyboard = true, platform,
}: CanvasProps) {
  const os = useMemo(() => platform ?? detectPlatform(), [platform]);
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const stageRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<Drag | null>(null);
  const keyGesture = useRef(false);
  const spaceHeld = useRef(false);

  const [tool, setTool] = useState<CanvasTool>('select');
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [stage, setStage] = useState({ w: 0, h: 0 });
  const [marquee, setMarquee] = useState<Rect | null>(null);
  const [cursor, setCursor] = useState<Point | null>(null);
  const [space, setSpace] = useState(false);
  const [panning, setPanning] = useState(false);

  // ---- view geometry -------------------------------------------------------
  // the paper the printer sets (^PW, ^LL), in whole dots
  const label = { w: toDots(design.size.w, dpi), h: toDots(design.size.h, dpi) };
  const ruler = view.rulers ? RULER_PX : 0;
  const avail = { w: stage.w - ruler, h: stage.h - ruler };
  const zoom = view.zoom === 'fit' ? fitZoom(label, avail) : view.zoom;
  const px = 1 / zoom;
  const baseFor = (z: number): Point => ({
    x: stage.w > 0 ? ruler + (avail.w - label.w * z) / 2 : ruler + MARGIN_PX,
    y: stage.h > 0 ? ruler + (avail.h - label.h * z) / 2 : ruler + MARGIN_PX,
  });
  const origin = { x: baseFor(zoom).x + pan.x, y: baseFor(zoom).y + pan.y };

  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const measure = () => setStage((s) => (s.w === el.clientWidth && s.h === el.clientHeight
      ? s : { w: el.clientWidth, h: el.clientHeight }));
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // the latest props and derived values, for listeners bound once
  const live = useRef({ design, selection, onChange, onGesture, onView, view, zoom, origin, label, avail, stage, ruler });
  live.current = { design, selection, onChange, onGesture, onView, view, zoom, origin, label, avail, stage, ruler };

  /** Sets the zoom; with an anchor (stage pixels) the dot under it stays put. */
  const setZoom = useCallback((next: Zoom, anchor?: Point) => {
    const l = live.current;
    if (next === 'fit') {
      setPan({ x: 0, y: 0 });
      l.view = { ...l.view, zoom: 'fit' };
      l.onView(l.view);
      return;
    }
    const z = clampZoom(next);
    const at = anchor ?? { x: l.stage.w / 2, y: l.stage.h / 2 };
    const dot = { x: (at.x - l.origin.x) / l.zoom, y: (at.y - l.origin.y) / l.zoom };
    const base = {
      x: l.stage.w > 0 ? l.ruler + (l.avail.w - l.label.w * z) / 2 : l.ruler + MARGIN_PX,
      y: l.stage.h > 0 ? l.ruler + (l.avail.h - l.label.h * z) / 2 : l.ruler + MARGIN_PX,
    };
    const nextPan = next === 1 && !anchor ? { x: 0, y: 0 } : { x: at.x - dot.x * z - base.x, y: at.y - dot.y * z - base.y };
    setPan(nextPan);
    // wheel events can come faster than renders: the next one builds on this
    l.zoom = z;
    l.origin = { x: base.x + nextPan.x, y: base.y + nextPan.y };
    l.view = { ...l.view, zoom: z };
    l.onView(l.view);
  }, []);

  // ---- wheel: pan, or zoom with ⌘ / Ctrl (a trackpad pinch) ------------------
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return undefined;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
      if (e.metaKey || e.ctrlKey) {
        const r = el.getBoundingClientRect();
        setZoom(live.current.zoom * Math.exp(-e.deltaY * scale * 0.002), { x: e.clientX - r.left, y: e.clientY - r.top });
        return;
      }
      const sideways = e.shiftKey && e.deltaX === 0;
      const dx = (sideways ? e.deltaY : e.deltaX) * scale;
      const dy = (sideways ? 0 : e.deltaY) * scale;
      setPan((p) => ({ x: p.x - dx, y: p.y - dy }));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [setZoom]);

  // ---- keyboard gestures: a held arrow is one undo step ------------------------
  const endKeyGesture = useCallback(() => {
    if (!keyGesture.current) return;
    keyGesture.current = false;
    live.current.onGesture('end');
  }, []);

  /** Emits a keyboard edit, opening the key gesture on the first one. */
  const keyEdit = (next: DesignV2): boolean | void => {
    if (next === live.current.design) return false;
    if (!keyGesture.current) {
      keyGesture.current = true;
      onGesture('begin');
    }
    live.current.design = next;
    onChange(next);
  };

  useEffect(() => {
    if (!keyboard) return undefined;
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key.startsWith('Arrow')) endKeyGesture();
      if (e.code === 'Space' || e.key === ' ') {
        spaceHeld.current = false;
        setSpace(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.code === 'Space' || e.key === ' ') && !e.metaKey && !e.ctrlKey
        && !isTypingTarget(e.target) && !isKeyboardControl(e.target) && !ownsKeys(e.target)) {
        e.preventDefault();
        if (!spaceHeld.current) {
          spaceHeld.current = true;
          setSpace(true);
        }
      }
    };
    const onBlur = () => {
      endKeyGesture();
      spaceHeld.current = false;
      setSpace(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keyup', onKeyUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('keyup', onKeyUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [keyboard, endKeyGesture]);

  // ---- editing helpers ------------------------------------------------------------
  const resizeCtx = (keepRatio = false): ResizeContext => ({
    dpi,
    metricsFor: (el) => {
      const f = fontOf(el);
      return f ? metricsFor(f.family, f.weight)?.metrics : null;
    },
    valueFor: (el) => elementValue(el, samples),
    keepRatio,
  });

  const step = view.snap ? gridIn : 1 / dpi;

  const runAlign = (op: AlignOp): boolean | void => {
    if (readOnly || !canAlign(op, selection.length)) return false;
    const next = alignSelection(design, selection, op, resizeCtx());
    if (next !== design) onChange(next);
  };

  const nudge = (dxDots: number, dyDots: number) => (): boolean | void => {
    if (readOnly || !selection.length) return false;
    // at the label's edge the key is still the canvas's, so it never scrolls
    keyEdit(moveSelection(live.current.design, selection, dxDots / dpi, dyDots / dpi));
  };

  const sizeBy = (handle: Handle, dxDots: number, dyDots: number) => (): boolean | void => {
    if (readOnly || !selection.length) return false;
    keyEdit(resizeSelection(live.current.design, selection, handle, dxDots / dpi, dyDots / dpi, resizeCtx()));
  };

  const edit = (next: DesignV2): boolean | void => {
    if (readOnly || next === design) return false;
    onChange(next);
  };

  const place = (t: Exclude<CanvasTool, 'select'>, at: Point) => {
    const metrics = metricsFor(DEFAULT_FONT.family, DEFAULT_FONT.weight)?.metrics ?? null;
    const fresh = clampToLabel(newElement(t, { x: snap(at.x, step), y: snap(at.y, step) }, metrics), design.size);
    const next = addElement(design, fresh);
    onChange(next);
    onSelect([next.elements[next.elements.length - 1].id]);
  };

  const pickTool = (t: CanvasTool) => (): boolean | void => {
    if (readOnly && t !== 'select') return false;
    setTool(t);
  };

  const toggleView = (key: 'grid' | 'snap' | 'rulers' | 'showSamples') => () => onView({ ...view, [key]: !view[key] });

  const handlers: ShortcutHandlers = {
    'tool.select': pickTool('select'),
    'tool.text': pickTool('text'),
    'tool.barcode': pickTool('barcode'),
    'tool.qr': pickTool('qr'),
    'tool.box': pickTool('box'),
    'tool.line': pickTool('line'),
    'tool.escape': () => {
      if (tool !== 'select') setTool('select');
      else if (selection.length) onSelect([]);
      else return false;
      return undefined;
    },
    'move.left': nudge(-1, 0),
    'move.right': nudge(1, 0),
    'move.up': nudge(0, -1),
    'move.down': nudge(0, 1),
    'move.left10': nudge(-10, 0),
    'move.right10': nudge(10, 0),
    'move.up10': nudge(0, -10),
    'move.down10': nudge(0, 10),
    'size.wider': sizeBy('e', 1, 0),
    'size.narrower': sizeBy('e', -1, 0),
    'size.taller': sizeBy('s', 0, 1),
    'size.shorter': sizeBy('s', 0, -1),
    'size.wider10': sizeBy('e', 10, 0),
    'size.narrower10': sizeBy('e', -10, 0),
    'size.taller10': sizeBy('s', 0, 10),
    'size.shorter10': sizeBy('s', 0, -10),
    'select.all': () => {
      if (!design.elements.length) return false;
      onSelect(design.elements.map((e) => e.id));
      return undefined;
    },
    'select.next': () => {
      if (!design.elements.length) return false;
      onSelect(stepSelection(design, selection, 1));
      return undefined;
    },
    'select.previous': () => {
      if (!design.elements.length) return false;
      onSelect(stepSelection(design, selection, -1));
      return undefined;
    },
    'edit.delete': () => {
      if (readOnly || !selection.length) return false;
      const next = deleteSelection(design, selection);
      if (next !== design) onChange(next);
      onSelect(selection.filter((id) => next.elements.some((e) => e.id === id)));
      return undefined;
    },
    'edit.duplicate': () => {
      if (readOnly || !selection.length) return false;
      const copied = duplicateSelection(design, selection);
      onChange(copied.design);
      onSelect(copied.ids);
      return undefined;
    },
    'arrange.back': () => edit(arrangeSelection(design, selection, 'back')),
    'arrange.forward': () => edit(arrangeSelection(design, selection, 'forward')),
    'arrange.toBack': () => edit(arrangeSelection(design, selection, 'toBack')),
    'arrange.toFront': () => edit(arrangeSelection(design, selection, 'toFront')),
    'edit.lock': () => edit(toggleLock(design, selection)),
    'align.left': () => runAlign('left'),
    'align.right': () => runAlign('right'),
    'align.top': () => runAlign('top'),
    'align.bottom': () => runAlign('bottom'),
    'align.center': () => runAlign('center'),
    'align.middle': () => runAlign('middle'),
    'align.distributeH': () => runAlign('distributeH'),
    'align.distributeV': () => runAlign('distributeV'),
    'canvas.zoomIn': () => setZoom(stepZoom(zoom, 'in')),
    'canvas.zoomOut': () => setZoom(stepZoom(zoom, 'out')),
    'canvas.fit': () => setZoom('fit'),
    'canvas.trueSize': () => setZoom(1),
    'canvas.grid': toggleView('grid'),
    'canvas.snap': toggleView('snap'),
    'canvas.rulers': toggleView('rulers'),
    'canvas.samples': toggleView('showSamples'),
  };
  useBuilderShortcuts(handlers, { enabled: keyboard, platform: os });

  // ---- pointer ----------------------------------------------------------------------
  const toLabel = (e: { clientX: number; clientY: number }): Point => {
    const r = svgRef.current?.getBoundingClientRect();
    return { x: (e.clientX - (r?.left ?? 0)) / zoom / dpi, y: (e.clientY - (r?.top ?? 0)) / zoom / dpi };
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    // one press at a time, from the primary pointer (a second finger or pen waits)
    if (!e.isPrimary || drag.current || (e.button !== 0 && e.button !== 1)) return;
    endKeyGesture();
    stageRef.current?.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const { pointerId } = e;
    const client = { x: e.clientX, y: e.clientY };
    if (spaceHeld.current || e.button === 1) {
      e.preventDefault();
      drag.current = { pointerId, kind: 'pan', client, pan };
      setPanning(true);
      return;
    }
    const p = toLabel(e);
    if (tool !== 'select') {
      if (!readOnly) place(tool, p);
      setTool('select');
      drag.current = null;
      return;
    }
    const handle = (e.target as Element).closest?.('[data-handle]')?.getAttribute('data-handle') as Handle | null;
    const only = selection.length === 1 ? design.elements.find((x) => x.id === selection[0]) : undefined;
    if (handle && only && !only.locked && !readOnly) {
      drag.current = { pointerId, kind: 'resize', start: p, client, base: design, id: only.id, handle, began: false, last: '' };
      return;
    }
    const hit = hitTest(design.elements, p, HIT_PX / zoom / dpi);
    if (hit) {
      let ids = [...selection];
      let clickSelect: string[] | null = null;
      if (e.shiftKey) {
        if (selection.includes(hit)) {
          clickSelect = selection.filter((id) => id !== hit);
        } else {
          ids = [...selection, hit];
          onSelect(ids);
        }
      } else if (!selection.includes(hit)) {
        ids = [hit];
        onSelect(ids);
      } else if (selection.length > 1) {
        clickSelect = [hit];
      }
      drag.current = {
        pointerId, kind: 'move', start: p, client, base: design, ids, began: false, copy: e.altKey,
        frozen: readOnly, clickSelect, last: '', shown: design,
      };
      return;
    }
    if (!e.shiftKey && selection.length) onSelect([]);
    drag.current = {
      pointerId, kind: 'marquee', start: p, client, additive: e.shiftKey, prior: e.shiftKey ? [...selection] : [], began: false,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (d ? e.pointerId !== d.pointerId : !e.isPrimary) return;
    const p = toLabel(e);
    setCursor({ x: p.x * dpi, y: p.y * dpi });
    if (!d) return;
    if (d.kind === 'pan') {
      setPan({ x: d.pan.x + e.clientX - d.client.x, y: d.pan.y + e.clientY - d.client.y });
      return;
    }
    const far = Math.hypot(e.clientX - d.client.x, e.clientY - d.client.y) >= DRAG_PX;
    if (d.kind === 'marquee') {
      if (!d.began && !far) return;
      d.began = true;
      setMarquee({ x: d.start.x, y: d.start.y, w: p.x - d.start.x, h: p.y - d.start.y });
      return;
    }
    if (d.kind === 'move' && d.frozen) return;
    if (!d.began) {
      if (!far) return;
      if (d.kind === 'move') {
        // locked elements never move, and ⌥ never copies them
        const movable = selected(d.base, d.ids).filter((x) => !x.locked).map((x) => x.id);
        if (!movable.length) {
          d.frozen = true;
          return;
        }
        d.ids = movable;
      }
      d.began = true;
      onGesture('begin');
      if (d.kind === 'move' && d.copy) {
        const copied = duplicateSelection(d.base, d.ids, 0);
        d.base = copied.design;
        d.shown = copied.design;
        d.ids = copied.ids;
        onChange(copied.design);
        onSelect(copied.ids);
      }
    }
    let dx = p.x - d.start.x;
    let dy = p.y - d.start.y;
    if (d.kind === 'move' && e.shiftKey) {
      if (Math.abs(dx) >= Math.abs(dy)) dy = 0;
      else dx = 0;
    }
    dx = snap(dx, step);
    dy = snap(dy, step);
    const key = `${dx},${dy},${e.shiftKey}`;
    if (key === d.last) return;
    d.last = key;
    if (d.kind === 'move') {
      // a locked selection, or a delta back at zero, gives the base again
      const next = moveSelection(d.base, d.ids, dx, dy);
      if (next !== d.shown) {
        d.shown = next;
        onChange(next);
      }
    } else {
      const el = d.base.elements.find((x) => x.id === d.id);
      if (el) onChange(replaceElements(d.base, [resize(el, d.handle, dx, dy, resizeCtx(e.shiftKey))]));
    }
  };

  /** The press ends: released, or cancelled by the browser (a cancel ends
   *  any gesture but never selects). */
  const finish = (e: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.pointerId) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    switch (d.kind) {
      case 'pan':
        setPanning(false);
        return;
      case 'move':
        if (d.began) onGesture('end');
        else if (d.clickSelect && !cancelled) onSelect(d.clickSelect);
        return;
      case 'resize':
        if (d.began) onGesture('end');
        return;
      case 'marquee': {
        setMarquee(null);
        if (!d.began || cancelled) return;
        const p = toLabel(e);
        const ids = marqueeSelect(design.elements, { x: d.start.x, y: d.start.y, w: p.x - d.start.x, h: p.y - d.start.y });
        onSelect(d.additive ? [...d.prior, ...ids.filter((id) => !d.prior.includes(id))] : ids);
      }
    }
  };

  // leaving mid-gesture still closes it, so every begin has its end
  useEffect(() => () => {
    const d = drag.current;
    drag.current = null;
    if (d && (d.kind === 'move' || d.kind === 'resize') && d.began) live.current.onGesture('end');
    endKeyGesture();
  }, [endKeyGesture]);

  // ---- drawing -----------------------------------------------------------------------
  const byId = new Map(design.elements.map((el) => [el.id, el]));
  const picked = selection.map((id) => byId.get(id)).filter((el): el is ElementV2 => !!el);
  const handleFor = picked.length === 1 && !picked[0].locked && !readOnly ? picked[0] : null;
  const names = !view.showSamples;
  const minor = gridIn * dpi;

  const status = (
    <>
      {`${Math.round(label.w)} × ${Math.round(label.h)} dots · ${inches(design.size.w)} × ${inches(design.size.h)} in · ${dpi} DPI`}
      {cursor && ` · x ${Math.round(cursor.x)} y ${Math.round(cursor.y)}`}
    </>
  );

  const stageCls = ['lbc-stage'];
  if (tool !== 'select') stageCls.push('is-placing');
  if (space) stageCls.push('is-space');
  if (panning) stageCls.push('is-panning');

  return (
    <div className="lbc">
      <CanvasToolbar tool={tool} onTool={setTool} zoom={zoom} onZoom={(z) => setZoom(z)} view={view} onView={onView}
        selectionCount={selection.length} onAlign={(op) => { runAlign(op); }} readOnly={readOnly}
        platform={os} status={status} />
      <div ref={stageRef} className={stageCls.join(' ')} tabIndex={-1} role="application" aria-label="Label canvas"
        onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={(e) => finish(e, false)}
        onPointerCancel={(e) => finish(e, true)} onPointerLeave={() => setCursor(null)}>
        <svg ref={svgRef} className="lbc-label" width={label.w * zoom} height={label.h * zoom}
          viewBox={`0 0 ${label.w} ${label.h}`} style={{ left: origin.x, top: origin.y }}
          overflow="visible" aria-hidden="true">
          <rect className="lbc-paper" x={0} y={0} width={label.w} height={label.h} />
          {view.grid && (
            <g className="lbc-gridlines">
              <defs>
                <pattern id={`${uid}-grid`} patternUnits="userSpaceOnUse" width={minor} height={minor}>
                  <path d={`M${minor} 0H0V${minor}`} fill="none" strokeWidth={px} />
                </pattern>
                <pattern id={`${uid}-grid5`} patternUnits="userSpaceOnUse" width={5 * minor} height={5 * minor}>
                  <path className="lbc-grid-major" d={`M${5 * minor} 0H0V${5 * minor}`} fill="none" strokeWidth={px} />
                </pattern>
              </defs>
              {minor * zoom >= 4 && <rect width={label.w} height={label.h} fill={`url(#${uid}-grid)`} />}
              <rect width={label.w} height={label.h} fill={`url(#${uid}-grid5)`} />
            </g>
          )}
          <g className="lbc-elements">
            {design.elements.map((el, i) => {
              const font = kindOf(el) === 'text' ? (() => {
                const f = fontOf(el) ?? DEFAULT_FONT;
                return metricsFor(f.family, f.weight);
              })() : null;
              const value = elementValue(el, samples);
              return (
                <CanvasElement key={el.id} el={el} dpi={dpi} names={names} px={px} uid={`${uid}-${i}`}
                  text={names ? nameOf(el, design, fieldName) : value}
                  hidden={!names && elementHidden(el, samples)} font={font} qrValue={value} />
              );
            })}
          </g>
          <g className="lbc-overlay">
            {picked.map((el) => {
              const f = dotFootprint(el, dpi);
              return (
                <rect key={el.id} className={`lbc-sel${picked.length > 1 ? ' is-multi' : ''}${el.locked ? ' is-locked' : ''}`}
                  x={f.x} y={f.y} width={Math.max(f.w, px)} height={Math.max(f.h, px)}
                  strokeWidth={1.5 * px} strokeDasharray={picked.length > 1 || el.locked ? `${4 * px} ${3 * px}` : undefined} />
              );
            })}
            {handleFor && (() => {
              const f = dotFootprint(handleFor, dpi);
              const s = HANDLE_PX * px;
              return HANDLES.map(([h, fx, fy]) => (
                <rect key={h} data-handle={h} className="lbc-handle" x={f.x + f.w * fx - s / 2}
                  y={f.y + f.h * fy - s / 2} width={s} height={s} strokeWidth={1.5 * px} />
              ));
            })()}
            {marquee && (
              <rect className="lbc-marquee" x={Math.min(marquee.x, marquee.x + marquee.w) * dpi}
                y={Math.min(marquee.y, marquee.y + marquee.h) * dpi} width={Math.abs(marquee.w) * dpi}
                height={Math.abs(marquee.h) * dpi} strokeWidth={px} />
            )}
          </g>
        </svg>
        {view.rulers && <Rulers zoom={zoom} origin={origin} stage={stage} label={label} cursor={cursor} />}
      </div>
    </div>
  );
}
