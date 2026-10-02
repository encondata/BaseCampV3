// @vitest-environment jsdom
/** ReaderStep's scan poll: once a second while running, stopping on done,
 *  on unmount and on Back; failed polls retried twice; one scan under
 *  StrictMode; snapshots of another scan ignored. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ startReaderScan: vi.fn(), getReaderScan: vi.fn() }));
vi.mock('../../lib/api', async (orig) => ({ ...(await orig<object>()), ...api }));

import { ApiError } from '../../lib/api';
import ReaderStep, { SCAN_POLL_MS } from './ReaderStep';

const HOST = { ips: ['10.0.0.9'], fresh: true };
const running = (probed: number) => ({
  scan_id: 'sc1', state: 'running', probed, total: 254, readers: [], host: HOST,
});
const DONE = {
  scan_id: 'sc1', state: 'done', probed: 254, total: 254, host: HOST,
  readers: [{ ip: '10.0.0.5', model: 'FX9600', serial: '1234ABCD', paired_with: null }],
};

const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
const tick = (ms = SCAN_POLL_MS) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  api.startReaderScan.mockReset().mockResolvedValue({ scan_id: 'sc1' });
  api.getReaderScan.mockReset();
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

function Harness() {
  const [shown, setShown] = useState(true);
  return shown
    ? <ReaderStep selectedIp="" onPick={() => {}} onBack={() => setShown(false)} />
    : <p>LEFT</p>;
}

it('re-polls every second while running and stops once the scan is done', async () => {
  api.getReaderScan
    .mockResolvedValueOnce(running(10))
    .mockResolvedValueOnce(running(120))
    .mockResolvedValue(DONE);
  render(<Harness />);
  await flush();
  expect(api.getReaderScan).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('10');

  await tick(SCAN_POLL_MS - 1);
  expect(api.getReaderScan).toHaveBeenCalledTimes(1);
  await tick(1);
  expect(api.getReaderScan).toHaveBeenCalledTimes(2);
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('120');

  await tick();
  expect(api.getReaderScan).toHaveBeenCalledTimes(3);
  expect(screen.getByText('10.0.0.5')).toBeTruthy();
  expect(screen.queryByRole('progressbar')).toBeNull();

  await tick(SCAN_POLL_MS * 5);
  expect(api.getReaderScan).toHaveBeenCalledTimes(3);
});

it('stops polling on unmount', async () => {
  api.getReaderScan.mockResolvedValue(running(10));
  const { unmount } = render(<Harness />);
  await flush();
  expect(api.getReaderScan).toHaveBeenCalledTimes(1);
  unmount();
  await tick(SCAN_POLL_MS * 5);
  expect(api.getReaderScan).toHaveBeenCalledTimes(1);
});

it('stops polling on Back', async () => {
  api.getReaderScan.mockResolvedValue(running(10));
  render(<Harness />);
  await flush();
  fireEvent.click(screen.getByRole('button', { name: 'Back' }));
  expect(screen.getByText('LEFT')).toBeTruthy();
  await tick(SCAN_POLL_MS * 5);
  expect(api.getReaderScan).toHaveBeenCalledTimes(1);
});

it('retries a failed poll twice before showing the error', async () => {
  api.getReaderScan.mockRejectedValue(new ApiError(0, 'network'));
  render(<Harness />);
  await flush();
  expect(api.getReaderScan).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('alert')).toBeNull();
  await tick();
  expect(api.getReaderScan).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('alert')).toBeNull();
  await tick();
  expect(api.getReaderScan).toHaveBeenCalledTimes(3);
  expect(screen.getByRole('alert').textContent).toBe("Can't reach this laptop's edge service. Try again.");
  await tick(SCAN_POLL_MS * 5);
  expect(api.getReaderScan).toHaveBeenCalledTimes(3);
});

it('a poll that recovers within the retries shows no error', async () => {
  api.getReaderScan
    .mockRejectedValueOnce(new ApiError(0, 'network'))
    .mockRejectedValueOnce(new ApiError(0, 'network'))
    .mockResolvedValue(DONE);
  render(<Harness />);
  await flush();
  await tick();
  await tick();
  expect(screen.getByText('10.0.0.5')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('StrictMode starts one scan and still polls it', async () => {
  api.getReaderScan.mockResolvedValue(DONE);
  render(<StrictMode><Harness /></StrictMode>);
  await flush();
  expect(api.startReaderScan).toHaveBeenCalledTimes(1);
  expect(screen.getByText('10.0.0.5')).toBeTruthy();
});

it("ignores a snapshot of a scan it didn't start", async () => {
  api.getReaderScan.mockResolvedValue({ ...DONE, scan_id: 'someone-else' });
  render(<Harness />);
  await flush();
  expect(screen.queryByText('10.0.0.5')).toBeNull();
  expect(screen.getByText('Starting the scan…')).toBeTruthy();
});

it('Scan again starts a fresh scan and retires the old poll', async () => {
  api.getReaderScan.mockResolvedValue(running(10));
  render(<Harness />);
  await flush();
  api.startReaderScan.mockResolvedValue({ scan_id: 'sc2' });
  api.getReaderScan.mockResolvedValue({ ...DONE, scan_id: 'sc2' });
  fireEvent.click(screen.getByRole('button', { name: 'Scan again' }));
  await flush();
  expect(api.startReaderScan).toHaveBeenCalledTimes(2);
  expect(screen.getByText('10.0.0.5')).toBeTruthy();
  const calls = api.getReaderScan.mock.calls.length;
  await tick(SCAN_POLL_MS * 5);
  expect(api.getReaderScan).toHaveBeenCalledTimes(calls);
});
