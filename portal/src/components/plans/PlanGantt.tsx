/**
 * The Gantt chart: MS Project's bar chart beside the task sheet (or under
 * it: PlanTab's Gantt › Below). It draws the dates the API computed and
 * schedules nothing.
 *
 * - The timescale: two tiers (ganttGeometry `tiers`), sticky at the top of
 *   the view and exactly as tall as the sheet's header (SHEET_HEAD_PX), so
 *   the rows line up across the panes.
 * - Lanes: one per row the sheet shows (`rows`, the outline less collapsed
 *   subtasks, filtered, maybe grouped — useSheetView — plus the blank
 *   new-task row), virtualized against the same
 *   scroll box with the same settings as the sheet (Review Focus 5) — under
 *   the sheet, against a box of its own PlanTab keeps level with the
 *   sheet's (Splitter.tsx). A task
 *   bar (`pln-bar`, accent, its progress filled in), a summary's bracket
 *   (`pln-bar-summary`), a milestone's diamond (`pln-diamond`) with its
 *   date, each in the task's own color when it has one (`pln-tinted`,
 *   `--pln-task`); red (`pln-bar-critical`) for critical tasks while
 *   Display › Critical Path is on, a colored one keeping its color as a
 *   stripe along the top (`pln-bar-hue`); the baseline under the bar while Display ›
 *   Baseline is on (`pln-baseline`); a deadline's green down-arrow
 *   (`pln-deadline`); resource names right of the bar. A task without the
 *   dates to draw gets no bar. Under the sheet (`taskLabels`), where the
 *   names aren't beside the bars, each task's name goes left of its bar,
 *   ellipsized to the room there, or after it when there's none
 *   (`labelPlace`).
 * - Behind the lanes, all of it deaf to the pointer: nonworking days shaded
 *   (days and hours zooms), the today and status-date lines, the
 *   initiative's scheduled window as a faint band, labeled in the
 *   timescale's top tier ("Scheduled: Nov 14–16") so the label never covers
 *   a bar, and the link arrows in one SVG over the rows rendered: a link
 *   with an end there is drawn, its far end placed by its row, so a link to
 *   a task out of sight runs off the edge (as in MS Project). The two lines
 *   are titled ("Today …", "Status date …") by a small mark at their top in
 *   the timescale, never by the line itself, so a line never takes a press
 *   meant for a bar or its lane.
 *
 * Only what is visible is drawn (lib/plans/ganttView): a window of the
 * scale around the visible part, in window coordinates, every span cut to
 * it, so no element is ever as wide as the scale (3 years at the hours
 * zoom is ~528,000 px). The window changes only every half a pane of
 * scrolling. The chart's sideways scroll is its own (SidePane, Splitter.tsx).
 *
 * Filters and Group by (the filter bar): a filter's context rows
 * (`context`) are dimmed and inert here too — their marks take no press,
 * a press on their lane selects nothing — and a group's band (`bands`) is a
 * shaded lane. A lane is keyed by its row's key, its task by
 * `taskOfRow`; a link is drawn only between rows keyed by its tasks' ids,
 * so a grouped chart draws none (a task can be on two rows).
 *
 * Presses. The lanes let the pointer through: only the marks that do
 * something take it — a bar, a diamond, a summary's bracket, a link handle,
 * and a link's wide invisible hit line. A press anywhere else on the chart
 * selects the row under it (Shift extends, Ctrl/⌘ toggles, as on the
 * sheet's row numbers). A press on a bar is useGanttDrag's: drag it to
 * move it, its right end to resize it, its progress handle to set
 * % Complete, its link handle (the dot right of it) onto another bar to
 * link them; a press too short to be a drag selects it. What a plan allows
 * is `data-drag` on the chart (full, progress while locked, none for a
 * reader); the ghost and tooltip are DragLayer's. A click on a link opens
 * its Task Dependency dialog (`onLinkClick`); a double-click on a bar is
 * Task Information's hook (`onBarDoubleClick`). The hover card is
 * GanttHover's, a component of its own, so it never redraws the chart.
 */
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore,
  type CSSProperties, type MouseEvent, type PointerEvent, type ReactNode, type RefObject,
} from 'react';

