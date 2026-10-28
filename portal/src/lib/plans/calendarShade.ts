/**
 * Nonworking-day shading for the Gantt. A day is shaded only when the whole
 * day is off: the weekday's pattern has no working interval, or a dated
 * exception for it lists none (`hours: []`, a holiday). A day with any
 * working hours is not shaded, so an exception that gives a normally idle
 * Saturday 06:00-22:00 makes it a working day. The exception replaces the
 * weekday's pattern (plans/calendar.py), it does not add to it.
 *
 * Only the day and hour zooms draw shading; at weeks and coarser the bands
 * would be slivers. Dates and weekdays are read as UTC (floatingTime.ts), so
 * the bands do not move with the browser's zone.
 */
import type { DayKey, PlanCalendar } from './api';
import { dayOf, fromMs } from './floatingTime';
import { MS_PER_DAY, ZOOM_PX_PER_DAY, pxPerDay, widthOfMs, xOfMs, type Scale } from './ganttGeometry';

export interface Band {
  x: number;
  width: number;
}

/** Index by Date.getUTCDay(). */
const DAY_KEYS: readonly DayKey[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * The shaded bands for a scale: each run of consecutive nonworking days is
 * one band (a Saturday and Sunday are one), cut off at the scale's edges.
 * `[]` for a scale coarser than the days zoom.
 */
export function nonworkingBands(calendar: PlanCalendar, scale: Scale): Band[] {
  if (pxPerDay(scale) < ZOOM_PX_PER_DAY.days - 1e-9) return [];

  const holidays = new Map<string, boolean>();           // date -> the day is off
  for (const exception of calendar.exceptions) holidays.set(exception.date, exception.hours.length === 0);

  const isOff = (dayMs: number): boolean => {
    const exception = holidays.get(dayOf(fromMs(dayMs)));
    if (exception !== undefined) return exception;
    return (calendar.week[DAY_KEYS[new Date(dayMs).getUTCDay()]] ?? []).length === 0;
  };

  const bands: Band[] = [];
  const close = (from: number, to: number): void => {
    const a = Math.max(from, scale.startMs);
    const b = Math.min(to, scale.endMs);
    if (b > a) bands.push({ x: xOfMs(scale, a), width: widthOfMs(scale, b - a) });
  };

  let run: number | null = null;
  let day = Math.floor(scale.startMs / MS_PER_DAY) * MS_PER_DAY;
  for (; day < scale.endMs; day += MS_PER_DAY) {
    if (isOff(day)) {
      run ??= day;
    } else if (run !== null) {
      close(run, day);
      run = null;
    }
  }
  if (run !== null) close(run, day);
  return bands;
}
