/**
 * Gantt bar drags, as pure functions: which part of a bar a press lands on
 * (`dragKind`), the snap of each zoom (`snapMs`), and the ops a finished
 * drag sends (`opsForDrag`). The portal schedules nothing: a move sends the
 * new Start (the API adds a Start No Earlier Than constraint to an auto
 * task, and keeps a manual task's span), a resize the new Duration, a
 * progress drag the new % Complete, a link drag a Finish-to-Start link;
 * the API computes every date from them.
 *
 * Positions are px on the chart's scale (ganttGeometry `xOf`), times the
 * UTC-naive epoch ms of floatingTime.ts. A resize measures the working
 * time from the task's start to where its end was let go on the plan's
 * calendar (`workMinutes`, the API's `work_between`), so the Duration is
 * what that drop means, in the task's own unit.
 */
import type { Op, Plan, PlanCalendar, PlanTask, WorkInterval } from './api';
import {
  MAX_DURATION_TEXT, MAX_INTEGER_DIGITS, durationLabel, parseDuration, unitMinutes, type DurationUnit, type Units,
} from './durations';
import { dayOf, fromMs, toMs } from './floatingTime';
import { MILESTONE_HALF, MS_PER_DAY, type Zoom } from './ganttGeometry';

export type DragKind = 'move' | 'resize' | 'progress' | 'link';

/** The bar's right end that resizes it, px. */
export const RESIZE_PX = 6;
/** How far either side of the progress edge its handle reaches, px: MS
 *  Project's few px, so a press near a half-done bar's middle still moves it. */
export const GRIP_PX = 3;
/** A bar narrower than this has no progress handle: a day at the days zoom
 *  (18px) would be a third handle, and pressing its middle should move it.
 *  Its progress is set at a finer zoom, or in the sheet. */
export const MIN_GRIP_BAR_PX = 24;
/** The link handle's width right of the bar, px: a dot at its middle. */
export const LINK_DOT_PX = 16;
/** A press that moves less than this is a click, not a drag, px. */
export const DRAG_THRESHOLD_PX = 3;
/** How far beside a bar a link drop still lands on it, px. */
export const DROP_SLOP_PX = 4;

/** A bar as a press reads it: where it is, how much of it is done (px), and
 *  whether it is a milestone's diamond (`x` its instant, no width). */
export interface DragBar {
  x: number;
  width: number;
  done: number;
  milestone: boolean;
}

/** The right end of a bar that resizes it: 6px, a third of a narrow bar. */
export const resizeEdge = (width: number): number => Math.min(RESIZE_PX, width / 3);

/** The bar's right end, px (a diamond's right tip). */
export const barEnd = (bar: Pick<DragBar, 'x' | 'width' | 'milestone'>): number =>
  (bar.milestone ? bar.x + MILESTONE_HALF : bar.x + bar.width);

/** Whether the bar has a progress handle at all. `progressOnly` (a locked
 *  plan, where progress is the only drag) drops the narrow-bar floor: there
 *  is no move to keep room for. */
export const hasGrip = (bar: Pick<DragBar, 'width' | 'milestone'>, progressOnly = false): boolean =>
  !bar.milestone && (progressOnly || bar.width >= MIN_GRIP_BAR_PX);

/** Where the progress handle sits: the progress edge, kept left of the
 *  resize zone so a bar at 100% can still be grabbed by either (with
 *  `progressOnly` there is no resize zone to share). */
export function gripX(bar: DragBar, progressOnly = false): number {
  const room = progressOnly ? bar.width : bar.width - resizeEdge(bar.width);
  return bar.x + Math.min(Math.max(bar.done, 0), room);
}

/**
 * What a press at `pointerX` on a bar does: past its right end (the link
 * handle) `link`; the right 6px `resize`; within GRIP_PX of the progress
 * handle `progress`; anywhere else `move`. A milestone only moves or links.
 * With `progressOnly` (a locked plan) it is `progress` at the handle and
 * `move` (which the plan refuses) anywhere else.
 */
export function dragKind(pointerX: number, bar: DragBar, progressOnly = false): DragKind {
  const atGrip = hasGrip(bar, progressOnly) && Math.abs(pointerX - gripX(bar, progressOnly)) <= GRIP_PX;
  if (progressOnly) return atGrip ? 'progress' : 'move';
  const end = barEnd(bar);
  if (pointerX > end) return 'link';
  if (bar.milestone) return 'move';
  if (pointerX >= end - resizeEdge(bar.width)) return 'resize';
  return atGrip ? 'progress' : 'move';
}

/** What a move of a task that has started gets instead (MS Project moves its
 *  Actual Start; here the engine keeps a started task where it began). */
export const MOVE_REFUSAL = 'This task has started — change its Actual Start instead.';

/** Why `task` can't be moved by a drag, or null: it has an actual start.
 *  Resizing it, its progress and its links are still drags. */
