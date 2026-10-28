/** Duration and lag text, held to the vectors file the API's pytest suite
 *  reads too (api/tests/fixtures/plans/durations.json), so the sheet's
 *  check-as-you-type agrees with the server on every string. */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  DurationError, MAX_DURATION_TEXT, MAX_INTEGER_DIGITS, MAX_YEARS, STANDARD_UNITS,
  asciiTrim, formatDuration, formatLag, maxMinutes, parseDuration, parseLag, unitMinutes,
  unitsOf, type DurationUnit, type Units,
} from './durations';

type ParseRow = [string, number, DurationUnit, boolean];
type FormatRow = [number, DurationUnit, boolean, string];
type CalendarUnits = { hours_per_day: number; hours_per_week: number; days_per_month: number };

interface Vectors {
  notes: string;
  units: CalendarUnits;
  units_alt: CalendarUnits;
  parse: ParseRow[];
  invalid: string[];
  lag: ParseRow[];
  invalid_lag: string[];
  format: FormatRow[];
  format_lag: FormatRow[];
  parse_alt: ParseRow[];
  format_alt: FormatRow[];
  parse_default_h: ParseRow[];
}

const V: Vectors = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '../../../../api/tests/fixtures/plans/durations.json'), 'utf8'));
const UNITS = unitsOf(V.units);
const UNITS_ALT = unitsOf(V.units_alt);

/** True when the minutes are a whole number of hundredths of the unit, so
 *  two-decimal text can return to the same value. */
const exact = (minutes: number, unit: DurationUnit, elapsed: boolean, units: Units = UNITS) =>
  (Math.abs(minutes) * 100) % unitMinutes(units, unit, elapsed) === 0;

const parsed = (text: string, units: Units = UNITS, defaultUnit?: DurationUnit) => {
  const d = parseDuration(text, units, defaultUnit);
  return [d.minutes, d.unit, d.elapsed];
};

const thrown = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error('expected an error');
};

describe('the vectors file', () => {
  it('has only the keys this port reads', () => {
    // a key added to the file needs a test here before the port can claim to agree
    expect(Object.keys(V).sort()).toEqual([
      'format', 'format_alt', 'format_lag', 'invalid', 'invalid_lag', 'lag', 'notes',
      'parse', 'parse_alt', 'parse_default_h', 'units', 'units_alt',
    ]);
  });

  it('notes the limits this port enforces', () => {
    expect(V.notes).toContain(`at most ${MAX_DURATION_TEXT} characters`);
    expect(V.notes).toContain(`at most ${MAX_INTEGER_DIGITS} digits before the decimal point`);
    expect(V.notes).toContain('do not use String.trim()');
    expect(V.notes).toContain('rounded half up on the magnitude, then the sign is applied');
  });

  it('reads the standard and the alternate calendars', () => {
    expect(UNITS).toEqual({ minutesPerDay: 480, minutesPerWeek: 2400, minutesPerMonth: 9600 });
    expect(UNITS).toEqual(STANDARD_UNITS);
    expect(UNITS_ALT).toEqual({ minutesPerDay: 600, minutesPerWeek: 3000, minutesPerMonth: 13200 });
  });
});

