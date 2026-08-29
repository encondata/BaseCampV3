import { afterEach, describe, expect, it, vi } from 'vitest';

import { elapsedSince, formatMinutes } from './timeFormat';

describe('formatMinutes', () => {
  it('formats 0 minutes as "0m"', () => {
    expect(formatMinutes(0)).toBe('0m');
  });

  it('formats sub-hour minutes as "Nm"', () => {
    expect(formatMinutes(45)).toBe('45m');
  });

  it('formats an exact hour as "Nh"', () => {
    expect(formatMinutes(60)).toBe('1h');
  });

  it('formats hours plus remainder minutes as "Nh Mm"', () => {
    expect(formatMinutes(765)).toBe('12h 45m');
  });

  it('formats an exact multi-hour span with no remainder as "Nh"', () => {
    expect(formatMinutes(1440)).toBe('24h');
  });
});

describe('elapsedSince', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns whole minutes elapsed since the given ISO timestamp', () => {
    const fixedNow = new Date('2026-08-28T12:00:00Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    expect(elapsedSince('2026-08-28T11:30:00Z')).toBe(30);
  });

  it('floors partial minutes down', () => {
    const fixedNow = new Date('2026-08-28T12:00:59Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    expect(elapsedSince('2026-08-28T12:00:00Z')).toBe(0);
  });

  it('never returns negative minutes for a timestamp in the future', () => {
    const fixedNow = new Date('2026-08-28T12:00:00Z').getTime();
    vi.spyOn(Date, 'now').mockReturnValue(fixedNow);

    expect(elapsedSince('2026-08-28T12:05:00Z')).toBe(0);
  });
});
