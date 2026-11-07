import { expect, it } from 'vitest';

import { breadcrumbs } from './breadcrumbs';

const trail = (pathname: string) => breadcrumbs(pathname).map((c) => `${c.title}=${c.path}`);

it('home is just Home', () => {
  expect(trail('/')).toEqual(['Home=/']);
});

it('a top-level page is Home, then the page', () => {
  expect(trail('/scan')).toEqual(['Home=/', 'Scanning=/scan']);
  expect(trail('/enroll')).toEqual(['Home=/', 'RFID Enroll=/enroll']);
  expect(trail('/setup')).toEqual(['Home=/', 'Kiosk Setup=/setup']);
  expect(trail('/timeclock')).toEqual(['Home=/', 'Timeclock=/timeclock']);
});

it('Label Printing nests its three pages under itself', () => {
  expect(trail('/labels')).toEqual(['Home=/', 'Label Printing=/labels']);
  expect(trail('/labels/station')).toEqual(['Home=/', 'Label Printing=/labels', 'Printing Station=/labels/station']);
  expect(trail('/labels/bulk')).toEqual(['Home=/', 'Label Printing=/labels', 'Bulk Print=/labels/bulk']);
  expect(trail('/labels/printers'))
    .toEqual(['Home=/', 'Label Printing=/labels', 'Printer Setup / Troubleshooting=/labels/printers']);
});

it('tabs within a page do not count — the query string never adds a level', () => {
  // the router hands the shell a pathname, so ?tab= never reaches here;
  // this pins that a settings sub-path would not invent one either
  expect(trail('/settings')).toEqual(['Home=/', 'Settings=/settings']);
});

it('the station screens are top-level pages', () => {
  expect(trail('/rfid_status')).toEqual(['Home=/', 'RFID Reader=/rfid_status']);
  expect(trail('/dock')).toEqual(['Home=/', 'Dock=/dock']);
  // under /timeclock by address, but its own station — not nested under Timeclock
  expect(trail('/timeclock/station')).toEqual(['Home=/', 'Time Clock=/timeclock/station']);
});

it('a trailing slash is the same page', () => {
  expect(trail('/scan/')).toEqual(['Home=/', 'Scanning=/scan']);
  expect(trail('/labels/station/')).toEqual(['Home=/', 'Label Printing=/labels', 'Printing Station=/labels/station']);
});

it('an unknown address falls back to Home alone', () => {
  // the router redirects these to / anyway; the bar must never show a guess
  expect(trail('/nowhere')).toEqual(['Home=/']);
  expect(trail('/scanning')).toEqual(['Home=/']);       // a prefix of nothing, not /scan
  expect(trail('/labels/nowhere')).toEqual(['Home=/', 'Label Printing=/labels']);
});
