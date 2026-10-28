/**
 * The Gantt view's layout math, on top of ganttGeometry: which slice of the
 * scale the chart draws, bars and bands clipped to it, a bar's place in its
 * row, which links are drawn and where their arrowheads point, the
 * initiative window band, what the hover card says, the zoom, splitter
 * and layout settings kept in localStorage, and the Below layout's math
 * (the end pads that keep its two scrollers level, where a task's name
 * goes at its bar). Pure, so PlanGantt only renders.
 *
 * Drawing only what is visible (Review Focus 5): a 3-year plan at the hours
 * zoom is about 528,000 px wide, so the chart never makes an element that
 * wide. It draws a window of the scale (`chartWindow`): the visible part
 * plus a lead on each side, bucketed so scrolling within a bucket redraws
 * nothing. Everything inside is placed in window coordinates (x less the
 * window's left edge) and cut to the window (`clip`).
 */
import type { Plan, PlanLink, PlanTask } from './api';
import type { Band } from './calendarShade';
import { formatDuration } from './durations';
import { dayOf, formatCell, formatDayRange, fromMs, toMs } from './floatingTime';
import {
  LINK_STUB, MILESTONE_HALF, MS_PER_DAY, ZOOMS, barOf, linkPath, type Bar, type LinkEnd, type Scale, type Tick, type Zoom,
} from './ganttGeometry';
import { planUnits } from './merge';
import type { LinkType } from './predecessors';

/** `[from, to]` on one axis, in px (or ms where named). */
export type Span = readonly [from: number, to: number];

// ── the drawn window ─────────────────────────────────────────────────

/** The least lead kept either side of the visible part, for a pane not yet measured. */
export const MIN_LEAD_PX = 256;

/**
 * The slice of the scale the chart draws for a pane `paneW` wide scrolled
 * to `scrollX`: the visible part with between one and two leads either
 * side (a lead is half the pane, at least MIN_LEAD_PX), cut to the scale.
 * It changes only when the scroll crosses into another lead-wide bucket,
 * so scrolling within one redraws nothing.
 */
export function chartWindow(scrollX: number, paneW: number, scaleW: number): Span {
  const lead = Math.max(MIN_LEAD_PX, Math.ceil(paneW / 2));
  const bucket = Math.floor(Math.max(0, scrollX) / lead);
  const from = (bucket - 1) * lead;
  const to = from + 3 * lead + Math.max(0, paneW);
  return [Math.max(0, from), Math.min(Math.max(0, scaleW), to)];
}

/** A span of the scale in window coordinates, cut to the window. */
export interface Piece {
  x: number;
  width: number;
  /** The span starts before the window (a summary's left cap is not drawn). */
  cutStart: boolean;
  /** The span runs past the window. */
  cutEnd: boolean;
}

/** `[x, x + width]` (scale px) in window coordinates, cut to `win`; null
 *  when it lies outside. A point (width 0) on the window's edge is kept. */
export function clip(x: number, width: number, win: Span): Piece | null {
  if (!Number.isFinite(x) || !Number.isFinite(width)) return null;
  const end = x + width;
  if (end < win[0] || x > win[1] || (width > 0 && (end <= win[0] || x >= win[1]))) return null;
  const a = Math.max(x, win[0]);
  const b = Math.min(end, win[1]);
  return { x: a - win[0], width: b - a, cutStart: x < win[0], cutEnd: end > win[1] };
}

/** The nonworking bands that touch the window, in window coordinates. */
export function bandsIn(bands: readonly Band[], win: Span): Piece[] {
  const out: Piece[] = [];
  for (const band of bands) {
    const piece = clip(band.x, band.width, win);
    if (piece && piece.width > 0) out.push(piece);
  }
  return out;
}

/** A vertical line's x (scale px) in window coordinates; null outside it. */
export function lineAt(x: number, win: Span): number | null {
  return Number.isFinite(x) && x >= win[0] && x <= win[1] ? x - win[0] : null;
}

// ── a bar's place in its row ─────────────────────────────────────────

export interface BarBox {
  top: number;
  height: number;
  /** The bar's middle: where links meet it and where a milestone's diamond centers. */
  mid: number;
  /** A summary's bracket bar, from `top`; its end caps hang below it. */
  summaryHeight: number;
  /** The baseline bar under the task bar. */
  baseTop: number;
  baseHeight: number;
}

