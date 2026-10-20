// @vitest-environment jsdom
/** The yellow label-regeneration takeover: polls the edge's run status
 *  and covers every shell page of a Label Station laptop while a run is
 *  going, with no way to dismiss it. */
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LabelRunStatus } from '../lib/api';

const apiMock = vi.hoisted(() => ({
  getLabelRunStatus: vi.fn(),
  getOffMoveAlarm: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...apiMock };
});

// KioskShell's own dependencies, for the mount test.
const auth = vi.hoisted(() => ({
  status: 'authed' as 'authed' | 'anon',
  person: { display_name: 'Alex Worker' },
  registration: 'ok' as const,
  preferences: null as unknown,
  sessionExpiresAt: null as string | null,
  kioskMove: null as { initiative_id: string; name: string } | null,
  logout: vi.fn(() => Promise.resolve()),
  setupRedirectPending: false,
  consumeSetupRedirect: vi.fn(),
  can: () => true,
}));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));
vi.mock('../lib/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sync')>();
  return { ...actual, useSyncStatus: () => ({ phase: 'idle' }) };
});
vi.mock('../lib/edgeStatus', () => ({
  useEdgeStatus: () => ({ status: null, refresh: async () => {} }),
}));
vi.mock('../lib/laptopSetup', () => ({ hydrateLaptopSetup: vi.fn(() => Promise.resolve(false)) }));

import { writeKioskSetup } from '../lib/kioskSetup';
import KioskShell from '../layout/KioskShell';
import LabelRegenScreen, { LABEL_RUN_POLL_MS } from './LabelRegenScreen';

const SETUP = {
  initiativeId: 'i-1', initiativeName: 'Initech ORD1 to AUS1', siteId: 's-1', siteName: 'ORD1',
  siteRole: 'source' as const, scanStatus: 'k', scanLabel: 'Dock', stationType: 'label' as const,
};

function status(extra: Partial<LabelRunStatus> = {}): LabelRunStatus {
  return { state: 'idle', reason: null, total: 0, done: 0, ready: 0, errors: 0, ...extra };
}

async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({
    matches: false, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  }));
  apiMock.getLabelRunStatus.mockResolvedValue(status());
  apiMock.getOffMoveAlarm.mockResolvedValue({
    mode: 'until_dismissed', timed_seconds: 10, alarms: [], latest_id: null, expires_at: null,
  });
  writeKioskSetup(SETUP);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
  delete window.__KIOSK_CONFIG__;
});

it('first run after setup says the labels are being prepared, with progress', async () => {
  apiMock.getLabelRunStatus.mockResolvedValue(status({ state: 'running', reason: 'setup', total: 10, done: 3 }));
  render(<LabelRegenScreen />);
  await flush();
  const dialog = screen.getByRole('alertdialog', { name: 'Preparing labels for this move' });
  expect(dialog.classList.contains('label-regen')).toBe(true);
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.textContent).toContain('3 of 10');
  expect(screen.queryByRole('button')).toBeNull();
});

it('a run for updates says updates were detected', async () => {
  apiMock.getLabelRunStatus.mockResolvedValue(status({ state: 'running', reason: 'updates', total: 10, done: 3 }));
  render(<LabelRegenScreen />);
  await flush();
  expect(screen.getByRole('alertdialog', {
    name: 'Label regeneration in progress — updates were detected',
  }).textContent).toContain('3 of 10');
});

it('hidden while idle, even when the last run reason is kept', async () => {
  apiMock.getLabelRunStatus.mockResolvedValue(status({ state: 'idle', reason: 'updates', total: 10, done: 10 }));
  render(<LabelRegenScreen />);
  await flush();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('polls every second: progress updates, and it closes when the run ends', async () => {
  apiMock.getLabelRunStatus.mockResolvedValue(status({ state: 'running', reason: 'updates', total: 10, done: 3 }));
  render(<LabelRegenScreen />);
  await flush();
  expect(screen.getByRole('alertdialog').textContent).toContain('3 of 10');
  apiMock.getLabelRunStatus.mockResolvedValue(status({ state: 'running', reason: 'updates', total: 10, done: 7 }));
  await tick(LABEL_RUN_POLL_MS);
  expect(screen.getByRole('alertdialog').textContent).toContain('7 of 10');
  apiMock.getLabelRunStatus.mockResolvedValue(status({ state: 'idle', reason: 'updates', total: 10, done: 10 }));
  await tick(LABEL_RUN_POLL_MS);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('a failed poll keeps the last state and never throws', async () => {
  apiMock.getLabelRunStatus.mockResolvedValue(status({ state: 'running', reason: 'setup', total: 4, done: 1 }));
  render(<LabelRegenScreen />);
  await flush();
  apiMock.getLabelRunStatus.mockRejectedValue(new Error('offline'));
  await tick(LABEL_RUN_POLL_MS);
  expect(screen.getByRole('alertdialog').textContent).toContain('1 of 4');
});

it('the page underneath is inert while it shows, and not after', async () => {
  apiMock.getLabelRunStatus.mockResolvedValue(status({ state: 'running', reason: 'setup', total: 2, done: 0 }));
  render(<div><button type="button">Page button</button><LabelRegenScreen /></div>);
  await flush();
  const page = screen.getByText('Page button');
  expect(page.hasAttribute('inert')).toBe(true);
  apiMock.getLabelRunStatus.mockResolvedValue(status({ state: 'idle', reason: 'setup', total: 2, done: 2 }));
  await tick(LABEL_RUN_POLL_MS);
  expect(page.hasAttribute('inert')).toBe(false);
});

it('mounted only for a signed-in laptop Label Station', async () => {
  apiMock.getLabelRunStatus.mockResolvedValue(status({ state: 'running', reason: 'setup', total: 2, done: 0 }));
  const shell = () => render(<MemoryRouter><KioskShell><p>body</p></KioskShell></MemoryRouter>);

  // Web mode: nothing.
  shell();
  await flush();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  cleanup();

  // Laptop RFID Station: nothing.
  window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
  writeKioskSetup({ ...SETUP, stationType: 'rfid' });
  shell();
  await flush();
  expect(screen.queryByRole('alertdialog', { name: /labels/i })).toBeNull();
  cleanup();
  expect(apiMock.getLabelRunStatus).not.toHaveBeenCalled();

  // Laptop Label Station, signed in: the takeover covers the shell.
  writeKioskSetup(SETUP);
  shell();
  await flush();
  expect(screen.getByRole('alertdialog', { name: 'Preparing labels for this move' })).toBeTruthy();
  cleanup();

  // Signed out: no polling.
  apiMock.getLabelRunStatus.mockClear();
  auth.status = 'anon';
  try {
    shell();
    await flush();
    expect(apiMock.getLabelRunStatus).not.toHaveBeenCalled();
  } finally {
    auth.status = 'authed';
  }
});
