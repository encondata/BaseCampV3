// @vitest-environment jsdom
/**
 * lib/plans/columns.ts: the task sheet's columns (MS Project names and
 * order), what each cell shows, and the per-browser column preferences in
 * localStorage `plans.columns.v1`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { STANDARD_UNITS } from './durations';
import {
  COLUMN_BY_KEY,
  DEFAULT_VISIBLE,
  PLAN_COLUMNS,
  REQUIRED_COLUMNS,
  columnPrefsSnapshot,
  columnWidth,
  loadColumnPrefs,
  saveColumnPrefs,
  subscribeColumnPrefs,
  type SheetContext,
} from './columns';
import { makeTask } from './planFixtures';

const KEY = 'plans.columns.v1';
const CTX: SheetContext = { showTimes: false, units: STANDARD_UNITS, timeZone: 'America/Chicago', locked: false };
const cell = (key: string, over = {}, ctx: Partial<SheetContext> = {}) =>
  COLUMN_BY_KEY.get(key)!.value(makeTask('t', over), { ...CTX, ...ctx });

beforeEach(() => localStorage.clear());
afterEach(() => localStorage.clear());

describe('PLAN_COLUMNS', () => {
  it('lists the default and optional columns in MS Project order', () => {
    expect(PLAN_COLUMNS.map((c) => c.key)).toEqual([
      'indicators', 'id', 'mode', 'name', 'duration', 'start', 'finish', 'predecessors', 'resources',
      'percent', 'deadline', 'wbs', 'successors', 'slack', 'critical', 'status', 'constraint_type',
      'constraint_date', 'actual_start', 'actual_finish', 'baseline_start', 'baseline_finish',
      'baseline_duration', 'start_variance', 'finish_variance', 'notes', 'created', 'updated',
    ]);
    expect(DEFAULT_VISIBLE).toEqual([
      'indicators', 'id', 'mode', 'name', 'duration', 'start', 'finish', 'predecessors', 'resources',
      'percent', 'deadline',
    ]);
  });

  it('uses MS Project labels', () => {
    const label = (key: string) => COLUMN_BY_KEY.get(key)!.label;
    expect(['name', 'resources', 'percent', 'slack', 'start_variance'].map(label))
      .toEqual(['Task Name', 'Resource Names', '% Complete', 'Total Slack', 'Start Variance']);
  });

  it('ID and Task Name are always shown', () => {
    expect([...REQUIRED_COLUMNS]).toEqual(['id', 'name']);
  });

  it('every width is at least its minimum', () => {
    for (const col of PLAN_COLUMNS) expect(col.width, col.key).toBeGreaterThanOrEqual(col.min);
  });
});

describe('cell values', () => {
  it('dates follow the plan’s Show times setting', () => {
    expect(cell('start', { start: '2026-11-02T08:00' })).toBe('Mon 11/2/26');
    expect(cell('start', { start: '2026-11-02T08:00' }, { showTimes: true })).toBe('Mon 11/2/26 8:00 AM');
    expect(cell('deadline', { deadline: null })).toBe('');
  });

  it('% Complete, Resource Names and Mode read as text', () => {
    expect(cell('percent', { percent_complete: 45 })).toBe('45%');
    expect(cell('resources', {
      assignees: [{ kind: 'person', id: 'p1', name: 'Dana Reyes' },
        { kind: 'partner', id: 'x1', name: 'Champagne Logistics' }],
    })).toBe('Dana Reyes, Champagne Logistics');
    expect(cell('mode', { mode: 'manual' })).toBe('Manually Scheduled');
    expect(cell('mode', { mode: 'auto' })).toBe('Auto Scheduled');
  });

  it('constraint types use MS Project’s names', () => {
    const names = (['asap', 'snet', 'snlt', 'fnet', 'fnlt', 'mso', 'mfo'] as const)
      .map((t) => cell('constraint_type', { constraint_type: t }));
    expect(names).toEqual([
      'As Soon As Possible', 'Start No Earlier Than', 'Start No Later Than', 'Finish No Earlier Than',
      'Finish No Later Than', 'Must Start On', 'Must Finish On',
    ]);
  });

  it('slack and variances are durations in the plan’s units, as the API sent them', () => {
    expect(cell('slack', { total_slack_minutes: 960 })).toBe('2 days');
    expect(cell('slack', { total_slack_minutes: -240 })).toBe('-0.5 days');
    expect(cell('slack', { total_slack_minutes: null })).toBe('');
    expect(cell('start_variance', { start_variance_minutes: 480 })).toBe('1 day');
    expect(cell('finish_variance', { finish_variance_minutes: 0 })).toBe('0 days');
    expect(cell('finish_variance', { finish_variance_minutes: null })).toBe('');
    // a 10-hour working day makes 600 minutes one day
    const tenHours = { minutesPerDay: 600, minutesPerWeek: 3000, minutesPerMonth: 12000 };
    expect(cell('slack', { total_slack_minutes: 600 }, { units: tenHours })).toBe('1 day');
  });

  it('Baseline Duration uses the task’s own unit', () => {
    expect(cell('baseline_duration', { baseline_duration_minutes: 240, duration_unit: 'h' })).toBe('4 hrs');
    expect(cell('baseline_duration', { baseline_duration_minutes: null })).toBe('');
  });

  it('Status, Critical and Notes', () => {
    expect(cell('status', { status: 'late' })).toBe('Late');
    expect(cell('status', { status: 'not_started' })).toBe('Not started');
    expect(cell('critical', { is_critical: true })).toBe('Yes');
    expect(cell('critical', { is_critical: false })).toBe('No');
    expect(cell('notes', { notes: 'Call the\nloading dock' })).toBe('Call the loading dock');
  });

  it('Created and Updated read in the plan’s time zone', () => {
    // 15:30 UTC is 9:30 AM in Chicago (CST from Nov 1)
    expect(cell('updated', { updated_at: '2026-11-04T15:30:00Z' }, { showTimes: true }))
      .toBe('Wed 11/4/26 9:30 AM');
    expect(cell('created', { created_at: '2026-11-03T03:00:00Z' })).toBe('Mon 11/2/26');
  });
});

describe('columnWidth', () => {
  it('is the stored width, else the default scaled with the list size', () => {
    const name = COLUMN_BY_KEY.get('name')!;
    expect(columnWidth(name, { name: 333 }, 1, false)).toBe(333);
    expect(columnWidth(name, {}, 1, false)).toBe(name.width);
    expect(columnWidth(name, {}, 1.3, false)).toBe(Math.round(name.width * 1.3));
  });

  it('date columns are wider when the plan shows times', () => {
    const start = COLUMN_BY_KEY.get('start')!;
    expect(columnWidth(start, {}, 1, true)).toBeGreaterThan(columnWidth(start, {}, 1, false));
  });
});

describe('column preferences', () => {
  it('without a saved entry, shows the default columns', () => {
    expect(loadColumnPrefs()).toEqual({ visible: DEFAULT_VISIBLE, widths: {} });
  });

  it('drops a column it does not know and a width for one', () => {
    localStorage.setItem(KEY, JSON.stringify({
      visible: ['id', 'name', 'bogus', 'duration'],
      widths: { bogus: 50, name: 300, duration: 'wide' },
      seen: PLAN_COLUMNS.map((c) => c.key),
    }));
    expect(loadColumnPrefs()).toEqual({ visible: ['id', 'name', 'duration'], widths: { name: 300 } });
  });

  it('keeps the saved order and hidden columns', () => {
    saveColumnPrefs({ visible: ['name', 'id', 'finish', 'wbs'], widths: { finish: 140 } });
    expect(loadColumnPrefs()).toEqual({ visible: ['name', 'id', 'finish', 'wbs'], widths: { finish: 140 } });
  });

  it('records every column it offered, so a column hidden on purpose stays hidden', () => {
    saveColumnPrefs({ visible: ['id', 'name'], widths: {} });
    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.seen).toEqual(PLAN_COLUMNS.map((c) => c.key));
    expect(loadColumnPrefs().visible).toEqual(['id', 'name']);
  });

  it('surfaces a default column the saved entry never offered, at its default place', () => {
    // saved before "deadline" and "mode" existed: neither was offered
    const offered = PLAN_COLUMNS.map((c) => c.key).filter((k) => k !== 'deadline' && k !== 'mode');
    localStorage.setItem(KEY, JSON.stringify({
      visible: ['id', 'name', 'duration', 'start'], widths: {}, seen: offered,
    }));
    expect(loadColumnPrefs().visible).toEqual(['id', 'mode', 'name', 'duration', 'start', 'deadline']);
  });

  it('always shows ID and Task Name', () => {
    localStorage.setItem(KEY, JSON.stringify({
      visible: ['duration'], widths: {}, seen: PLAN_COLUMNS.map((c) => c.key),
    }));
    expect(loadColumnPrefs().visible).toEqual(['id', 'name', 'duration']);
  });

  it('a damaged entry reads as the defaults', () => {
    localStorage.setItem(KEY, '{not json');
    expect(loadColumnPrefs().visible).toEqual(DEFAULT_VISIBLE);
    localStorage.setItem(KEY, JSON.stringify({ visible: 'id', widths: [3] }));
    expect(loadColumnPrefs()).toEqual({ visible: DEFAULT_VISIBLE, widths: {} });
  });

  it('keeps widths between the column minimum and a sane maximum', () => {
    localStorage.setItem(KEY, JSON.stringify({
      visible: DEFAULT_VISIBLE, widths: { name: 5, duration: 99999 }, seen: PLAN_COLUMNS.map((c) => c.key),
    }));
    const { widths } = loadColumnPrefs();
    expect(widths.name).toBe(COLUMN_BY_KEY.get('name')!.min);
    expect(widths.duration).toBeLessThanOrEqual(1200);
  });

  it('a save tells subscribers, and the snapshot stays the same object until something changes', () => {
    const heard = vi.fn();
    const stop = subscribeColumnPrefs(heard);
    const first = columnPrefsSnapshot();
    expect(columnPrefsSnapshot()).toBe(first);
    saveColumnPrefs({ visible: ['id', 'name'], widths: {} });
    expect(heard).toHaveBeenCalledTimes(1);
    const second = columnPrefsSnapshot();
    expect(second).not.toBe(first);
    expect(second.visible).toEqual(['id', 'name']);
    stop();
    saveColumnPrefs({ visible: [...DEFAULT_VISIBLE], widths: {} });
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('survives storage that throws', () => {
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    try {
      expect(loadColumnPrefs().visible).toEqual(DEFAULT_VISIBLE);
      expect(() => saveColumnPrefs({ visible: ['id', 'name'], widths: {} })).not.toThrow();
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});