const BASELINE_GAP = 2;

/** The bar's box in a row `rowH` tall: centered, or lifted with the
 *  baseline bar under it when the baseline shows. */
export function barBox(rowH: number, baseline: boolean): BarBox {
  const height = Math.max(6, Math.round(rowH * 0.4));
  const baseHeight = Math.max(3, Math.round(rowH * 0.14));
  const block = baseline ? height + BASELINE_GAP + baseHeight : height;
  const top = Math.max(0, Math.floor((rowH - block) / 2));
  return {
    top, height, mid: top + height / 2, summaryHeight: Math.max(4, Math.round(height / 2)),
    baseTop: top + height + BASELINE_GAP, baseHeight,
  };
}

// ── the initiative's scheduled window ────────────────────────────────

/** An initiative's date-only fields: `YYYY-MM-DD`, or that day at midnight UTC. */
export interface DayWindow {
  start: string | null;
  end: string | null;
}

/** The plan day a date-only field names, read from its digits (a midnight
 *  UTC instant would shift a day in a browser west of UTC); null when it
 *  isn't one. */
function dayText(value: string | null | undefined): string | null {
  if (!value) return null;
  const day = dayOf(value);
  return Number.isNaN(toMs(day)) ? null : day;
}

/** The window's days as ms of the plan clock, the last day whole; one end
 *  alone is that one day. */
export function windowSpan(w: DayWindow | null | undefined): Span | null {
  const a = dayText(w?.start);
  const b = dayText(w?.end);
  if (!a && !b) return null;
  const ms = [a, b].filter((d): d is string => d !== null).map(toMs);
  return [Math.min(...ms), Math.max(...ms) + MS_PER_DAY];
}

/** "Scheduled: Nov 14–16" (see formatDayRange); "Scheduled: from Nov 14"
 *  or "…until Nov 16" for one end; null with neither. */
export function windowLabel(w: DayWindow | null | undefined): string | null {
  const a = dayText(w?.start);
  const b = dayText(w?.end);
  if (a && b) return `Scheduled: ${a <= b ? formatDayRange(a, b) : formatDayRange(b, a)}`;
  if (a) return `Scheduled: from ${formatDayRange(a, a)}`;
  if (b) return `Scheduled: until ${formatDayRange(b, b)}`;
  return null;
}

// the window's label in the timescale's top tier: the tier's type is
// monospace (10.5px, 0.02em spacing), so a label's width is its length

/** px one character of the timescale's type takes (a little generous). */
export const TIER_CHAR_PX = 6.8;
/** A tick's left padding before its label. */
export const TIER_PAD = 6;
/** The room kept between the window's label and a tick's label. */
export const PILL_GAP = 8;
/** The window label's padding and border, both sides together. */
const PILL_PAD = 18;

/** The window label's width for `text`. */
export function pillWidth(text: string): number {
  return text.length * TIER_CHAR_PX + PILL_PAD;
}

/**
 * Where the window's label goes in the top tier (window coordinates, like
 * `top`): at the band's left edge when that is clear of the tier's labels,
 * else at the clear spot nearest it — just after a tick's label, or ending
 * just before one. It sits in the timescale, so it never covers a bar.
 */
export function windowPillX(bandX: number, text: string, top: readonly Tick[]): number {
  const width = pillWidth(text);
  const ends = top.map((t) => t.x + TIER_PAD + t.label.length * TIER_CHAR_PX + PILL_GAP);
  const clear = (x: number) => top.every((t, i) => x >= ends[i] || x + width + PILL_GAP <= t.x);
  if (clear(bandX)) return bandX;
  const spots = [...ends, ...top.map((t) => t.x - PILL_GAP - width)].filter((x) => x >= 0 && clear(x));
  return spots.reduce((best, x) => (Math.abs(x - bandX) < Math.abs(best - bandX) ? x : best), spots[0] ?? bandX);
}

/**
 * The window label's x with the view scrolled to `viewX` (window
 * coordinates): the top-tier unit holding the view's left edge keeps its
 * label there (plans.css `.pln-tick-label`, stopping whole at the unit's
 * end), so a label at `baseX` that it would run into moves past it, and
 * on past any later unit's label it then runs into.
 */
