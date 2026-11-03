/** Floating plan times (`YYYY-MM-DDTHH:MM`, plan wall-clock text): parsed and
 *  formatted as UTC-naive values, so every browser shows what the API sent
 *  whatever zone it runs in (Review Focus 4). */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  dayOf, formatCell, formatDay, formatDayRange, formatDayTime, formatShortDay, fromDateInput, fromInstant, fromMs,
  lastDay, toDateInput, toDateTimeInput, toMs,
} from './floatingTime';

describe('toMs / fromMs', () => {
  it('reads the parts as UTC', () => {
    expect(toMs('2026-11-02T08:00')).toBe(Date.UTC(2026, 10, 2, 8, 0));
    expect(toMs('2026-11-02')).toBe(Date.UTC(2026, 10, 2));
    expect(toMs('2026-12-31T23:59')).toBe(Date.UTC(2026, 11, 31, 23, 59));
  });

  it('writes the parts back', () => {
    expect(fromMs(Date.UTC(2026, 10, 2, 8, 0))).toBe('2026-11-02T08:00');
    expect(fromMs(Date.UTC(2026, 0, 5, 0, 7))).toBe('2026-01-05T00:07');
    expect(fromMs(toMs('2028-02-29T13:30'))).toBe('2028-02-29T13:30');
  });

  it('drops seconds when writing', () => {
    expect(fromMs(Date.UTC(2026, 10, 2, 8, 0, 59, 999))).toBe('2026-11-02T08:00');
  });

  it('keeps a year below 100 as written', () => {
    expect(fromMs(toMs('0026-03-01T00:00'))).toBe('0026-03-01T00:00');
  });

  it('answers NaN for text that is not a plan time', () => {
    for (const text of ['', '2026-11-02 08:00', '2026-11-02T08:00Z', '2026-11-02T08:00:00',
      '2026-02-30', '2026-13-01', '2026-11-02T24:00', '2026-11-02T08:60', '26-11-02', 'x']) {
      expect(Number.isNaN(toMs(text))).toBe(true);
    }
    expect(fromMs(Number.NaN)).toBe('');
  });
});

describe('display', () => {
  it('formats a day as weekday M/D/YY', () => {
    expect(formatDay('2026-11-02T08:00')).toBe('Mon 11/2/26');
    expect(formatDay('2026-11-02')).toBe('Mon 11/2/26');
    expect(formatDay('2027-01-03T17:00')).toBe('Sun 1/3/27');
    expect(formatDay('2105-07-09T08:00')).toBe('Thu 7/9/05');
  });

  it('formats a day and a 12-hour time', () => {
    expect(formatDayTime('2026-11-02T08:00')).toBe('Mon 11/2/26 8:00 AM');
    expect(formatDayTime('2026-11-02T13:30')).toBe('Mon 11/2/26 1:30 PM');
    expect(formatDayTime('2026-11-02T00:05')).toBe('Mon 11/2/26 12:05 AM');
    expect(formatDayTime('2026-11-02T12:00')).toBe('Mon 11/2/26 12:00 PM');
  });

  it('formats a sheet cell with or without times', () => {
    expect(formatCell('2026-11-02T13:30', true)).toBe('Mon 11/2/26 1:30 PM');
    expect(formatCell('2026-11-02T13:30', false)).toBe('Mon 11/2/26');
    expect(formatCell(null, true)).toBe('');
  });

  it('shows nothing for a missing or bad value', () => {
    expect(formatDay(null)).toBe('');
    expect(formatDay('nope')).toBe('');
    expect(formatDayTime(undefined)).toBe('');
  });

  it('formats a milestone’s short date as M/D', () => {
    expect(formatShortDay('2026-11-16T17:00')).toBe('11/16');
    expect(formatShortDay('2027-01-03')).toBe('1/3');
    expect(formatShortDay(null)).toBe('');
    expect(formatShortDay('2026-02-30')).toBe('');
  });

  it('formats a day range with an en dash, naming the month and year only once when they repeat', () => {
    expect(formatDayRange('2026-11-14', '2026-11-16')).toBe('Nov 14\u201316');
    expect(formatDayRange('2026-11-30', '2026-12-02')).toBe('Nov 30 \u2013 Dec 2');
    expect(formatDayRange('2026-12-30', '2027-01-02')).toBe('Dec 30, 2026 \u2013 Jan 2, 2027');
    expect(formatDayRange('2026-11-14', '2026-11-14')).toBe('Nov 14');
    expect(formatDayRange('2026-11-14T08:00', '2026-11-16T17:00')).toBe('Nov 14\u201316');
  });

  it('formats a range from either end alone, and nothing from bad days', () => {
    expect(formatDayRange('2026-11-14', null)).toBe('Nov 14');
    expect(formatDayRange(null, '2026-11-16')).toBe('Nov 16');
    expect(formatDayRange('nope', 'also nope')).toBe('');
    expect(formatDayRange(null, null)).toBe('');
  });
});

