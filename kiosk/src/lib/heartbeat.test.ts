// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ heartbeatRequest: vi.fn() }));
vi.mock('./api', () => api);

import { startHeartbeat } from './heartbeat';

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  api.heartbeatRequest.mockResolvedValue({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null });
});
afterEach(() => vi.useRealTimers());

it('beats at once, then every interval, reporting the registration state; stop() ends it', async () => {
  const onState = vi.fn();
  const handle = startHeartbeat(onState, 1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(api.heartbeatRequest).toHaveBeenCalledTimes(1);
  const body = api.heartbeatRequest.mock.calls[0][0];
  expect(body.mode).toBe('web');
  expect(body.serial).toMatch(/^kiosk-web-/);
  expect(body.name).toMatch(/^Kiosk /);
  expect(onState).toHaveBeenCalledWith('ok');
  await vi.advanceTimersByTimeAsync(2000);
  expect(api.heartbeatRequest).toHaveBeenCalledTimes(3);
  handle.stop();
  await vi.advanceTimersByTimeAsync(5000);
  expect(api.heartbeatRequest).toHaveBeenCalledTimes(3);
});

it('keeps the last state through failures and now() beats immediately', async () => {
  const onState = vi.fn();
  const handle = startHeartbeat(onState, 60_000);
  await vi.advanceTimersByTimeAsync(0);
  api.heartbeatRequest.mockRejectedValueOnce(new Error('423'));
  await handle.now();
  expect(onState).toHaveBeenCalledTimes(1);          // failure reported nothing
  await handle.now();
  expect(onState).toHaveBeenCalledTimes(2);
  handle.stop();
});
