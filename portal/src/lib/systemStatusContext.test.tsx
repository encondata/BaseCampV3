// @vitest-environment jsdom
/**
 * SystemStatusProvider's `loaded` flag: false until the first /system/status
 * answer lands, so a page can tell "email is off" from "not known yet" (the
 * defaults say email is off). A failed first fetch counts as loaded too, so
 * nothing waits forever on a status that may never come.
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import type { SystemStatus } from './systemStatus';

const fetcher = vi.hoisted(() => ({ getSystemStatus: vi.fn() }));
vi.mock('./systemStatus', async (importActual) => ({
  ...(await importActual<typeof import('./systemStatus')>()), ...fetcher,
}));

const { DEFAULT_SYSTEM_STATUS } = await import('./systemStatus');
const { SystemStatusProvider, useSystemStatus } = await import('./systemStatusContext');

function Probe() {
  const { status, loaded } = useSystemStatus();
  return <p data-testid="probe">{loaded ? `loaded, email ${status.email_enabled ? 'on' : 'off'}` : 'loading'}</p>;
}

const probe = () => screen.getByTestId('probe').textContent;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('is not loaded while the first status is on its way, then carries it', async () => {
  let land: (s: SystemStatus) => void = () => {};
  fetcher.getSystemStatus.mockReturnValueOnce(new Promise<SystemStatus>((resolve) => { land = resolve; }));
  render(<SystemStatusProvider><Probe /></SystemStatusProvider>);
  expect(probe()).toBe('loading');

  await act(async () => { land({ ...DEFAULT_SYSTEM_STATUS, email_enabled: true }); });
  expect(probe()).toBe('loaded, email on');
});

it('counts a failed first fetch as loaded, keeping the defaults', async () => {
  fetcher.getSystemStatus.mockRejectedValueOnce(new Error('system status 500'));
  render(<SystemStatusProvider><Probe /></SystemStatusProvider>);
  await waitFor(() => expect(probe()).toBe('loaded, email off'));
});

it('is not loaded without a provider: nothing ever fetched it', () => {
  render(<Probe />);
  expect(probe()).toBe('loading');
});
