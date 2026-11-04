/**
 * Gantt chart geometry: plan times to pixels, the two-tier timescale, bar and
 * link-arrow shapes. Pure functions; the portal never schedules, it draws the
 * dates the API computed.
 *
 * Plan times are floating wall-clock text (floatingTime.ts). They are read
 * with `toMs` as UTC-naive epoch milliseconds, and every calendar question
 * here (which day, which weekday, which month) goes through the getUTC*
 * getters or plain millisecond arithmetic, so a tick reads the same in a
 * browser in any zone (Review Focus 4). Never `new Date(text)`, never a
 * local getter.
 *
 * The x axis is `(ms - scale.startMs)` times the zoom's px per day over the
 * length of a day. That order (multiply, then divide) keeps whole-day and
 * whole-hour positions exact: `x * (px / ms)` would give 111.99999999999999
 * for 08:00 on the third day at 48 px a day.
 */
import type { PlanTask } from './api';
import { toMs } from './floatingTime';
import type { LinkType } from './predecessors';

export const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_WEEK = 7 * MS_PER_DAY;

/** The straight run out of, and into, a bar before a link line turns, in px. */
export const LINK_STUB = 8;

/** Half the width of a milestone's diamond, in px: it has no bar of its own,
 *  so it hangs this far past its instant on each side. */
export const MILESTONE_HALF = 6;

/** The room `fitZoom` keeps in the pane beyond the plan's own span: a link stub
 *  at each end and a milestone's half-width past the last date. */
export const FIT_MARGIN = 2 * LINK_STUB + MILESTONE_HALF;

// ── zoom ─────────────────────────────────────────────────────────────

export type Zoom = 'hours' | 'days' | 'weeks' | 'months' | 'quarters';

/** Finest first: `zoomIn` moves toward the front, `zoomOut` toward the back. */
export const ZOOMS: readonly Zoom[] = ['hours', 'days', 'weeks', 'months', 'quarters'];

export const ZOOM_PX_PER_DAY: Record<Zoom, number> = {
  hours: 480, days: 48, weeks: 18, months: 5, quarters: 1.8,
};

export function zoomIn(zoom: Zoom): Zoom {
  return ZOOMS[Math.max(0, ZOOMS.indexOf(zoom) - 1)];
}

export function zoomOut(zoom: Zoom): Zoom {
  return ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + 1)];
}

// ── calendar units (all UTC) ─────────────────────────────────────────

type Unit = 'hour' | 'day' | 'week' | 'month' | 'quarter' | 'year';

const mod = (n: number, m: number): number => ((n % m) + m) % m;

/** The first moment of the month, quarter or year (`step` months) holding `ms`. */
function monthFloor(ms: number, step: number): number {
  const at = new Date(ms);
  const month = at.getUTCMonth();
  return Date.UTC(at.getUTCFullYear(), month - (month % step), 1);
}

/** `ms` is the first moment of a month; `n` months later (earlier if negative). */
function monthAdd(ms: number, n: number): number {
  const at = new Date(ms);
  return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + n, 1);
}

/** The start of the unit that holds `ms`. Weeks begin on Monday, as the
 *  calendar's `week` does: the epoch day 0 was a Thursday. */
const FLOOR: Record<Unit, (ms: number) => number> = {
  hour: (ms) => Math.floor(ms / MS_PER_HOUR) * MS_PER_HOUR,
  day: (ms) => Math.floor(ms / MS_PER_DAY) * MS_PER_DAY,
  week: (ms) => (Math.floor(ms / MS_PER_DAY) - mod(Math.floor(ms / MS_PER_DAY) + 3, 7)) * MS_PER_DAY,
  month: (ms) => monthFloor(ms, 1),
  quarter: (ms) => monthFloor(ms, 3),
  year: (ms) => monthFloor(ms, 12),
};

/** `n` units after `ms`, which must already be the start of a unit. */
const ADD: Record<Unit, (ms: number, n: number) => number> = {
  hour: (ms, n) => ms + n * MS_PER_HOUR,
  day: (ms, n) => ms + n * MS_PER_DAY,
  week: (ms, n) => ms + n * MS_PER_WEEK,
  month: (ms, n) => monthAdd(ms, n),
  quarter: (ms, n) => monthAdd(ms, 3 * n),
  year: (ms, n) => monthAdd(ms, 12 * n),
};

/** The start of the unit holding `ms`, or `ms` itself when it is on one. */
function ceil(unit: Unit, ms: number): number {
  const floor = FLOOR[unit](ms);
  return floor === ms ? ms : ADD[unit](floor, 1);
}

const BOTTOM_UNIT: Record<Zoom, Unit> = {
  hours: 'hour', days: 'day', weeks: 'week', months: 'month', quarters: 'quarter',
};