describe('parseDuration', () => {
  it.each(V.parse)('parses %j', (text, minutes, unit, elapsed) => {
    expect(parsed(text)).toEqual([minutes, unit, elapsed]);
  });

  it.each(V.invalid)('refuses %j', (text) => {
    const err = thrown(() => parseDuration(text, UNITS));
    expect(err).toBeInstanceOf(DurationError);
    expect((err as DurationError).code).toBe('bad_duration');
  });

  it.each(V.parse_alt)('parses %j in the alternate calendar', (text, minutes, unit, elapsed) => {
    expect(parsed(text, UNITS_ALT)).toEqual([minutes, unit, elapsed]);
  });

  it.each(V.parse_default_h)('parses %j with hours as the default unit', (text, minutes, unit, elapsed) => {
    expect(parsed(text, UNITS, 'h')).toEqual([minutes, unit, elapsed]);
  });

  it('takes the default unit for a bare number only', () => {
    expect(parsed('2', UNITS, 'w')).toEqual([4800, 'w', false]);
    expect(parsed('3d', UNITS, 'h')).toEqual([1440, 'd', false]);
  });

  it('never multiplies in floating point', () => {
    // 1.025 * 60 is 61.49999999999999 in a double, which rounds to 61
    expect(parseDuration('1.025h', UNITS).minutes).toBe(62);
    const hundred = { minutesPerDay: 100, minutesPerWeek: 500, minutesPerMonth: 2000 };
    expect(parseDuration('0.025d', hundred).minutes).toBe(3);
    expect(parseDuration('0.015d', hundred).minutes).toBe(2);
  });

  it('caps the length after trimming, not before', () => {
    const padded = ' '.repeat(100) + '5d' + ' '.repeat(100);
    expect(parseDuration(padded, UNITS).minutes).toBe(2400);
  });

  it('refuses a sign', () => {
    for (const text of ['+2d', '-2d', '-1']) {
      expect(() => parseDuration(text, UNITS)).toThrow(DurationError);
    }
  });

  it('refuses an oversized number fast', () => {
    const started = performance.now();
    expect(() => parseDuration('9'.repeat(5000) + 'd', UNITS)).toThrow(DurationError);
    expect(() => parseDuration('1234567890m', UNITS)).toThrow(DurationError);
    expect(performance.now() - started).toBeLessThan(100);
    expect(parseDuration('999999999m', UNITS).minutes).toBe(999999999);
  });

  it('refuses text that is not a string', () => {
    for (const value of [null, undefined, 5, ['5d']]) {
      expect(() => parseDuration(value as unknown as string, UNITS)).toThrow(DurationError);
    }
  });

  it('never echoes unbounded input in its message', () => {
    const err = thrown(() => parseDuration('x'.repeat(10_000), UNITS)) as DurationError;
    expect(err.message.length).toBeLessThan(120);
  });

  it('refuses an unknown default unit as a programming error', () => {
    const err = thrown(() => parseDuration('3', UNITS, 'y' as DurationUnit));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DurationError);
  });
});

describe('parseLag', () => {
  it.each(V.lag)('parses %j', (text, minutes, unit, elapsed) => {
    const d = parseLag(text, UNITS);
    expect([d.minutes, d.unit, d.elapsed]).toEqual([minutes, unit, elapsed]);
  });

  it.each(V.invalid_lag)('refuses %j', (text) => {
    const err = thrown(() => parseLag(text, UNITS));
    expect(err).toBeInstanceOf(DurationError);
    expect((err as DurationError).code).toBe('bad_duration');
  });

  it('refuses what parseDuration refuses, a sign aside', () => {
    for (const text of V.invalid) {
      if (/^ *[-+]/.test(text)) continue;
      expect(() => parseLag(text, UNITS)).toThrow(DurationError);
    }
  });

  it('rounds the size half up and then applies the sign', () => {
    expect(parseLag('-0.5m', UNITS).minutes).toBe(-1);
    expect(parseLag('-2.5m', UNITS).minutes).toBe(-3);
    expect(parseLag('-2', UNITS, 'h')).toEqual({ minutes: -120, unit: 'h', elapsed: false });
  });

  it('reads a signed zero as plain zero', () => {
    expect(Object.is(parseLag('-0d', UNITS).minutes, 0)).toBe(true);
    expect(Object.is(parseLag('-0.0000001m', UNITS).minutes, 0)).toBe(true);
  });
});

