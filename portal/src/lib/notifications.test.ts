import { describe, expect, it } from 'vitest';

import {
  canForChannel, formatDays, formatQuietHours,
} from './notifications';

describe('formatQuietHours', () => {
  it('formats a normal (non-overnight) window with the tz abbreviation', () => {
    expect(formatQuietHours('21:00:00', '07:00:00', 'America/Chicago'))
      .toBe('9:00 PM – 7:00 AM CT');
  });

  it('formats an overnight window the same way (start > end is allowed)', () => {
    expect(formatQuietHours('22:00:00', '06:30:00', 'America/New_York'))
      .toBe('10:00 PM – 6:30 AM ET');
  });

  it('returns an em dash when there are no quiet hours', () => {
    expect(formatQuietHours(null, null, 'America/Chicago')).toBe('—');
  });
});

describe('formatDays', () => {
  it('collapses all 7 days to Daily', () => {
    expect(formatDays(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])).toBe('Daily');
  });

  it('collapses the weekday set to Mon–Fri', () => {
    expect(formatDays(['mon', 'tue', 'wed', 'thu', 'fri'])).toBe('Mon–Fri');
  });

  it('collapses sat+sun to Weekends', () => {
    expect(formatDays(['sat', 'sun'])).toBe('Weekends');
  });

  it('collapses another contiguous run to a range', () => {
    expect(formatDays(['wed', 'thu', 'fri', 'sat'])).toBe('Wed–Sat');
  });

  it('falls back to a comma list for a non-contiguous set', () => {
    expect(formatDays(['mon', 'wed', 'fri'])).toBe('Mon, Wed, Fri');
  });

  it('returns an em dash for an empty list', () => {
    expect(formatDays([])).toBe('—');
  });
});

describe('canForChannel', () => {
  const caps = { can_email: true, can_text: false, can_push: true, can_web: false };

  it('reads the matching capability flag for each channel', () => {
    expect(canForChannel(caps, 'email')).toBe(true);
    expect(canForChannel(caps, 'text')).toBe(false);
    expect(canForChannel(caps, 'push')).toBe(true);
    expect(canForChannel(caps, 'web')).toBe(false);
  });
});

describe('timezone helpers', () => {
  it('allTimezones returns the full IANA list including worldwide zones', async () => {
    const { allTimezones, DEFAULT_TIMEZONE } = await import('./notifications');
    const zones = allTimezones();
    expect(zones.length).toBeGreaterThan(100);
    expect(zones).toContain(DEFAULT_TIMEZONE);
    expect(zones).toContain('Pacific/Auckland');
    expect(zones).toContain('Europe/London');
    expect(zones).toContain('UTC');
    expect([...zones].sort()).toEqual(zones); // alphabetical
  });

  it('DEFAULT_TIMEZONE is New York', async () => {
    const { DEFAULT_TIMEZONE } = await import('./notifications');
    expect(DEFAULT_TIMEZONE).toBe('America/New_York');
  });

  it('tzOffsetLabel formats a UTC offset and handles bad zones', async () => {
    const { tzOffsetLabel } = await import('./notifications');
    expect(tzOffsetLabel('UTC')).toBe('UTC+00:00');
    expect(tzOffsetLabel('America/New_York')).toMatch(/^UTC-0[45]:00$/);
    expect(tzOffsetLabel('Not/AZone')).toBe('');
  });

  it('timezoneOptions carries value/label/sub for the ComboBox', async () => {
    const { timezoneOptions } = await import('./notifications');
    const opts = timezoneOptions();
    const ny = opts.find((o) => o.value === 'America/New_York');
    expect(ny).toBeTruthy();
    expect(ny!.label).toBe('America/New_York');
    expect(ny!.sub).toMatch(/^UTC-0[45]:00$/);
  });
});
