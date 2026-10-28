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

/**
 * The pixel axis for a plan: two bottom-tier units before the project start
 * and four after its finish, both snapped to the unit's edge. An empty plan
 * (no finish) or a finish before the start draws as if it finished at its
 * start. A start that is not a plan time is a bug in the caller: it throws.
 */
export function makeScale(
  projectStart: string, projectFinish: string | null | undefined, zoom: Zoom,
): Scale {
  const start = toMs(projectStart);
  if (Number.isNaN(start)) throw new RangeError(`makeScale: not a plan time: ${projectStart}`);
  const finishMs = projectFinish ? toMs(projectFinish) : Number.NaN;
  const finish = Number.isNaN(finishMs) ? start : Math.max(start, finishMs);

  const unit = BOTTOM_UNIT[zoom];
  const startMs = ADD[unit](FLOOR[unit](start), -PAD_BEFORE);
  const endMs = ADD[unit](ceil(unit, finish), PAD_AFTER);
  const perDay = ZOOM_PX_PER_DAY[zoom];
  return { startMs, endMs, pxPerMs: perDay / MS_PER_DAY, width: ((endMs - startMs) * perDay) / MS_PER_DAY };
}

/** The zoom that fits the plan in `widthPx`: the finest one whose scale is no
 *  wider, else quarters. */
export function fitZoom(projectStart: string, projectFinish: string | null | undefined, widthPx: number): Zoom {
  for (const zoom of ZOOMS) {
    if (makeScale(projectStart, projectFinish, zoom).width <= widthPx) return zoom;
  }
  return 'quarters';
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
function ticksOf(scale: Scale, unit: Unit, label: Labeler): Tick[] {
  const ticks: Tick[] = [];
  let at = FLOOR[unit](scale.startMs);
  while (at < scale.endMs) {
    const next = ADD[unit](at, 1);
    const from = Math.max(at, scale.startMs);
    ticks.push({
      x: xOfMs(scale, from),
      width: widthOfMs(scale, Math.min(next, scale.endMs) - from),
      label: label(at),
    });
    at = next;
  }
  return ticks;
}

/** The two header tiers for the zoom the scale was made at. */
export function tiers(scale: Scale, zoom: Zoom): { top: Tick[]; bottom: Tick[] } {
  return {
    top: ticksOf(scale, TOP_UNIT[zoom], LABELS[zoom].top),
    bottom: ticksOf(scale, BOTTOM_UNIT[zoom], LABELS[zoom].bottom),
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

/** A bar's ends and the y of its row's center, in px. */
export interface LinkEnd {
  x0: number;
  x1: number;
  y: number;
}

/** The straight run out of, and into, a bar before the line turns. */
export const LINK_STUB = 8;

const hundredth = (v: number): string => String(Math.round(v * 100) / 100);

/**
 * A right-angle SVG path for a link, from the predecessor's end (FS, FF) or
 * start (SS, SF) to the successor's start (FS, SS) or end (FF, SF).
 *
 * The line leaves the predecessor on the side it starts from (right of an
 * end, left of a start) by `stub` px, drops to the successor's row, and runs
 * into the successor's edge: `M x1 y H x1+8 V y2 H x0'` for a forward FS.
 * When that last run would have to turn back (the successor's edge lies
 * behind the stub, as in `x0' < x1 + 8` for FS), the line detours instead:
 * out, onto the line between the predecessor's row and the next one (the
 * previous one when the successor is above), across, down to the successor's
 * row `stub` px clear of its edge, and in. Five runs after the `M`.
 *
 * Coordinates are rounded to a hundredth of a pixel. A narrower `stub` suits
 * the coarse zooms, where an FS gap is only a few px wide.
 */
export function linkPath(
  from: LinkEnd, to: LinkEnd, type: LinkType, rowH: number, stub: number = LINK_STUB,
): string {
  const out = type === 'FS' || type === 'FF' ? 1 : -1;        // the side the line leaves by
  const into = type === 'FS' || type === 'SS' ? 1 : -1;       // the way its last run travels
  const x = out > 0 ? from.x1 : from.x0;
  const edge = into > 0 ? to.x0 : to.x1;
  const turn = x + out * stub;
  const head = `M ${hundredth(x)} ${hundredth(from.y)} H ${hundredth(turn)}`;
  if ((edge - turn) * into >= 0) {
    return `${head} V ${hundredth(to.y)} H ${hundredth(edge)}`;
  }
  const between = from.y + (to.y < from.y ? -rowH : rowH) / 2;
  return `${head} V ${hundredth(between)} H ${hundredth(edge - into * stub)}`
    + ` V ${hundredth(to.y)} H ${hundredth(edge)}`;
}