import type { PlanTask } from '../../lib/plans/api';
import { taskOfRow, type GroupBand } from '../../lib/plans/filters';
import { nonworkingBands } from '../../lib/plans/calendarShade';
import { SHEET_HEAD_PX, SHEET_OVERSCAN } from '../../lib/plans/columns';
import { GRIP_PX, gripX, hasGrip } from '../../lib/plans/drag';
import { formatDay, formatShortDay } from '../../lib/plans/floatingTime';
import {
  MILESTONE_HALF, baselineOf, barOf, fitScrollLeft, makeScale, msOf, progressWidth, tiers, widthOfMs, xOf, xOfMs,
  type Bar, type LinkEnd, type Scale, type Tick, type Zoom,
} from '../../lib/plans/ganttGeometry';
import {
  LABEL_GAP_PX, LABEL_MAX_PX, bandsIn, barBox, chartWindow, clip, labelPlace, lineAt, linkEnd, linkRow, linkShape, linkStub,
  linksToDraw, pillAt, scaleSpan, taskScrollLeft, windowLabel, windowPillX, windowSpan, type BarBox, type DayWindow,
  type LinkShape, type Span,
} from '../../lib/plans/ganttView';
import type { LinkType } from '../../lib/plans/predecessors';
import { extendRows, selectCell, toggleRow, type Selection } from '../../lib/plans/selection';
import { GanttDragTip, GanttHover } from './GanttHoverCard';
import { SidePane, type SidePaneHandle } from './Splitter';
import { useGanttDrag, type DragAccess, type DragStore } from './useGanttDrag';
import type { PlanController } from './usePlan';
import type { ChartScroll, GanttDisplay } from './usePlanCommands';

export interface PlanGanttProps {
  ctl: PlanController;
  /** The rows shown, in order, by key: the sheet's rows. */
  rows: string[];
  /** A filter's context rows: dimmed and inert. */
  context?: ReadonlySet<string>;
  /** Group by's bands, by row key. */
  bands?: ReadonlyMap<string, GroupBand>;
  rowHeight: number;
  /** The chart's vertical scroll box: the view's one box, which the sheet
   *  reads too (Beside), or the chart's own (Below). */
  scrollRef: RefObject<HTMLDivElement | null>;
  zoom: Zoom;
  display: GanttDisplay;
  selection: Selection;
  onSelect(sel: Selection): void;
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
  /** A click on a link's line: its Task Dependency dialog. Without it links take no clicks. */
  onLinkClick?(linkId: string): void;
  /** A double-click on a bar, diamond or summary bracket (Task Information's hook). */
  onBarDoubleClick?(task: PlanTask): void;
  /** Each task's name at its bar (Below, where the sheet isn't beside it). */
  taskLabels?: boolean;
  /** Room after the last lane (Below: so the chart scrolls as far as the sheet). */
  endPad?: number;
  /** Where its scroll box is as the chart mounts (the sheet's place); the box's own scrollTop by default. */
  startTop?(): number;
  /** The moment (ms) a chart of this plan last had at its left edge, to
   *  open there instead of at the project start (a layout switch mounts
   *  the chart again); null for none. */
  startMoment?(planId: string): number | null;
  /** Each sideways scroll: the moment (ms) now at the chart's left edge. */
  onLeftMoment?(planId: string, ms: number): void;
}

/** A link with its shape, ready to draw. */
interface DrawnLink {
  id: string;
  shape: LinkShape;
  critical: boolean;
}

const NO_TICKS = { top: [], bottom: [] };
const NO_KEYS: ReadonlySet<string> = new Set();
const NO_BANDS: ReadonlyMap<string, GroupBand> = new Map();