export function moveRefusal(task: Pick<PlanTask, 'actual_start'>): string | null {
  return task.actual_start !== null ? MOVE_REFUSAL : null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** Each zoom's snap: five minutes to the minute, quarter and wide hours to 5
 *  minutes, hours to 15 minutes, days to the hour, coarser to the day. */
export const SNAP_MS: Record<Zoom, number> = {
  fiveMinutes: MINUTE, quarterHours: 5 * MINUTE, wideHours: 5 * MINUTE,
  hours: 15 * MINUTE, days: HOUR, weeks: MS_PER_DAY, months: MS_PER_DAY, quarters: MS_PER_DAY,
};

/** Whether a drag at this zoom shows times, not just days: it snaps finer than a day. */
export function showsTimes(zoom: Zoom): boolean {
  return SNAP_MS[zoom] < MS_PER_DAY;
}

/** The nearest snap of the zoom to `ms` (whole days are midnights of the plan's clock). */
export function snapMs(ms: number, zoom: Zoom): number {
  const step = SNAP_MS[zoom];
  return Math.round(ms / step) * step;
}

/**
 * Where a time `from` dragged by `moved` ms lands: the move itself snaps,
 * at every zoom, so a task keeps its clock time (a 13:00 start moves to
 * 13:00 a week on, an 08:10 one to 09:10 an hour on) and a drop back where
 * it began lands where it began, sending nothing.
 */
export function snapShift(from: number, moved: number, zoom: Zoom): number {
  return from + snapMs(moved, zoom);
}

/** The pointer's x on the scale: in from the chart pane's left edge, plus
 *  the pane's sideways scroll (its content moves by a transform). */
export function pointerScaleX(clientX: number, paneLeft: number, scrollLeft: number): number {
  return clientX - paneLeft + scrollLeft;
}

/** Index by Date.getUTCDay(). */
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;

const clockMs = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * HOUR + m * MINUTE;
};

/** Each calendar's exceptions by date, made once per calendar (a drag
 *  measures on every pointer move). */
const EXCEPTIONS = new WeakMap<object, ReadonlyMap<string, readonly WorkInterval[]>>();

function exceptionsOf(calendar: Pick<PlanCalendar, 'exceptions'>): ReadonlyMap<string, readonly WorkInterval[]> {
  let byDate = EXCEPTIONS.get(calendar.exceptions);
  if (!byDate) {
    byDate = new Map(calendar.exceptions.map((e) => [e.date, e.hours]));
    EXCEPTIONS.set(calendar.exceptions, byDate);
  }
  return byDate;
}

/**
 * Working minutes from `a` to `b` (epoch ms) on the calendar, negative when
 * `b` is earlier: the API's `work_between` (plans/calendar.py). A dated
 * exception replaces its weekday's hours; a partial minute rounds toward 0.
 */
export function workMinutes(calendar: Pick<PlanCalendar, 'week' | 'exceptions'>, a: number, b: number): number {
  if (b < a) return -workMinutes(calendar, b, a);
  const exceptions = exceptionsOf(calendar);
  let total = 0;
  const last = Math.floor(b / MS_PER_DAY) * MS_PER_DAY;
  for (let day = Math.floor(a / MS_PER_DAY) * MS_PER_DAY; day <= last; day += MS_PER_DAY) {
    const hours = exceptions.get(dayOf(fromMs(day))) ?? calendar.week[DAY_KEYS[new Date(day).getUTCDay()]] ?? [];
    for (const [start, end] of hours) {
      const lo = Math.max(day + clockMs(start), a);
      const hi = Math.min(day + clockMs(end), b);
      if (hi > lo) total += hi - lo;
    }
  }
  return Math.trunc(total / MINUTE);
}

/** Smaller units first falls back through: a month to weeks, days, hours, minutes. */
const SMALLER: Record<DurationUnit, DurationUnit | null> = { mo: 'w', w: 'd', d: 'h', h: 'm', m: null };

/** The most decimals the parser could read in a duration of `unit` (its
 *  64-character text limit, less the whole part, the point and the word). */
function decimalLimit(unit: DurationUnit, elapsed: boolean): number {
  return MAX_DURATION_TEXT - MAX_INTEGER_DIGITS - 2 - durationLabel(unit, elapsed, false).length;
}

/**
 * Duration text that parses back (parseDuration, the API's parse_duration)
 * to exactly `minutes`, a whole number >= 0: the task's own unit with the
 * fewest decimals that do (`2.125 days` for 1,020 minutes of 480-minute
 * days, where `2.13 days` would read as 1,022). When no decimal count up
 * to `maxDecimals` (the parser's own limit unless given) round-trips, the
 * next smaller unit that does (`17 hrs`). Minutes always do.
 */
