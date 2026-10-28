/**
 * The Gantt view's split: the Splitter between the task sheet and the
 * chart, and SidePane, the sideways scroll each pane has of its own.
 *
 * The scroll design (Review Focus 5). One box scrolls up and down: PlanTab's
 * `.pln-panes` (`scrollRef`), which the sheet's and the chart's
 * virtualizers both read, so rows and lanes move as one and a collapsed
 * summary leaves both. Inside it the panes sit side by side in a grid
 * (sheet | splitter | chart), each as tall as all the rows, each header
 * sticky at the top of that one box.
 *
 * Neither pane is a scroll box of its own. One between a sticky header and
 * `.pln-panes` would catch the header (it would stick to the pane, not to
 * the view), and its sideways scrollbar would sit under the last row, a
 * 1,500-task plan's 45,000 px down. So each pane clips sideways
 * (`overflow-x: clip`, which makes no scroll box) and moves its content with
 * a transform, and its scrollbar is a thin native scroller (`.pln-hbar`)
 * held at the bottom of the view (`position: sticky`) around an empty spacer
 * as wide as the content. That scrollbar's scrollLeft IS the pane's sideways
 * scroll: dragging it, a sideways trackpad swipe or Shift+wheel over the
 * pane, or code (`scrollTo`) moves it, and its scroll event moves that
 * pane's content and nothing else. The other pane never moves.
 *
 * The chart draws only a window of its scale (lib/plans/ganttView); it
 * passes the window's left edge as `origin`, so the content (drawn from
 * there) moves by `origin - scrollLeft`.
 *
 * That is the Beside layout (PlanTab's Gantt › Beside, the default). Below
 * (Gantt › Below, for narrower screens) stacks the panes instead: the sheet
 * on top at full width, a horizontal Splitter, the chart under it at full
 * width. Side by side, one box can scroll both; stacked, each pane needs a
 * vertical scroll box of its own, so Below has two `.pln-panes`, one per
 * pane, each virtualizer reading its own. Everything above holds inside
 * each: its header sticks to the top of its box, its scrollbar to the
 * bottom, and both virtualize with the same settings (the header's
 * `scrollMargin` included), so the same scrollTop shows the same rows. PlanTab
 * keeps the two at the same scrollTop both ways (`useLevelScroll`): a
 * scroll of either writes the other, and the scroll event that write
 * causes is known by its value and not written back, so neither chases the
 * other. They must also scroll the same distance, or the last rows of the
 * one with the shorter view would be out of the other's reach: the pane
 * with the taller view gets the difference as room at its end
 * (SidePane's `endPad`, ganttView `endPads`). Hidden has no chart at all:
 * the sheet alone fills the one box.
 */
import {
  useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState,
  type KeyboardEvent, type PointerEvent, type ReactNode, type Ref, type RefObject,
} from 'react';

/** px a wheel "line" scrolls (Firefox reports wheels in lines). */
const LINE_PX = 16;
/** The Ctrl+wheel travel (px) that zooms one step: one wheel notch, or a
 *  short trackpad pinch. */
const ZOOM_WHEEL_PX = 50;

export interface SidePaneHandle {
  /** The pane's visible width, px. */
  width(): number;
  /** Scrolls the pane sideways to `x` (its scrollbar clamps it). */
  scrollTo(x: number): void;
}

interface SidePaneProps {
  className: string;
  /** The content's full width, the scrollbar's range; measured from the
   *  content when absent. */
  contentWidth?: number;
  /** Where the content's own left edge sits on the scrolled axis (the chart
   *  draws a window of its scale starting here); 0 by default. */
  origin?: number;
  /** Each sideways scroll, with the new scroll x. */
  onScrollX?(x: number): void;
  /** The pane's visible width, when it changes. */
  onWidth?(px: number): void;
  /** Ctrl+wheel over the pane: -1 to zoom in (wheel up), 1 out. */
  onZoomStep?(dir: -1 | 1): void;
  /** Receives the pane's scrollbar (its scrollLeft is the pane's scroll). */
  barRef?: RefObject<HTMLDivElement>;
  handleRef?: Ref<SidePaneHandle>;
  /** Room (px) after the content, inside the pane so its scrollbar still
   *  holds to the bottom of the view: Below's scrollers scroll as far as
   *  each other with it. */
  endPad?: number;
  children: ReactNode;
}

