import { expect, it } from 'vitest';

import type { TimeEntryItem } from './api';
import { buildTimeclockEvents, hoursDayPoints } from './peopleDashboard';

const E = (over: Partial<TimeEntryItem>): TimeEntryItem => ({
  id: 'e1', person_id: 'p1', person_name: 'Ada Lovelace',
  initiative_id: null, initiative_name: null, site_id: null, site_name: null,
  clock_in_at: '2026-09-02T09:00:00Z', clock_out_at: null,
  break_minutes: 0, minutes: 0,
  status: 'open', status_label: 'Open', status_color: '#333',
  source: 'punch', notes: '', adjusted: false, adjust_reason: null,
  approved_by: null, approved_by_name: null, approved_at: null,
  reject_reason: null,
  created_at: '2026-09-02T09:00:00Z', updated_at: '2026-09-02T09:00:00Z',
  ...over,
});

it('emits in and out events interleaved newest-first with cap', () => {
  const entries = [
    E({ id: 'e2', clock_in_at: '2026-09-02T08:00:00Z',
        clock_out_at: '2026-09-02T12:30:00Z', minutes: 270,
        site_name: 'NAP11' }),
    E({ id: 'e1', clock_in_at: '2026-09-02T09:00:00Z' }), // still open
  ];
  const evs = buildTimeclockEvents(entries, 20);
  expect(evs.map((e) => `${e.kind}@${e.at}`)).toEqual([
    'out@2026-09-02T12:30:00Z',
    'in@2026-09-02T09:00:00Z',
    'in@2026-09-02T08:00:00Z',
  ]);
  expect(evs[0].minutes).toBe(270);
  expect(evs[0].context).toBe('NAP11');
  expect(evs[1].minutes).toBeNull();
  expect(buildTimeclockEvents(entries, 2)).toHaveLength(2);
});

it('prefers initiative over site as context', () => {
  const evs = buildTimeclockEvents(
    [E({ initiative_name: 'NAP11 Hall Migration', site_name: 'NAP11' })], 5);
  expect(evs[0].context).toBe('NAP11 Hall Migration');
});

it('hoursDayPoints maps day stats to chart points', () => {
  const pts = hoursDayPoints([
    { day: '2026-08-30', minutes: 0 },
    { day: '2026-09-02', minutes: 480 },
  ]);
  expect(pts).toHaveLength(2);
  expect(pts[1]).toMatchObject({ key: '2026-09-02', value: 480 });
  expect(pts[1].label).toMatch(/Sep/);
});
