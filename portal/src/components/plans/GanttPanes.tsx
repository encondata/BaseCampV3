/**
 * The Gantt view's panes in the layout the person chose (the toolbar's
 * Gantt group, kept per browser in `plans.layout.v1`: it's about the
 * monitor, not the plan):
 *
 *  - Beside (the default): the sheet, the splitter and the chart side by
 *    side in one vertical scroll box (`scrollRef`). The splitter's place is
 *    the sheet's width, kept in `plans.split.v1`.
 *  - Below (narrower screens): the sheet on top at full width in a box of
 *    its own (`scrollRef` still), a horizontal splitter, and the chart under
 *    it at full width in its own box, the two kept on the same row both
 *    ways (`useLevelScroll`) and padded at the end to scroll as far as each
 *    other. The splitter's place is the sheet's height, kept in
 *    `plans.split.below.v1`. The bars carry their tasks' names.
 *  - Hidden: the sheet alone in the one box; the chart isn't mounted.
 *
 * The sheet keeps its place in the tree in all three (`.pln-panes` › `.pln-split`
 * › the sheet's SidePane), so a switch leaves it mounted and its box keeps
 * its scrollTop: the same rows stay on screen and the selection stays. The
 * chart moves between boxes, so it mounts again, at the sheet's row and at
 * the moment the last chart had at its left edge (kept here per plan, as
 * the chart reports each sideways scroll). The scroll design is in
 * Splitter.tsx.
 */
import {
  useCallback, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject,
} from 'react';

import {
  MIN_SHEET_H, MIN_SHEET_PX, endPads, maxSplit, maxSplitHeight, readLayout, readSplit, readSplitBelow, splitHeight,
  splitWidth, writeLayout, writeSplit, writeSplitBelow, type GanttLayout,
} from '../../lib/plans/ganttView';
import Splitter, { SidePane } from './Splitter';

/** The layout kept in this browser, and a setter that keeps the choice. */
export function useGanttLayout(): [GanttLayout, (layout: GanttLayout) => void] {
  const [layout, setLayout] = useState<GanttLayout>(readLayout);
  const choose = useCallback((next: GanttLayout) => {
    setLayout(next);
    writeLayout(next);
  }, []);
  return [layout, choose];
}

/** What the chart is given for the box it sits in. */
export interface ChartSlot {
  /** Its vertical scroll box: the shared one beside the sheet, its own below it. */
  scrollRef: RefObject<HTMLDivElement | null>;
  /** Room after its last lane (Below). */
  endPad: number;
  /** Its bars carry their tasks' names (Below). */
  taskLabels: boolean;
  /** Where its box is scrolled as it mounts: the sheet's place. (Its
   *  virtualizer scrolls the box to where it starts; below the sheet the box
   *  is new and gets its ref only after the chart's first render, so the
   *  chart can't read it from there.) */
  startTop(): number;
  /** The moment (ms) the last chart of this plan had at its left edge, or null. */
  startMoment(planId: string): number | null;
  /** The chart's report of the moment now at its left edge. */
  onLeftMoment(planId: string, ms: number): void;
}

export default function GanttPanes({ layout, on, viewRef, scrollRef, sheetSideRef, sheet, chart }: {
  layout: GanttLayout;
  /** The plan is on screen (the boxes exist). */
  on: boolean;
  /** The view area: Below's split is a share of its height. */
  viewRef: RefObject<HTMLElement | null>;
  /** The sheet's vertical scroll box: the shared one (Beside, Hidden) or its own (Below). */
  scrollRef: RefObject<HTMLDivElement>;
  /** The sheet's sideways scrollbar. */
  sheetSideRef: RefObject<HTMLDivElement>;
  sheet: ReactNode;
  chart(slot: ChartSlot): ReactNode;
}) {
  const beside = layout === 'beside';
  const below = layout === 'below';
  // the chart's own box below the sheet, held in state (a callback ref): the
  // chart is drawn only once the box exists, so its virtualizer has it from
  // its first render, and the box's scroll is kept level from the start
  const [chartBox, setChartBox] = useState<HTMLDivElement | null>(null);
  const chartRef = useMemo(() => ({ current: chartBox }), [chartBox]);
  const split = useSplit(scrollRef, on && beside);
  const stack = useSplitBelow(viewRef, on && below);
  const pads = useLevelScroll(scrollRef, chartBox, on && below);
  const startTop = useCallback(() => scrollRef.current?.scrollTop ?? 0, [scrollRef]);
  // the chart's place in time, kept across its remounts (and Hidden)
  const leftMoment = useRef<{ planId: string; ms: number } | null>(null);
  const startMoment = useCallback((planId: string) => {
    const m = leftMoment.current;
    return m && m.planId === planId ? m.ms : null;
  }, []);
  const onLeftMoment = useCallback((planId: string, ms: number) => {
    leftMoment.current = { planId, ms };
  }, []);
  const slot = { startTop, startMoment, onLeftMoment };

  return (
    <>
      <div className={`pln-panes${below ? ' pln-panes-sheet' : ''}`} ref={scrollRef}
           style={below ? { height: stack.height } : undefined}>
        <div className={`pln-split${beside ? '' : ' pln-solo'}`}
             style={beside ? ({ '--pln-split': `${split.width}px` } as CSSProperties) : undefined}>
          <SidePane className="pln-pane-sheet" barRef={sheetSideRef} endPad={below ? pads.sheet : 0}>
            {sheet}
          </SidePane>
          {beside && (
            <Splitter value={split.width} min={MIN_SHEET_PX} max={split.max} label="Resize the task sheet"
                      onChange={split.move} onCommit={split.save} />
          )}
          {beside && chart({ scrollRef, endPad: 0, taskLabels: false, ...slot })}
        </div>
      </div>
      {below && (
        <Splitter orientation="horizontal" value={stack.height} min={MIN_SHEET_H} max={stack.max}
                  label="Resize the task sheet" onChange={stack.move} onCommit={stack.save} />
      )}
      {below && (
        <div className="pln-panes pln-panes-chart" ref={setChartBox}>
          <div className="pln-split pln-solo">
            {chartBox && chart({ scrollRef: chartRef, endPad: pads.chart, taskLabels: true, ...slot })}
          </div>
        </div>
      )}
    </>
  );
}

