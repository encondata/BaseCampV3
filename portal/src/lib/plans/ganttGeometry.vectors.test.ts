/**
 * The Gantt geometry the project plan PDF draws with, held to the vectors
 * file the API's pytest suite reads too (api/tests/fixtures/plans/gantt.json,
 * tests/test_plans_gantt_vectors.py): the zooms' scale, the fit, the two
 * timescale tiers and their labels, bars, milestones, baselines, link paths
 * and arrowheads, nonworking shading, and the PDF's own page geometry
 * (planPdf). The API's reports/project_plan/gantt.py is a port of these
 * functions, so its PDF and this page estimate agree on every row.
 *
 * The portal is the reference. After a deliberate change to one of these
 * functions, rewrite the file from it (from portal/):
 *
 *     REGEN_GANTT_VECTORS=1 npx vitest run src/lib/plans/ganttGeometry.vectors.test.ts
 *
 * then make the API's port agree.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { PlanCalendar } from './api';
import { nonworkingBands } from './calendarShade';
import {
  ZOOMS, baselineOf, barOf, fitZoom, linkPath, makeScale, progressWidth, tiers, type LinkEnd, type Scale, type Zoom,
} from './ganttGeometry';
import { barBox, linkShape, linkStub } from './ganttView';
import {
  PAPERS, chartWidth, contentBox, estimatePages, ganttRows, planSpan, printFit, printRange, printScale, spanTooLong,
  tableRows, type Paper, type PrintSpan,
} from './planPdf';
import type { LinkType } from './predecessors';

const FILE = path.resolve(__dirname, '../../../../api/tests/fixtures/plans/gantt.json');

interface Row {
  name: string;
  fn: string;
  args: unknown[];
  expected: unknown;
}

type Task = { start: string | null; finish: string | null; is_milestone: boolean };
type BaseTask = { baseline_start: string | null; baseline_finish: string | null };

/** What each vector's `fn` calls, by the name both suites use. */
const FNS: Record<string, (...args: never[]) => unknown> = {
  makeScale: (start: string, finish: string | null, zoom: Zoom) => makeScale(start, finish, zoom),
  fitZoom: (start: string, finish: string | null, width: number) => fitZoom(start, finish, width),
  tiers: (scale: Scale, zoom: Zoom, window: [number, number] | null) => tiers(scale, zoom, window ?? undefined),
  barOf: (scale: Scale, task: Task) => barOf(scale, task),
  baselineOf: (scale: Scale, task: BaseTask) => baselineOf(scale, task),
  progressWidth: (width: number, percent: number) => progressWidth({ width }, percent),
  linkPath: (from: LinkEnd, to: LinkEnd, type: LinkType, rowH: number, stub: number) =>
    linkPath(from, to, type, rowH, stub),
  linkShape: (from: LinkEnd, to: LinkEnd, type: LinkType, rowH: number, stub: number, toHalf: number) =>
    linkShape(from, to, type, rowH, { stub, toHalf }),
  linkStub: (zoom: Zoom) => linkStub(zoom),
  barBox: (rowH: number, baseline: boolean) => barBox(rowH, baseline),
  nonworkingBands: (calendar: PlanCalendar, scale: Scale) => nonworkingBands(calendar, scale),
  printScale: (start: string, finish: string, zoom: Zoom) => printScale(start, finish, zoom),
  printFit: (start: string, finish: string, paper: Paper) => printFit(start, finish, paper),
  planSpan: (start: string, finish: string | null, tasks: { start: string | null; finish: string | null }[]) =>
    planSpan(start, finish, tasks),
  printRange: (span: PrintSpan, from: string | null, to: string | null) => printRange(span, from, to),
  spanTooLong: (start: string, finish: string) => spanTooLong(start, finish),
  pageLayout: (paper: Paper) => ({
    content: contentBox(paper), chart: chartWidth(paper), ganttRows: ganttRows(paper), tableRows: tableRows(paper),
  }),
  estimatePages: (rows: number, start: string, finish: string, zoom: Zoom | 'fit', paper: Paper) =>
    estimatePages({ rows, start, finish, zoom, paper }),
};

const call = (fn: string, args: unknown[]): unknown => (FNS[fn] as (...a: unknown[]) => unknown)(...args);

