// @vitest-environment jsdom
/** Link-with-phone panel: requests a code on mount, shows it dashed,
 *  polls every 2 s, hands an approved session up, and recovers from
 *  denied/expired/error with a new code. Fake timers throughout. */
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  createPairRequest: vi.fn(),
  pollPair: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));
vi.mock('qrcode', () => ({ default: { toCanvas: vi.fn(() => Promise.resolve()) } }));

import { ApiError } from '../lib/api';
import PairPanel, { formatCode, portalHost, POLL_MS } from './PairPanel';

const CREATED = {
  code: 'ABCD2345', poll_token: 'pt', link_url: 'http://localhost:5173/link/ABCD2345',
  expires_at: new Date(Date.now() + 300_000).toISOString(),
};
const SESSION = { access_token: 't' } as never;

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  api.createPairRequest.mockResolvedValue(CREATED);
  api.pollPair.mockResolvedValue({ status: 'pending', session: null });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.clearAllMocks(); });

it('formats the code and the portal host', () => {
  expect(formatCode('ABCD2345')).toBe('ABCD-2345');
  expect(portalHost('https://portal.example.com/')).toBe('portal.example.com');
});

it('requests a code with the kiosk identity, shows it, and polls until approved', async () => {
  const onApproved = vi.fn();
  render(<PairPanel onApproved={onApproved} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const body = api.createPairRequest.mock.calls[0][0];
  expect(body.serial).toMatch(/^kiosk-web-/);
  expect(body.name).toMatch(/^Kiosk /);
  expect(screen.getByLabelText('Link code').textContent).toBe('ABCD-2345');
  expect(screen.getByText(/Expires in (5:00|4:5\d)/)).toBeTruthy();

  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
  expect(api.pollPair).toHaveBeenCalledWith('ABCD2345', 'pt');
  api.pollPair.mockResolvedValue({ status: 'approved', session: SESSION });
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
  expect(onApproved).toHaveBeenCalledWith(SESSION);
  const calls = api.pollPair.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3); });
  expect(api.pollPair).toHaveBeenCalledTimes(calls);       // polling stopped
});

it('shows the declined copy and gets a new code on request', async () => {
  render(<PairPanel onApproved={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  api.pollPair.mockResolvedValue({ status: 'denied', session: null });
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
  expect(screen.getByText('Sign-in was declined on the phone.')).toBeTruthy();
  api.pollPair.mockResolvedValue({ status: 'pending', session: null });
  await act(async () => { screen.getByRole('button', { name: 'Get a new code' }).click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(api.createPairRequest).toHaveBeenCalledTimes(2);
  expect(screen.getByLabelText('Link code').textContent).toBe('ABCD-2345');
});

it('expires locally when the clock runs out', async () => {
  api.createPairRequest.mockResolvedValue({ ...CREATED, expires_at: new Date(Date.now() + 3000).toISOString() });
  render(<PairPanel onApproved={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 2); });
  expect(screen.getByText('This code expired.')).toBeTruthy();
});

it('reports a failed code request with a retry', async () => {
  api.createPairRequest.mockRejectedValueOnce(new ApiError(429, 'pair_rate_limited'));
  render(<PairPanel onApproved={vi.fn()} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByText(/Couldn't get a code \(too many codes requested/)).toBeTruthy();
  await act(async () => { screen.getByRole('button', { name: 'Try again' }).click(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(screen.getByLabelText('Link code')).toBeTruthy();
});
