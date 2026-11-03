/**
 * Watches — the pure rules the watch screens share: what each kind of thing is
 * called, which events a watch on it can name (the portal side of
 * api/src/serversherpa/notifications/watches.py `kinds_for`), how a watch's
 * events read in a list, what a failed watch call says, and which failures mean
 * a screen was out of date. The calls themselves are in lib/api.ts.
 */

import { ApiError, type NotificationKindSetting, type WatchTarget } from './api';

/** What the portal calls each thing a watch can be on. */
export const THING_LABELS: Record<WatchTarget, string> = {
  initiative: 'Initiative',
  site: 'Site',
  truck: 'Truck',
  device: 'Device',
  everything: 'Everything',
};

/** The kinds of event a watch on `thing` can name, in the order `kinds` has
 *  them (the registry's): those marked `everywhere` for an Everything watch,
 *  else those that reach the kind of thing. The API refuses any other
 *  (422 `invalid_kind`). */
export function kindsFor(
  thing: WatchTarget, kinds: NotificationKindSetting[],
): NotificationKindSetting[] {
  return kinds.filter((k) => (thing === 'everything' ? k.everywhere : k.reaches.includes(thing)));
}

/** A watch's events as a list cell: "All events" when it names none, else the
 *  events' labels joined with ", ". A kind the registry no longer has shows as
 *  itself. */
export function eventsText(kinds: string[], all: NotificationKindSetting[]): string {
  if (kinds.length === 0) return 'All events';
  const labels = new Map(all.map((k) => [k.kind, k.label]));
  return kinds.map((kind) => labels.get(kind) ?? kind).join(', ');
}

/** What a failed watch call says (a toast, or a dialog's error line):
 *  `already_watching` has its own sentence, read-only maintenance says its
 *  own, any other answer of the API is the house fallback with its code, and
 *  anything else (no connection, a bug) is the plain one. */
export function watchErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return "Couldn't update your watch.";
  if (err.code === 'already_watching') return "You're already watching this.";
  if (err.code === 'read_only_mode' && err.message) return err.message;
  return `Request failed (${err.code}).`;
}

const OUT_OF_DATE = new Set(['already_watching', 'watch_not_found']);

/** Whether a failed watch call means the screen was out of date: the person already
 *  watches the thing (made elsewhere: `already_watching`), or the watch they meant to
 *  stop is already gone (`watch_not_found`). The screen reads its watches again and
 *  shows what is true now, with nothing to report. */
export function isOutOfDate(err: unknown): boolean {
  return err instanceof ApiError && OUT_OF_DATE.has(err.code);
}
