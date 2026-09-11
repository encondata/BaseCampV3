/**
 * Pure geometry for the Initiatives › Timeline page (InitiativeTimeline.tsx):
 * range/tick math for the Gantt-style timeline, bar positioning, sorting,
 * and the month-calendar grid. No DOM, no React — every date is compared
 * as a date-only value in local time (times are stripped before any
 * comparison or arithmetic), so callers can pass whatever `Date` they
 * have without worrying about time-of-day skew.
 */

export type TimelineScale = 'month' | 'quarter' | 'year';

/** End-exclusive: `end` is the first instant NOT in the range. */
export interface TimelineRange { start: Date; end: Date }

export interface TimelineTick { at: Date; label: string }

export interface TimelineBar { left: number; width: number }

/** The subset of InitiativeItem this module actually needs — kept
 *  independent of lib/api.ts so this stays a standalone, DOM-free
 *  geometry module. InitiativeItem satisfies this shape structurally. */
export interface TimelineItem {
  name: string;
  scheduled_start: string | null;
  scheduled_end: string | null;
  real_start_at?: string | null;
  real_end_at?: string | null;
}

const MONTH_ABBR = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

/** Strips the time-of-day, keeping the date in local time. */
function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Parses an API date-only field (scheduled_start/scheduled_end/
 *  real_start_at/real_end_at — all stored as midnight UTC for a plain
 *  YYYY-MM-DD input, per lib/initiatives.ts and pages/InitiativeDetail.tsx)
 *  into a local calendar Date. Reads the Y-M-D digits directly rather
 *  than going through `new Date(iso)`, which parses a bare date as UTC
 *  midnight and then renders as the previous day anywhere west of UTC. */
function parseApiDate(iso: string): Date {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return new Date(y, m - 1, d);
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d);
  out.setDate(out.getDate() + n);
  return out;
}

function addMonths(d: Date, n: number): Date {
  const out = new Date(d);
  out.setMonth(out.getMonth() + n);
  return out;
}

/** Monday on or after `d` (Monday-first weeks, matching monthGrid). */
function mondayOnOrAfter(d: Date): Date {
  const dow = d.getDay(); // 0 = Sun .. 6 = Sat
  const delta = dow === 0 ? 1 : dow === 1 ? 0 : 8 - dow;
  return addDays(d, delta);
}

/** ISO-8601 week number (1-53) for a date-only value. */
function isoWeekNumber(d: Date): number {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0 .. Sun=6
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // this ISO week's Thursday
  const firstThursday = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const diffWeeks = Math.round(
    (t.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000));
  return diffWeeks + 1;
}

/** Calendar range for a scale, anchored at any date within it. Month is
 *  the calendar month, quarter the calendar quarter (Jan-Mar, Apr-Jun,
 *  Jul-Sep, Oct-Dec), year the calendar year — all end-exclusive. */
export function rangeFor(anchor: Date, scale: TimelineScale): TimelineRange {
  const a = dateOnly(anchor);
  if (scale === 'month') {
    const start = new Date(a.getFullYear(), a.getMonth(), 1);
    return { start, end: addMonths(start, 1) };
  }
  if (scale === 'quarter') {
    const qStartMonth = Math.floor(a.getMonth() / 3) * 3;
    const start = new Date(a.getFullYear(), qStartMonth, 1);
    return { start, end: addMonths(start, 3) };
  }
  const start = new Date(a.getFullYear(), 0, 1);
  return { start, end: new Date(a.getFullYear() + 1, 0, 1) };
}

/** Header ticks for the timeline's right pane: one per day (Month scale),
 *  one per ISO week (Quarter scale), one per month (Year scale). */
export function ticksFor(range: TimelineRange, scale: TimelineScale): TimelineTick[] {
  const ticks: TimelineTick[] = [];
  if (scale === 'month') {
    for (let cur = range.start; cur < range.end; cur = addDays(cur, 1)) {
      ticks.push({ at: cur, label: String(cur.getDate()) });
    }
    return ticks;
  }
  if (scale === 'quarter') {
    for (let cur = mondayOnOrAfter(range.start); cur < range.end; cur = addDays(cur, 7)) {
      const label = `Wk ${isoWeekNumber(cur)} · ${MONTH_ABBR[cur.getMonth()]} ${cur.getDate()}`;
      ticks.push({ at: cur, label });
    }
    return ticks;
  }
  for (let cur = range.start; cur < range.end; cur = addMonths(cur, 1)) {
    ticks.push({ at: cur, label: MONTH_ABBR[cur.getMonth()] });
  }
  return ticks;
}