export function pillAt(baseX: number, text: string, top: readonly Tick[], viewX: number): number {
  const at = top.findIndex((t) => viewX >= t.x && viewX < t.x + t.width);
  if (at < 0) return baseX;
  const width = pillWidth(text);
  const tick = top[at];
  const labelW = tick.label.length * TIER_CHAR_PX;
  const held = Math.min(Math.max(0, viewX - tick.x), Math.max(0, tick.width - 2 * TIER_PAD - labelW));
  const left = tick.x + TIER_PAD + held;
  if (!(baseX < left + labelW + PILL_GAP && baseX + width + PILL_GAP > left)) return baseX;
  let x = left + labelW + PILL_GAP;
  for (const next of top.slice(at + 1)) {
    const end = next.x + TIER_PAD + next.label.length * TIER_CHAR_PX + PILL_GAP;
    if (x < end && x + width + PILL_GAP > next.x) x = end;
  }
  return x;
}

/** The span makeScale is given: the project's, widened to take in the
 *  initiative's window so its band is always on the scale. */
export function scaleSpan(
  projectStart: string, projectFinish: string | null, win: Span | null,
): { start: string; finish: string | null } {
  if (!win) return { start: projectStart, finish: projectFinish };
  const start = toMs(projectStart);
  const finish = projectFinish ? toMs(projectFinish) : Number.NaN;
  return {
    start: win[0] < start ? fromMs(win[0]) : projectStart,
    finish: Number.isNaN(finish) || win[1] > finish ? fromMs(win[1]) : projectFinish,
  };
}

// ── links ────────────────────────────────────────────────────────────

/**
 * The links to draw: both ends shown (in `rowIndex`; a task collapsed
 * away under a summary has no row, so its links are hidden) and at least
 * one end within the rendered rows `first..last` and `overscan` more rows
 * each side. The far end is placed by its row (`linkRow`), so a link to
 * a task out of sight runs off the edge, as in MS Project. A 1,500-task
 * plan draws the links touching tens of rows, not thousands.
 */
export function linksToDraw(
  links: readonly PlanLink[], rowIndex: ReadonlyMap<string, number>, first: number, last: number, overscan: number,
): PlanLink[] {
  const lo = first - overscan;
  const hi = last + overscan;
  const near = (i: number) => i >= lo && i <= hi;
  return links.filter((link) => {
    const a = rowIndex.get(link.predecessor_id);
    const b = rowIndex.get(link.successor_id);
    return a !== undefined && b !== undefined && (near(a) || near(b));
  });
}

/** The row a link end is drawn at: its own, or for a far end one row past
 *  the drawn rows `lo..hi`, where the SVG cuts it, so its line visibly
 *  leaves the edge without the SVG growing to reach it. */
export function linkRow(index: number, lo: number, hi: number): number {
  return Math.min(Math.max(index, lo - 1), hi + 1);
}

/** The straight run out of and into a bar: shorter at the coarse zooms,
 *  where an FS gap is only a few px wide. */
export function linkStub(zoom: Zoom): number {
  if (zoom === 'weeks') return 6;
  if (zoom === 'months' || zoom === 'quarters') return 4;
  return LINK_STUB;
}

/** A bar's link ends; a milestone's are its diamond's tips. */
export function linkEnd(bar: Bar, milestone: boolean, y: number): LinkEnd {
  return milestone
    ? { x0: bar.x - MILESTONE_HALF, x1: bar.x + MILESTONE_HALF, y }
    : { x0: bar.x, x1: bar.x + bar.width, y };
}

export type ArrowDir = 'left' | 'right' | 'up' | 'down';

export interface LinkShape {
  /** The line, ending under the arrowhead. */
  d: string;
  /** The arrowhead: a triangle, as `<polygon points>`. */
  head: string;
  /** Which way the arrowhead points: the way the path's last run goes. */
  dir: ArrowDir;
  tip: readonly [x: number, y: number];
}

/** The arrowhead's length along the line and half its width, in px. */
export const ARROW_LEN = 5;
export const ARROW_HALF = 3.5;

