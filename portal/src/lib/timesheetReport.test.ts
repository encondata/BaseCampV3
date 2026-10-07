import { expect, it } from 'vitest';

import {
  buildTimesheetRunOptions, quickRange, timesheetDateError, timesheetDefaults,
  timesheetOptionsValid,
} from './timesheetReport';

const d = (y: number, m: number, day: number) => new Date(y, m - 1, day, 15, 30);

it('this week runs Monday to Sunday around today', () => {
  // 2026-10-07 is a Wednesday
  expect(quickRange('this_week', d(2026, 10, 7))).toEqual({ from: '2026-10-05', to: '2026-10-11' });
  // a Monday is its own week start
  expect(quickRange('this_week', d(2026, 10, 5))).toEqual({ from: '2026-10-05', to: '2026-10-11' });
});

it('a Sunday belongs to the week that started the Monday before', () => {
  expect(quickRange('this_week', d(2026, 10, 11))).toEqual({ from: '2026-10-05', to: '2026-10-11' });
  expect(quickRange('last_week', d(2026, 10, 11))).toEqual({ from: '2026-09-28', to: '2026-10-04' });
});

it('last week crosses month and year boundaries', () => {
  expect(quickRange('last_week', d(2026, 10, 7))).toEqual({ from: '2026-09-28', to: '2026-10-04' });
  // 2026-01-01 is a Thursday: last week is Dec 22-28, 2025
  expect(quickRange('last_week', d(2026, 1, 1))).toEqual({ from: '2025-12-22', to: '2025-12-28' });
});

it('this month is the 1st through today', () => {
  expect(quickRange('this_month', d(2026, 10, 6))).toEqual({ from: '2026-10-01', to: '2026-10-06' });
  expect(quickRange('this_month', d(2026, 10, 1))).toEqual({ from: '2026-10-01', to: '2026-10-01' });
});

it('last month is the whole previous month, including leap February and January', () => {
  expect(quickRange('last_month', d(2026, 10, 6))).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  expect(quickRange('last_month', d(2026, 1, 15))).toEqual({ from: '2025-12-01', to: '2025-12-31' });
  expect(quickRange('last_month', d(2028, 3, 1))).toEqual({ from: '2028-02-01', to: '2028-02-29' });
});

it('defaults come from the definition and fall back when missing or invalid', () => {
  expect(timesheetDefaults({ options: {} })).toEqual({
    format: 'xlsx', views: ['day', 'punch'], statuses: ['approved', 'pending'],
  });
  expect(timesheetDefaults({
    options: { default_format: 'pdf', default_views: ['punch'], default_statuses: ['rejected', 'approved'] },
  })).toEqual({ format: 'pdf', views: ['punch'], statuses: ['approved', 'rejected'] });
  expect(timesheetDefaults({
    options: { default_format: 'docx', default_views: [], default_statuses: ['bogus'] },
  })).toEqual({ format: 'xlsx', views: ['day', 'punch'], statuses: ['approved', 'pending'] });
});

it('builds run options, omitting an empty person and site', () => {
  expect(buildTimesheetRunOptions({
    from: '2026-10-01', to: '2026-10-06', personId: '', siteId: '',
    statuses: ['pending', 'approved'], views: ['punch', 'day'], format: 'pdf',
  })).toEqual({
    from: '2026-10-01', to: '2026-10-06', statuses: ['approved', 'pending'],
    views: ['day', 'punch'], format: 'pdf',
  });
  expect(buildTimesheetRunOptions({
    from: '2026-10-01', to: '2026-10-06', personId: 'p1', siteId: 's1',
    statuses: ['open'], views: ['day'], format: 'xlsx',
  })).toMatchObject({ person_id: 'p1', site_id: 's1', statuses: ['open'] });
});

it('validates dates, at least one status and one view', () => {
  const ok = { from: '2026-10-01', to: '2026-10-06', statuses: ['approved' as const], views: ['day' as const] };
  expect(timesheetOptionsValid(ok)).toBe(true);
  expect(timesheetOptionsValid({ ...ok, from: '' })).toBe(false);
  expect(timesheetOptionsValid({ ...ok, to: '2026-09-30' })).toBe(false);
  expect(timesheetOptionsValid({ ...ok, statuses: [] })).toBe(false);
  expect(timesheetOptionsValid({ ...ok, views: [] })).toBe(false);
  expect(timesheetOptionsValid({ ...ok, from: '2025-01-01', to: '2026-01-02' })).toBe(false);
  expect(timesheetOptionsValid({ ...ok, from: '2025-01-01', to: '2026-01-01' })).toBe(true);
});

it('explains a bad date range', () => {
  expect(timesheetDateError('', '2026-10-01')).toBe('');
  expect(timesheetDateError('2026-10-05', '2026-10-01')).toBe('The From date must be on or before the To date.');
  expect(timesheetDateError('2025-01-01', '2026-01-02')).toBe('The range can span at most 366 days.');
  expect(timesheetDateError('2026-10-01', '2026-10-06')).toBe('');
});
