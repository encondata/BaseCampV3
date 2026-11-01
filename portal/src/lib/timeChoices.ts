/**
 * Times of day for the dialogs' pickers: every quarter hour as "HH:MM", and
 * its 12-hour label. Shared by the Learning schedule and the notification
 * quiet-hours editors.
 */

import { compareOrdinal } from './naturalSort';

/** Times of day, every 15 minutes: "00:00" … "23:45". */
export const TIME_CHOICES: string[] = Array.from({ length: 96 }, (_, i) =>
  `${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`);

/** "08:00" -> "8:00 AM" (locale-independent, so copy and tests agree). */
export function timeLabel(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return hhmm;
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/** The ComboBox options for a time picker: the quarter-hour grid, plus
 *  `current` (an API time, "21:10:00" or "21:10") slotted in order when it is
 *  not on the grid — so a stored 9:10 PM shows as itself instead of vanishing.
 *  Values are always "HH:MM". */
export function timeOptions(current: string | null): { value: string; label: string }[] {
  const found = current === null ? null : /^(\d{1,2}):(\d{2})/.exec(current);
  const hhmm = found ? `${found[1].padStart(2, '0')}:${found[2]}` : null;
  const values = hhmm !== null && !TIME_CHOICES.includes(hhmm)
    ? [...TIME_CHOICES, hhmm].sort(compareOrdinal)
    : TIME_CHOICES;
  return values.map((value) => ({ value, label: timeLabel(value) }));
}