// ── the cases (REGEN writes their expected values) ──────────────────

const PROJECT = ['2026-11-02T08:00', '2026-11-20T17:00'] as const;
const WEEK: PlanCalendar['week'] = {
  mon: [['08:00', '12:00'], ['13:00', '17:00']], tue: [['08:00', '12:00'], ['13:00', '17:00']],
  wed: [['08:00', '12:00'], ['13:00', '17:00']], thu: [['08:00', '12:00'], ['13:00', '17:00']],
  fri: [['08:00', '12:00'], ['13:00', '17:00']], sat: [], sun: [],
};
const CALENDAR = {
  week: WEEK,
  exceptions: [
    { date: '2026-11-26', name: 'Thanksgiving', hours: [] },              // a Thursday off
    { date: '2026-11-21', name: 'Cutover Saturday', hours: [['06:00', '22:00']] },   // a Saturday worked
  ],
} as unknown as PlanCalendar;

const scaleAt = (zoom: Zoom, start: string = PROJECT[0], finish: string = PROJECT[1]) =>
  printScale(start, finish, zoom);
const end = (x0: number, x1: number, y: number): LinkEnd => ({ x0, x1, y });

function cases(): { name: string; fn: string; args: unknown[] }[] {
  const out: { name: string; fn: string; args: unknown[] }[] = [];
  const add = (name: string, fn: string, ...args: unknown[]) => out.push({ name, fn, args });

  for (const zoom of ZOOMS) add(`makeScale at ${zoom}`, 'makeScale', ...PROJECT, zoom);
  add('makeScale of an empty plan', 'makeScale', PROJECT[0], null, 'days');

  add('fit: a day and a half fits at hours', 'fitZoom', '2026-11-02T08:00', '2026-11-03T12:00', 740);
  add('fit: three weeks fit at weeks', 'fitZoom', ...PROJECT, 740);
  add('fit: a year fits at quarters', 'fitZoom', '2026-11-02T08:00', '2027-11-02T08:00', 740);
  add('fit: three years fit nowhere, so quarters', 'fitZoom', '2026-11-02T08:00', '2029-11-02T08:00', 740);
  add('fit: no span is days', 'fitZoom', PROJECT[0], PROJECT[0], 740);

  add('tiers at hours, in a window', 'tiers', scaleAt('hours', '2026-11-02T08:00', '2026-11-03T17:00'), 'hours',
    [100, 520]);
  add('tiers at days across a month boundary', 'tiers', scaleAt('days', '2026-11-25T08:00', '2026-12-04T17:00'),
    'days', null);
  add('tiers at days, one tile of a long range', 'tiers', scaleAt('days', '2026-11-02T08:00', '2027-11-02T08:00'),
    'days', [740, 1480]);
  add('tiers at weeks across a year boundary', 'tiers', scaleAt('weeks', '2026-12-10T08:00', '2027-01-20T17:00'),
    'weeks', null);
  add('tiers at months across a year boundary', 'tiers', scaleAt('months', '2026-10-01T08:00', '2027-03-01T17:00'),
    'months', null);
  add('tiers at quarters across a year boundary', 'tiers',
    scaleAt('quarters', '2026-05-01T08:00', '2027-08-01T17:00'), 'quarters', null);
  add('tiers on the portal scale at days', 'tiers', makeScale(...PROJECT, 'days'), 'days', [0, 400]);

  const days = scaleAt('days');
  add('a whole-day bar', 'barOf', days, { start: '2026-11-03T08:00', finish: '2026-11-03T17:00', is_milestone: false });
  add('a partial-day bar', 'barOf', days, { start: '2026-11-04T10:30', finish: '2026-11-04T14:15', is_milestone: false });
  add('a bar over a weekend', 'barOf', days, { start: '2026-11-06T13:00', finish: '2026-11-10T12:00', is_milestone: false });
  add('a milestone is a point', 'barOf', days, { start: '2026-11-13T17:00', finish: '2026-11-13T17:00', is_milestone: true });
  add('a milestone with only a finish', 'barOf', days, { start: null, finish: '2026-11-13T17:00', is_milestone: true });
  add('a task without dates has no bar', 'barOf', days, { start: null, finish: null, is_milestone: false });
  add('a finish before the start is width 0', 'barOf', days,
    { start: '2026-11-05T08:00', finish: '2026-11-04T08:00', is_milestone: false });
  add('a partial-day bar at weeks', 'barOf', scaleAt('weeks'),
    { start: '2026-11-04T10:30', finish: '2026-11-09T14:15', is_milestone: false });
  add('a bar at quarters', 'barOf', scaleAt('quarters'),
    { start: '2026-11-04T10:30', finish: '2026-11-19T14:15', is_milestone: false });
  add('a baseline bar', 'baselineOf', days, { baseline_start: '2026-11-03T08:00', baseline_finish: '2026-11-05T17:00' });
  add('no baseline', 'baselineOf', days, { baseline_start: null, baseline_finish: null });

  add('progress: part done', 'progressWidth', 96, 37.5);
  add('progress: over 100 is the bar', 'progressWidth', 48, 150);
  add('progress: under 0 is none', 'progressWidth', 48, -5);

  // links: rows 18 px, the y their middles
  add('FS with room: out, down, in', 'linkPath', end(100, 200, 9), end(260, 300, 27), 'FS', 18, 8);
  add('FS back to back: a straight drop', 'linkPath', end(100, 200, 9), end(200, 300, 27), 'FS', 18, 8);
  add('FS backward: the detour between the rows', 'linkPath', end(100, 200, 9), end(150, 300, 45), 'FS', 18, 8);
  add('FS backward and up', 'linkPath', end(100, 200, 63), end(120, 300, 9), 'FS', 18, 8);
  add('SS: out the start, back past the successor', 'linkPath', end(100, 200, 9), end(120, 220, 45), 'SS', 18, 8);
  add('SS to an earlier start', 'linkPath', end(100, 200, 9), end(60, 220, 27), 'SS', 18, 8);
  add('FF: out the end, back into the end', 'linkPath', end(100, 200, 9), end(150, 260, 27), 'FF', 18, 8);
  add('FF to an earlier end', 'linkPath', end(100, 200, 9), end(120, 180, 27), 'FF', 18, 8);
  add('SF: out the start into the end', 'linkPath', end(300, 400, 9), end(100, 250, 27), 'SF', 18, 8);
  add('SF backward: the detour', 'linkPath', end(300, 400, 9), end(320, 450, 45), 'SF', 18, 8);
  add('FS at a coarse zoom stub', 'linkPath', end(100, 104.5, 9), end(106.2, 120, 27), 'FS', 18, 4);
  add('an FS arrow into a bar', 'linkShape', end(100, 200, 9), end(260, 300, 27), 'FS', 18, 8, 3.5);
  add('an FS arrow dropping onto a bar', 'linkShape', end(100, 200, 9), end(200, 300, 27), 'FS', 18, 8, 3.5);
  add('an SS arrow', 'linkShape', end(100, 200, 9), end(120, 220, 45), 'SS', 18, 8, 3.5);
  add('an FF arrow, leftward', 'linkShape', end(100, 200, 9), end(120, 180, 27), 'FF', 18, 6, 3.5);
  add('a detoured arrow, up', 'linkShape', end(100, 200, 63), end(120, 300, 9), 'FS', 18, 8, 3.5);
  for (const zoom of ZOOMS) add(`link stub at ${zoom}`, 'linkStub', zoom);

  add('bar box, no baseline', 'barBox', 18, false);
  add('bar box with the baseline', 'barBox', 18, true);
  add('bar box in a sheet row', 'barBox', 30, true);

  add('nonworking days: weekends, a holiday, a worked Saturday', 'nonworkingBands', CALENDAR,
    scaleAt('days', '2026-11-16T08:00', '2026-12-04T17:00'));
  add('nonworking days at hours', 'nonworkingBands', CALENDAR, scaleAt('hours', '2026-11-27T08:00', '2026-11-30T17:00'));

  for (const zoom of ZOOMS) add(`print scale at ${zoom}`, 'printScale', ...PROJECT, zoom);
  add('print scale of no span', 'printScale', PROJECT[0], PROJECT[0], 'days');
  add('print fit on letter', 'printFit', '2026-11-02T08:00', '2027-01-29T17:00', 'letter');
  add('print fit on A4', 'printFit', '2026-11-02T08:00', '2026-11-16T17:00', 'a4');
  add('print fit, a short range', 'printFit', '2026-11-02T08:00', '2026-11-03T12:00', 'letter');
  add('plan span: a task before the start widens it', 'planSpan', ...PROJECT, [
    { start: '2026-11-02T08:00', finish: '2026-11-03T17:00' }, { start: '2026-10-28T08:00', finish: '2026-10-28T12:00' },
    { start: null, finish: null }]);
  add('plan span: an empty plan', 'planSpan', PROJECT[0], null, []);
  const span = { start: PROJECT[0], finish: PROJECT[1] };
  add('print range: the whole project', 'printRange', span, null, null);
  add('print range: custom days inside', 'printRange', span, '2026-11-09', '2026-11-12');
  add('print range: custom days cut to the plan', 'printRange', span, '2026-10-01', '2027-12-31');
  add('print range: cut at the end only', 'printRange', span, '2026-11-15', '2027-01-31');
  add('print range: wholly after the plan', 'printRange', span, '2026-12-01', '2026-12-31');
  add('print range: wholly before the plan', 'printRange', span, '2026-10-01', '2026-11-01');
  add('ten years exactly is not too long', 'spanTooLong', '2026-01-01T00:00', '2036-01-01T00:00');
  add('a minute past ten years is too long', 'spanTooLong', '2026-01-01T00:00', '2036-01-01T00:01');
  add('ten years from Feb 29 ends on Mar 1', 'spanTooLong', '2028-02-29T08:00', '2038-03-01T08:00');
  add('ten years from Feb 29, a day over', 'spanTooLong', '2028-02-29T08:00', '2038-03-02T08:00');
  for (const paper of PAPERS) add(`page layout on ${paper}`, 'pageLayout', paper);
  add('pages: 40 tasks fit to letter', 'estimatePages', 40, '2026-11-02T08:00', '2027-01-29T17:00', 'fit', 'letter');
  add('pages: 40 tasks at days on letter', 'estimatePages', 40, '2026-11-02T08:00', '2027-01-29T17:00', 'days', 'letter');
  add('pages: 25 tasks at days on A4', 'estimatePages', 25, '2026-11-02T08:00', '2026-12-15T17:00', 'days', 'a4');
  add('pages: a year at days', 'estimatePages', 12, '2026-11-01T00:00', '2027-11-01T00:00', 'days', 'letter');
  add('pages: 1,500 tasks by months', 'estimatePages', 1500, '2026-11-02T08:00', '2028-05-01T17:00', 'months', 'a4');
  add('pages: no tasks', 'estimatePages', 0, PROJECT[0], PROJECT[0], 'fit', 'letter');
  return out;
}