describe('formatDuration', () => {
  it.each(V.format)('formats %j %s elapsed=%s', (minutes, unit, elapsed, text) => {
    expect(formatDuration(minutes, unit, elapsed, UNITS)).toBe(text);
  });

  it.each(V.format_alt)('formats %j %s in the alternate calendar', (minutes, unit, elapsed, text) => {
    expect(formatDuration(minutes, unit, elapsed, UNITS_ALT)).toBe(text);
  });

  it.each(V.format.filter((row) => exact(row[0], row[1], row[2])))(
    'round-trips %j %s', (minutes, unit, elapsed) => {
      const d = parseDuration(formatDuration(minutes, unit, elapsed, UNITS), UNITS);
      expect(d).toEqual({ minutes, unit, elapsed });
    });

  it('refuses an unknown unit', () => {
    expect(() => formatDuration(5, 'y' as DurationUnit, false, UNITS)).toThrow();
  });
});

describe('formatLag', () => {
  it.each(V.format_lag)('formats %j %s elapsed=%s', (minutes, unit, elapsed, text) => {
    expect(formatLag(minutes, unit, elapsed, UNITS)).toBe(text);
  });

  it.each(V.format_lag.filter((row) => exact(row[0], row[1], row[2])))(
    'round-trips %j %s', (minutes, unit, elapsed) => {
      const d = parseLag(formatLag(minutes, unit, elapsed, UNITS), UNITS);
      expect(d).toEqual({ minutes, unit, elapsed });
    });
});

describe('unitsOf', () => {
  it('keeps the standard value for a missing or null key', () => {
    expect(unitsOf({})).toEqual(STANDARD_UNITS);
    expect(unitsOf(null)).toEqual(STANDARD_UNITS);
    expect(unitsOf({ hours_per_day: null, days_per_month: null })).toEqual(STANDARD_UNITS);
    expect(unitsOf({ hours_per_day: 4 })).toEqual(
      { minutesPerDay: 240, minutesPerWeek: 2400, minutesPerMonth: 4800 });
  });

  it('rounds half up from the exact decimal', () => {
    // 0.5 days x 441 minutes = 220.5 -> 221
    expect(unitsOf({ hours_per_day: 7.35, hours_per_week: 36.75, days_per_month: 0.5 })).toEqual(
      { minutesPerDay: 441, minutesPerWeek: 2205, minutesPerMonth: 221 });
  });

  it.each([
    { hours_per_day: 0 },
    { hours_per_day: -8 },
    { hours_per_week: 0 },
    { hours_per_week: -1 },
    { days_per_month: 0 },
    { days_per_month: -20 },
    { hours_per_day: 0.001 },
    { hours_per_day: 'eight' },
    { hours_per_week: Number.NaN },
    { days_per_month: Number.POSITIVE_INFINITY },
    { hours_per_day: true },
  ])('refuses %j as a bad calendar, not bad duration text', (calendar) => {
    const err = thrown(() => unitsOf(calendar as never));
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(DurationError);
  });

  it('reads a value written with an exponent exactly', () => {
    // String(1e-7) is "1e-7": under a minute a day either way
    expect(() => unitsOf({ hours_per_day: 1e-7 })).toThrow();
    expect(unitsOf({ hours_per_day: 1e1 }).minutesPerDay).toBe(600);
  });
});

describe('limits', () => {
  it('caps durations and lags at ten years', () => {
    expect(MAX_YEARS).toBe(10);
    expect(maxMinutes(UNITS, false)).toBe(480 * 260 * 10);
    expect(maxMinutes(UNITS, true)).toBe(1440 * 365 * 10);
  });

  it('trims ASCII whitespace only', () => {
    expect(asciiTrim(' \t\n\r\f\v5d\v\f\r\n\t ')).toBe('5d');
    expect(asciiTrim(' 5d ')).toBe(' 5d ');
    expect(asciiTrim('﻿5d ')).toBe('﻿5d ');
    expect(asciiTrim('   ')).toBe('');
  });

  it('knows the minutes in each unit', () => {
    expect(unitMinutes(UNITS, 'mo', false)).toBe(9600);
    expect(unitMinutes(UNITS, 'mo', true)).toBe(43200);
    expect(unitMinutes(UNITS_ALT, 'w', false)).toBe(3000);
    expect(unitMinutes(UNITS_ALT, 'w', true)).toBe(10080);
  });
});