export function SidePane({
  className, contentWidth, origin = 0, onScrollX, onWidth, onZoomStep, barRef, handleRef, endPad = 0, children,
}: SidePaneProps) {
  const paneRef = useRef<HTMLDivElement>(null);
  const shiftRef = useRef<HTMLDivElement>(null);
  const ownBar = useRef<HTMLDivElement>(null);
  const bar = barRef ?? ownBar;
  const [measured, setMeasured] = useState(0);

  const latest = useRef({ origin, onScrollX, onWidth, onZoomStep });
  useLayoutEffect(() => {
    latest.current = { origin, onScrollX, onWidth, onZoomStep };
  });

  // the content follows the scrollbar: moved by a transform, no scroll box
  const place = useCallback(() => {
    const b = bar.current;
    const shift = shiftRef.current;
    if (b && shift) shift.style.transform = `translateX(${latest.current.origin - b.scrollLeft}px)`;
  }, [bar]);
  const sync = useCallback(() => {
    place();
    const b = bar.current;
    if (b) latest.current.onScrollX?.(b.scrollLeft);
  }, [bar, place]);
  useLayoutEffect(place, [origin, place]);

  useImperativeHandle(handleRef, () => ({
    width: () => paneRef.current?.clientWidth ?? 0,
    scrollTo: (x: number) => {
      const b = bar.current;
      if (!b) return;
      b.scrollLeft = Math.max(0, x);
      sync();
    },
  }), [bar, sync]);

  // the pane's width, and (for the sheet) the content's
  const measuring = contentWidth === undefined;
  useLayoutEffect(() => {
    const pane = paneRef.current;
    const shift = shiftRef.current;
    if (!pane || !shift) return undefined;
    const measure = () => {
      latest.current.onWidth?.(pane.clientWidth);
      if (measuring) {
        const child = shift.firstElementChild as HTMLElement | null;
        setMeasured(Math.max(shift.scrollWidth, child?.offsetWidth ?? 0));
      }
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(pane);
    observer.observe(shift);
    if (shift.firstElementChild) observer.observe(shift.firstElementChild);
    return () => observer.disconnect();
  }, [measuring]);

  // a sideways wheel (a trackpad swipe, Shift+wheel) over the pane scrolls
  // this pane alone; up and down is left to the shared box; Ctrl+wheel zooms
  // where the pane zooms. Not passive: the browser must not also go back a
  // page on a sideways swipe, nor zoom the page on Ctrl+wheel.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return undefined;
    let zoomTravel = 0;
    const onWheel = (e: WheelEvent) => {
      const unit = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? pane.clientWidth : 1;
      const zoom = latest.current.onZoomStep;
      if (e.ctrlKey && zoom) {
        e.preventDefault();
        const dy = e.deltaY * unit;
        zoomTravel = Math.sign(zoomTravel) === Math.sign(dy) ? zoomTravel + dy : dy;
        if (Math.abs(zoomTravel) >= ZOOM_WHEEL_PX) {
          zoom(zoomTravel < 0 ? -1 : 1);
          zoomTravel = 0;
        }
        return;
      }
      // mostly sideways, or Shift+wheel (where the browser hasn't already
      // turned it sideways); a vertical swipe's drift stays the browser's
      let sideways = 0;
      if (Math.abs(e.deltaX) > Math.abs(e.deltaY)) sideways = e.deltaX;
      else if (e.shiftKey && e.deltaX === 0) sideways = e.deltaY;
      const b = bar.current;
      if (!sideways || !b || b.scrollWidth <= b.clientWidth) return;
      e.preventDefault();
      b.scrollLeft += sideways * unit;
      sync();
    };
    pane.addEventListener('wheel', onWheel, { passive: false });
    return () => pane.removeEventListener('wheel', onWheel);
  }, [bar, sync]);

  const span = Math.max(0, Math.round(contentWidth ?? measured));
  return (
    <div className={`pln-pane ${className}`} ref={paneRef}>
      <div className="pln-pane-shift" ref={shiftRef}
           style={endPad > 0 ? { paddingBottom: Math.round(endPad) } : undefined}>{children}</div>
      {/* the pane's sideways scrollbar; the keyboard scrolls the sheet through its cells */}
      <div className="pln-hbar" ref={bar} onScroll={sync} tabIndex={-1} aria-hidden="true">
        <div className="pln-hbar-span" style={{ width: span }} />
      </div>
    </div>
  );
}

