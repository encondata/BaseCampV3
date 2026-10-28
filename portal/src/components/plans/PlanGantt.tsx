/**
 * The Gantt chart: MS Project's bar chart beside the task sheet. It draws
 * the dates the API computed and schedules nothing.
 *
 * - The timescale: two tiers (ganttGeometry `tiers`), sticky at the top of
 *   the view and exactly as tall as the sheet's header (SHEET_HEAD_PX), so
 *   the rows line up across the panes.
 * - Lanes: one per row the sheet shows (`rows`, the outline less collapsed
 *   subtasks, plus the blank new-task row), virtualized against the same
 *   scroll box with the same settings as the sheet (Review Focus 5). A task
 *   bar (`pln-bar`, accent, its progress filled in), a summary's bracket
 *   (`pln-bar-summary`), a milestone's diamond (`pln-diamond`) with its
 *   date; red (`pln-bar-critical`) for critical tasks while Display ›
 *   Critical Path is on; the baseline under the bar while Display ›
 *   Baseline is on (`pln-baseline`); a deadline's green down-arrow
 *   (`pln-deadline`); resource names right of the bar. A task without the
 *   dates to draw gets no bar.
 * - Behind the lanes: nonworking days shaded (days and hours zooms), the
 *   today and status-date lines (each titled with its date), the
 *   initiative's scheduled window as a faint band, labeled in the
 *   timescale's top tier ("Scheduled: Nov 14–16") so the label never covers
 *   a bar, and the link arrows in one SVG over the rows rendered: a link
 *   with an end there is drawn, its far end placed by its row, so a link to
 *   a task out of sight runs off the edge (as in MS Project).
 *
 * Only what is visible is drawn (lib/plans/ganttView): a window of the
 * scale around the visible part, in window coordinates, every span cut to
 * it, so no element is ever as wide as the scale (3 years at the hours
 * zoom is ~528,000 px). The window changes only every half a pane of
 * scrolling. The chart's sideways scroll is its own (SidePane, Splitter.tsx).
 *
 * A press on a lane selects its row (Shift extends, Ctrl/⌘ toggles, as on
 * the sheet's row numbers). The hover card is GanttHover's, a component of
 * its own, so it never redraws the chart. Bars carry `data-task-id`, and
 * `onBarPointerDown` is the hook Task 9's drags attach to.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode, type RefObject,
} from 'react';

import type { PlanTask } from '../../lib/plans/api';
import { nonworkingBands } from '../../lib/plans/calendarShade';
import { SHEET_HEAD_PX, SHEET_OVERSCAN } from '../../lib/plans/columns';
import { formatDay, formatShortDay } from '../../lib/plans/floatingTime';
import {
  MILESTONE_HALF, baselineOf, barOf, fitScrollLeft, makeScale, msOf, progressWidth, tiers, widthOfMs, xOf, xOfMs,
  type Bar, type LinkEnd, type Scale, type Tick, type Zoom,
} from '../../lib/plans/ganttGeometry';
import {
  bandsIn, barBox, chartWindow, clip, lineAt, linkEnd, linkRow, linkShape, linkStub, linksToDraw, pillAt, scaleSpan,
  taskScrollLeft, windowLabel, windowPillX, windowSpan, type BarBox, type DayWindow, type LinkShape, type Span,
} from '../../lib/plans/ganttView';
import type { LinkType } from '../../lib/plans/predecessors';
import { extendRows, selectCell, toggleRow, type Selection } from '../../lib/plans/selection';
import { GanttHover } from './GanttHoverCard';
import { SidePane, type SidePaneHandle } from './Splitter';
import type { PlanController } from './usePlan';
import type { ChartScroll, GanttDisplay } from './usePlanCommands';

export interface PlanGanttProps {
  ctl: PlanController;
  /** The task ids shown, in order: the sheet's rows. */
  rows: string[];
  rowHeight: number;
  /** The view's one vertical scroll box, which the sheet reads too. */
  scrollRef: RefObject<HTMLDivElement | null>;
  zoom: Zoom;
  display: GanttDisplay;
  selection: Selection;
  onSelect(sel: Selection): void;
  /** Bars may be dragged (Task 9): the plan can be changed and isn't locked. */
  editable: boolean;
  /** The sheet's blank new-task row is shown: the chart keeps a lane for it,
   *  so both panes are the same height. */
  blankRow?: boolean;
  /** The initiative's scheduled window (date-only fields); the plan's copy
   *  when absent. */
  scheduled?: DayWindow;
  /** A one-off sideways scroll (Fit, Scroll to Task), done once per `seq`. */
  scrollRequest?: ChartScroll | null;
  /** Ctrl+wheel over the chart: -1 zooms in, 1 out. */
  onZoomStep?(dir: -1 | 1): void;
  /** Focus back on the sheet after a press on the chart (keys act there). */
  focusSheet?(): void;
  /** Task 9's drags: a pointerdown on a bar, diamond or summary bracket. */
  onBarPointerDown?(e: PointerEvent<HTMLElement>, task: PlanTask): void;
}