const TOP_UNIT: Record<Zoom, Unit> = {
  hours: 'day', days: 'week', weeks: 'month', months: 'quarter', quarters: 'year',
};

// ── scale ────────────────────────────────────────────────────────────

export interface Scale {
  startMs: number;
  endMs: number;
  pxPerMs: number;
  width: number;
}

const PAD_BEFORE = 2;
const PAD_AFTER = 4;

/** The project's start and finish as epoch ms. An empty plan (no finish), a
 *  finish that is not a plan time and a finish before the start all read as
 *  finishing at the start. A start that is not a plan time is a bug in the
 *  caller: it throws. */
function projectSpan(
  caller: string, projectStart: string, projectFinish: string | null | undefined,
): { start: number; finish: number } {
  const start = toMs(projectStart);
  if (Number.isNaN(start)) throw new RangeError(`${caller}: not a plan time: ${projectStart}`);
  const finish = projectFinish ? toMs(projectFinish) : Number.NaN;
  return { start, finish: Number.isNaN(finish) ? start : Math.max(start, finish) };
}

/**
 * The pixel axis for a plan: two bottom-tier units before the project start
 * and four after its finish, both snapped to the unit's edge.
 */
export function makeScale(
  projectStart: string, projectFinish: string | null | undefined, zoom: Zoom,
): Scale {
  const { start, finish } = projectSpan('makeScale', projectStart, projectFinish);
  const unit = BOTTOM_UNIT[zoom];
  const startMs = ADD[unit](FLOOR[unit](start), -PAD_BEFORE);
  const endMs = ADD[unit](ceil(unit, finish), PAD_AFTER);
  const perDay = ZOOM_PX_PER_DAY[zoom];
  return { startMs, endMs, pxPerMs: perDay / MS_PER_DAY, width: ((endMs - startMs) * perDay) / MS_PER_DAY };
}

/**
 * The zoom that fits the plan in a pane `widthPx` wide: the finest one at which
 * the plan's own span (start to finish, not snapped to a unit and without the
 * scale's padding, which scrolls out of the way) is no wider than the pane less
 * FIT_MARGIN; quarters when none is. A plan with no span (start == finish, or
 * no finish) is shown at days. After applying a fit, scroll to `fitScrollLeft`.
 */
export function fitZoom(projectStart: string, projectFinish: string | null | undefined, widthPx: number): Zoom {
  const { start, finish } = projectSpan('fitZoom', projectStart, projectFinish);
  if (finish <= start) return 'days';
  const room = widthPx - FIT_MARGIN;
  for (const zoom of ZOOMS) {
    if (((finish - start) * ZOOM_PX_PER_DAY[zoom]) / MS_PER_DAY <= room) return zoom;
  }
  return 'quarters';
}

/** Where to scroll the Gantt after a fit: the project start, half the margin
 *  in from the pane's left edge (never left of the scale; 0 for a start that
 *  is not a plan time). */
export function fitScrollLeft(scale: Scale, projectStart: string): number {
  const left = xOf(scale, projectStart) - FIT_MARGIN / 2;
  return Number.isFinite(left) ? Math.max(0, left) : 0;
}

/** The scale's px per day, whole for every zoom (480, 48, 18, 5, 1.8). */
export const pxPerDay = (scale: Scale): number => scale.pxPerMs * MS_PER_DAY;

/** The width in px of a span of milliseconds. */
export const widthOfMs = (scale: Scale, spanMs: number): number => (spanMs * pxPerDay(scale)) / MS_PER_DAY;

/** The x in px of a moment, in epoch milliseconds of the plan's UTC-naive clock. */
export const xOfMs = (scale: Scale, ms: number): number => widthOfMs(scale, ms - scale.startMs);

/** The x in px of a plan time; NaN when the text is not one. */
export const xOf = (scale: Scale, s: string): number => xOfMs(scale, toMs(s));

/** The inverse of `xOf`: the moment (epoch ms of the same UTC clock) at x px.
 *  Not rounded; the drag code snaps it. `fromMs` turns it back into plan text. */
export const msOf = (scale: Scale, x: number): number => scale.startMs + (x * MS_PER_DAY) / pxPerDay(scale);

// ── timescale ────────────────────────────────────────────────────────