/** px the arrow keys move the splitter (Shift: four times as far). */
const KEY_STEP_PX = 16;

/**
 * The bar between the sheet and the chart: drag it, or focus it and use
 * ←/→ (Shift for bigger steps), Home and End. `onChange` follows the drag;
 * `onCommit` gets where it ends (a cancelled drag goes back where it began).
 * `value` is the sheet's width; with `orientation="horizontal"` (Below: the
 * bar lies across the view, the sheet above it) it is the sheet's height,
 * and ↑/↓ and the pointer's y move it.
 */
export default function Splitter({ value, min, max, label, orientation = 'vertical', onChange, onCommit }: {
  value: number;
  min: number;
  max: number;
  label: string;
  /** The bar's own direction: vertical between side-by-side panes, horizontal between stacked ones. */
  orientation?: 'vertical' | 'horizontal';
  onChange(px: number): void;
  onCommit(px: number): void;
}) {
  const across = orientation === 'horizontal';
  /** The pointer along the axis the bar moves on. */
  const at = (e: PointerEvent<HTMLDivElement>) => (across ? e.clientY : e.clientX);
  const drag = useRef<{ from: number; start: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const clamp = (px: number) => Math.min(Math.max(Math.round(px), min), Math.max(min, max));

  const end = (px: number | null) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    setDragging(false);
    if (px === null) {
      onChange(d.start);
      return;
    }
    onChange(px);
    onCommit(px);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = (e.shiftKey ? 4 : 1) * KEY_STEP_PX;
    let next: number;
    if (e.key === (across ? 'ArrowDown' : 'ArrowRight')) next = value + step;
    else if (e.key === (across ? 'ArrowUp' : 'ArrowLeft')) next = value - step;
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else return;
    e.preventDefault();
    const px = clamp(next);
    onChange(px);
    onCommit(px);
  };

  return (
    <div role="separator" aria-orientation={orientation} aria-label={label} aria-valuenow={value}
         aria-valuetext={`Sheet ${value} pixels ${across ? 'tall' : 'wide'}`} aria-valuemin={min}
         aria-valuemax={Math.max(min, max)}
         tabIndex={0}
         className={`pln-splitter${dragging ? ' on' : ''}`}
         onPointerDown={(e: PointerEvent<HTMLDivElement>) => {
           if (e.button !== 0) return;
           e.preventDefault();
           try {
             e.currentTarget.setPointerCapture(e.pointerId);
           } catch {
             // no capture (an inactive pointer id): moves over the bar still drag it
           }
           drag.current = { from: at(e), start: value };
           setDragging(true);
         }}
         onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
           const d = drag.current;
           if (d) onChange(clamp(d.start + at(e) - d.from));
         }}
         onPointerUp={(e: PointerEvent<HTMLDivElement>) => {
           const d = drag.current;
           if (d) end(clamp(d.start + at(e) - d.from));
         }}
         onPointerCancel={() => end(null)}
         // the capture went away without a pointerup: the drag ends where it began
         onLostPointerCapture={() => end(null)}
         onKeyDown={onKeyDown} />
  );
}