/** A link with its shape, ready to draw. */
interface DrawnLink {
  id: string;
  shape: LinkShape;
  critical: boolean;
}

const NO_TICKS = { top: [], bottom: [] };

export default function PlanGantt({
  ctl, rows, rowHeight, scrollRef, zoom, display, selection, onSelect, editable, blankRow = false, scheduled,
  scrollRequest = null, onZoomStep, focusSheet, onBarPointerDown,
}: PlanGanttProps) {
  const plan = ctl.plan;
  const tasks = plan?.tasks;
  const tasksById = useMemo(() => new Map((tasks ?? []).map((t) => [t.id, t])), [tasks]);

  // ── the scale: the project's span, widened to the initiative window ──
  const windowDays = scheduled ?? plan?.initiative_window ?? null;
  const winStart = windowDays?.start ?? null;
  const winEnd = windowDays?.end ?? null;
  const band = useMemo(() => windowSpan({ start: winStart, end: winEnd }), [winStart, winEnd]);
  const projectStart = plan?.project_start ?? null;
  const projectFinish = plan?.project_finish ?? null;
  const scale = useMemo<Scale | null>(() => {
    if (!projectStart) return null;
    const span = scaleSpan(projectStart, projectFinish, band);
    try {
      return makeScale(span.start, span.finish, zoom);
    } catch {
      return null;                     // a project start that isn't a plan time
    }
  }, [projectStart, projectFinish, band, zoom]);
  const scaleW = scale?.width ?? 0;

  // ── the drawn window: moves only when the scroll crosses a lead ──
  const side = useRef<SidePaneHandle>(null);
  const [paneW, setPaneW] = useState(0);
  const scrollX = useRef(0);
  const sizes = useRef({ paneW: 0, scaleW: 0 });
  const [win, setWin] = useState<Span>(() => chartWindow(0, 0, scaleW));
  const updateWin = useCallback(() => {
    const next = chartWindow(scrollX.current, sizes.current.paneW, sizes.current.scaleW);
    setWin((cur) => (cur[0] === next[0] && cur[1] === next[1] ? cur : next));
  }, []);
  // the top tier's labels hold to the view's left edge (MS Project's
  // "November 2026" stays readable while its month scrolls past): one custom
  // property on the tier, the view's left edge in window coordinates, set
  // on every scroll without a redraw; the window's label, up in the same
  // tier, moves past the held label (`pillAt`) the same way
  const scaleTop = useRef<HTMLDivElement>(null);
  const pillRef = useRef<HTMLSpanElement>(null);
  const pill = useRef<{ base: number; text: string; top: Tick[] } | null>(null);
  const shownWin = useRef(win);
  const pinLabels = useCallback(() => {
    const viewX = scrollX.current - shownWin.current[0];
    scaleTop.current?.style.setProperty('--pln-view-x', `${viewX}px`);
    const p = pill.current;
    if (p && pillRef.current) pillRef.current.style.left = `${pillAt(p.base, p.text, p.top, viewX)}px`;
  }, []);
  const onScrollX = useCallback((x: number) => {
    scrollX.current = x;
    pinLabels();
    updateWin();
  }, [pinLabels, updateWin]);
  useLayoutEffect(() => {
    sizes.current = { paneW, scaleW };
    updateWin();
  }, [paneW, scaleW, updateWin]);
  useLayoutEffect(() => {
    shownWin.current = win;
    pinLabels();
  }, [win, pinLabels]);

  // a zoom keeps the moment at the chart's left edge where it is
  const shown = useRef<Scale | null>(null);
  useLayoutEffect(() => {
    const before = shown.current;
    shown.current = scale;
    if (!before || !scale || (before.pxPerMs === scale.pxPerMs && before.startMs === scale.startMs)) return;
    side.current?.scrollTo(xOfMs(scale, msOf(before, scrollX.current)));
  }, [scale]);

  // a plan opens at its start (the scale may begin weeks earlier, at the
  // initiative's window), as a fit leaves it
  const planId = plan?.id ?? null;
  const opened = useRef<string | null>(null);
  useLayoutEffect(() => {
    if (!scale || !projectStart || !planId || opened.current === planId) return;
    opened.current = planId;
    side.current?.scrollTo(fitScrollLeft(scale, projectStart));
  }, [scale, projectStart, planId]);

  // Fit and Scroll to Task, once per request
  const handled = useRef(scrollRequest?.seq ?? 0);
  useLayoutEffect(() => {
    if (!scrollRequest || scrollRequest.seq === handled.current || !scale || !projectStart) return;
    handled.current = scrollRequest.seq;
    let x: number | null = null;
    if (scrollRequest.to === 'fit') {
      x = fitScrollLeft(scale, projectStart);
    } else {
      const task = scrollRequest.taskId ? tasksById.get(scrollRequest.taskId) : undefined;
      x = task ? taskScrollLeft(scale, task) : null;
    }
    if (x !== null) side.current?.scrollTo(x);
  }, [scrollRequest, scale, projectStart, tasksById]);

  // ── rows: the sheet's virtualizer settings, against the same box ──
  const count = rows.length + (blankRow ? 1 : 0);
  const itemKey = useCallback((i: number) => rows[i] ?? 'blank', [rows]);
  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    overscan: SHEET_OVERSCAN,
    scrollMargin: SHEET_HEAD_PX,
    getItemKey: itemKey,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, rowHeight]);
  const items = virtualizer.getVirtualItems();
  const first = items.length ? items[0].index : 0;
  const last = items.length ? items[items.length - 1].index : -1;

  const box = useMemo(() => barBox(rowHeight, display.baseline), [rowHeight, display.baseline]);
  const ticks = useMemo(() => (scale ? tiers(scale, zoom, win) : NO_TICKS), [scale, zoom, win]);
  const calendar = plan?.calendar;
  const allBands = useMemo(() => (calendar && scale ? nonworkingBands(calendar, scale) : []), [calendar, scale]);
  const offDays = useMemo(() => bandsIn(allBands, win), [allBands, win]);

  // ── links: an end within the rendered rows and the overscan; the SVG
  // spans those rows, a far end is held one row past it (where it's cut) ──
  const rowIndex = useMemo(() => new Map(rows.map((id, i) => [id, i])), [rows]);
  const links = plan?.links;
  const linkLo = Math.max(0, first - SHEET_OVERSCAN);
  const linkHi = Math.min(count - 1, last + SHEET_OVERSCAN);
  const linkTop = linkLo * rowHeight;
  const linkRows = Math.max(0, linkHi - linkLo + 1);
  const drawnLinks = useMemo<DrawnLink[]>(() => {
    if (!scale || !links || last < first) return [];
    const stub = linkStub(zoom);
    const winW = win[1] - win[0];
    const out: DrawnLink[] = [];
    for (const link of linksToDraw(links, rowIndex, first, last, SHEET_OVERSCAN)) {
      const pred = tasksById.get(link.predecessor_id);
      const succ = tasksById.get(link.successor_id);
      const a = pred && barOf(scale, pred);
      const b = succ && barOf(scale, succ);
      if (!pred || !succ || !a || !b) continue;
      const at = (bar: Bar): Bar => ({ x: bar.x - win[0], width: bar.width });
      const yOf = (id: string) => linkRow(rowIndex.get(id)!, linkLo, linkHi) * rowHeight + box.mid - linkTop;
      const from = linkEnd(at(a), pred.is_milestone, yOf(pred.id));
      const shape = shapeInto(from, at(b), succ.is_milestone, yOf(succ.id), link.link_type, rowHeight, stub,
        box.height / 2);
      if (!shape) continue;
      // both ends off the same side of the window: nothing of it shows
      const xs = [from.x0, from.x1, shape.tip[0]];
      if (Math.max(...xs) + 2 * stub < 0 || Math.min(...xs) - 2 * stub > winW) continue;
      out.push({ id: link.id, shape, critical: display.critical && pred.is_critical && succ.is_critical });
    }
    return out;
  }, [scale, links, rowIndex, first, last, linkLo, linkHi, tasksById, zoom, win, rowHeight, box, linkTop,
    display.critical]);

  // ── markers behind the lanes ──
  const now = plan?.now ?? null;
  const statusDate = plan?.status_date ?? null;
  const today = scale && now ? lineAt(xOf(scale, now), win) : null;
  const status = scale && statusDate ? lineAt(xOf(scale, statusDate), win) : null;
  const bandPiece = scale && band ? clip(xOfMs(scale, band[0]), widthOfMs(scale, band[1] - band[0]), win) : null;
  const bandLabel = windowLabel({ start: winStart, end: winEnd });
  const tierTop = useMemo(() => ticks.top.map((t) => ({ ...t, x: t.x - win[0] })), [ticks, win]);
  const pillBase = bandPiece && bandLabel ? windowPillX(bandPiece.x, bandLabel, tierTop) : null;
  useLayoutEffect(() => {
    pill.current = pillBase !== null && bandLabel ? { base: pillBase, text: bandLabel, top: tierTop } : null;
    pinLabels();
  }, [pillBase, bandLabel, tierTop, pinLabels]);

  // ── presses (the hover card is GanttHover's) ──
  const chartRef = useRef<HTMLDivElement>(null);
  const chartBar = useRef<HTMLDivElement>(null);
  const latest = useRef({ selection, onSelect, rows, focusSheet, onBarPointerDown });
  useLayoutEffect(() => {
    latest.current = { selection, onSelect, rows, focusSheet, onBarPointerDown };
  });
  const onChartDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const id = (e.target as Element).closest('[data-lane]')?.getAttribute('data-lane');
    if (!id || id === 'blank') return;
    const { selection: sel, onSelect: select, rows: shownRows, focusSheet: focus } = latest.current;
    const col = sel.active?.col ?? 'name';
    if (e.shiftKey) select(extendRows(sel, id, col, shownRows));
    else if (e.ctrlKey || e.metaKey) select(toggleRow(sel, id, col));
    else select(selectCell(id, col));
    focus?.();
  };
  const onBarDown = useCallback((e: PointerEvent<HTMLElement>, task: PlanTask) => {
    latest.current.onBarPointerDown?.(e, task);
  }, []);

  if (!plan || !scale) return null;

  const winW = win[1] - win[0];
  const style = {
    width: winW,
    '--pln-row-h': `${rowHeight}px`,
    '--pln-head-h': `${SHEET_HEAD_PX}px`,
  } as CSSProperties;

  return (
    <SidePane className="pln-pane-chart" contentWidth={scale.width} origin={win[0]} onScrollX={onScrollX}
              onWidth={setPaneW} onZoomStep={onZoomStep} handleRef={side} barRef={chartBar}>
      {/* everything here is the sheet's rows again, drawn: the sheet is the accessible view */}
      <div className={`pln-gantt${editable ? ' pln-gantt-editable' : ''}`} style={style} aria-hidden="true">
        <div className="pln-scale">
          {bandPiece && <span className="pln-window-cap" style={{ left: bandPiece.x, width: bandPiece.width }} />}
          <div className="pln-scale-top" ref={scaleTop}>
            {ticks.top.map((t) => (
              <span key={t.x} className="pln-tick"
                    style={{
                      left: t.x - win[0], width: t.width, '--pln-tick-x': `${t.x - win[0]}px`,
                      '--pln-tick-w': `${t.width}px`, '--pln-label-ch': t.label.length,
                    } as CSSProperties}>
                <span className="pln-tick-label">{t.label}</span>
              </span>
            ))}
            {/* the initiative window's label: up here, clear of the tier's labels, it never covers a bar */}
            {/* placed by pinLabels, which follows the scroll */}
            {pillBase !== null && <span ref={pillRef} className="pln-window-label">{bandLabel}</span>}
          </div>
          <div className="pln-scale-bottom">
            {ticks.bottom.map((t) => (
              <span key={t.x} className="pln-tick" style={{ left: t.x - win[0], width: t.width }}>{t.label}</span>
            ))}
          </div>
        </div>

        <div className="pln-chart" ref={chartRef} style={{ height: virtualizer.getTotalSize() }}
             onMouseDown={onChartDown}>
          {offDays.map((b) => <span key={b.x} className="pln-offday" style={{ left: b.x, width: b.width }} />)}
          {bandPiece && <span className="pln-window" style={{ left: bandPiece.x, width: bandPiece.width }} />}
          {today !== null && <span className="pln-today" title={`Today ${formatDay(now)}`} style={{ left: today }} />}
          {status !== null && (
            <span className="pln-status-date" title={`Status date ${formatDay(statusDate)}`} style={{ left: status }} />
          )}

          {drawnLinks.length > 0 && (
            <svg className="pln-links" width={winW} height={linkRows * rowHeight} style={{ top: linkTop }}>
              {drawnLinks.map((l) => (
                <g key={l.id}>
                  <path className={`pln-link-path${l.critical ? ' pln-link-critical' : ''}`} data-link={l.id} d={l.shape.d} />
                  <polygon className={`pln-link-tip${l.critical ? ' pln-link-critical' : ''}`} points={l.shape.head} />
                </g>
              ))}
            </svg>
          )}

          {items.map((item) => {
            const id = rows[item.index];
            const task = id === undefined ? undefined : tasksById.get(id);
            const selected = task ? selection.rows.has(task.id) || selection.active?.id === task.id : false;
            return (
              <Lane key={item.key} laneId={task?.id ?? 'blank'} task={task} y={item.start - SHEET_HEAD_PX}
                    scale={scale} win={win} box={box} display={display} selected={selected}
                    onBarPointerDown={onBarPointerDown ? onBarDown : undefined} />
            );
          })}
        </div>
      </div>
      <GanttHover chartRef={chartRef} scrollRef={scrollRef} barRef={chartBar} tasksById={tasksById} plan={plan} />
    </SidePane>
  );
}

