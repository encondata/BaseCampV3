/**
 * The personal schedule's pure pieces: the default, the day labels, the
 * "same schedule" test, and the summary line under the schedule card — the
 * sentences of the design (§3 "Your schedule"), word for word.
 */
import { describe, expect, it } from 'vitest';

import type { NotifSchedule } from './api';
import { DAYS } from './notifications';
import {
  DAY_LABELS, DEFAULT_SCHEDULE, sameSchedule, summaryLine,
} from './notificationSchedule';

const WORKWEEK = ['mon', 'tue', 'wed', 'thu', 'fri'] as NotifSchedule['days'];

/** America/Chicago, every day, no quiet hours — each test changes what it needs. */
const schedule = (over: Partial<NotifSchedule> = {}): NotifSchedule => ({
  timezone: 'America/Chicago', days: [...DAYS], quiet_start: null, quiet_end: null, ...over,
});

const NEVER_WAIT = 'Critical notifications never wait.';
const SINGLE = 'Email that waits arrives as one summary at 5:00 AM CT, an hour before quiet hours end on a day you work.';
const QUIET_ONLY = 'Email that waits during quiet hours arrives as one summary at 5:00 AM CT.';
const DAYS_OFF = 'Email from days off arrives as one summary at 11:00 PM CT the night before the next day you work.';

describe('DEFAULT_SCHEDULE', () => {
  it('has no timezone of its own, every day on and no quiet hours', () => {
    expect(DEFAULT_SCHEDULE).toEqual({
      timezone: null, days: ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'],
      quiet_start: null, quiet_end: null,
    });
  });
});

describe('DAY_LABELS', () => {
  it('labels every day with its three-letter name', () => {
    expect(DAY_LABELS).toEqual({
      mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun',
    });
  });
});

describe('sameSchedule', () => {
  it('is true for schedules that read the same, whatever object they are', () => {
    expect(sameSchedule(schedule(), schedule())).toBe(true);
    expect(sameSchedule(DEFAULT_SCHEDULE, { ...DEFAULT_SCHEDULE, days: [...DAYS] })).toBe(true);
  });

  it('tells apart each field', () => {
    const base = schedule({ quiet_start: '21:00', quiet_end: '06:00' });
    expect(sameSchedule(base, { ...base, timezone: null })).toBe(false);
    expect(sameSchedule(base, { ...base, timezone: 'America/Denver' })).toBe(false);
    expect(sameSchedule(base, { ...base, days: WORKWEEK })).toBe(false);
    expect(sameSchedule(base, { ...base, quiet_start: '22:00' })).toBe(false);
    expect(sameSchedule(base, { ...base, quiet_end: null })).toBe(false);
  });

  it('tells apart two lists of the same length', () => {
    expect(sameSchedule(schedule({ days: ['mon', 'tue'] }), schedule({ days: ['mon', 'wed'] }))).toBe(false);
  });
});