describe('inputs', () => {
  it('fills date and datetime-local inputs', () => {
    expect(toDateInput('2026-11-02T08:00')).toBe('2026-11-02');
    expect(toDateInput(null)).toBe('');
    expect(toDateTimeInput('2026-11-02T08:00')).toBe('2026-11-02T08:00');
    expect(toDateTimeInput('2026-11-02')).toBe('2026-11-02T00:00');
    expect(toDateTimeInput(null)).toBe('');
  });

  it('keeps a date alone so the API applies the calendar’s default time', () => {
    expect(fromDateInput('2026-11-02')).toBe('2026-11-02');
    expect(fromDateInput('2026-11-02T08:00')).toBe('2026-11-02T08:00');
    expect(fromDateInput('2026-11-02T08:00:30')).toBe('2026-11-02T08:00');
    expect(fromDateInput('')).toBeNull();
    expect(fromDateInput('2026-02-30')).toBeNull();
    expect(fromDateInput('11/2/2026')).toBeNull();
  });

  it('takes the day of a plan time', () => {
    expect(dayOf('2026-11-02T08:00')).toBe('2026-11-02');
    expect(dayOf('2026-11-02')).toBe('2026-11-02');
  });
});

describe('in a browser far from the plan’s zone (Review Focus 4)', () => {
  const prev = process.env.TZ;

  afterEach(() => {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    vi.resetModules();
  });

  it.each(['Asia/Tokyo', 'America/Chicago', 'Pacific/Kiritimati', 'Pacific/Pago_Pago'])(
    'shows the wall-clock dates the API sent in %s', async (zone) => {
      process.env.TZ = zone;
      vi.resetModules();
      const ft = await import('./floatingTime');
      // the zone took: a local getter would read another hour here
      expect(new Date(Date.UTC(2026, 10, 2)).getHours() === 0).toBe(false);
      expect(ft.formatDay('2026-11-02T00:00')).toBe('Mon 11/2/26');
      expect(ft.formatDay('2026-11-02T23:59')).toBe('Mon 11/2/26');
      expect(ft.formatDayTime('2026-11-02T00:00')).toBe('Mon 11/2/26 12:00 AM');
      expect(ft.toMs('2026-11-02T00:00')).toBe(Date.UTC(2026, 10, 2));
      expect(ft.fromMs(ft.toMs('2026-03-08T02:30'))).toBe('2026-03-08T02:30');   // a US DST gap
      expect(ft.fromDateInput('2026-11-02')).toBe('2026-11-02');
      expect(ft.formatShortDay('2026-11-02T00:00')).toBe('11/2');
      expect(ft.formatDayRange('2026-11-30T00:00', '2026-12-02T23:59')).toBe('Nov 30 \u2013 Dec 2');
    });
});

describe('fromInstant', () => {
  it('turns an instant into the plan’s wall-clock time', () => {
    expect(fromInstant('2026-11-04T15:30:00Z', 'America/Chicago')).toBe('2026-11-04T09:30');
    expect(fromInstant('2026-10-30T15:30:00Z', 'America/Chicago')).toBe('2026-10-30T10:30');   // CDT
    expect(fromInstant('2026-11-04T15:30:00.123456+00:00', 'Asia/Tokyo')).toBe('2026-11-05T00:30');
  });

  it('reads midnight as 00:00, not 24:00', () => {
    expect(fromInstant('2026-11-05T06:00:00Z', 'America/Chicago')).toBe('2026-11-05T00:00');
  });

  it('falls back to UTC for a zone the browser does not know, and to nothing for a bad instant', () => {
    expect(fromInstant('2026-11-04T15:30:00Z', 'Mars/Olympus_Mons')).toBe('2026-11-04T15:30');
    expect(fromInstant('not a time', 'America/Chicago')).toBe('');
    expect(fromInstant(null, 'America/Chicago')).toBe('');
  });
});

describe('lastDay', () => {
  it('is the day of the last working minute: a finish at midnight ends the day before', () => {
    expect(lastDay('2026-11-03T08:00', '2026-11-04T17:00')).toBe('2026-11-04');
    expect(lastDay('2026-11-03T20:00', '2026-11-05T00:00')).toBe('2026-11-04');
    expect(lastDay('2026-11-03T08:00', '2026-11-03T08:01')).toBe('2026-11-03');
  });

  it('a milestone, a finish not after the start, or none: the start’s day', () => {
    expect(lastDay('2026-11-06T17:00', '2026-11-06T17:00')).toBe('2026-11-06');
    expect(lastDay('2026-11-06T17:00', '2026-11-05T17:00')).toBe('2026-11-06');
    expect(lastDay('2026-11-06T17:00', null)).toBe('2026-11-06');
  });
});