/** The link into `to`: a milestone's diamond is met at its tip when the
 *  line arrives sideways, or from straight above or below at its top or
 *  bottom when that saves a detour (a milestone right at the predecessor's
 *  finish). A bar is met at its edge, or at its top or bottom on a drop. */
function shapeInto(
  from: LinkEnd, to: Bar, milestone: boolean, y: number, type: LinkType, rowH: number, stub: number, barHalf: number,
): LinkShape | null {
  const edge = linkShape(from, linkEnd(to, milestone, y), type, rowH, { stub, toHalf: milestone ? 0 : barHalf });
  if (!milestone) return edge;
  const center = linkShape(from, { x0: to.x, x1: to.x, y }, type, rowH, { stub, toHalf: MILESTONE_HALF });
  if (!edge) return center;
  if (!center || (center.dir !== 'up' && center.dir !== 'down')) return edge;
  return runsOf(center.d) < runsOf(edge.d) ? center : edge;
}

const runsOf = (d: string): number => (d.match(/[HV]/g) ?? []).length;

interface LaneProps {
  laneId: string;
  task: PlanTask | undefined;
  y: number;
  scale: Scale;
  win: Span;
  box: BarBox;
  display: GanttDisplay;
  selected: boolean;
  onBarPointerDown?(e: PointerEvent<HTMLElement>, task: PlanTask): void;
}

