/** Small display helpers: m:ss and the dates the training list shows. */
import { getLang } from './i18n';

export function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** A due date (`YYYY-MM-DD`, a calendar day, not an instant) as "Fri, Nov 8".
 *  Built from its parts so no time zone can move it a day. */
export function dueDay(iso: string): string {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat(getLang(), { weekday: 'short', month: 'short', day: 'numeric' })
    .format(new Date(y, m - 1, d));
}

/** When something was signed (an instant), as "Nov 4" in the worker's own zone. */
export function signedDay(iso: string): string {
  return new Intl.DateTimeFormat(getLang(), { month: 'short', day: 'numeric' }).format(new Date(iso));
}