if (process.env.REGEN_GANTT_VECTORS) {
  const rows: Row[] = cases().map((c) => ({ ...c, expected: call(c.fn, c.args) }));
  fs.writeFileSync(FILE, `${JSON.stringify(rows, null, 1)}\n`);
}

const ROWS: Row[] = JSON.parse(fs.readFileSync(FILE, 'utf8'));

describe('the shared Gantt vectors (api/tests/fixtures/plans/gantt.json)', () => {
  it('cover every function, every zoom, both papers and all four link types', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(20);
    expect(new Set(ROWS.map((r) => r.fn))).toEqual(new Set(Object.keys(FNS)));
    for (const zoom of ZOOMS) {
      for (const fn of ['makeScale', 'printScale', 'tiers', 'linkStub']) {
        expect(ROWS.some((r) => r.fn === fn && r.args.includes(zoom)), `${fn} at ${zoom}`).toBe(true);
      }
    }
    for (const paper of PAPERS) expect(ROWS.some((r) => r.fn === 'pageLayout' && r.args[0] === paper)).toBe(true);
    for (const type of ['FS', 'SS', 'FF', 'SF']) expect(ROWS.some((r) => r.fn === 'linkPath' && r.args[2] === type)).toBe(true);
  });

  it('are the cases this file makes', () => {
    expect(ROWS.map(({ name, fn, args }) => ({ name, fn, args }))).toEqual(
      JSON.parse(JSON.stringify(cases())));
  });

  it.each(ROWS.map((r) => [r.name, r] as const))('%s', (_name, row) => {
    expect(JSON.parse(JSON.stringify(call(row.fn, row.args)))).toEqual(row.expected);
  });
});
