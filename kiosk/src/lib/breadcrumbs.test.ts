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

it('Asset Lookup is a top-level page', () => {
  expect(trail('/lookup')).toEqual(['Home=/', 'Asset Lookup=/lookup']);
});

it('Label Printing nests its three pages under itself', () => {
  expect(trail('/labels')).toEqual(['Home=/', 'Label Printing=/labels']);
  expect(trail('/labels/station')).toEqual(['Home=/', 'Label Printing=/labels', 'Printing Station=/labels/station']);
  expect(trail('/labels/bulk')).toEqual(['Home=/', 'Label Printing=/labels', 'Bulk Print=/labels/bulk']);
  expect(trail('/labels/printers'))
    .toEqual(['Home=/', 'Label Printing=/labels', 'Printer Setup / Troubleshooting=/labels/printers']);
});

it('a troubleshooting topic nests under Troubleshooting, so the list is a link back', () => {
  expect(trail('/troubleshooting')).toEqual(['Home=/', 'Troubleshooting=/troubleshooting']);
  expect(trail('/troubleshooting/zebra-ds22'))
    .toEqual(['Home=/', 'Troubleshooting=/troubleshooting', 'Zebra Scanner Troubleshooting=/troubleshooting/zebra-ds22']);
  expect(trail('/troubleshooting/zebra-ds22/'))
    .toEqual(['Home=/', 'Troubleshooting=/troubleshooting', 'Zebra Scanner Troubleshooting=/troubleshooting/zebra-ds22']);
});

it('an unknown troubleshooting topic stops at Troubleshooting', () => {
  // the topic page shows "This topic isn't available." with its own Back link
  expect(trail('/troubleshooting/nope')).toEqual(['Home=/', 'Troubleshooting=/troubleshooting']);
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
