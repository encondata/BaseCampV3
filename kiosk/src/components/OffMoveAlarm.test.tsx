// @vitest-environment jsdom
/** The Asset Not Part Of Move takeover: polls the edge, flashes over every
 *  shell page of an RFID Station laptop, sounds the siren, and dismisses
 *  on tap or the space bar. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { OffMoveAlarmRow, OffMoveAlarmState } from '../lib/api';

const apiMock = vi.hoisted(() => ({
  getOffMoveAlarm: vi.fn(),
  dismissOffMoveAlarm: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...apiMock };
});

const soundMock = vi.hoisted(() => ({
  stop: vi.fn(),
  startSiren: vi.fn(),
  soundBlocked: vi.fn(() => false),
}));
vi.mock('../lib/sound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sound')>();
  return { ...actual, startSiren: soundMock.startSiren, soundBlocked: soundMock.soundBlocked };
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
import { writeSoundSettings } from '../lib/sound';
import KioskShell from '../layout/KioskShell';
import OffMoveAlarm from './OffMoveAlarm';

const SETUP = {
  initiativeId: 'i-1', initiativeName: 'Initech ORD1 to AUS1', siteId: 's-1', siteName: 'ORD1',
  siteRole: 'source' as const, scanStatus: 'k', scanLabel: 'Dock', stationType: 'rfid' as const,
};

function row(id: number, extra: Partial<OffMoveAlarmRow> = {}): OffMoveAlarmRow {
  return {
    id, make_model: 'Dell PowerEdge R740', name: `ord1-db-0${id}`, serial: `SN${id}`,
    rfid: `10048${id}`, raised_at: '2026-10-17T14:00:00+00:00', ...extra,
  };
}

function state(alarms: OffMoveAlarmRow[], extra: Partial<OffMoveAlarmState> = {}): OffMoveAlarmState {
  return {
    mode: 'until_dismissed', timed_seconds: 10, alarms,
    latest_id: alarms.length ? Math.max(...alarms.map((a) => a.id)) : null,
    expires_at: null, ...extra,
  };
}

const EMPTY = state([]);

/** Lets the pending poll promise settle inside act. */
async function flush() {
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-17T14:00:00Z'));
  vi.stubGlobal('matchMedia', () => ({
    matches: false, addEventListener() {}, removeEventListener() {},
    addListener() {}, removeListener() {},
  }));
  apiMock.getOffMoveAlarm.mockResolvedValue(EMPTY);
  apiMock.dismissOffMoveAlarm.mockResolvedValue({ dismissed: 1 });
  soundMock.startSiren.mockImplementation(() => soundMock.stop);
  soundMock.soundBlocked.mockReturnValue(false);
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

it('shows_takeover_with_title_move_and_table_columns', async () => {
  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(1), row(2)]));
  render(<OffMoveAlarm />);
  await flush();

  const dialog = screen.getByRole('alertdialog', { name: /Asset Not Part Of Move/ });
  expect(within(dialog).getByRole('heading').textContent).toContain('Asset Not Part Of Move');
  expect(dialog.textContent).toContain('2 assets');
  expect(dialog.textContent).toContain('Initech ORD1 to AUS1');
  const headers = within(dialog).getAllByRole('columnheader').map((th) => th.textContent);
  expect(headers).toEqual(['Make / Model', 'Name', 'Serial', 'RFID']);
  expect(within(dialog).getAllByRole('row')).toHaveLength(3);
  expect(within(dialog).getByText('ord1-db-02')).toBeTruthy();
  expect(within(dialog).getByRole('button', { name: /Tap or press Space to dismiss/ })).toBeTruthy();
});

it('missing_values_show_dash', async () => {
  apiMock.getOffMoveAlarm.mockResolvedValue(state([
    row(1, { make_model: null, name: null, serial: null, rfid: 'EE01' }),
  ]));
  render(<OffMoveAlarm />);
  await flush();

  const cells = within(screen.getByRole('alertdialog')).getAllByRole('cell').map((c) => c.textContent);
  expect(cells).toEqual(['—', '—', '—', 'EE01']);
  expect(screen.getByRole('alertdialog').textContent).toContain('1 asset ');
});

it('space_dismisses_with_latest_id', async () => {
  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(3), row(7)]));
  render(<OffMoveAlarm />);
  await flush();
  expect(screen.getByRole('alertdialog')).toBeTruthy();

  // A held key's repeats do nothing, but still don't scroll the page.
  const repeat = new KeyboardEvent('keydown', { key: ' ', code: 'Space', repeat: true, cancelable: true });
  act(() => { window.dispatchEvent(repeat); });
  expect(repeat.defaultPrevented).toBe(true);
  expect(apiMock.dismissOffMoveAlarm).not.toHaveBeenCalled();

  const press = new KeyboardEvent('keydown', { key: ' ', code: 'Space', cancelable: true });
  act(() => { window.dispatchEvent(press); });
  expect(press.defaultPrevented).toBe(true);
  expect(apiMock.dismissOffMoveAlarm).toHaveBeenCalledWith(7);
  expect(screen.queryByRole('alertdialog')).toBeNull();

  // A poll already in flight with the old rows must not bring it back.
  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(3), row(7)]));
  await tick(1000);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('tap_dismisses', async () => {
  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(4)]));
  render(<OffMoveAlarm />);
  await flush();

  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
  expect(apiMock.dismissOffMoveAlarm).toHaveBeenCalledWith(4);
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('siren_starts_with_alarm_and_stops_on_dismiss', async () => {
  writeSoundSettings({ volume: 0.4 });
  render(<OffMoveAlarm />);
  await flush();
  expect(soundMock.startSiren).not.toHaveBeenCalled();

  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(1)]));
  await tick(1000);
  expect(soundMock.startSiren).toHaveBeenCalledTimes(1);
  expect(soundMock.startSiren).toHaveBeenCalledWith(0.4);

  // A re-alarm while the takeover is up keeps the same siren going.
  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(1), row(2)]));
  await tick(1000);
  expect(soundMock.startSiren).toHaveBeenCalledTimes(1);
  expect(soundMock.stop).not.toHaveBeenCalled();

  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
  expect(soundMock.stop).toHaveBeenCalledTimes(1);

  // A new alarm after the dismiss starts it again.
  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(5)]));
  await tick(1000);
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(soundMock.startSiren).toHaveBeenCalledTimes(2);
});

