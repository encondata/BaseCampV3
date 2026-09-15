/**
 * lib/timeline.ts — pure geometry, no DOM. Dates are constructed with the
 * (year, month, day) constructor throughout so every comparison happens
 * in local time, matching the module's own date-only semantics.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  barFor, calendarWeeks, itemsOnDay, monthBandsFor, monthGrid, rangeFor,
  realBarFor, sortForTimeline, ticksFor, type TimelineItem,
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

describe('calendarWeeks', () => {
  // September 2026: the grid starts Mon Aug 31, so week 0 is Aug 31 – Sep 6,
  // week 1 is Sep 7-13, week 2 Sep 14-20, week 3 Sep 21-27, week 4 Sep 28 –
  // Oct 4, and week 5 Oct 5-11.
  const cells = monthGrid(new Date(2026, 8, 1));

  it('gives one entry per week row, each holding its seven days', () => {
    const weeks = calendarWeeks([], cells);
    expect(weeks).toHaveLength(6);
    expect(weeks[0].days).toHaveLength(7);
    expect(weeks[0].days[0].date).toEqual(new Date(2026, 7, 31));
    expect(weeks[5].days[6].date).toEqual(new Date(2026, 9, 11));
    expect(weeks[0].segments).toEqual([]);
    expect(weeks[0].laneCount).toBe(0);
  });

  it('turns a multi-day item into one spanning segment per week it touches', () => {
    const items = [item({
      name: 'Long', scheduled_start: '2026-09-10', scheduled_end: '2026-09-16',
    })];
    const weeks = calendarWeeks(items, cells);
    // Sep 10 is a Thursday (column 3) in week 1; the run reaches Sunday.
    expect(weeks[1].segments).toEqual([expect.objectContaining({
      startCol: 3, span: 4, lane: 0,
      continuesBefore: false, continuesAfter: true,
    })]);
    // Week 2 picks it up on Monday and stops on Wednesday (Sep 16).
    expect(weeks[2].segments).toEqual([expect.objectContaining({
      startCol: 0, span: 3, lane: 0,
      continuesBefore: true, continuesAfter: false,
    })]);
    expect(weeks[0].segments).toEqual([]);
    expect(weeks[3].segments).toEqual([]);
  });

  it('renders a single-day item as a one-column segment with no continuation', () => {
    const items = [item({ name: 'One', scheduled_start: '2026-09-09', scheduled_end: null })];
    const seg = calendarWeeks(items, cells)[1].segments[0];
    expect(seg).toMatchObject({
      startCol: 2, span: 1, lane: 0, continuesBefore: false, continuesAfter: false,
    });
    expect(seg.item.name).toBe('One');
  });

  it('clips a run that starts before the grid and ends after it', () => {
    const items = [item({
      name: 'Straddles', scheduled_start: '2026-08-01', scheduled_end: '2026-11-01',
    })];
    const weeks = calendarWeeks(items, cells);
    expect(weeks[0].segments[0]).toMatchObject({
      startCol: 0, span: 7, continuesBefore: true, continuesAfter: true,
    });
    expect(weeks[5].segments[0]).toMatchObject({
      startCol: 0, span: 7, continuesBefore: true, continuesAfter: true,
    });
  });

  it('stacks overlapping runs into separate lanes and reuses a free lane', () => {
    const items = [
      item({ name: 'A', scheduled_start: '2026-09-07', scheduled_end: '2026-09-09' }),
      item({ name: 'B', scheduled_start: '2026-09-08', scheduled_end: '2026-09-10' }),
      // Starts after A ends, so it fits beside B on A's lane.
      item({ name: 'C', scheduled_start: '2026-09-11', scheduled_end: '2026-09-11' }),
    ];
    const week = calendarWeeks(items, cells)[1];
    const byName = Object.fromEntries(week.segments.map((s) => [s.item.name, s]));
    expect(byName.A.lane).toBe(0);
    expect(byName.B.lane).toBe(1);
    expect(byName.C.lane).toBe(0);
    expect(week.laneCount).toBe(2);
  });

  it('orders lanes by start date, then by the longer run, then by name', () => {
    const items = [
      item({ name: 'Zed short', scheduled_start: '2026-09-07', scheduled_end: '2026-09-07' }),
      item({ name: 'Alpha long', scheduled_start: '2026-09-07', scheduled_end: '2026-09-11' }),
      item({ name: 'Earlier', scheduled_start: '2026-09-06', scheduled_end: '2026-09-09' }),
    ];
    const week = calendarWeeks(items, cells)[1];
    const byName = Object.fromEntries(week.segments.map((s) => [s.item.name, s]));
    // Earlier starts before the week, so it takes lane 0; the longer of the
    // two Monday runs takes lane 1 and the short one lane 2.
    expect(byName.Earlier.lane).toBe(0);
    expect(byName['Alpha long'].lane).toBe(1);
    expect(byName['Zed short'].lane).toBe(2);
  });

  it('ignores unscheduled items', () => {
    const weeks = calendarWeeks([item({ name: 'No dates', scheduled_start: null })], cells);
    expect(weeks.every((w) => w.segments.length === 0)).toBe(true);
  });

  it('treats an end before the start as a single day', () => {
    const items = [item({
      name: 'Backwards', scheduled_start: '2026-09-09', scheduled_end: '2026-09-07',
    })];
    expect(calendarWeeks(items, cells)[1].segments[0])
      .toMatchObject({ startCol: 2, span: 1 });
  });
});

describe('rangeFor 45-day scale', () => {
  it('starts on the anchor day when the anchor is itself a Monday', () => {
    // Sep 7 2026 is a Monday.
    const { start, end } = rangeFor(new Date(2026, 8, 7), '45d');
    expect(start).toEqual(new Date(2026, 8, 7));
    expect(end).toEqual(new Date(2026, 9, 22)); // Sep 7 + 45 days, end-exclusive
  });

  it('backs a mid-week anchor up to the Monday of its week', () => {
    // Sep 10 2026 is a Thursday.
    const { start, end } = rangeFor(new Date(2026, 8, 10), '45d');
    expect(start).toEqual(new Date(2026, 8, 7));
    expect(end).toEqual(new Date(2026, 9, 22));
  });

  it('puts a Sunday in the week that began the previous Monday', () => {
    // Sep 13 2026 is a Sunday — monthGrid's Monday-first convention makes it
    // the last day of the week starting Mon Sep 7, not the first of Sep 14's.
    const { start, end } = rangeFor(new Date(2026, 8, 13), '45d');
    expect(start).toEqual(new Date(2026, 8, 7));
    expect(end).toEqual(new Date(2026, 9, 22));
  });

  it('ignores the anchor time-of-day', () => {
    const { start } = rangeFor(new Date(2026, 8, 10, 23, 45), '45d');
    expect(start).toEqual(new Date(2026, 8, 7));
  });

  it('spans exactly 45 days', () => {
    const { start, end } = rangeFor(new Date(2026, 8, 10), '45d');
    const days = Math.round((end.getTime() - start.getTime()) / 86400000);
    expect(days).toBe(45);
  });
});

describe('ticksFor 45-day scale', () => {
  it('returns 45 day ticks labeled with the day of the month', () => {
    const range = rangeFor(new Date(2026, 8, 10), '45d'); // Mon Sep 7 2026
    const ticks = ticksFor(range, '45d');
    expect(ticks).toHaveLength(45);
    expect(ticks[0].at).toEqual(new Date(2026, 8, 7));
    expect(ticks[0].label).toBe('7');
    expect(ticks[44].at).toEqual(new Date(2026, 9, 21));
    expect(ticks[44].label).toBe('21');
    expect(ticks[23].at).toEqual(new Date(2026, 8, 30));
    expect(ticks[24].at).toEqual(new Date(2026, 9, 1));
    expect(ticks[24].label).toBe('1');
  });
});

describe('monthBandsFor', () => {
  it('a range inside one month is a single band at 0/100', () => {
    const bands = monthBandsFor(rangeFor(new Date(2026, 8, 15), 'month'));
    expect(bands).toEqual([{ label: 'Sep 2026', left: 0, width: 100 }]);
  });

  it('a 45-day range crossing a month boundary yields two clipped bands', () => {
    const range = rangeFor(new Date(2026, 8, 10), '45d'); // Sep 7 - Oct 22 2026
    const bands = monthBandsFor(range);
    expect(bands.map((b) => b.label)).toEqual(['Sep 2026', 'Oct 2026']);
    expect(bands[0].left).toBe(0);
    expect(bands[0].width).toBeCloseTo((24 / 45) * 100, 6); // Sep 7 - Sep 30
    expect(bands[1].left).toBeCloseTo((24 / 45) * 100, 6);
    expect(bands[1].width).toBeCloseTo((21 / 45) * 100, 6); // Oct 1 - Oct 21
  });

  it('a quarter yields three whole-month bands', () => {
    const bands = monthBandsFor(rangeFor(new Date(2026, 7, 3), 'quarter'));
    expect(bands.map((b) => b.label)).toEqual(['Jul 2026', 'Aug 2026', 'Sep 2026']);
  });

  it('bands are contiguous, in order, and sum to 100', () => {
    for (const range of [
      rangeFor(new Date(2026, 8, 10), '45d'),
      rangeFor(new Date(2026, 7, 3), 'quarter'),
      rangeFor(new Date(2026, 3, 9), 'year'),
      { start: new Date(2026, 1, 20), end: new Date(2026, 4, 3) },
    ]) {
      const bands = monthBandsFor(range);
      expect(bands.length).toBeGreaterThan(0);
      expect(bands[0].left).toBe(0);
      for (let i = 1; i < bands.length; i++) {
        expect(bands[i].left).toBeCloseTo(bands[i - 1].left + bands[i - 1].width, 6);
      }
      const last = bands[bands.length - 1];
      expect(last.left + last.width).toBeCloseTo(100, 6);
      const total = bands.reduce((sum, b) => sum + b.width, 0);
      expect(total).toBeCloseTo(100, 6);
      for (const b of bands) expect(b.width).toBeGreaterThan(0);
    }
  });

  it('names the year on every band, so a range crossing New Year stays clear', () => {
    // Dec 15 2026 is a Tuesday; its week began Mon Dec 14.
    const range = rangeFor(new Date(2026, 11, 15), '45d');
    expect(range.start).toEqual(new Date(2026, 11, 14));
    expect(range.end).toEqual(new Date(2027, 0, 28));
    const bands = monthBandsFor(range);
    expect(bands.map((b) => b.label)).toEqual(['Dec 2026', 'Jan 2027']);
    expect(bands[0].width).toBeCloseTo((18 / 45) * 100, 6); // Dec 14 - Dec 31
    expect(bands[1].width).toBeCloseTo((27 / 45) * 100, 6); // Jan 1 - Jan 27
  });

  it('a range spanning a whole year yields twelve bands', () => {
    const bands = monthBandsFor(rangeFor(new Date(2026, 3, 9), 'year'));
    expect(bands).toHaveLength(12);
    expect(bands[0].label).toBe('Jan 2026');
    expect(bands[11].label).toBe('Dec 2026');
  });
});