export default function PlanGantt({
  ctl, rows, context = NO_KEYS, bands = NO_BANDS, rowHeight, scrollRef, zoom, display, selection, onSelect,
  blankRow = false, scheduled,
  scrollRequest = null, onZoomStep, focusSheet, onLinkClick, onBarDoubleClick, taskLabels = false, endPad = 0,
  startTop, startMoment, onLeftMoment,
}: PlanGanttProps) {
  const plan = ctl.plan;
  const planId = plan?.id ?? null;
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

  // where the chart left off (a layout switch mounts it again): the moment
  // at its left edge, in this scale's px; null to open at the project start
  const [resumeX] = useState<number | null>(() => {
    const ms = scale && planId ? startMoment?.(planId) ?? null : null;
    return scale && ms !== null ? xOfMs(scale, ms) : null;
  });
  // the moment at the left edge goes up on every sideways scroll
  const report = useRef({ scale, planId, onLeftMoment });
  useLayoutEffect(() => {
    report.current = { scale, planId, onLeftMoment };
  });

  // ── the drawn window: moves only when the scroll crosses a lead ──
  const side = useRef<SidePaneHandle>(null);
  const [paneW, setPaneW] = useState(0);
  const scrollX = useRef(resumeX ?? 0);
  const sizes = useRef({ paneW: 0, scaleW: 0 });
  const [win, setWin] = useState<Span>(() => chartWindow(resumeX ?? 0, 0, scaleW));
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
    const { scale: s, planId: id, onLeftMoment: tell } = report.current;
    if (s && id) tell?.(id, msOf(s, x));
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
  // initiative's window), as a fit leaves it; under the sheet, with room
  // left of it for the first tasks' names. A chart mounted again for the
  // same plan (a layout switch) opens where the last one left off.
  const opened = useRef<string | null>(null);
  const labelRoom = taskLabels ? LABEL_MAX_PX : 0;
  useLayoutEffect(() => {
    if (!scale || !projectStart || !planId || opened.current === planId) return;
    opened.current = planId;
    const ms = startMoment?.(planId) ?? null;
    side.current?.scrollTo(ms !== null ? xOfMs(scale, ms) : fitScrollLeft(scale, projectStart) - labelRoom);
    // (startMoment is read once per plan, at its opening: not a dependency)
  }, [scale, projectStart, planId, labelRoom]);

  // Fit and Scroll to Task, once per request
  const handled = useRef(scrollRequest?.seq ?? 0);
  useLayoutEffect(() => {
    if (!scrollRequest || scrollRequest.seq === handled.current || !scale || !projectStart) return;
    handled.current = scrollRequest.seq;
    let x: number | null = null;
    if (scrollRequest.to === 'fit') {
      x = fitScrollLeft(scale, projectStart) - labelRoom;
    } else {
      const task = scrollRequest.taskId ? tasksById.get(scrollRequest.taskId) : undefined;
      x = task ? taskScrollLeft(scale, task) : null;
    }
    if (x !== null) side.current?.scrollTo(x);
  }, [scrollRequest, scale, projectStart, tasksById, labelRoom]);

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
    // the chart mounts into a box already scrolled (Gantt › Beside again
    // from Hidden), or one to be kept level with the sheet's (Below): a new
    // virtualizer scrolls its box to where it starts, so it starts there,
    // not at the top
    initialOffset: () => (startTop ? startTop() : scrollRef.current?.scrollTop ?? 0),
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

  // ── presses (the hover card is GanttHover's, the drags useGanttDrag's) ──
  const chartRef = useRef<HTMLDivElement>(null);
  const chartBar = useRef<HTMLDivElement>(null);
  /** A row nobody selects: a filter's context row, a group's band. */
  const inert = useCallback((key: string) => context.has(key) || bands.has(key), [context, bands]);
  // the rows a Shift-press steps through
  const nav = useMemo(() => (context.size || bands.size ? rows.filter((key) => !inert(key)) : rows),
    [rows, context, bands, inert]);
  const latest = useRef({ selection, onSelect, rows, nav, inert, focusSheet, onLinkClick, onBarDoubleClick });
  useLayoutEffect(() => {
    latest.current = { selection, onSelect, rows, nav, inert, focusSheet, onLinkClick, onBarDoubleClick };
  });
  /** A press on a task's row (by its key), as on the sheet's row numbers. */
  const selectRow = useCallback((id: string, mods: { shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }) => {
    const { selection: sel, onSelect: select, nav: shownRows, focusSheet: focus } = latest.current;
    const col = sel.active?.col ?? 'name';
    if (mods.shiftKey) select(extendRows(sel, id, col, shownRows));
    else if (mods.ctrlKey || mods.metaKey) select(toggleRow(sel, id, col));
    else select(selectCell(id, col));
    focus?.();
  }, []);
  const onChartDown = (e: MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest('[data-link-hit]')) return;       // a link: its click opens its dialog
    let id = target.closest('[data-lane]')?.getAttribute('data-lane') ?? null;
    if (!id) {
      // the lanes let presses through to the chart: the row under the pointer
      const top = chartRef.current?.getBoundingClientRect().top ?? 0;
      id = latest.current.rows[Math.floor((e.clientY - top) / rowHeight)] ?? null;
    }
    if (!id || id === 'blank' || latest.current.inert(id)) return;
    selectRow(id, e);
  };
  const onLinkHit = useCallback((e: MouseEvent<SVGPathElement>) => {
    const id = e.currentTarget.getAttribute('data-link-hit');
    if (id) latest.current.onLinkClick?.(id);
  }, []);
  const onBarDouble = useCallback((task: PlanTask) => latest.current.onBarDoubleClick?.(task), []);
  const drag = useGanttDrag({
    ctl, scale, zoom, rows, inert, rowHeight, box, tasksById, chartRef, barRef: chartBar, select: selectRow,
  });

  if (!plan || !scale) return null;

  const winW = win[1] - win[0];
  const style = {
    width: winW,
    '--pln-row-h': `${rowHeight}px`,
    '--pln-head-h': `${SHEET_HEAD_PX}px`,
  } as CSSProperties;

  return (
    <SidePane className="pln-pane-chart" contentWidth={scale.width} origin={win[0]} onScrollX={onScrollX}
              onWidth={setPaneW} onZoomStep={onZoomStep} handleRef={side} barRef={chartBar} endPad={endPad}>
      {/* everything here is the sheet's rows again, drawn: the sheet is the accessible view */}
      <div className="pln-gantt" data-drag={drag.access} style={style} aria-hidden="true">
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
          {/* the today and status-date lines' titles: a mark at each line's top, up here clear of the bars */}
          {today !== null && <span className="pln-today-mark" title={`Today ${formatDay(now)}`} style={{ left: today }} />}
          {status !== null && (
            <span className="pln-status-mark" title={`Status date ${formatDay(statusDate)}`} style={{ left: status }} />
          )}
        </div>

        <div className="pln-chart" ref={chartRef} style={{ height: virtualizer.getTotalSize() }}
             onMouseDown={onChartDown}>
          {offDays.map((b) => <span key={b.x} className="pln-offday" style={{ left: b.x, width: b.width }} />)}
          {bandPiece && <span className="pln-window" style={{ left: bandPiece.x, width: bandPiece.width }} />}
          {today !== null && <span className="pln-today" style={{ left: today }} />}
          {status !== null && <span className="pln-status-date" style={{ left: status }} />}

          {drawnLinks.length > 0 && (
            <svg className="pln-links" width={winW} height={linkRows * rowHeight} style={{ top: linkTop }}>
              {drawnLinks.map((l) => (
                <g key={l.id}>
                  <path className={`pln-link-path${l.critical ? ' pln-link-critical' : ''}`} data-link={l.id} d={l.shape.d} />
                  <polygon className={`pln-link-tip${l.critical ? ' pln-link-critical' : ''}`} points={l.shape.head} />
                  {/* a click target wider than the 1px line, drawn invisible over it */}
                  {onLinkClick && <path className="pln-link-hit" data-link-hit={l.id} d={l.shape.d} onClick={onLinkHit} />}
                </g>
              ))}
            </svg>
          )}

          {items.map((item) => {
            const key = rows[item.index];
            if (key !== undefined && bands.has(key)) {
              return <span key={key} className="pln-lane pln-band-lane" data-lane={key}
                           style={{ transform: `translateY(${item.start - SHEET_HEAD_PX}px)` }} />;
            }
            const taskId = key === undefined ? null : taskOfRow(key);
            const task = taskId === null ? undefined : tasksById.get(taskId);
            const selected = task ? selection.rows.has(key) || selection.active?.id === key : false;
            const dim = task !== undefined && context.has(key);
            return (
              <Lane key={item.key} laneId={task ? key : 'blank'} task={task} y={item.start - SHEET_HEAD_PX}
                    scale={scale} win={win} box={box} display={display} selected={selected} context={dim}
                    access={dim ? 'none' : drag.access} labels={taskLabels} onBarPointerDown={drag.onBarPointerDown}
                    onBarDoubleClick={onBarDouble} />
            );
          })}

          <DragLayer store={drag.store} win={win} rowHeight={rowHeight} box={box} />
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

/** A bar's handlers: the drags' press and Task Information's double-click. */
interface BarHandlers {
  access: DragAccess;
  onBarPointerDown(e: PointerEvent<HTMLElement>, task: PlanTask, rowKey: string): void;
  onBarDoubleClick(task: PlanTask): void;
}

interface LaneProps extends BarHandlers {
  laneId: string;
  task: PlanTask | undefined;
  y: number;
  scale: Scale;
  win: Span;
  box: BarBox;
  display: GanttDisplay;
  selected: boolean;
  /** A filter's context row: dimmed, its marks inert. */
  context: boolean;
  labels: boolean;
}

/** One row's lane; redraws only when its task, place, window or state changes. */
const Lane = memo(function Lane({ laneId, task, y, selected, context, ...marks }: LaneProps) {
  return (
    <div className={`pln-lane${selected ? ' on' : ''}${context ? ' pln-context' : ''}`} data-lane={laneId}
         style={{ transform: `translateY(${y}px)` }}>
      {task && <TaskMarks task={task} rowKey={laneId} inert={context} {...marks} />}
    </div>
  );
});

/** The live drag's ghost bar, link band and tooltip; redraws on its own as the pointer moves. */
function DragLayer({ store, win, rowHeight, box }: { store: DragStore; win: Span; rowHeight: number; box: BarBox }) {
  const p = useSyncExternalStore(store.subscribe, store.get, store.get);
  if (!p) return null;
  const out: ReactNode[] = [];
  const barAt = (row: number, x: number, width: number, milestone: boolean, kind: string) => {
    if (milestone) {
      const at = lineAt(x, win);
      if (at !== null) {
        out.push(<span key={kind} className={`pln-drag-ghost pln-drag-mark ${kind}`}
                       style={{ left: at - MILESTONE_HALF, top: row * rowHeight + box.mid - MILESTONE_HALF }} />);
      }
      return;
    }
    const piece = clip(x, width, win);
    if (piece) {
      out.push(<span key={kind} className={`pln-drag-ghost ${kind}`}
                     style={{ left: piece.x, width: piece.width, top: row * rowHeight + box.top, height: box.height }} />);
    }
  };
  if (p.ghost && p.done !== null) barAt(p.row, p.ghost.x, p.done, false, 'pln-drag-done');
  else if (p.ghost) barAt(p.row, p.ghost.x, p.ghost.width, p.milestone, 'pln-drag-bar');
  if (p.target) barAt(p.target.row, p.target.bar.x, p.target.bar.width, p.target.milestone, 'pln-drag-target');
  if (p.band) {
    out.push(
      <svg key="band" className="pln-drag-svg" width={1} height={1}>
        <line className="pln-drag-band" x1={p.band.x0 - win[0]} y1={p.band.y0} x2={p.band.x1 - win[0]} y2={p.band.y1} />
      </svg>,
    );
  }
  return (
    <>
      {out}
      <GanttDragTip title={p.title} facts={p.facts} x={p.clientX} y={p.clientY} />
    </>
  );
}

/** The deadline marker's half width (its arrow points at the deadline). */
const DEADLINE_HALF = 5;
/** A baseline milestone's half width (a small diamond under the real one). */
const BASE_MARK_HALF = 4;
/** Room between a bar's end and its resource names. */
const NAMES_GAP = 6;

/** A link handle's height beside a milestone's diamond. */
const DOT_MARK_H = 2 * MILESTONE_HALF;

function TaskMarks({
  task, rowKey, inert, scale, win, box, display, labels, access, onBarPointerDown, onBarDoubleClick,
}: BarHandlers & {
  task: PlanTask; rowKey: string; inert: boolean; scale: Scale; win: Span; box: BarBox; display: GanttDisplay;
  labels: boolean;
}) {
  const out: ReactNode[] = [];
  const critical = display.critical && task.is_critical && !task.is_summary;
  // the task's own color: the fill of its bar, bracket or diamond; under
  // Critical Path (red), a stripe along the top instead (plans.css .pln-tinted)
  const color = task.color;
  const tint = color && !critical ? ' pln-tinted' : '';
  const hue = color ? ({ '--pln-task': color } as CSSProperties) : undefined;
  const stripe = color && critical ? <span className="pln-bar-hue" /> : null;
  const down = access === 'none' ? undefined : (e: PointerEvent<HTMLElement>) => onBarPointerDown(e, task, rowKey);
  // a context row's bar opens nothing (it is only there to place a match)
  const dbl = inert ? undefined : () => onBarDoubleClick(task);
  /** The link handle, right of the bar's end (window px): open plans only. */
  const dot = (at: number, top: number, height: number) => (access === 'full'
    ? <span key="dot" className="pln-link-dot" data-task-id={task.id} style={{ left: at, top, height }}
            onPointerDown={down} />
    : null);
  const names = task.assignees.map((a) => a.name).join(', ');
  const cut = (p: { cutStart: boolean; cutEnd: boolean }) =>
    `${p.cutStart ? ' pln-cut-start' : ''}${p.cutEnd ? ' pln-cut-end' : ''}`;
  // Below: the task's name at its bar — left of it, or after it (before the resource names)
  const title = task.name || 'Untitled task';
  /** The name left of a mark whose left edge is at `x` on the scale (`at` in the window), or null to put it after. */
  const nameBefore = (x: number, at: number) => {
    if (!labels) return null;
    const place = labelPlace(x);
    if (place.side === 'after') return null;
    return (
      <span key="label" className="pln-bar-label"
            style={{ left: at - LABEL_GAP_PX - place.width, width: place.width, top: box.mid }}>{title}</span>
    );
  };

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
      const before = nameBefore(bar.x - MILESTONE_HALF, at - MILESTONE_HALF);
      out.push(
        before,
        <div key="bar" className={`pln-diamond${critical ? ' pln-diamond-critical' : ''}${tint}`}
             data-task-id={task.id} style={{ ...hue, left: at - MILESTONE_HALF, top: box.mid - MILESTONE_HALF }}
             onPointerDown={down} onDoubleClick={dbl}>
          {stripe}
        </div>,
        dot(at + MILESTONE_HALF, box.mid - DOT_MARK_H / 2, DOT_MARK_H),
        <span key="names" className="pln-bar-names" style={{ left: at + MILESTONE_HALF + NAMES_GAP, top: box.mid }}>
          <span className="pln-diamond-date">{formatShortDay(task.start ?? task.finish)}</span>
          {labels && !before && <span className="pln-bar-label-after">{title}</span>}
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
      const height = task.is_summary ? box.summaryHeight : box.height;
      // the progress handle (drag.ts `gripX`), where the plan takes progress drags
      const dragBar = { ...bar, done: progressWidth(bar, task.percent_complete), milestone: false };
      const progressOnly = access === 'progress';
      const grip = access !== 'none' && !task.is_summary && hasGrip(dragBar, progressOnly)
        ? gripX(dragBar, progressOnly) - win[0] - piece.x - GRIP_PX
        : null;
      // a bar cut at the window's start begins out past the lead: so would a name left of it
      const before = piece.cutStart ? null : nameBefore(bar.x, piece.x);
      const after = labels && !before && !piece.cutStart;
      out.push(
        before,
        <div key="bar" className={`${kind}${tint}${cut(piece)}`} data-task-id={task.id} onPointerDown={down}
             onDoubleClick={dbl} style={{ ...hue, left: piece.x, width: piece.width, top: box.top, height }}>
          {done > 0 && <span className="pln-bar-done" style={{ width: done }} />}
          {stripe}
          {grip !== null && <span className="pln-pct-grip" style={{ left: grip, width: 2 * GRIP_PX }} />}
        </div>,
      );
      if (!piece.cutEnd) out.push(dot(piece.x + piece.width, box.top, box.height));
      if ((names || after) && !piece.cutEnd) {
        out.push(
          <span key="names" className="pln-bar-names" style={{ left: piece.x + piece.width + NAMES_GAP, top: box.mid }}>
            {after && <span className="pln-bar-label-after">{title}</span>}
            {after && names ? ` ${names}` : names}
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