const round = (v: number): number => Math.round(v * 100) / 100;
const fmt = (v: number): string => String(round(v));

/** The points of a linkPath (`M x y` then `H`/`V` runs). */
function pointsOf(d: string): [number, number][] {
  const tokens = d.match(/[MHV]|-?\d+(?:\.\d+)?/g) ?? [];
  const points: [number, number][] = [];
  let cmd = '';
  let x = 0;
  let y = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === 'M' || t === 'H' || t === 'V') {
      cmd = t;
      continue;
    }
    if (cmd === 'M') {
      x = Number(t);
      y = Number(tokens[i + 1]);
      i += 1;
    } else if (cmd === 'H') {
      x = Number(t);
    } else if (cmd === 'V') {
      y = Number(t);
    }
    points.push([x, y]);
  }
  return points;
}

/**
 * A link's line and arrowhead. The arrowhead points the way the path's
 * last run goes, whatever came before (a path may be one run, end on a
 * drop, or detour in five). A last run that drops onto the successor (a
 * back-to-back handoff) stops `toHalf` short of the successor's middle,
 * at its top or bottom edge. The line stops just under the arrowhead so
 * its end never shows past the tip. null when an end is not a number.
 */
export function linkShape(
  from: LinkEnd, to: LinkEnd, type: LinkType, rowH: number, opts: { stub: number; toHalf: number },
): LinkShape | null {
  const d = linkPath(from, to, type, rowH, opts.stub);
  if (!d) return null;
  const points = pointsOf(d);
  if (points.length < 2) return null;
  const [px, py] = points[points.length - 2];
  let [ex, ey] = points[points.length - 1];
  const vertical = ex === px;
  let dir: ArrowDir;
  if (vertical) {
    dir = ey > py ? 'down' : 'up';
    ey = dir === 'down' ? Math.max(py, ey - opts.toHalf) : Math.min(py, ey + opts.toHalf);
  } else {
    dir = ex > px ? 'right' : 'left';
  }
  const tip: [number, number] = [round(ex), round(ey)];

  // the line's end: back under the head (overlapping it by a px), never past the run's start
  const back = ARROW_LEN - 1;
  const lineEnd = vertical
    ? (dir === 'down' ? Math.max(py, ey - back) : Math.min(py, ey + back))
    : (dir === 'right' ? Math.max(px, ex - back) : Math.min(px, ex + back));
  const runs = points.slice(1, -1).map((p, i) => (p[0] !== points[i][0] ? `H ${fmt(p[0])}` : `V ${fmt(p[1])}`));
  const last = vertical ? (lineEnd !== py ? `V ${fmt(lineEnd)}` : '') : (lineEnd !== px ? `H ${fmt(lineEnd)}` : '');
  const line = [`M ${fmt(points[0][0])} ${fmt(points[0][1])}`, ...runs, last].filter(Boolean).join(' ');

  const [tx, ty] = tip;
  const corner = (x: number, y: number) => `${fmt(x)},${fmt(y)}`;
  let head: string;
  if (dir === 'right') head = `${corner(tx, ty)} ${corner(tx - ARROW_LEN, ty - ARROW_HALF)} ${corner(tx - ARROW_LEN, ty + ARROW_HALF)}`;
  else if (dir === 'left') head = `${corner(tx, ty)} ${corner(tx + ARROW_LEN, ty - ARROW_HALF)} ${corner(tx + ARROW_LEN, ty + ARROW_HALF)}`;
  else if (dir === 'down') head = `${corner(tx, ty)} ${corner(tx - ARROW_HALF, ty - ARROW_LEN)} ${corner(tx + ARROW_HALF, ty - ARROW_LEN)}`;
  else head = `${corner(tx, ty)} ${corner(tx - ARROW_HALF, ty + ARROW_LEN)} ${corner(tx + ARROW_HALF, ty + ARROW_LEN)}`;
  return { d: line, head, dir, tip };
}

// ── Scroll to Task ───────────────────────────────────────────────────

/** How far in from the chart's left edge Scroll to Task leaves a bar's start. */
export const SCROLL_PAD = 24;

/** The chart's scroll that brings the task's bar in from the left (a
 *  milestone's diamond whole); null for a task with nothing to draw. */
