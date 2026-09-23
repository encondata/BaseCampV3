import { describe, expect, it } from 'vitest';

import { barTone, dayUptime, formatDay, formatUptime } from './summary';

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
