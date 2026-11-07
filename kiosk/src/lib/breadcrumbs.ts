/**
 * The top bar's trail back home: "Home › Label Printing › Printing Station".
 *
 * Jimmy (2026-11-07): the bar should read like nested text, where clicking
 * Home goes home and each level adds the steps back to it. A level is a
 * PAGE, never a tab within one — Settings stays "Home › Settings" whichever
 * tab is open. Since tabs live in the query string and this reads only the
 * pathname, that rule holds by construction.
 *
 * Levels come from the same tables the launcher and the routes use, so a
 * new page shows up here without anyone remembering to add it:
 *   - the station screens (RFID Reader, Dock, Time Clock) are top-level
 *     pages. Time Clock's address sits under /timeclock, but it is its own
 *     station, so it is matched FIRST and never reads as a child of
 *     Timeclock;
 *   - every launcher feature is a top-level page;
 *   - Label Printing is the one page with pages beneath it.
 * An address that matches nothing gets Home alone — the router sends such
 * addresses home anyway, and the bar must never show a guess.
 */

import { DOCK_FEATURE, FEATURES, RFID_READER_FEATURE, TIMECLOCK_STATION_FEATURE } from './features';
import { LABEL_SECTIONS } from './labelSections';

export interface Crumb {
  title: string;
  /** Where clicking it goes. The last crumb is where you are, and the
   *  shell renders it as plain text rather than a link. */
  path: string;
}

export const HOME_CRUMB: Crumb = { title: 'Home', path: '/' };

/** The stations come before the features so /timeclock/station is never
 *  claimed by Timeclock's /timeclock prefix. */
const STATIONS = [TIMECLOCK_STATION_FEATURE, RFID_READER_FEATURE, DOCK_FEATURE];

/** `/scan` and `/scan/…` are the page; `/scanning` is not. */
function within(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function breadcrumbs(pathname: string): Crumb[] {
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, '') : pathname;
  const trail: Crumb[] = [HOME_CRUMB];
  if (path === '/') return trail;

  const station = STATIONS.find((s) => within(path, s.path));
  if (station) return [...trail, { title: station.title, path: station.path }];

  const feature = FEATURES.find((f) => within(path, f.path));
  if (!feature) return trail;
  trail.push({ title: feature.title, path: feature.path });

  if (feature.id === 'labels') {
    const section = LABEL_SECTIONS.find((s) => within(path, s.path));
    if (section) trail.push({ title: section.title, path: section.path });
  }
  return trail;
}
