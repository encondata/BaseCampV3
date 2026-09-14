// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ heartbeatRequest: vi.fn() }));
vi.mock('./api', () => api);

import { startHeartbeat } from './heartbeat';

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  api.heartbeatRequest.mockClear();
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

it('marks only the very first beat as a sign-in when told to, carrying the login method', async () => {
  const onState = vi.fn();
  const handle = startHeartbeat(onState, 1000, { method: 'link' });
  await vi.advanceTimersByTimeAsync(0);
  expect(api.heartbeatRequest.mock.calls[0][0].sign_in).toBe(true);
  expect(api.heartbeatRequest.mock.calls[0][0].login_method).toBe('link');
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.heartbeatRequest.mock.calls[1][0].sign_in).toBeUndefined();
  expect(api.heartbeatRequest.mock.calls[1][0].login_method).toBeUndefined();
  handle.stop();
});

it('sends no sign_in flag when the first beat is not a sign-in', async () => {
  const onState = vi.fn();
  const handle = startHeartbeat(onState, 1000);
  await vi.advanceTimersByTimeAsync(0);
  expect(api.heartbeatRequest.mock.calls[0][0].sign_in).toBeUndefined();
  handle.stop();
});

it('retries the sign-in flag on the next tick after a failed first beat', async () => {
  const onState = vi.fn();
  api.heartbeatRequest.mockRejectedValueOnce(new Error('network'));
  const handle = startHeartbeat(onState, 1000, { method: 'password' });
  await vi.advanceTimersByTimeAsync(0);
  expect(api.heartbeatRequest.mock.calls[0][0].sign_in).toBe(true);
  expect(api.heartbeatRequest.mock.calls[0][0].login_method).toBe('password');
  expect(onState).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(api.heartbeatRequest.mock.calls[1][0].sign_in).toBe(true);
  expect(api.heartbeatRequest.mock.calls[1][0].login_method).toBe('password');
  expect(onState).toHaveBeenCalledTimes(1);
  handle.stop();
});

it('now() after a failed first beat still carries the sign-in flag', async () => {
  const onState = vi.fn();
  api.heartbeatRequest.mockRejectedValueOnce(new Error('network'));
  const handle = startHeartbeat(onState, 60_000, { method: 'link' });
  await vi.advanceTimersByTimeAsync(0);
  expect(api.heartbeatRequest.mock.calls[0][0].sign_in).toBe(true);
  await handle.now();
  expect(api.heartbeatRequest.mock.calls[1][0].sign_in).toBe(true);
  expect(api.heartbeatRequest.mock.calls[1][0].login_method).toBe('link');
  handle.stop();
});
