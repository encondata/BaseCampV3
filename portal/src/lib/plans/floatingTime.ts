/**
 * Floating plan times: `YYYY-MM-DDTHH:MM` wall-clock text in the plan's own
 * zone (api/src/serversherpa/plans/floating.py), never a zone, an offset or
 * `Z`. The portal reads them as UTC-naive values: the parts go through
 * Date.UTC and come back through the getUTC* getters, so a plan in
 * America/Chicago shows the same dates in a browser in Tokyo. Never parse
 * plan text with `new Date(text)` and never use a local getter on one.
 */

const PLAN_TIME = /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2}))?$/;
const INPUT_TIME = /^([0-9]{4}-[0-9]{2}-[0-9]{2})(?:T([0-9]{2}:[0-9]{2})(?::[0-9]{2}(?:\.[0-9]+)?)?)?$/;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** The plan time (or a date alone, at midnight) as epoch milliseconds of
 *  the same UTC wall clock; NaN for text that is not a real plan time. */
export function toMs(s: string): number {
  const m = PLAN_TIME.exec(s);
  if (!m) return Number.NaN;
  const [year, month, day, hour, minute] = m.slice(1).map((part) => (part === undefined ? 0 : Number(part)));
  if (hour > 23 || minute > 59) return Number.NaN;
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (year < 100) at.setUTCFullYear(year);       // Date.UTC reads 0-99 as 1900-1999
  if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month - 1 || at.getUTCDate() !== day) {
    return Number.NaN;                           // 2026-02-30 and friends
  }
  return at.getTime();
}

/** Epoch milliseconds back to plan time text, to the minute; '' for NaN. */
export function fromMs(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const at = new Date(ms);
  return `${pad(at.getUTCFullYear(), 4)}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())}`
    + `T${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}`;
}

function parts(s: string | null | undefined): Date | null {
  if (!s) return null;
  const ms = toMs(s);
  return Number.isNaN(ms) ? null : new Date(ms);
}

const dayText = (at: Date): string =>
  `${WEEKDAYS[at.getUTCDay()]} ${at.getUTCMonth() + 1}/${at.getUTCDate()}/${pad(at.getUTCFullYear() % 100)}`;

/** `Mon 11/2/26`; '' for a missing or bad value. */
export function formatDay(s: string | null | undefined): string {
  const at = parts(s);
  return at ? dayText(at) : '';
}

/** `Mon 11/2/26 8:00 AM`; '' for a missing or bad value. */
export function formatDayTime(s: string | null | undefined): string {
  const at = parts(s);
  if (!at) return '';
  const hours = at.getUTCHours();
  const clock = `${hours % 12 === 0 ? 12 : hours % 12}:${pad(at.getUTCMinutes())} ${hours < 12 ? 'AM' : 'PM'}`;
  return `${dayText(at)} ${clock}`;
}

/** A sheet date cell: with its time when the plan shows times. */
export function formatCell(s: string | null | undefined, showTimes: boolean): string {
  return showTimes ? formatDayTime(s) : formatDay(s);
}

/** `11/16`, a milestone's date beside its diamond; '' for a missing or bad value. */
export function formatShortDay(s: string | null | undefined): string {
  const at = parts(s);
  return at ? `${at.getUTCMonth() + 1}/${at.getUTCDate()}` : '';
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const monthDay = (at: Date, withYear: boolean): string =>
  `${MONTHS_SHORT[at.getUTCMonth()]} ${at.getUTCDate()}${withYear ? `, ${at.getUTCFullYear()}` : ''}`;

/**
 * The days `a` through `b` with an en dash, naming a month or a year once
 * when both ends share it: `Nov 14–16`, `Nov 30 – Dec 2`, `Dec 30, 2026 –
 * Jan 2, 2027`; one day (or one end alone) is `Nov 14`. Times are ignored;
 * '' when neither end is a real day.
 */
export function formatDayRange(a: string | null | undefined, b: string | null | undefined): string {
  const from = parts(a ? dayOf(a) : null);
  const to = parts(b ? dayOf(b) : null);
  if (!from || !to) {
    const one = from ?? to;
    return one ? monthDay(one, false) : '';
  }
  if (from.getTime() === to.getTime()) return monthDay(from, false);
  if (from.getUTCFullYear() !== to.getUTCFullYear()) return `${monthDay(from, true)} – ${monthDay(to, true)}`;
  if (from.getUTCMonth() !== to.getUTCMonth()) return `${monthDay(from, false)} – ${monthDay(to, false)}`;
  return `${monthDay(from, false)}–${to.getUTCDate()}`;
}

/** The day of a plan time, `YYYY-MM-DD`. */
export function dayOf(s: string): string {
  return s.slice(0, 10);
}

/** The value for an `<input type="date">`; '' for none. */
export function toDateInput(s: string | null | undefined): string {
  return s ? dayOf(s) : '';
}

/** The value for an `<input type="datetime-local">`; a date alone reads as
 *  midnight; '' for none. */
export function toDateTimeInput(s: string | null | undefined): string {
  if (!s) return '';
  return s.length === 10 ? `${s}T00:00` : s.slice(0, 16);
}

const zoneFormats = new Map<string, Intl.DateTimeFormat>();

/** en-US numeric parts in `timeZone` (UTC when the browser doesn't know it). */
function zoneFormat(timeZone: string): Intl.DateTimeFormat {
  let format = zoneFormats.get(timeZone);
  if (!format) {
    const options: Intl.DateTimeFormatOptions = {
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    };
    try {
      format = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
    } catch {
      format = new Intl.DateTimeFormat('en-US', { ...options, timeZone: 'UTC' });
    }
    zoneFormats.set(timeZone, format);
  }
  return format;
}

/** An instant (ISO text with an offset, as `updated_at` arrives) as plan
 *  text on the wall clock of `timeZone` (the plan's zone), to the minute;
 *  '' for a missing or unreadable instant. */
export function fromInstant(iso: string | null | undefined, timeZone: string): string {
  if (!iso) return '';
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return '';
  const part: Record<string, string> = {};
  for (const p of zoneFormat(timeZone).formatToParts(ms)) part[p.type] = p.value;
  const hour = part.hour === '24' ? '00' : part.hour;   // some engines write midnight as 24
  return `${part.year}-${part.month}-${part.day}T${hour}:${part.minute}`;
}

/** A date or datetime-local input's value as plan text, or null when it is
 *  blank or not a real date. A date alone stays `YYYY-MM-DD`, so the API
 *  applies the calendar's default start or end time; seconds are dropped. */
export function fromDateInput(v: string): string | null {
  const m = INPUT_TIME.exec(v);
  if (!m) return null;
  const text = m[2] === undefined ? m[1] : `${m[1]}T${m[2]}`;
  return Number.isNaN(toMs(text)) ? null : text;
}