export function taskScrollLeft(
  scale: Scale, task: Pick<PlanTask, 'start' | 'finish' | 'is_milestone'>,
): number | null {
  const bar = barOf(scale, task);
  if (!bar) return null;
  return Math.max(0, bar.x - (task.is_milestone ? MILESTONE_HALF : 0) - SCROLL_PAD);
}

// ── the hover card ───────────────────────────────────────────────────

export interface Fact {
  label: string;
  value: string;
}

/** The hover card's lines under the task's name, in MS Project's words:
 *  dates as the sheet shows them, the duration and slack in the plan's
 *  units, and the deadline, assignees and slack only when there are some. */
export function hoverFacts(task: PlanTask, plan: Pick<Plan, 'calendar' | 'settings'>): Fact[] {
  const showTimes = plan.settings.show_times;
  const units = planUnits(plan);
  const facts: Fact[] = [
    { label: 'Start', value: formatCell(task.start, showTimes) },
    { label: 'Finish', value: formatCell(task.finish, showTimes) },
    { label: 'Duration', value: formatDuration(task.duration_minutes, task.duration_unit, task.elapsed, units) },
    { label: '% Complete', value: `${task.percent_complete}%` },
  ];
  if (task.assignees.length) facts.push({ label: 'Resource Names', value: task.assignees.map((a) => a.name).join(', ') });
  if (task.deadline) facts.push({ label: 'Deadline', value: formatCell(task.deadline, showTimes) });
  if (task.total_slack_minutes !== null) {
    facts.push({ label: 'Total Slack', value: formatDuration(task.total_slack_minutes, 'd', false, units) });
  }
  return facts;
}

// ── stored settings ──────────────────────────────────────────────────

const ZOOM_PREFIX = 'plans.zoom.';

/** The plan's zoom in this browser; days when none is kept (or storage refuses). */
export function readZoom(planId: string | null): Zoom {
  if (!planId) return 'days';
  try {
    const stored = localStorage.getItem(ZOOM_PREFIX + planId);
    return ZOOMS.find((z) => z === stored) ?? 'days';
  } catch {
    return 'days';
  }
}

export function writeZoom(planId: string, zoom: Zoom): void {
  try {
    localStorage.setItem(ZOOM_PREFIX + planId, zoom);
  } catch {
    // storage refused: the zoom lasts this visit only
  }
}

/** The splitter's place: the sheet pane's width in px, for every plan. */
export const SPLIT_KEY = 'plans.split.v1';
export const SPLITTER_PX = 6;
export const MIN_SHEET_PX = 160;
export const MIN_CHART_PX = 200;
/** The sheet's share of the view until the splitter is moved. */
const DEFAULT_SPLIT = 0.45;
/** Before the view is measured, with nothing kept. */
const UNMEASURED_SPLIT_PX = 480;

export function readSplit(): number | null {
  try {
    const stored = Number(localStorage.getItem(SPLIT_KEY) ?? Number.NaN);
    return Number.isFinite(stored) && stored > 0 ? Math.round(stored) : null;
  } catch {
    return null;
  }
}

export function writeSplit(px: number): void {
  try {
    localStorage.setItem(SPLIT_KEY, String(Math.round(px)));
  } catch {
    // storage refused: the splitter stays put this visit only
  }
}

/** The widest the sheet pane may be in a view `viewW` wide: the chart keeps
 *  MIN_CHART_PX (the sheet keeps MIN_SHEET_PX before that). */
export function maxSplit(viewW: number): number {
  return Math.max(MIN_SHEET_PX, viewW - SPLITTER_PX - MIN_CHART_PX);
}

/** The sheet pane's width: the kept one, else 45% of the view, held between
 *  MIN_SHEET_PX and maxSplit. A view not measured yet (0) takes the kept
 *  width as it is. */
export function splitWidth(stored: number | null, viewW: number): number {
  if (viewW <= 0) return Math.max(MIN_SHEET_PX, stored ?? UNMEASURED_SPLIT_PX);
  const want = stored ?? Math.round(viewW * DEFAULT_SPLIT);
  return Math.min(Math.max(want, MIN_SHEET_PX), maxSplit(viewW));
}

// ── the layout: Beside, Below or Hidden ─────────────────────────────