describe('summaryLine — quiet hours', () => {
  it('21:00–06:00 in America/Chicago, every day: one summary an hour before quiet hours end', () => {
    expect(summaryLine(schedule({ quiet_start: '21:00', quiet_end: '06:00' }))).toEqual({
      text: `${SINGLE} ${NEVER_WAIT}`, warn: false,
    });
  });

  it('Mon–Fri with 21:00–06:00 (covers midnight): the single 5:00 AM sentence', () => {
    expect(summaryLine(schedule({ days: WORKWEEK, quiet_start: '21:00', quiet_end: '06:00' }))).toEqual({
      text: `${SINGLE} ${NEVER_WAIT}`, warn: false,
    });
  });

  it("Mon–Fri with 01:00–06:00 (doesn't cover midnight): both sentences, 5:00 AM and 11:00 PM", () => {
    expect(summaryLine(schedule({ days: WORKWEEK, quiet_start: '01:00', quiet_end: '06:00' }))).toEqual({
      text: `${QUIET_ONLY} ${DAYS_OFF} ${NEVER_WAIT}`, warn: false,
    });
  });

  it('Mon–Fri with 00:00–06:00 (starts at midnight): the single sentence', () => {
    expect(summaryLine(schedule({ days: WORKWEEK, quiet_start: '00:00', quiet_end: '06:00' }))).toEqual({
      text: `${SINGLE} ${NEVER_WAIT}`, warn: false,
    });
  });

  it("every day with 01:00–06:00 (doesn't cover midnight, but there are no days off): the single sentence", () => {
    expect(summaryLine(schedule({ quiet_start: '01:00', quiet_end: '06:00' }))).toEqual({
      text: `${SINGLE} ${NEVER_WAIT}`, warn: false,
    });
  });

  it('puts the summary an hour before the end, across midnight too', () => {
    expect(summaryLine(schedule({ quiet_start: '21:00', quiet_end: '00:30' })).text)
      .toContain('at 11:30 PM CT,');
    expect(summaryLine(schedule({ quiet_start: '22:00', quiet_end: '00:00' })).text)
      .toContain('at 11:00 PM CT,');
    expect(summaryLine(schedule({ quiet_start: '09:00', quiet_end: '17:15' })).text)
      .toContain('at 4:15 PM CT,');
  });

  it('reads a stored time that carries seconds', () => {
    expect(summaryLine(schedule({ quiet_start: '21:00:00', quiet_end: '06:00:00' })).text)
      .toBe(`${SINGLE} ${NEVER_WAIT}`);
  });
});

describe('summaryLine — quiet hours of an hour or less', () => {
  // The API holds mail for a summary only while that summary is still ahead:
  // the summary goes out an hour before quiet hours end, so a window of an
  // hour or less ends its quiet time before the summary could be sent, and
  // nothing is ever held for it. The line says what happens: the same
  // sentences as with no quiet hours.
  const ALWAYS = 'No quiet hours and no days off, so email always goes out right away.';

  it('05:30–06:00 (30 minutes) with Mon–Fri: only the days-off sentence', () => {
    expect(summaryLine(schedule({ days: WORKWEEK, quiet_start: '05:30', quiet_end: '06:00' }))).toEqual({
      text: `${DAYS_OFF} ${NEVER_WAIT}`, warn: false,
    });
  });

  it('05:30–06:00 with every day: email always goes out right away', () => {
    expect(summaryLine(schedule({ quiet_start: '05:30', quiet_end: '06:00' }))).toEqual({
      text: ALWAYS, warn: false,
    });
  });

  it('measures an overnight window across midnight: 23:30–00:20 is 50 minutes', () => {
    expect(summaryLine(schedule({ quiet_start: '23:30', quiet_end: '00:20' })).text).toBe(ALWAYS);
    expect(summaryLine(schedule({ days: WORKWEEK, quiet_start: '23:30', quiet_end: '00:20' })).text)
      .toBe(`${DAYS_OFF} ${NEVER_WAIT}`);
  });

  it('a window starting at 12:00 AM is measured the same way: 00:00–00:30 is 30 minutes', () => {
    expect(summaryLine(schedule({ quiet_start: '00:00', quiet_end: '00:30' })).text).toBe(ALWAYS);
  });

  it('exactly one hour holds nothing either (the summary time is the start itself)', () => {
    expect(summaryLine(schedule({ quiet_start: '05:00', quiet_end: '06:00' })).text).toBe(ALWAYS);
    expect(summaryLine(schedule({ quiet_start: '23:30', quiet_end: '00:30' })).text).toBe(ALWAYS);
    expect(summaryLine(schedule({ days: WORKWEEK, quiet_start: '05:00', quiet_end: '06:00' })).text)
      .toBe(`${DAYS_OFF} ${NEVER_WAIT}`);
  });

  it('a window just over an hour holds mail, so it keeps the quiet-hours sentence', () => {
    expect(summaryLine(schedule({ quiet_start: '04:45', quiet_end: '06:00' })).text)
      .toBe(`${SINGLE} ${NEVER_WAIT}`);
    expect(summaryLine(schedule({ quiet_start: '23:00', quiet_end: '00:30' })).text)
      .toBe(`Email that waits arrives as one summary at 11:30 PM CT, an hour before quiet hours end on a day you work. ${NEVER_WAIT}`);
  });

  it('still asks for both times first: a half-set or equal window is not a short one', () => {
    expect(summaryLine(schedule({ quiet_start: '05:30', quiet_end: null })))
      .toEqual({ text: 'Pick a start and end time.', warn: true });
    expect(summaryLine(schedule({ quiet_start: '05:30', quiet_end: '05:30' })))
      .toEqual({ text: 'Pick a start and end time.', warn: true });
  });

  it('no days still wins over a short window', () => {
    expect(summaryLine(schedule({ days: [], quiet_start: '05:30', quiet_end: '06:00' })))
      .toEqual({ text: 'Pick at least one day.', warn: true });
  });
});

