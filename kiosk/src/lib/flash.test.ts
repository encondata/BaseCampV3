// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { flash, readFlash, subscribeFlash } from './flash';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

it('sets a flash, notifies, and clears itself after the duration', () => {
  let calls = 0;
  const off = subscribeFlash(() => { calls += 1; });
  expect(readFlash()).toBeNull();

  flash('hsl(150 60% 45%)', 350);
  expect(readFlash()).toMatchObject({ color: 'hsl(150 60% 45%)', ms: 350 });
  expect(calls).toBe(1);

  vi.advanceTimersByTime(360);
  expect(readFlash()).toBeNull();
  expect(calls).toBe(2);
  off();
});

it('a second flash replaces the first and restarts the timer', () => {
  flash('red', 300);
  const first = readFlash();
  vi.advanceTimersByTime(200);
  flash('green', 300);
  const second = readFlash();
  expect(second?.color).toBe('green');
  expect(second?.id).not.toBe(first?.id);
  vi.advanceTimersByTime(200);
  expect(readFlash()).not.toBeNull(); // the first timer must not clear the second flash
  vi.advanceTimersByTime(150);
  expect(readFlash()).toBeNull();
});