it('timed_mode_shows_countdown_and_hides_after_expires_at', async () => {
  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(1)], {
    mode: 'timed', timed_seconds: 10, expires_at: '2026-10-17T14:00:05+00:00',
  }));
  render(<OffMoveAlarm />);
  await flush();
  expect(screen.getByRole('button', { name: /Dismiss \(5s\)/ })).toBeTruthy();

  await tick(2000);
  expect(screen.getByRole('button', { name: /Dismiss \(3s\)/ })).toBeTruthy();

  await tick(3500);
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(soundMock.stop).toHaveBeenCalled();
  // Expiry is the edge's: the screen never sends a dismiss for it.
  expect(apiMock.dismissOffMoveAlarm).not.toHaveBeenCalled();
});

it('new_asset_while_open_is_added', async () => {
  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(1)]));
  render(<OffMoveAlarm />);
  await flush();
  expect(within(screen.getByRole('alertdialog')).getAllByRole('row')).toHaveLength(2);

  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(1), row(2)]));
  await tick(1000);
  const dialog = screen.getByRole('alertdialog');
  expect(within(dialog).getAllByRole('row')).toHaveLength(3);
  expect(dialog.textContent).toContain('2 assets');

  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
  expect(apiMock.dismissOffMoveAlarm).toHaveBeenCalledWith(2);
});

it('blocked_sound_shows_tap_to_enable_notice', async () => {
  soundMock.soundBlocked.mockReturnValue(true);
  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(1)]));
  render(<OffMoveAlarm />);
  await flush();
  await tick(1000);

  const notice = screen.getByRole('button', { name: /Tap to enable sound/ });
  soundMock.soundBlocked.mockReturnValue(false);
  fireEvent.click(notice);
  // The tap restarts the siren inside a user gesture, and is not a dismiss.
  expect(soundMock.startSiren).toHaveBeenCalledTimes(2);
  expect(apiMock.dismissOffMoveAlarm).not.toHaveBeenCalled();
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  await tick(1000);
  expect(screen.queryByRole('button', { name: /Tap to enable sound/ })).toBeNull();
});

it('poll_failure_keeps_last_state_and_never_throws', async () => {
  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(1)]));
  render(<OffMoveAlarm />);
  await flush();
  expect(screen.getByRole('alertdialog')).toBeTruthy();

  apiMock.getOffMoveAlarm.mockRejectedValue(new Error('401'));
  await tick(3000);
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(apiMock.getOffMoveAlarm.mock.calls.length).toBeGreaterThanOrEqual(4);

  // A failing dismiss still hides the takeover at once.
  apiMock.dismissOffMoveAlarm.mockRejectedValue(new Error('offline'));
  fireEvent.click(screen.getByRole('button', { name: /dismiss/i }));
  await flush();
  expect(screen.queryByRole('alertdialog')).toBeNull();
});

it('preview shows the given rows, never polls or dismisses on the edge, and closes', async () => {
  const onClose = vi.fn();
  render(<OffMoveAlarm preview={{ rows: [row(1)], mode: 'timed', timed_seconds: 3, onClose }} />);
  await flush();
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  expect(screen.getByRole('button', { name: /Dismiss \(3s\)/ })).toBeTruthy();
  expect(soundMock.startSiren).toHaveBeenCalledTimes(1);

  await tick(3500);
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(apiMock.getOffMoveAlarm).not.toHaveBeenCalled();
  expect(apiMock.dismissOffMoveAlarm).not.toHaveBeenCalled();
  expect(soundMock.stop).toHaveBeenCalled();
});

it('not_mounted_on_label_station_or_web', async () => {
  apiMock.getOffMoveAlarm.mockResolvedValue(state([row(1)]));
  const shell = () => render(<MemoryRouter><KioskShell><p>body</p></KioskShell></MemoryRouter>);

  // Web mode, RFID setup: nothing.
  shell();
  await flush();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  cleanup();

  window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
  writeKioskSetup({ ...SETUP, stationType: 'label' });
  shell();
  await flush();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  cleanup();
  expect(apiMock.getOffMoveAlarm).not.toHaveBeenCalled();

  // Laptop RFID Station, signed in: the takeover covers the shell.
  writeKioskSetup(SETUP);
  shell();
  await flush();
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  cleanup();

  // Signed out: no polling (every alarm route needs an edge session).
  apiMock.getOffMoveAlarm.mockClear();
  auth.status = 'anon';
  try {
    shell();
    await flush();
    expect(apiMock.getOffMoveAlarm).not.toHaveBeenCalled();
  } finally {
    auth.status = 'authed';
  }
});