/** One row's lane; redraws only when its task, place, window or state changes. */
const Lane = memo(function Lane({ laneId, task, y, scale, win, box, display, selected, onBarPointerDown }: LaneProps) {
  return (
    <div className={`pln-lane${selected ? ' on' : ''}`} data-lane={laneId} style={{ transform: `translateY(${y}px)` }}>
      {task && <TaskMarks task={task} scale={scale} win={win} box={box} display={display}
                          onBarPointerDown={onBarPointerDown} />}
    </div>
  );
});

/** The deadline marker's half width (its arrow points at the deadline). */
const DEADLINE_HALF = 5;
/** A baseline milestone's half width (a small diamond under the real one). */
const BASE_MARK_HALF = 4;
/** Room between a bar's end and its resource names. */
const NAMES_GAP = 6;

function TaskMarks({ task, scale, win, box, display, onBarPointerDown }: {
  task: PlanTask; scale: Scale; win: Span; box: BarBox; display: GanttDisplay;
  onBarPointerDown?(e: PointerEvent<HTMLElement>, task: PlanTask): void;
}) {
  const out: ReactNode[] = [];
  const critical = display.critical && task.is_critical && !task.is_summary;
  const down = onBarPointerDown ? (e: PointerEvent<HTMLElement>) => onBarPointerDown(e, task) : undefined;
  const names = task.assignees.map((a) => a.name).join(', ');
  const cut = (p: { cutStart: boolean; cutEnd: boolean }) =>
    `${p.cutStart ? ' pln-cut-start' : ''}${p.cutEnd ? ' pln-cut-end' : ''}`;

  if (display.baseline) {
    const base = baselineOf(scale, task);
    if (base && task.is_milestone) {
      const at = lineAt(base.x, win);
      if (at !== null) {
        out.push(<span key="base" className="pln-baseline pln-baseline-mark"
                       style={{ left: at - BASE_MARK_HALF, top: box.baseTop + box.baseHeight / 2 - BASE_MARK_HALF }} />);
      }
    } else if (base) {
      const piece = clip(base.x, base.width, win);
      if (piece) {
        out.push(<span key="base" className="pln-baseline"
                       style={{ left: piece.x, width: piece.width, top: box.baseTop, height: box.baseHeight }} />);
      }
    }
  }

  const bar = barOf(scale, task);
  if (bar && task.is_milestone) {
    const at = lineAt(bar.x, win);
    if (at !== null) {
      out.push(
        <div key="bar" className={`pln-diamond${critical ? ' pln-diamond-critical' : ''}`} data-task-id={task.id}
             style={{ left: at - MILESTONE_HALF, top: box.mid - MILESTONE_HALF }} onPointerDown={down} />,
        <span key="names" className="pln-bar-names" style={{ left: at + MILESTONE_HALF + NAMES_GAP, top: box.mid }}>
          <span className="pln-diamond-date">{formatShortDay(task.start ?? task.finish)}</span>
          {names && ` ${names}`}
        </span>,
      );
    }
  } else if (bar) {
    const piece = clip(bar.x, bar.width, win);
    if (piece) {
      // the part done, measured on the whole bar, then cut to the drawn piece
      const doneTo = bar.x + progressWidth(bar, task.percent_complete) - win[0];
      const done = Math.min(Math.max(doneTo - piece.x, 0), piece.width);
      const kind = task.is_summary ? 'pln-bar-summary' : `pln-bar${critical ? ' pln-bar-critical' : ''}`;
      out.push(
        <div key="bar" className={`${kind}${cut(piece)}`} data-task-id={task.id} onPointerDown={down}
             style={{ left: piece.x, width: piece.width, top: box.top,
               height: task.is_summary ? box.summaryHeight : box.height }}>
          {done > 0 && <span className="pln-bar-done" style={{ width: done }} />}
        </div>,
      );
      if (names && !piece.cutEnd) {
        out.push(
          <span key="names" className="pln-bar-names" style={{ left: piece.x + piece.width + NAMES_GAP, top: box.mid }}>
            {names}
          </span>,
        );
      }
    }
  }

  if (task.deadline) {
    const at = lineAt(xOf(scale, task.deadline), win);
    if (at !== null) {
      out.push(
        <span key="deadline" className="pln-deadline"
              style={{ left: at - DEADLINE_HALF, top: box.top - 2, height: box.height + 4 }}>
          <svg viewBox="0 0 10 14" preserveAspectRatio="none" aria-hidden="true">
            <path d="M3.5 0h3v7.5H10L5 14 0 7.5h3.5z" />
          </svg>
        </span>,
      );
    }
  }
  return <>{out}</>;
}
