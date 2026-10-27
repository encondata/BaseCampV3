/**
 * Small helpers shared by an initiative's Learning tab and its dialogs:
 * wording for days and times, the roster's status chips, and the error
 * wording for the tab's calls.
 */

import type { RosterStatus } from '../../lib/learning';
import { apiErrorText } from '../../lib/learningDoc';
import { parseApiDay } from '../../lib/timeline';

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** "Nov 8" for an API date-only value (YYYY-MM-DD, read as a local day). */
export const dayLabel = (iso: string): string =>
  parseApiDay(iso).toLocaleDateString([], { month: 'short', day: 'numeric' });

/** "Nov 21, 2026". */
export const dayLabelYear = (iso: string): string =>
  parseApiDay(iso).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

/** "Nov 3, 8:00 AM" for an instant, in the viewer's time zone. */
export const instantLabel = (iso: string): string =>
  new Date(iso).toLocaleString([], {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

/** "08:00" -> "8:00 AM" (locale-independent, so copy and tests agree). */
export function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** Reminder days the pickers offer (the API allows up to 365). */
export const REMINDER_CHOICES = Array.from({ length: 61 }, (_, i) => i);

/** Times of day, every 15 minutes. */
export const TIME_CHOICES = Array.from({ length: 96 }, (_, i) =>
  `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);

/** "5 days before" / "1 day before" / "On the start day" (reminder offsets). */
export const offsetLabel = (days: number): string =>
  (days === 0 ? 'On the start day' : `${plural(days, 'day')} before`);

/** "5", "5 and 3", "5, 3 and 1" — for "5 and 3 days before start". */
export function joinNumbers(values: number[]): string {
  const list = values.map(String);
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}

export const STATUS_CHIP: Record<RosterStatus, { label: string; cls: string }> = {
  complete: { label: 'Complete', cls: 'c-green' },
  in_progress: { label: 'In progress', cls: 'c-amber' },
  overdue: { label: 'Overdue', cls: 'c-red' },
  not_opened: { label: 'Not opened', cls: 'c-slate' },
  no_email: { label: 'No email', cls: 'c-violet' },
};

/** API codes the tab's calls can answer with, in plain words. */
export const TAB_ERRORS: Record<string, string> = {
  no_email: 'This person has no email. Print a code sheet for them instead.',
  learning_report_missing: 'The Learning compliance report isn’t set up. Ask an administrator.',
  learning_view_required: 'You need Learning access to run this report.',
  not_found: 'That person is no longer on this initiative.',
};

/** Plain wording for a failed call: the tab's own code wording, then the
 *  server's message (apiErrorText); a thrown Error (the report lookup)
 *  is matched by its message. */
export function tabErrorText(err: unknown, fallback?: string): string {
  if (err instanceof Error && TAB_ERRORS[err.message]) return TAB_ERRORS[err.message];
  return apiErrorText(err, TAB_ERRORS, fallback);
}
