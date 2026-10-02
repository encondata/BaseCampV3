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

it('applies a clear_setup once, acks on an immediate re-beat, then stops acking', async () => {
  const onClear = vi.fn();
  api.heartbeatRequest
    .mockResolvedValueOnce({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: 'x1' })
    .mockResolvedValueOnce({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: null })
    .mockResolvedValue({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: null });
  const handle = startHeartbeat(vi.fn(), 60_000, undefined, onClear);
  await vi.advanceTimersByTimeAsync(0);
  expect(onClear).toHaveBeenCalledWith('x1');
  expect(api.heartbeatRequest).toHaveBeenCalledTimes(2);            // immediate re-beat
  expect(api.heartbeatRequest.mock.calls[0][0].setup_cleared).toBeUndefined();
  expect(api.heartbeatRequest.mock.calls[1][0].setup_cleared).toBe('x1');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.heartbeatRequest.mock.calls[2][0].setup_cleared).toBeUndefined();
  expect(onClear).toHaveBeenCalledTimes(1);
  expect(JSON.parse(localStorage.getItem('ss.kiosk.setupClear')!).acked).toBe(true);
  handle.stop();
});

it('keeps sending the ack while the server still repeats the same id', async () => {
  api.heartbeatRequest.mockResolvedValue({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: 'x2' });
  const onClear = vi.fn();
  const handle = startHeartbeat(vi.fn(), 60_000, undefined, onClear);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(60_000);
  const calls = api.heartbeatRequest.mock.calls;
  expect(calls[calls.length - 1][0].setup_cleared).toBe('x2');
  expect(onClear).toHaveBeenCalledTimes(1);
  handle.stop();
});

it('a reload with an unacked id resumes acking without re-applying', async () => {
  localStorage.setItem('ss.kiosk.setupClear', JSON.stringify({ id: 'x3', acked: false, notice: true }));
  api.heartbeatRequest.mockResolvedValue({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: null });
  const onClear = vi.fn();
  const handle = startHeartbeat(vi.fn(), 60_000, undefined, onClear);
  await vi.advanceTimersByTimeAsync(0);
  expect(api.heartbeatRequest.mock.calls[0][0].setup_cleared).toBe('x3');
  expect(onClear).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.heartbeatRequest.mock.calls[1][0].setup_cleared).toBeUndefined();   // settled
  handle.stop();
});

it('applies a newer id that arrives while the older one is still unacked, then acks it', async () => {
  localStorage.setItem('ss.kiosk.setupClear', JSON.stringify({ id: 'old', acked: false, notice: true }));
  api.heartbeatRequest
    .mockResolvedValueOnce({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: 'new' })
    .mockResolvedValue({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: null });
  const onClear = vi.fn();
  const handle = startHeartbeat(vi.fn(), 60_000, undefined, onClear);
  await vi.advanceTimersByTimeAsync(0);
  expect(api.heartbeatRequest.mock.calls[0][0].setup_cleared).toBe('old');
  expect(onClear).toHaveBeenCalledWith('new');
  expect(api.heartbeatRequest.mock.calls[1][0].setup_cleared).toBe('new');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.heartbeatRequest.mock.calls[2][0].setup_cleared).toBeUndefined();
  handle.stop();
});

it('a throwing onState cannot defer the clear', async () => {
  api.heartbeatRequest.mockResolvedValue({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: 'x4' });
  const onClear = vi.fn();
  const handle = startHeartbeat(() => { throw new Error('boom'); }, 60_000, undefined, onClear);
  await vi.advanceTimersByTimeAsync(0);
  expect(onClear).toHaveBeenCalledWith('x4');
  handle.stop();
});

it('with storage refusing writes, a repeated clear_setup re-beats only once and carries the ack', async () => {
  vi.resetModules();
  const { startHeartbeat: start } = await import('./heartbeat');
  const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('quota');
  });
  try {
    api.heartbeatRequest.mockResolvedValue({ device_id: 'd', name: 'K', registration: 'ok', token_expires_at: null, clear_setup: 'x5' });
    const onClear = vi.fn();
    const handle = start(vi.fn(), 60_000, undefined, onClear);
    await vi.advanceTimersByTimeAsync(0);
    expect(api.heartbeatRequest).toHaveBeenCalledTimes(2);
    expect(api.heartbeatRequest.mock.calls[1][0].setup_cleared).toBe('x5');
    expect(onClear).toHaveBeenCalledTimes(1);
    handle.stop();
  } finally {
    spy.mockRestore();
  }
});