export function exactDurationText(
  minutes: number, unit: DurationUnit, elapsed: boolean, units: Units, maxDecimals?: number,
): string {
  const per = BigInt(unitMinutes(units, unit, elapsed));
  const want = BigInt(Math.round(Math.abs(minutes)));
  const limit = Math.max(0, Math.min(maxDecimals ?? Number.POSITIVE_INFINITY, decimalLimit(unit, elapsed)));
  for (let k = 0; k <= limit; k += 1) {
    const scale = 10n ** BigInt(k);
    const n = (want * scale * 2n + per) / (per * 2n);          // the nearest k-decimal number of units
    if ((n * per * 2n + scale) / (scale * 2n) !== want) continue;   // as the parser rounds it back
    const whole = (n / scale).toString();
    const text = k === 0 ? whole : `${whole}.${(n % scale).toString().padStart(k, '0')}`;
    return `${text} ${durationLabel(unit, elapsed, text === '1')}`;
  }
  const smaller = SMALLER[unit];
  return smaller ? exactDurationText(minutes, smaller, elapsed, units, maxDecimals) : `${want} ${durationLabel('m', elapsed, want === 1n)}`;
}

/** A resize's duration: at least a minute (none would make a milestone), in
 *  the task's own unit, in text that reads back to exactly that. */
function durationText(minutes: number, task: PlanTask, units: Units): string {
  return exactDurationText(Math.max(1, minutes), task.duration_unit, task.elapsed, units);
}

/**
 * The ops a finished drag sends; `[]` when it changes nothing.
 *
 * - `move`, `value` = how far the start moved, ms: `update_task.fields.start`.
 * - `resize`, `value` = how far the finish moved, ms: `fields.duration`, the
 *   working time (wall-clock when elapsed) from the start to the new finish,
 *   in the task's display unit, at least a minute.
 * - `progress`, `value` = how far the progress edge moved, ms: `set_percent`,
 *   rounded to 5%, within 0 to 100.
 * - `link`, `value` = the task dropped on: `add_link`, Finish-to-Start.
 *
 * A summary gets its dates and progress from its subtasks, so only a link
 * drag sends anything for one.
 */
export function opsForDrag(
  kind: DragKind, task: PlanTask, value: number | string, units: Units, calendar: Pick<PlanCalendar, 'week' | 'exceptions'>,
): Op[] {
  if (kind === 'link') {
    const target = String(value);
    return target === task.id ? [] : [{ op: 'add_link', predecessor_id: task.id, successor_id: target, link_type: 'FS' }];
  }
  const delta = Number(value);
  if (task.is_summary || !Number.isFinite(delta)) return [];
  const start = task.start ? toMs(task.start) : Number.NaN;
  const finish = task.finish ? toMs(task.finish) : Number.NaN;

  if (kind === 'move') {
    const at = Number.isNaN(start) ? finish : start;
    if (delta === 0 || Number.isNaN(at)) return [];
    return [{ op: 'update_task', id: task.id, fields: { start: fromMs(at + delta) } }];
  }
  if (Number.isNaN(start) || Number.isNaN(finish) || task.is_milestone) return [];

  if (kind === 'resize') {
    if (delta === 0) return [];
    const end = finish + delta;
    const minutes = task.elapsed ? Math.trunc((end - start) / MINUTE) : workMinutes(calendar, start, end);
    const text = durationText(minutes, task, units);
    return parseDuration(text, units).minutes === task.duration_minutes
      ? []
      : [{ op: 'update_task', id: task.id, fields: { duration: text } }];
  }

  // progress: the edge's new place along the bar, as a share of it
  const span = finish - start;
  if (span <= 0) return [];
  const doneAt = (span * task.percent_complete) / 100 + delta;
  const percent = Math.min(100, Math.max(0, Math.round((doneAt / span) * 20) * 5));
  return percent === task.percent_complete ? [] : [{ op: 'set_percent', ids: [task.id], percent }];
}

/** Whether `a` is `b` or one of its summary tasks. */
function isAncestor(a: string, b: string, parentOf: ReadonlyMap<string, string | null>): boolean {
  for (let id: string | null | undefined = b; id; id = parentOf.get(id)) {
    if (id === a) return true;
  }
  return false;
}

/**
 * Whether a link drag from `from` may drop on `to`: not the same task, not
 * a link the plan already has, and not a summary with its own subtask
 * (either way). The API answers the rest (a cycle names its tasks).
 */
export function canLink(plan: Pick<Plan, 'tasks' | 'links'>, from: string, to: string): boolean {
  if (from === to) return false;
  if (plan.links.some((l) => l.predecessor_id === from && l.successor_id === to)) return false;
  const parentOf = new Map(plan.tasks.map((t) => [t.id, t.parent_id]));
  return !isAncestor(from, to, parentOf) && !isAncestor(to, from, parentOf);
}