/** Where the Gantt chart goes: beside the sheet (the split), under it (for
 *  narrower screens), or nowhere. Kept per browser — it's about the
 *  monitor, not the plan. */
export type GanttLayout = 'beside' | 'below' | 'hidden';
export const GANTT_LAYOUTS: readonly GanttLayout[] = ['beside', 'below', 'hidden'];
export const LAYOUT_KEY = 'plans.layout.v1';

/** The layout kept in this browser; Beside when none (or not one) is kept, or storage refuses. */
export function readLayout(): GanttLayout {
  try {
    const stored = localStorage.getItem(LAYOUT_KEY);
    return GANTT_LAYOUTS.find((l) => l === stored) ?? 'beside';
  } catch {
    return 'beside';
  }
}

export function writeLayout(layout: GanttLayout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, layout);
  } catch {
    // storage refused: the layout lasts this visit only
  }
}

/** Below's splitter: the sheet's height in px (Beside's width keeps SPLIT_KEY). */
export const SPLIT_BELOW_KEY = 'plans.split.below.v1';
/** The sheet's least height in Below: its header, its scrollbar and a few rows. */
export const MIN_SHEET_H = 120;
/** The chart's least height in Below. */
export const MIN_CHART_H = 120;
/** Before the view is measured, with nothing kept. */
const UNMEASURED_SPLIT_H = 280;

export function readSplitBelow(): number | null {
  try {
    const stored = Number(localStorage.getItem(SPLIT_BELOW_KEY) ?? Number.NaN);
    return Number.isFinite(stored) && stored > 0 ? Math.round(stored) : null;
  } catch {
    return null;
  }
}

export function writeSplitBelow(px: number): void {
  try {
    localStorage.setItem(SPLIT_BELOW_KEY, String(Math.round(px)));
  } catch {
    // storage refused: the splitter stays put this visit only
  }
}

/** The tallest the sheet may be in a view `viewH` tall: the chart keeps MIN_CHART_H. */
export function maxSplitHeight(viewH: number): number {
  return Math.max(MIN_SHEET_H, viewH - SPLITTER_PX - MIN_CHART_H);
}

/** The sheet's height in Below: the kept one, else half of what the
 *  splitter leaves, held between MIN_SHEET_H and maxSplitHeight. A view not
 *  measured yet (0) takes the kept height as it is. */
export function splitHeight(stored: number | null, viewH: number): number {
  if (viewH <= 0) return Math.max(MIN_SHEET_H, stored ?? UNMEASURED_SPLIT_H);
  const want = stored ?? Math.floor((viewH - SPLITTER_PX) / 2);
  return Math.min(Math.max(want, MIN_SHEET_H), maxSplitHeight(viewH));
}

/** Below's two scrollers stay on the same row, so they must scroll the same
 *  distance: both hold the same rows under the same header, and the one with
 *  the taller view gets the difference as extra room at its end (else the
 *  shorter one's last rows would be out of the other's reach). 0s until
 *  both are measured. */
export function endPads(sheetH: number, chartH: number): { sheet: number; chart: number } {
  if (sheetH <= 0 || chartH <= 0) return { sheet: 0, chart: 0 };
  return { sheet: Math.max(0, sheetH - chartH), chart: Math.max(0, chartH - sheetH) };
}

/** A task name's widest at its bar (Below), px. */
export const LABEL_MAX_PX = 200;
/** Less room than this before a bar and its name goes after it. */
export const LABEL_MIN_PX = 48;
/** Between a bar and the name left of it: a link's stub (and its
 *  arrowhead, inside it) into the bar's start or out of it, and its turn
 *  there, stay clear of the name. */
export const LABEL_GAP_PX = LINK_STUB + 4;

/** Where a task's name goes in Below, where the names aren't beside the
 *  bars: left of its bar, ellipsized to the room there (`room`: px from the
 *  scale's start to the bar's), else after the bar. */
export function labelPlace(room: number): { side: 'before' | 'after'; width: number } {
  const width = Math.min(LABEL_MAX_PX, room - LABEL_GAP_PX);
  return width >= LABEL_MIN_PX ? { side: 'before', width } : { side: 'after', width: LABEL_MAX_PX };
}
