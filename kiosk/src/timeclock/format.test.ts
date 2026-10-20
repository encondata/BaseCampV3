import { expect, it } from 'vitest';

import { formatClock, formatWorked } from './format';

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
