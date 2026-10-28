/** Nonworking-day shading for the Gantt: whole days the calendar does not
 *  work, from the weekly pattern and the dated exceptions (plans/calendar.py
 *  clean_calendar). Only the finer zooms draw it. */
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PlanCalendar } from './api';
import { nonworkingBands } from './calendarShade';
import { makeScale, type Scale } from './ganttGeometry';
import { toMs } from './floatingTime';
import { makePlan } from './planFixtures';

const standard = (): PlanCalendar => makePlan().calendar;

/** Mon 11-02 through Sun 11-08 at days zoom: 48 px a day, 336 wide. */
const week: Scale = {
  startMs: toMs('2026-11-02'), endMs: toMs('2026-11-09'), pxPerMs: 48 / 86_400_000, width: 7 * 48,
};

describe('nonworkingBands', () => {
  it('shades Saturday and Sunday of a week at days zoom, as one band', () => {
    expect(nonworkingBands(standard(), week)).toEqual([{ x: 5 * 48, width: 2 * 48 }]);
  });

  it('shades each weekend a padded scale holds', () => {
    // Sat 10-31 .. Tue 11-10
    const scale = makeScale('2026-11-02T08:00', '2026-11-06T17:00', 'days');
    expect(nonworkingBands(standard(), scale)).toEqual([
      { x: 0, width: 96 },
      { x: 7 * 48, width: 96 },
    ]);
  });

  it('shades nothing at the coarser zooms', () => {
    for (const zoom of ['weeks', 'months', 'quarters'] as const) {
      const scale = makeScale('2026-11-02T08:00', '2027-03-26T17:00', zoom);
      expect(nonworkingBands(standard(), scale)).toEqual([]);
    }
  });

  it('shades at hours zoom, clipped to the scale', () => {
    // starts Fri 11-06 06:00, ends Sun 11-08 21:00
    const scale = makeScale('2026-11-06T08:00', '2026-11-08T17:00', 'hours');
    const bands = nonworkingBands(standard(), scale);
    expect(bands).toEqual([{ x: 18 * 20, width: 45 * 20 }]);
    expect(bands[0].x + bands[0].width).toBe(scale.width);
  });

  it('clips a weekend that begins before the scale does', () => {
    // starts Sat 11-07 12:00
    const scale = makeScale('2026-11-07T14:00', '2026-11-07T17:00', 'hours');
    expect(nonworkingBands(standard(), scale)).toEqual([{ x: 0, width: scale.width }]);
  });

  it('shades a holiday: an exception with no hours (Thanksgiving)', () => {
    const calendar = standard();
    calendar.exceptions = [{ date: '2026-11-26', name: 'Thanksgiving', hours: [] }];
    // Sat 11-21 .. Tue 12-01
    const scale = makeScale('2026-11-23T08:00', '2026-11-27T17:00', 'days');
    expect(nonworkingBands(calendar, scale)).toEqual([
      { x: 0, width: 96 },            // Sat 11-21, Sun 11-22
      { x: 5 * 48, width: 48 },       // Thu 11-26
      { x: 7 * 48, width: 96 },       // Sat 11-28, Sun 11-29
    ]);
  });

  it('merges a holiday that touches a weekend into one band', () => {
    const calendar = standard();
    calendar.exceptions = [{ date: '2026-11-27', name: 'Day after Thanksgiving', hours: [] }];
    const scale = makeScale('2026-11-23T08:00', '2026-11-27T17:00', 'days');
    expect(nonworkingBands(calendar, scale)).toEqual([
      { x: 0, width: 96 },
      { x: 6 * 48, width: 3 * 48 },   // Fri 11-27, Sat, Sun
    ]);
  });

  it('leaves a Saturday with working hours unshaded (Sat 11-14, 06:00-22:00)', () => {
    const calendar = standard();
    calendar.exceptions = [{ date: '2026-11-14', name: 'Move day', hours: [['06:00', '22:00']] }];
    // Sat 11-07 .. Tue 11-17
    const scale = makeScale('2026-11-09T08:00', '2026-11-13T17:00', 'days');
    expect(nonworkingBands(calendar, scale)).toEqual([
      { x: 0, width: 96 },            // Sat 11-07, Sun 11-08
      { x: 8 * 48, width: 48 },       // Sun 11-15 alone: Sat 11-14 works
    ]);
    expect(nonworkingBands(standard(), scale)).toEqual([
      { x: 0, width: 96 },
      { x: 7 * 48, width: 96 },       // without the exception Sat + Sun are one band
    ]);
  });

  it('leaves a short working day unshaded, however few hours it has', () => {
    const calendar = standard();
    calendar.exceptions = [{ date: '2026-11-06', name: 'Half day', hours: [['08:00', '10:00']] }];
    expect(nonworkingBands(calendar, week)).toEqual([{ x: 5 * 48, width: 96 }]);
  });

  it('ignores an exception outside the scale', () => {
    const calendar = standard();
    calendar.exceptions = [
      { date: '2025-12-25', name: 'Christmas, a year ago', hours: [] },
      { date: '2026-11-05', name: 'Thursday off', hours: [] },      // in range
      { date: '2026-11-09', name: 'Just past the end', hours: [] },  // the scale ends 11-09 00:00
      { date: '2027-07-04', name: 'Next summer', hours: [['06:00', '22:00']] },
    ];
    expect(nonworkingBands(calendar, week)).toEqual([
      { x: 3 * 48, width: 48 },
      { x: 5 * 48, width: 96 },
    ]);
    // a Saturday far away with hours changes nothing here either
    calendar.exceptions = [{ date: '2027-07-03', name: 'Far Saturday', hours: [['06:00', '22:00']] }];
    expect(nonworkingBands(calendar, week)).toEqual(nonworkingBands(standard(), week));
  });

  it('reads the weekday pattern: a Wednesday off every week', () => {
    const calendar = standard();
    calendar.week = { ...calendar.week, wed: [] };
    expect(nonworkingBands(calendar, week)).toEqual([
      { x: 2 * 48, width: 48 },
      { x: 5 * 48, width: 96 },
    ]);
  });

  it('shades nothing when every day works, and everything when none does', () => {
    const always: PlanCalendar = {
      ...standard(),
      week: { mon: [['00:00', '24:00']], tue: [['00:00', '24:00']], wed: [['00:00', '24:00']],
        thu: [['00:00', '24:00']], fri: [['00:00', '24:00']], sat: [['00:00', '24:00']],
        sun: [['00:00', '24:00']] },
    };
    expect(nonworkingBands(always, week)).toEqual([]);
    const never: PlanCalendar = {
      ...standard(),
      week: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    };
    expect(nonworkingBands(never, week)).toEqual([{ x: 0, width: week.width }]);
  });
});

describe('in a browser far from the plan’s zone (Review Focus 4)', () => {
  const prev = process.env.TZ;

  afterEach(() => {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    vi.resetModules();
  });

  it.each(['Asia/Tokyo', 'America/Chicago', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])(
    'shades the same weekdays in %s', async (zone) => {
      process.env.TZ = zone;
      vi.resetModules();
      const shade = await import('./calendarShade');
      const geo = await import('./ganttGeometry');
      // the zone took: a local getter would read another hour here
      expect(new Date(Date.UTC(2026, 10, 2)).getHours() === 0).toBe(false);

      const calendar = standard();
      calendar.exceptions = [{ date: '2026-11-26', name: 'Thanksgiving', hours: [] }];
      const scale = geo.makeScale('2026-11-23T08:00', '2026-11-27T17:00', 'days');
      expect(shade.nonworkingBands(calendar, scale)).toEqual([
        { x: 0, width: 96 }, { x: 5 * 48, width: 48 }, { x: 7 * 48, width: 96 },
      ]);
    });
});
