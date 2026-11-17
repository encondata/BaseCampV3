// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const helper = vi.hoisted(() => ({ getHostSystem: vi.fn() }));
vi.mock('./hostHelper', async (orig) => ({
  ...(await orig<typeof import('./hostHelper')>()),
  lockdownAvailable: () => true,
  getHostSystem: helper.getHostSystem,
}));

import { HOST_POLL_MS, useHostSystem } from './useHostSystem';

let visibility: DocumentVisibilityState = 'visible';
const setVisibility = (v: DocumentVisibilityState) => {
  visibility = v;
  act(() => { document.dispatchEvent(new Event('visibilitychange')); });
};
const wait = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  helper.getHostSystem.mockReset().mockResolvedValue({ battery: null, wifi: null, wired: null, network: 'none' });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete (document as { visibilityState?: unknown }).visibilityState;
});

it('polls every 15 s, pauses while hidden and refreshes when the page is back', async () => {
  const { unmount } = renderHook(() => useHostSystem());
  await wait(0);
  expect(helper.getHostSystem).toHaveBeenCalledTimes(1);
  await wait(HOST_POLL_MS);
  expect(helper.getHostSystem).toHaveBeenCalledTimes(2);
  setVisibility('hidden');
  await wait(HOST_POLL_MS * 4);
  expect(helper.getHostSystem).toHaveBeenCalledTimes(2);
  setVisibility('visible');
  await wait(0);
  expect(helper.getHostSystem).toHaveBeenCalledTimes(3);
  await wait(HOST_POLL_MS);
  expect(helper.getHostSystem).toHaveBeenCalledTimes(4);
  unmount();
  await wait(HOST_POLL_MS * 2);
  expect(helper.getHostSystem).toHaveBeenCalledTimes(4);
});

it('does not start polling when it mounts hidden', async () => {
  visibility = 'hidden';
  renderHook(() => useHostSystem());
  await wait(HOST_POLL_MS * 2);
  expect(helper.getHostSystem).not.toHaveBeenCalled();
  setVisibility('visible');
  await wait(0);
  expect(helper.getHostSystem).toHaveBeenCalledTimes(1);
});
