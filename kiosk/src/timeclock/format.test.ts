import { afterEach, expect, it, vi } from 'vitest';

import { formatClock, formatPunch, formatWorked, kioskZone } from './format';

afterEach(() => vi.restoreAllMocks());

it('formats worked minutes', () => {
  expect(formatWorked(0)).toBe('0m');
  expect(formatWorked(5)).toBe('5m');
  expect(formatWorked(59)).toBe('59m');
  expect(formatWorked(60)).toBe('1h 00m');
  expect(formatWorked(444)).toBe('7h 24m');
  expect(formatWorked(480)).toBe('8h 00m');
});

it('never shows negative or fractional minutes', () => {
  expect(formatWorked(-3)).toBe('0m');
  expect(formatWorked(4.6)).toBe('5m');
});

it('formats a clock time as a short locale time', () => {
  const iso = new Date(2026, 9, 20, 8, 2).toISOString();
  expect(formatClock(iso)).toBe(
    new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  );
  expect(formatClock(iso)).toMatch(/8:02/);
});

it('a punch today is just its clock time', () => {
  const now = new Date(2026, 9, 20, 15, 0);
  const iso = new Date(2026, 9, 20, 0, 5).toISOString();
  expect(formatPunch(iso, now)).toBe(formatClock(iso));
});

it('a punch on the previous local day says yesterday', () => {
  const now = new Date(2026, 9, 20, 6, 30);
  const iso = new Date(2026, 9, 19, 22, 0).toISOString();
  expect(formatPunch(iso, now)).toBe(`yesterday ${formatClock(iso)}`);
  expect(formatPunch(iso, now)).toMatch(/^yesterday 10:00/);
  // across a month boundary too
  const first = new Date(2026, 10, 1, 7, 0);
  const late = new Date(2026, 9, 31, 23, 15).toISOString();
  expect(formatPunch(late, first)).toBe(`yesterday ${formatClock(late)}`);
});

it('an older punch carries its short date', () => {
  const now = new Date(2026, 9, 20, 6, 30);
  const at = new Date(2026, 9, 18, 22, 0);
  const iso = at.toISOString();
  const date = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  expect(formatPunch(iso, now)).toBe(`${date} ${formatClock(iso)}`);
  expect(formatPunch(iso, now)).toMatch(/18/);
});

it('kioskZone is the browser\'s own IANA zone', () => {
  expect(kioskZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone);
});

it('kioskZone is undefined when the browser cannot say', () => {
  vi.spyOn(Intl, 'DateTimeFormat').mockImplementation(() => { throw new Error('no Intl'); });
  expect(kioskZone()).toBeUndefined();
});