export interface Tick {
  x: number;
  width: number;
  label: string;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const WEEKDAY_LETTERS = 'SMTWTFS';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

type Labeler = (ms: number) => string;

interface TierLabels {
  top: Labeler;
  bottom: Labeler;
}

const quarterOf = (at: Date): number => Math.floor(at.getUTCMonth() / 3) + 1;

const LABELS: Record<Zoom, TierLabels> = {
  // Mon 11/2 over 8
  hours: {
    top: (ms) => { const at = new Date(ms); return `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCMonth() + 1}/${at.getUTCDate()}`; },
    bottom: (ms) => String(new Date(ms).getUTCHours()),
  },
  // Nov 2, '26 (the week's Monday) over M T W...
  days: {
    top: (ms) => {
      const at = new Date(ms);
      return `${MONTHS_SHORT[at.getUTCMonth()]} ${at.getUTCDate()}, '${String(at.getUTCFullYear() % 100).padStart(2, '0')}`;
    },
    bottom: (ms) => WEEKDAY_LETTERS[new Date(ms).getUTCDay()],
  },
  // November 2026 over 11/2 (the week's Monday)
  weeks: {
    top: (ms) => { const at = new Date(ms); return `${MONTHS[at.getUTCMonth()]} ${at.getUTCFullYear()}`; },
    bottom: (ms) => { const at = new Date(ms); return `${at.getUTCMonth() + 1}/${at.getUTCDate()}`; },
  },
  // Q4 2026 over Nov
  months: {
    top: (ms) => { const at = new Date(ms); return `Q${quarterOf(at)} ${at.getUTCFullYear()}`; },
    bottom: (ms) => MONTHS_SHORT[new Date(ms).getUTCMonth()],
  },
  // 2026 over Q4
  quarters: {
    top: (ms) => String(new Date(ms).getUTCFullYear()),
    bottom: (ms) => `Q${quarterOf(new Date(ms))}`,
  },
};

/** One tier: a tick per unit, the first and last cut off at the scale's edges
 *  so the ticks tile 0..width. A cut-off tick keeps the label of its whole unit. */
function ticksOf(scale: Scale, unit: Unit, label: Labeler, fromX: number, toX: number): Tick[] {
  const ticks: Tick[] = [];
  // start at the unit holding the window's left edge, not at the scale's start
  let at = FLOOR[unit](Math.max(scale.startMs, msOf(scale, fromX)));
  while (at < scale.endMs) {
    const next = ADD[unit](at, 1);
    const from = Math.max(at, scale.startMs);
    const x = xOfMs(scale, from);
    if (x >= toX) break;
    const width = widthOfMs(scale, Math.min(next, scale.endMs) - from);
    if (x + width > fromX) ticks.push({ x, width, label: label(at) });
    at = next;
  }
  return ticks;
}

/**
 * The two header tiers for the zoom the scale was made at. With a `window`
 * `[fromX, toX]` (the visible part of the scale, in px) only the ticks that
 * overlap it are made, whole and not cut to it: a 3-year hours scale holds
 * 26,000 ticks, a 1,500px window of it under 100. A side that is not a
 * number is open; a window with no width holds nothing.
 */
export function tiers(
  scale: Scale, zoom: Zoom, window?: readonly [fromX: number, toX: number],
): { top: Tick[]; bottom: Tick[] } {
  const fromX = window && !Number.isNaN(window[0]) ? window[0] : Number.NEGATIVE_INFINITY;
  const toX = window && !Number.isNaN(window[1]) ? window[1] : Number.POSITIVE_INFINITY;
  if (toX <= fromX) return { top: [], bottom: [] };
  return {
    top: ticksOf(scale, TOP_UNIT[zoom], LABELS[zoom].top, fromX, toX),
    bottom: ticksOf(scale, BOTTOM_UNIT[zoom], LABELS[zoom].bottom, fromX, toX),
  };
}

// ── bars ─────────────────────────────────────────────────────────────

export interface Bar {
  x: number;
  width: number;
}

const timeOf = (s: string | null | undefined): number => (s ? toMs(s) : Number.NaN);

/**
 * Where a task's bar sits. A milestone is a point: its x, width 0. null when
 * the task lacks the dates to draw (a plan time of null, or not a real one).
 * A finish before the start gives width 0, never a negative one.
 */
export function barOf(
  scale: Scale, task: Pick<PlanTask, 'start' | 'finish' | 'is_milestone'>,
): Bar | null {
  const start = timeOf(task.start);
  const finish = timeOf(task.finish);
  if (task.is_milestone) {
    const at = Number.isNaN(start) ? finish : start;
    return Number.isNaN(at) ? null : { x: xOfMs(scale, at), width: 0 };
  }
  if (Number.isNaN(start) || Number.isNaN(finish)) return null;
  return { x: xOfMs(scale, start), width: Math.max(0, widthOfMs(scale, finish - start)) };
}

/** The part of a bar filled in for `percent` complete (clamped to 0-100). */
export function progressWidth(bar: Pick<Bar, 'width'>, percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return (bar.width * Math.min(100, Math.max(0, percent))) / 100;
}

/** Where the task's baseline sits; null without a baseline start and finish. */
export function baselineOf(
  scale: Scale, task: Pick<PlanTask, 'baseline_start' | 'baseline_finish'>,
): Bar | null {
  const start = timeOf(task.baseline_start);
  const finish = timeOf(task.baseline_finish);
  if (Number.isNaN(start) || Number.isNaN(finish)) return null;
  return { x: xOfMs(scale, start), width: Math.max(0, widthOfMs(scale, finish - start)) };
}

// ── link arrows ──────────────────────────────────────────────────────

/** A bar's ends and the y of its row's center, in px. A milestone has
 *  x0 === x1. */
export interface LinkEnd {
  x0: number;
  x1: number;
  y: number;
}

type Point = readonly [x: number, y: number];

const hundredth = (v: number): number => Math.round(v * 100) / 100;

/** The points (each a step along one axis from the one before) as a path
 *  `M x y` then `H`/`V` runs, to a hundredth of a pixel. A run of no length is
 *  left out, and two runs the same way in a row are one. */
function trace(points: readonly Point[]): string {
  const [first, ...rest] = points.map(([x, y]): Point => [hundredth(x), hundredth(y)]);
  const runs: { axis: 'H' | 'V'; to: number; sign: number }[] = [];
  let [cx, cy] = first;
  for (const [x, y] of rest) {
    const axis = x !== cx ? 'H' : 'V';
    const delta = axis === 'H' ? x - cx : y - cy;
    if (delta !== 0) {
      const to = axis === 'H' ? x : y;
      const last = runs[runs.length - 1];
      if (last && last.axis === axis && last.sign === Math.sign(delta)) last.to = to;
      else runs.push({ axis, to, sign: Math.sign(delta) });
    }
    [cx, cy] = [x, y];
  }
  return `M ${first[0]} ${first[1]}${runs.map((run) => ` ${run.axis} ${run.to}`).join('')}`;
}

/**
 * A right-angle SVG path for a link, from the predecessor's end (FS, FF) or
 * start (SS, SF) to the successor's start (FS, SS) or end (FF, SF).
 *
 * The line leaves the predecessor on the side it starts from (right of an
 * end, left of a start), drops to the successor's row at a vertical run, and
 * runs into the successor's edge: `M x1 y H x1+8 V y2 H x0'` for an FS whose
 * successor starts 8px or more past the end. Where the vertical run goes:
 *
 * - FS, SF (the line leaves and arrives the same way): `stub` px out, or at
 *   the successor's edge when that is nearer, so a back-to-back handoff drops
 *   straight onto the successor (`M 226 20 V 60` for zero lag) instead of
 *   looping. When the edge lies behind the predecessor's own edge the line
 *   detours: out `stub` px, onto the line between the predecessor's row and
 *   the next one (the previous one when the successor is above), across, down
 *   to the successor's row `stub` px clear of its edge, and in. Five runs.
 * - FF, SS (it leaves and arrives opposite ways): `stub` px out, or `stub` px
 *   past the successor's edge when that is farther, so it never needs the
 *   detour (`M 200 100 H 508 V 20 H 500`).
 *
 * Runs of no length are left out. Coordinates are rounded to a hundredth of
 * a pixel. A narrower `stub` suits the coarse zooms, where an FS gap is only
 * a few px wide. Any input that is not finite gives `''`.
 */
export function linkPath(
  from: LinkEnd, to: LinkEnd, type: LinkType, rowH: number, stub: number = LINK_STUB,
): string {
  if (![from.x0, from.x1, from.y, to.x0, to.x1, to.y, rowH, stub].every(Number.isFinite)) return '';
  const out = type === 'FS' || type === 'FF' ? 1 : -1;        // the side the line leaves by
  const into = type === 'FS' || type === 'SS' ? 1 : -1;       // the way its last run travels
  const x = out > 0 ? from.x1 : from.x0;
  const edge = into > 0 ? to.x0 : to.x1;
  const turn = x + out * stub;

  let drop: number | null;
  if (out === into) {
    const ahead = (edge - x) * out;                           // how far on the edge lies
    drop = ahead >= 0 ? x + out * Math.min(stub, ahead) : null;
  } else {
    drop = (edge - turn) * into >= 0 ? turn : edge + out * stub;
  }
  if (drop !== null) return trace([[x, from.y], [drop, from.y], [drop, to.y], [edge, to.y]]);

  const between = from.y + (to.y < from.y ? -rowH : rowH) / 2;
  const lead = edge - into * stub;
  return trace([[x, from.y], [turn, from.y], [turn, between], [lead, between], [lead, to.y], [edge, to.y]]);
}
