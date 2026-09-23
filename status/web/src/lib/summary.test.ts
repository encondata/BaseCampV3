import { describe, expect, it } from 'vitest';

import { barTone, dayUptime, footerCopy, formatDay, formatUptime } from './summary';

describe('formatUptime', () => {
  it('shows exactly 100 as 100%', () => expect(formatUptime(100)).toBe('100%'));
  it('truncates, never rounds up to 100', () => expect(formatUptime(99.9999)).toBe('99.99%'));
  it('keeps two decimals', () => expect(formatUptime(87.5)).toBe('87.50%'));
  it('truncates rather than rounds', () => expect(formatUptime(66.6667)).toBe('66.66%'));
  it('shows a dash for no data', () => expect(formatUptime(null)).toBe('—'));
});

describe('barTone', () => {
  it('no data', () => expect(barTone({ day: 'd', ok: null, total: null })).toBe('none'));
  it('zero total', () => expect(barTone({ day: 'd', ok: 0, total: 0 })).toBe('none'));
  it('perfect day', () => expect(barTone({ day: 'd', ok: 5, total: 5 })).toBe('up'));
  it('any failure is red', () => expect(barTone({ day: 'd', ok: 1439, total: 1440 })).toBe('down'));
});

describe('dayUptime / formatDay', () => {
  it('day uptime text', () => {
    expect(dayUptime({ day: 'd', ok: 1439, total: 1440 })).toBe('99.93%');
    expect(dayUptime({ day: 'd', ok: null, total: null })).toBe('No data');
  });
  it('formats a UTC day without shifting it', () =>
    expect(formatDay('2026-09-23')).toBe('Sep 23, 2026'));
});

describe('footerCopy', () => {
  it('every minute, for the common 60s interval', () =>
    expect(footerCopy(60, 2)).toBe('Checks run every minute. A service shows down after 2 failed checks in a row.'));
  it('every N seconds, under a minute', () =>
    expect(footerCopy(15, 2)).toBe('Checks run every 15 seconds. A service shows down after 2 failed checks in a row.'));
  it('every N seconds, not a whole minute', () =>
    expect(footerCopy(90, 2)).toBe('Checks run every 90 seconds. A service shows down after 2 failed checks in a row.'));
  it('every N minutes, a whole multiple of 60 over 60', () =>
    expect(footerCopy(300, 2)).toBe('Checks run every 5 minutes. A service shows down after 2 failed checks in a row.'));
  it('singular check for threshold 1', () =>
    expect(footerCopy(60, 1)).toBe('Checks run every minute. A service shows down after 1 failed check in a row.'));
});