/** Beside's splitter: the sheet pane's width in px, within what the view
 *  (`ref`, the scroll box, measured while `on`) leaves the chart. `move`
 *  follows a drag; `save` keeps the place (`plans.split.v1`). */
function useSplit(ref: RefObject<HTMLElement | null>, on: boolean) {
  const [viewW, setViewW] = useState(0);
  const [stored, setStored] = useState<number | null>(readSplit);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return undefined;
    const measure = () => setViewW(el.clientWidth);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, on]);
  const width = splitWidth(stored, viewW);
  const save = useCallback((px: number) => {
    setStored(px);
    writeSplit(px);
  }, []);
  return { width, max: viewW > 0 ? maxSplit(viewW) : Math.max(width, MIN_SHEET_PX), move: setStored, save };
}

/** Below's splitter: the sheet's height in px, within what the view area
 *  (`ref`, measured while `on`) leaves the chart (`plans.split.below.v1`). */
function useSplitBelow(ref: RefObject<HTMLElement | null>, on: boolean) {
  const [viewH, setViewH] = useState(0);
  const [stored, setStored] = useState<number | null>(readSplitBelow);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!on || !el) return undefined;
    const measure = () => setViewH(el.clientHeight);
    measure();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, on]);
  const height = splitHeight(stored, viewH);
  const save = useCallback((px: number) => {
    setStored(px);
    writeSplitBelow(px);
  }, []);
  return { height, max: viewH > 0 ? maxSplitHeight(viewH) : Math.max(height, MIN_SHEET_H), move: setStored, save };
}

/**
 * Below: the sheet's box (`sheetRef`) and the chart's (`chart`) on the
 * same row, both ways. A scroll of either writes the other's scrollTop; the
 * scroll event that write causes comes back with the value written (read
 * back, so a clamp counts) and is let go, so neither box chases the other.
 * A write that changes nothing isn't made, so it leaves no echo to wait
 * for. The chart comes in at the sheet's row. Returns the end pads that
 * let both scroll as far as each other (ganttView `endPads`), measured
 * again as the boxes change size; a change of pads, a box resized and the
 * chart's rows drawn or changed level the chart again (its rows can come a
 * render after the sheet scrolled to a `&task=` link, when its box couldn't
 * take the first write).
 */
function useLevelScroll(sheetRef: RefObject<HTMLElement | null>, chartEl: HTMLElement | null,
  on: boolean): { sheet: number; chart: number } {
  const [heights, setHeights] = useState<readonly [number, number]>([0, 0]);
  const level = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const sheet = sheetRef.current;
    const chart = chartEl;
    if (!on || !sheet || !chart) {
      setHeights((h) => (h[0] || h[1] ? [0, 0] : h));
      return undefined;
    }
    const echoes = new Map<HTMLElement, number>();
    const write = (to: HTMLElement, top: number) => {
      const before = to.scrollTop;
      if (Math.abs(before - top) < 1) return;
      to.scrollTop = top;
      if (to.scrollTop !== before) echoes.set(to, to.scrollTop);
    };
    const follow = (from: HTMLElement, to: HTMLElement) => () => {
      const top = from.scrollTop;
      const echo = echoes.get(from);
      if (echo !== undefined) {
        echoes.delete(from);
        if (Math.abs(top - echo) < 1) return;     // our own write coming back
      }
      write(to, top);
    };
    const onSheet = follow(sheet, chart);
    const onChart = follow(chart, sheet);
    level.current = () => write(chart, sheet.scrollTop);
    const measure = () => setHeights((h) => (h[0] === sheet.clientHeight && h[1] === chart.clientHeight
      ? h : [sheet.clientHeight, chart.clientHeight]));
    measure();
    level.current();
    sheet.addEventListener('scroll', onSheet, { passive: true });
    chart.addEventListener('scroll', onChart, { passive: true });
    // the boxes changing size, and the chart's rows drawn or changed: a
    // write the chart's box couldn't take yet (clamped while its rows were
    // still to come: the sheet scrolled to a `&task=` link on its first
    // render) lands now, so the two come level
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      measure();
      level.current();
    });
    observer?.observe(sheet);
    observer?.observe(chart);
    const chartRows = chart.firstElementChild;
    if (chartRows) observer?.observe(chartRows);
    return () => {
      sheet.removeEventListener('scroll', onSheet);
      chart.removeEventListener('scroll', onChart);
      observer?.disconnect();
      level.current = () => {};
    };
  }, [sheetRef, chartEl, on]);

  const pads = endPads(heights[0], heights[1]);
  // new pads change how far each box scrolls: the chart comes level again
  useLayoutEffect(() => {
    level.current();
  }, [pads.sheet, pads.chart]);
  return pads;
}
