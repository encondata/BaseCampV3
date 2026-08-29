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
