// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({ runCheck: vi.fn() }));
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, ...apiMock };
});

import type { CheckName } from '../../lib/api';
import NetworkCheckStep from './NetworkCheckStep';

const INFO: Record<string, Record<string, string>> = {
  reader: { endpoint_ip: '10.0.0.5' },
  router: { lan_ip: '192.168.8.20' },
  registration: { wan_ip: '203.0.113.7' },
};
const ok = (name: CheckName) => ({
  name, ok: true, state: 'ok' as const, detail: '', info: INFO[name],
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  apiMock.runCheck.mockReset().mockImplementation((name: CheckName) => Promise.resolve(ok(name)));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function settle() { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); }

describe('NetworkCheckStep', () => {
  it('runs the four checks in order and shows each passed with the IPs', async () => {
    const onContinue = vi.fn();
    render(<NetworkCheckStep onContinue={onContinue} onBack={vi.fn()} />);
    await settle();
    expect(apiMock.runCheck.mock.calls.map((c) => c[0]))
      .toEqual(['reader', 'router', 'portal', 'registration']);
    expect(screen.getAllByLabelText('passed')).toHaveLength(4);
    expect(screen.getByText('All checks passed')).toBeTruthy();
    expect(screen.getByText('10.0.0.5')).toBeTruthy();
    expect(screen.getByText('192.168.8.20')).toBeTruthy();
    expect(screen.getByText('203.0.113.7')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Run again' })).toBeNull();
  });

  it('continues after 1500 ms and not before', async () => {
    const onContinue = vi.fn();
    render(<NetworkCheckStep onContinue={onContinue} onBack={vi.fn()} />);
    await settle();
    await act(async () => { await vi.advanceTimersByTimeAsync(1400); });
    expect(onContinue).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(150); });
    expect(onContinue).toHaveBeenCalledTimes(1);
  });

  it('a failure keeps the rest running and offers Back and Run again', async () => {
    const onContinue = vi.fn();
    const onBack = vi.fn();
    apiMock.runCheck.mockImplementation((name: CheckName) => Promise.resolve(
      name === 'portal'
        ? { name, ok: false, state: 'fail', detail: 'Portal did not answer', info: undefined }
        : ok(name)));
    render(<NetworkCheckStep onContinue={onContinue} onBack={onBack} />);
    await settle();
    expect(apiMock.runCheck).toHaveBeenCalledTimes(4);
    expect(screen.getAllByLabelText('passed')).toHaveLength(3);
    expect(screen.getAllByLabelText('failed')).toHaveLength(1);
    expect(screen.getByText('Portal did not answer')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(onContinue).not.toHaveBeenCalled();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Run again' })).toBeTruthy();
  });

  it('a rejected check becomes a failure with its code', async () => {
    const { ApiError } = await import('../../lib/api');
    apiMock.runCheck.mockImplementation((name: CheckName) => (
      name === 'reader' ? Promise.reject(new ApiError(503, 'edge_offline')) : Promise.resolve(ok(name))));
    render(<NetworkCheckStep onContinue={vi.fn()} onBack={vi.fn()} />);
    await settle();
    expect(screen.getByText('edge_offline')).toBeTruthy();
    expect(apiMock.runCheck).toHaveBeenCalledTimes(4);
  });

  it('Run again re-runs all four', async () => {
    apiMock.runCheck.mockImplementation((name: CheckName) => Promise.resolve(
      name === 'router' ? { name, ok: false, state: 'fail', detail: 'No gateway' } : ok(name)));
    render(<NetworkCheckStep onContinue={vi.fn()} onBack={vi.fn()} />);
    await settle();
    expect(apiMock.runCheck).toHaveBeenCalledTimes(4);
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    await user.click(screen.getByRole('button', { name: 'Run again' }));
    await settle();
    expect(apiMock.runCheck).toHaveBeenCalledTimes(8);
  });

  it('an unknown router state shows its detail', async () => {
    apiMock.runCheck.mockImplementation((name: CheckName) => Promise.resolve(
      name === 'router'
        ? { name, ok: false, state: 'unknown', detail: 'Router not identified' } : ok(name)));
    const onContinue = vi.fn();
    render(<NetworkCheckStep onContinue={onContinue} onBack={vi.fn()} />);
    await settle();
    expect(screen.getByText('Router not identified')).toBeTruthy();
    expect(screen.getAllByLabelText('failed')).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(onContinue).not.toHaveBeenCalled();
  });
});
