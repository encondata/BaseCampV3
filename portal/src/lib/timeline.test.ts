/**
 * lib/timeline.ts — pure geometry, no DOM. Dates are constructed with the
 * (year, month, day) constructor throughout so every comparison happens
 * in local time, matching the module's own date-only semantics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  barFor, itemsOnDay, monthGrid, rangeFor, realBarFor, sortForTimeline,
  ticksFor, type TimelineItem,
} from './timeline';

function item(overrides: Partial<TimelineItem>): TimelineItem {
  return {
    name: 'Item', scheduled_start: null, scheduled_end: null,
    real_start_at: null, real_end_at: null,
    ...overrides,
  };
}

describe('rangeFor', () => {
  it('month is the calendar month, end-exclusive', () => {
    const { start, end } = rangeFor(new Date(2026, 8, 15), 'month'); // Sep 15 2026
    expect(start).toEqual(new Date(2026, 8, 1));
    expect(end).toEqual(new Date(2026, 9, 1));
  });

  it('quarter is the calendar quarter, end-exclusive', () => {
    const { start, end } = rangeFor(new Date(2026, 8, 15), 'quarter'); // Q3 2026
    expect(start).toEqual(new Date(2026, 6, 1));
    expect(end).toEqual(new Date(2026, 9, 1));
  });

  it('quarter handles the first month of a quarter too', () => {
    const { start, end } = rangeFor(new Date(2026, 0, 5), 'quarter'); // Q1 2026
    expect(start).toEqual(new Date(2026, 0, 1));
    expect(end).toEqual(new Date(2026, 3, 1));
  });

  it('year is the calendar year, end-exclusive', () => {
    const { start, end } = rangeFor(new Date(2026, 8, 15), 'year');
    expect(start).toEqual(new Date(2026, 0, 1));
    expect(end).toEqual(new Date(2027, 0, 1));
  });
});

describe('ticksFor', () => {
  it('month scale: one tick per day, labeled 1…N', () => {
    const range = rangeFor(new Date(2026, 8, 1), 'month'); // September, 30 days
    const ticks = ticksFor(range, 'month');
    expect(ticks).toHaveLength(30);
    expect(ticks[0].label).toBe('1');
    expect(ticks[29].label).toBe('30');
    expect(ticks[0].at).toEqual(new Date(2026, 8, 1));
  });

  it('quarter scale: one tick per ISO week, Monday-aligned', () => {
    const range = rangeFor(new Date(2026, 6, 1), 'quarter'); // Q3 2026: Jul 1 - Sep 30
    const ticks = ticksFor(range, 'quarter');
    expect(ticks.length).toBeGreaterThan(10);
    for (const t of ticks) {
      expect(t.at.getDay()).toBe(1); // every tick lands on a Monday
      expect(t.label).toMatch(/^Wk \d+ · [A-Z][a-z]{2} \d{1,2}$/);
    }
  });

  it('year scale: one tick per month, labeled Jan…Dec', () => {
    const range = rangeFor(new Date(2026, 5, 1), 'year');
    const ticks = ticksFor(range, 'year');
    expect(ticks).toHaveLength(12);
    expect(ticks.map((t) => t.label)).toEqual([
      'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
      'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
    ]);
  });
});

describe('barFor', () => {
  const range = rangeFor(new Date(2026, 8, 1), 'month'); // Sep 1 - Sep 30 (end excl Oct 1)

  it('null when scheduled_start is missing', () => {
    expect(barFor(item({}), range)).toBeNull();
  });

  it('null when the span is entirely before the range', () => {
    const i = item({ scheduled_start: '2026-07-01', scheduled_end: '2026-07-05' });
    expect(barFor(i, range)).toBeNull();
  });

  it('null when the span is entirely after the range', () => {
    const i = item({ scheduled_start: '2026-11-01', scheduled_end: '2026-11-05' });
    expect(barFor(i, range)).toBeNull();
  });

  it('missing scheduled_end renders a one-day bar', () => {
    const i = item({ scheduled_start: '2026-09-10' });
    const bar = barFor(i, range)!;
    expect(bar).not.toBeNull();
    // day 10 of 30 → left = 9/30 * 100, width = 1/30 * 100
    expect(bar.left).toBeCloseTo((9 / 30) * 100, 6);
    expect(bar.width).toBeCloseTo((1 / 30) * 100, 6);
  });

  it('clips a bar that starts before the range', () => {
    const i = item({ scheduled_start: '2026-08-25', scheduled_end: '2026-09-05' });
    const bar = barFor(i, range)!;
    expect(bar.left).toBe(0);
    // visible span is Sep 1..5 inclusive = 5 days
    expect(bar.width).toBeCloseTo((5 / 30) * 100, 6);
  });

  it('clips a bar that ends after the range', () => {
    const i = item({ scheduled_start: '2026-09-28', scheduled_end: '2026-10-10' });
    const bar = barFor(i, range)!;
    // visible span is Sep 28..30 inclusive = 3 days
    expect(bar.left).toBeCloseTo((27 / 30) * 100, 6);
    expect(bar.width).toBeCloseTo((3 / 30) * 100, 6);
  });

  it('spans the full range when start/end bracket it entirely', () => {
    const i = item({ scheduled_start: '2026-01-01', scheduled_end: '2026-12-31' });
    const bar = barFor(i, range)!;
    expect(bar.left).toBe(0);
    expect(bar.width).toBeCloseTo(100, 6);
  });
});

describe('realBarFor', () => {
  const range = rangeFor(new Date(2026, 8, 1), 'month');
  const today = new Date(2026, 8, 15);

  it('null when real_start_at is missing', () => {
    expect(realBarFor(item({}), range, today)).toBeNull();
  });

  it('defaults the end to today when real_end_at is unset', () => {
    const i = item({ real_start_at: '2026-09-10', real_end_at: null });
    const bar = realBarFor(i, range, today)!;
    // Sep 10..15 inclusive = 6 days
    expect(bar.left).toBeCloseTo((9 / 30) * 100, 6);
    expect(bar.width).toBeCloseTo((6 / 30) * 100, 6);
  });

  it('uses real_end_at when present', () => {
    const i = item({ real_start_at: '2026-09-10', real_end_at: '2026-09-12' });
    const bar = realBarFor(i, range, today)!;
    expect(bar.width).toBeCloseTo((3 / 30) * 100, 6);
  });
});

describe('sortForTimeline', () => {
  it('sorts scheduled items by scheduled_start asc, unscheduled last by name', () => {
    const items = [
      item({ name: 'Zeta', scheduled_start: null }),
      item({ name: 'Beta', scheduled_start: '2026-09-05' }),
      item({ name: 'Alpha', scheduled_start: null }),
      item({ name: 'Gamma', scheduled_start: '2026-09-01' }),
    ];
    const sorted = sortForTimeline(items).map((i) => i.name);
    expect(sorted).toEqual(['Gamma', 'Beta', 'Alpha', 'Zeta']);
  });

  it('does not mutate the input array', () => {
    const items = [item({ name: 'B' }), item({ name: 'A' })];
    const copy = [...items];
    sortForTimeline(items);
    expect(items).toEqual(copy);
  });
});

describe('monthGrid', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 10)); // Sep 10 2026
  });
  afterEach(() => { vi.useRealTimers(); });

  it('returns 42 Monday-first cells', () => {
    const cells = monthGrid(new Date(2026, 8, 1)); // September 2026 starts Tuesday
    expect(cells).toHaveLength(42);
    expect(cells[0].date.getDay()).toBe(1); // Monday
    // Sep 1 2026 is a Tuesday, so the grid's first cell is Mon Aug 31
    expect(cells[0].date).toEqual(new Date(2026, 7, 31));
    expect(cells[0].inMonth).toBe(false);
  });

  it('flags the in-month cells and today', () => {
    const cells = monthGrid(new Date(2026, 8, 1));
    const sep10 = cells.find((c) => c.date.getTime() === new Date(2026, 8, 10).getTime());
    expect(sep10?.inMonth).toBe(true);
    expect(sep10?.isToday).toBe(true);
    const aug31 = cells.find((c) => c.date.getTime() === new Date(2026, 7, 31).getTime());
    expect(aug31?.isToday).toBe(false);
  });
});

describe('itemsOnDay', () => {
  const items = [
    item({ name: 'One-day', scheduled_start: '2026-09-10', scheduled_end: null }),
    item({ name: 'Ranged', scheduled_start: '2026-09-08', scheduled_end: '2026-09-12' }),
    item({ name: 'Unscheduled', scheduled_start: null }),
  ];

  it('includes items whose range covers the day, inclusive of both ends', () => {
    expect(itemsOnDay(items, new Date(2026, 8, 8)).map((i) => i.name)).toEqual(['Ranged']);
    expect(itemsOnDay(items, new Date(2026, 8, 10)).map((i) => i.name).sort())
      .toEqual(['One-day', 'Ranged']);
    expect(itemsOnDay(items, new Date(2026, 8, 12)).map((i) => i.name)).toEqual(['Ranged']);
  });

  it('excludes days outside the range and unscheduled items', () => {
    expect(itemsOnDay(items, new Date(2026, 8, 13))).toEqual([]);
    expect(itemsOnDay(items, new Date(2026, 8, 7))).toEqual([]);
  });
});
