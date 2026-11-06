/**
 * Watches — the pure rules the watch screens share: what each kind of thing is
 * called, which events a watch on it can name (the portal side of
 * api/src/serversherpa/notifications/watches.py `kinds_for`), how a watch's
 * events read in a list, what a failed watch call or Watch toggle says, and
 * which failures mean a screen was out of date. An asset watch is not on a
 * `WatchTarget` thing (it waits for one condition and ends), so it has its own
 * label and events text below. The calls themselves are in lib/api.ts.
 */

import {
  ApiError, type AssetWatch, type NotificationKindSetting, type Watch, type WatchTarget,
} from './api';

/** What the portal calls each thing a watch can be on. A wiki node is a folder or a
 *  page (`wikiNodeLabel`); this is the page's, for a row the API sent no label for. */
export const THING_LABELS: Record<WatchTarget, string> = {
  initiative: 'Initiative',
  site: 'Site',
  truck: 'Truck',
  device: 'Device',
  wiki_space: 'Wiki library',
  wiki_node: 'Wiki page',
  everything: 'Everything',
};

/** What the watch rows call an asset: the chip on the Watching cell of an asset watch. It stands
 *  apart from `THING_LABELS`, which is keyed by what a `Watch` is on. */
export const ASSET_THING_LABEL = 'Asset';

/** What a wiki node is called by its kind: "Wiki folder" for a folder, else "Wiki page"
 *  (the API's own rule for its `thing_label`: a library has its own label, and a file is
 *  a page). The line under a node the Wiki picker found says it, as the chip on its watch
 *  row does. */
export function wikiNodeLabel(kind: string): string {
  return kind === 'folder' ? 'Wiki folder' : THING_LABELS.wiki_node;
}

/** Whether a watch is on a wiki library, folder or page. The wiki has no event choice (a
 *  wiki watch hears every page update and comment), so such a row can only be stopped. */
export function isWikiWatch(watch: Pick<Watch, 'thing'>): boolean {
  return watch.thing === 'wiki_space' || watch.thing === 'wiki_node';
}

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

/** An asset watch's events as a list cell: "Next update", or "Status becomes" and the status's
 *  label (its key, for one the API sent no label for). */
export function assetWatchEventsText(w: AssetWatch): string {
  return w.condition === 'status' ? `Status becomes ${w.status_label ?? w.status}` : 'Next update';
}

/** The plain sentence for a watch that could not be changed (the wiki's). */
const WATCH_FAILED = "Couldn't update your watch.";

/** What a failed watch call says (a toast, or a dialog's error line):
 *  `already_watching` has its own sentence, read-only maintenance says its
 *  own, any other answer of the API is the house fallback with its code, and
 *  anything else (no connection, a bug) is the plain one. */
export function watchErrorMessage(err: unknown): string {
  if (!(err instanceof ApiError)) return WATCH_FAILED;
  if (err.code === 'already_watching') return "You're already watching this.";
  if (err.code === 'read_only_mode' && err.message) return err.message;
  return `Request failed (${err.code}).`;
}

/** What a failed Watch / Stop watching toggle says in its toast: the Watch
 *  button's and the device row menus' (useDeviceWatches) one sentence. Read-only
 *  maintenance says the server's own message; anything else is the plain
 *  sentence, with no code. With no error (the state could not be read again
 *  after an out-of-date click), the plain sentence too. */
export function watchToggleMessage(err?: unknown): string {
  if (err instanceof ApiError && err.code === 'read_only_mode' && err.message) return err.message;
  return WATCH_FAILED;
}

const OUT_OF_DATE = new Set(['already_watching', 'watch_not_found']);

/** Whether a failed watch call means the screen was out of date: the person already
 *  watches the thing (made elsewhere: `already_watching`), or the watch they meant to
 *  stop is already gone (`watch_not_found`). The screen reads its watches again and
 *  shows what is true now, with nothing to report. */
export function isOutOfDate(err: unknown): boolean {
  return err instanceof ApiError && OUT_OF_DATE.has(err.code);
}
