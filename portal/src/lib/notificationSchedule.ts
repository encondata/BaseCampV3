/**
 * Notification schedule — the pure parts of the personal schedule card on
 * /me › Notifications (components/notifications/ScheduleCard.tsx): the
 * default, the "same schedule" test, and the summary line that says when
 * email that has to wait goes out.
 *
 * The sentences are the design's (§3 "Your schedule"). The rule they describe
 * is the API's (api/src/serversherpa/notifications/schedule.py): email held
 * by quiet hours or a day off goes out as one summary an hour before the
 * person is back online — an hour before quiet hours end, or, for a day off
 * with no quiet hours, at 11:00 PM the night before the next day they work.
 */

import type { NotifSchedule } from './api';
import { DAYS, DEFAULT_TIMEZONE, tzAbbrev } from './notifications';
import { timeLabel } from './timeChoices';

export { DAY_LABELS } from './notifications';

/** A schedule nobody has changed: the company reference zone (no zone of
 *  their own), every day on, no quiet hours. Nothing waits. */
export const DEFAULT_SCHEDULE: NotifSchedule = {
  timezone: null, days: [...DAYS], quiet_start: null, quiet_end: null,
};

/** Whether two schedules read the same: the same zone, the same set of days
 *  and the same quiet hours. */
export function sameSchedule(a: NotifSchedule, b: NotifSchedule): boolean {
  return a.timezone === b.timezone
    && a.quiet_start === b.quiet_start && a.quiet_end === b.quiet_end
    && a.days.length === b.days.length && a.days.every((d) => b.days.includes(d));
}

/** "HH:MM" (a trailing ":SS" is ignored) as minutes since midnight. */
function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/** Minutes since midnight as "HH:MM". */
function clockOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

const PICK_A_DAY = 'Pick at least one day.';
const PICK_TIMES = 'Pick a start and end time.';
const NEVER_WAIT = 'Critical notifications never wait.';

/** What the schedule card says under its controls, and whether it is a
 *  warning (the days or the quiet hours are not something that can be saved).
 *
 *  `quietOn` is whether quiet hours are switched on. It follows the times
 *  unless the card passes it: a switch turned on with no time picked yet has
 *  no times to follow. Quiet hours that are on but have no start, no end, or
 *  the same for both are not a window, so the line asks for the times. */
export function summaryLine(
  s: NotifSchedule,
  quietOn: boolean = s.quiet_start !== null || s.quiet_end !== null,
): { text: string; warn: boolean } {
  if (s.days.length === 0) return { text: PICK_A_DAY, warn: true };

  const zone = tzAbbrev(s.timezone ?? DEFAULT_TIMEZONE);
  const everyDay = DAYS.every((d) => s.days.includes(d));
  const daysOff = `Email from days off arrives as one summary at 11:00 PM ${zone} the night before the next day you work.`;

  if (!quietOn) {
    return everyDay
      ? { text: 'No quiet hours and no days off, so email always goes out right away.', warn: false }
      : { text: `${daysOff} ${NEVER_WAIT}`, warn: false };
  }

  const { quiet_start: start, quiet_end: end } = s;
  if (start === null || end === null || minutesOf(start) === minutesOf(end)) {
    return { text: PICK_TIMES, warn: true };
  }

  // One hour before quiet hours end, wrapping back past midnight.
  const at = timeLabel(clockOf((minutesOf(end) - 60 + 1440) % 1440));
  // A window that wraps past midnight, or starts at 12:00 AM, runs into the
  // next day, so a day off and quiet hours share one summary.
  const coversMidnight = minutesOf(start) > minutesOf(end) || minutesOf(start) === 0;
  const text = everyDay || coversMidnight
    ? `Email that waits arrives as one summary at ${at} ${zone}, an hour before quiet hours end on a day you work.`
    : `Email that waits during quiet hours arrives as one summary at ${at} ${zone}. ${daysOff}`;
  return { text: `${text} ${NEVER_WAIT}`, warn: false };
}