/** Shared clip-to-range math for barFor/realBarFor: a [start, endInclusive]
 *  date span becomes a { left%, width% } bar within `range`, or null when
 *  the span falls entirely outside the range. */
function barBetween(
  start: Date, endInclusive: Date, range: TimelineRange,
): TimelineBar | null {
  const endExclusive = addDays(endInclusive < start ? start : endInclusive, 1);
  if (endExclusive <= range.start || start >= range.end) return null;
  const clippedStart = start < range.start ? range.start : start;
  const clippedEnd = endExclusive > range.end ? range.end : endExclusive;
  const totalMs = range.end.getTime() - range.start.getTime();
  const left = ((clippedStart.getTime() - range.start.getTime()) / totalMs) * 100;
  const width = ((clippedEnd.getTime() - clippedStart.getTime()) / totalMs) * 100;
  return { left, width };
}

/** The scheduled bar: scheduled_start → scheduled_end, clipped to `range`.
 *  A missing scheduled_end renders as a one-day bar; a missing
 *  scheduled_start, or a span entirely outside the range, is null. */
export function barFor(item: TimelineItem, range: TimelineRange): TimelineBar | null {
  if (!item.scheduled_start) return null;
  const start = parseApiDate(item.scheduled_start);
  const end = item.scheduled_end ? parseApiDate(item.scheduled_end) : start;
  return barBetween(start, end, range);
}

/** The thinner "real dates" bar: real_start_at → real_end_at, defaulting
 *  the end to `today` (an in-flight initiative) when real_end_at is
 *  unset. Null when there's no real_start_at. */
export function realBarFor(
  item: TimelineItem, range: TimelineRange, today: Date,
): TimelineBar | null {
  if (!item.real_start_at) return null;
  const start = parseApiDate(item.real_start_at);
  const end = item.real_end_at ? parseApiDate(item.real_end_at) : dateOnly(today);
  return barBetween(start, end, range);
}

/** Timeline row order: scheduled items first (by scheduled_start asc),
 *  then unscheduled items, each group broken by name. */
export function sortForTimeline<T extends TimelineItem>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const aHas = !!a.scheduled_start;
    const bHas = !!b.scheduled_start;
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas && a.scheduled_start !== b.scheduled_start) {
      return (a.scheduled_start as string) < (b.scheduled_start as string) ? -1 : 1;
    }
    return a.name.localeCompare(b.name);
  });
}

export interface MonthCell { date: Date; inMonth: boolean; isToday: boolean }

/** A 42-cell (6×7) Monday-first month grid for `anchor`'s month, with
 *  leading/trailing days from the adjacent months included so every week
 *  row is full. "Today" is the real current date (not injectable — this
 *  is the one function here that reads the clock, since a calendar grid
 *  is inherently "today-relative"). */
export function monthGrid(anchor: Date): MonthCell[] {
  const a = dateOnly(anchor);
  const monthStart = new Date(a.getFullYear(), a.getMonth(), 1);
  const startDow = monthStart.getDay(); // 0 = Sun .. 6 = Sat
  const leadingDays = startDow === 0 ? 6 : startDow - 1;
  const gridStart = addDays(monthStart, -leadingDays);
  const today = dateOnly(new Date());
  const cells: MonthCell[] = [];
  for (let i = 0; i < 42; i++) {
    const date = addDays(gridStart, i);
    cells.push({
      date,
      inMonth: date.getMonth() === a.getMonth() && date.getFullYear() === a.getFullYear(),
      isToday: date.getTime() === today.getTime(),
    });
  }
  return cells;
}

/** Initiatives active on `day`: scheduled_start ≤ day ≤ scheduled_end,
 *  with scheduled_end defaulting to scheduled_start. Unscheduled items
 *  never match. */
export function itemsOnDay<T extends TimelineItem>(items: T[], day: Date): T[] {
  const d = dateOnly(day).getTime();
  return items.filter((i) => {
    if (!i.scheduled_start) return false;
    const start = parseApiDate(i.scheduled_start).getTime();
    const end = i.scheduled_end ? parseApiDate(i.scheduled_end).getTime() : start;
    return d >= start && d <= end;
  });
}