describe('summaryLine — no quiet hours', () => {
  it('Mon–Fri: email from days off waits for 11:00 PM the night before the next working day', () => {
    expect(summaryLine(schedule({ days: WORKWEEK }))).toEqual({
      text: `${DAYS_OFF} ${NEVER_WAIT}`, warn: false,
    });
  });

  it('all days: email always goes out right away, and says nothing about critical ones', () => {
    expect(summaryLine(schedule())).toEqual({
      text: 'No quiet hours and no days off, so email always goes out right away.', warn: false,
    });
    expect(summaryLine(DEFAULT_SCHEDULE).text).not.toContain('Critical');
  });
});

describe('summaryLine — the zone', () => {
  it('uses the zone abbreviation the quiet-hours column uses (CDT and CST both read CT)', () => {
    expect(summaryLine(schedule({ days: WORKWEEK })).text).toContain('11:00 PM CT');
    expect(summaryLine(schedule({ days: WORKWEEK, timezone: 'America/Denver' })).text).toContain('11:00 PM MT');
  });

  it('reads an unset zone as the company reference zone, Eastern', () => {
    expect(summaryLine(schedule({ days: WORKWEEK, timezone: null })).text).toContain('11:00 PM ET');
  });

  it('shows a zone the browser cannot resolve as itself', () => {
    expect(summaryLine(schedule({ days: WORKWEEK, timezone: 'Zone/Unknown' })).text)
      .toContain('11:00 PM Zone/Unknown');
  });
});

describe('summaryLine — warnings', () => {
  it('no days: asks for at least one', () => {
    expect(summaryLine(schedule({ days: [] }))).toEqual({ text: 'Pick at least one day.', warn: true });
  });

  it('no days wins over a half-set quiet window', () => {
    expect(summaryLine(schedule({ days: [], quiet_start: '21:00' })))
      .toEqual({ text: 'Pick at least one day.', warn: true });
  });

  it('quiet hours with only a start: asks for a start and end time', () => {
    expect(summaryLine(schedule({ quiet_start: '21:00', quiet_end: null })))
      .toEqual({ text: 'Pick a start and end time.', warn: true });
  });

  it('quiet hours with only an end: the same', () => {
    expect(summaryLine(schedule({ quiet_start: null, quiet_end: '06:00' })))
      .toEqual({ text: 'Pick a start and end time.', warn: true });
  });

  it('a start equal to the end is not a window: the same ask', () => {
    expect(summaryLine(schedule({ quiet_start: '06:00', quiet_end: '06:00' })))
      .toEqual({ text: 'Pick a start and end time.', warn: true });
  });

  it('quiet hours switched on with no time picked yet: the same ask', () => {
    expect(summaryLine(schedule(), true)).toEqual({ text: 'Pick a start and end time.', warn: true });
  });

  it('quiet hours switched off reads the times as not there', () => {
    expect(summaryLine(schedule({ quiet_start: '21:00', quiet_end: '06:00' }), false).text)
      .toBe('No quiet hours and no days off, so email always goes out right away.');
  });
});
