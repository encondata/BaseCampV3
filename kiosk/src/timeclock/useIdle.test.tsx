// @vitest-environment jsdom
import { cleanup, renderHook } from '@testing-library/react';
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { useIdle } from './useIdle';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('fires after the idle time', () => {
  const onIdle = vi.fn();
  renderHook(() => useIdle(true, 20_000, onIdle));
  act(() => { vi.advanceTimersByTime(19_999); });
  expect(onIdle).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); });
  expect(onIdle).toHaveBeenCalledTimes(1);
});

it('is pushed back by a keydown and a pointerdown', () => {
  const onIdle = vi.fn();
  renderHook(() => useIdle(true, 20_000, onIdle));
  act(() => { vi.advanceTimersByTime(15_000); });
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' })); });
  act(() => { vi.advanceTimersByTime(15_000); });
  expect(onIdle).not.toHaveBeenCalled();
  act(() => { window.dispatchEvent(new Event('pointerdown')); });
  act(() => { vi.advanceTimersByTime(19_999); });
  expect(onIdle).not.toHaveBeenCalled();
  act(() => { vi.advanceTimersByTime(1); });
  expect(onIdle).toHaveBeenCalledTimes(1);
});

it('does nothing while inactive, and stops when it turns inactive', () => {
  const onIdle = vi.fn();
  const { rerender } = renderHook(({ on }) => useIdle(on, 1_000, onIdle), { initialProps: { on: false } });
  act(() => { vi.advanceTimersByTime(5_000); });
  expect(onIdle).not.toHaveBeenCalled();
  rerender({ on: true });
  rerender({ on: false });
  act(() => { vi.advanceTimersByTime(5_000); });
  expect(onIdle).not.toHaveBeenCalled();
});

it('calls the latest onIdle without restarting the timer', () => {
  const first = vi.fn();
  const second = vi.fn();
  const { rerender } = renderHook(({ cb }) => useIdle(true, 1_000, cb), { initialProps: { cb: first } });
  act(() => { vi.advanceTimersByTime(600); });
  rerender({ cb: second });
  act(() => { vi.advanceTimersByTime(400); });
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledTimes(1);
});
