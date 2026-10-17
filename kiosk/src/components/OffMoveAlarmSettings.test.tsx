// @vitest-environment jsdom
/** The Sound tab's "Off-move alarm" section: the mode, the timed seconds,
 *  and a Test alarm preview — shown only on a signed-in laptop RFID
 *  Station. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  getAlarmSettings: vi.fn(),
  saveAlarmSettings: vi.fn(),
  getOffMoveAlarm: vi.fn(),
  dismissOffMoveAlarm: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...apiMock };
});

const soundMock = vi.hoisted(() => ({ stop: vi.fn(), startSiren: vi.fn() }));
vi.mock('../lib/sound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sound')>();
  return { ...actual, startSiren: soundMock.startSiren, soundBlocked: () => false };
});

const auth = vi.hoisted(() => ({ status: 'authed' as 'authed' | 'anon' }));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));

import { writeKioskSetup } from '../lib/kioskSetup';
import OffMoveAlarmSettings from './OffMoveAlarmSettings';

const SETUP = {
  initiativeId: 'i-1', initiativeName: 'Initech ORD1 to AUS1', siteId: 's-1', siteName: 'ORD1',
  siteRole: 'source' as const, scanStatus: 'k', scanLabel: 'Dock', stationType: 'rfid' as const,
};

async function flush() {
  await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve(); });
}

function laptop() {
  window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
}

function seconds() {
  return screen.getByLabelText('Alarm seconds') as HTMLInputElement;
}

function radio(name: string) {
  return screen.getByRole('radio', { name });
}

beforeEach(() => {
  auth.status = 'authed';
  laptop();
  writeKioskSetup(SETUP);
  apiMock.getAlarmSettings.mockResolvedValue({ mode: 'until_dismissed', timed_seconds: 10 });
  apiMock.saveAlarmSettings.mockImplementation(async (s) => s);
  soundMock.startSiren.mockImplementation(() => soundMock.stop);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
  delete window.__KIOSK_CONFIG__;
});

it('section_hidden_off_rfid_station', async () => {
  // Web kiosk.
  delete window.__KIOSK_CONFIG__;
  render(<OffMoveAlarmSettings />);
  await flush();
  expect(screen.queryByText('Off-move alarm')).toBeNull();
  cleanup();

  // Laptop, Label Station.
  laptop();
  writeKioskSetup({ ...SETUP, stationType: 'label' });
  render(<OffMoveAlarmSettings />);
  await flush();
  expect(screen.queryByText('Off-move alarm')).toBeNull();
  cleanup();

  // Laptop RFID Station, signed out.
  writeKioskSetup(SETUP);
  auth.status = 'anon';
  render(<OffMoveAlarmSettings />);
  await flush();
  expect(screen.queryByText('Off-move alarm')).toBeNull();
  expect(apiMock.getAlarmSettings).not.toHaveBeenCalled();
  cleanup();

  // Signed in: shown.
  auth.status = 'authed';
  render(<OffMoveAlarmSettings />);
  await flush();
  expect(screen.getByText('Off-move alarm')).toBeTruthy();
});

it('loads_and_shows_defaults', async () => {
  render(<OffMoveAlarmSettings />);
  await flush();
  expect(apiMock.getAlarmSettings).toHaveBeenCalledTimes(1);
  expect(radio('Until dismissed').getAttribute('aria-checked')).toBe('true');
  expect(radio('Timed').getAttribute('aria-checked')).toBe('false');
  expect(seconds().value).toBe('10');
  expect(seconds().disabled).toBe(true);
  expect(screen.getByText('3–600 seconds')).toBeTruthy();
  expect(screen.getByText("Plays at the volume set above and the laptop's own volume.")).toBeTruthy();
});

it('switching_to_timed_saves_and_enables_seconds', async () => {
  apiMock.getAlarmSettings.mockResolvedValue({ mode: 'until_dismissed', timed_seconds: 25 });
  render(<OffMoveAlarmSettings />);
  await flush();

  fireEvent.click(radio('Timed'));
  await flush();
  expect(apiMock.saveAlarmSettings).toHaveBeenCalledWith({ mode: 'timed', timed_seconds: 25 });
  expect(radio('Timed').getAttribute('aria-checked')).toBe('true');
  expect(seconds().disabled).toBe(false);

  // A valid seconds value saves on blur.
  fireEvent.change(seconds(), { target: { value: '45' } });
  fireEvent.blur(seconds());
  await flush();
  expect(apiMock.saveAlarmSettings).toHaveBeenLastCalledWith({ mode: 'timed', timed_seconds: 45 });

  // ...and on Enter.
  fireEvent.change(seconds(), { target: { value: '600' } });
  fireEvent.keyDown(seconds(), { key: 'Enter' });
  await flush();
  expect(apiMock.saveAlarmSettings).toHaveBeenLastCalledWith({ mode: 'timed', timed_seconds: 600 });
  expect(apiMock.saveAlarmSettings).toHaveBeenCalledTimes(3);
});

it('seconds_outside_3_to_600_are_refused_with_a_hint', async () => {
  apiMock.getAlarmSettings.mockResolvedValue({ mode: 'timed', timed_seconds: 10 });
  render(<OffMoveAlarmSettings />);
  await flush();
  expect(seconds().disabled).toBe(false);

  for (const bad of ['2', '601', '', '5.5', 'abc']) {
    fireEvent.change(seconds(), { target: { value: bad } });
    fireEvent.blur(seconds());
    await flush();
    expect(apiMock.saveAlarmSettings).not.toHaveBeenCalled();
    expect(seconds().getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText('3–600 seconds').className).toContain('form-error');
  }

  fireEvent.change(seconds(), { target: { value: '3' } });
  fireEvent.blur(seconds());
  await flush();
  expect(apiMock.saveAlarmSettings).toHaveBeenCalledWith({ mode: 'timed', timed_seconds: 3 });
  expect(seconds().getAttribute('aria-invalid')).toBeNull();
  expect(screen.getByText('3–600 seconds').className).not.toContain('form-error');
});

it('test_alarm_shows_preview_with_sample_row_and_writes_nothing', async () => {
  apiMock.getAlarmSettings.mockResolvedValue({ mode: 'until_dismissed', timed_seconds: 10 });
  render(<OffMoveAlarmSettings />);
  await flush();

  fireEvent.click(screen.getByRole('button', { name: 'Test alarm' }));
  await flush();
  const dialog = screen.getByRole('alertdialog', { name: /Asset Not Part Of Move/ });
  const cells = within(dialog).getAllByRole('cell').map((c) => c.textContent);
  expect(cells).toEqual(['Dell PowerEdge R740', 'sample-server', 'SAMPLE123', '100000']);
  expect(soundMock.startSiren).toHaveBeenCalledTimes(1);

  // Space dismisses the preview.
  fireEvent.keyDown(window, { key: ' ', code: 'Space' });
  await flush();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(soundMock.stop).toHaveBeenCalled();
  expect(apiMock.dismissOffMoveAlarm).not.toHaveBeenCalled();
  expect(apiMock.getOffMoveAlarm).not.toHaveBeenCalled();
  expect(apiMock.saveAlarmSettings).not.toHaveBeenCalled();

  // It can be opened again, and uses the current timed seconds.
  fireEvent.click(radio('Timed'));
  await flush();
  apiMock.saveAlarmSettings.mockClear();
  fireEvent.click(screen.getByRole('button', { name: 'Test alarm' }));
  await flush();
  expect(within(screen.getByRole('alertdialog')).getByRole('button', { name: /Dismiss \(10s\)/ }))
    .toBeTruthy();
  fireEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: /Dismiss/ }));
  await flush();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(apiMock.dismissOffMoveAlarm).not.toHaveBeenCalled();
  expect(apiMock.saveAlarmSettings).not.toHaveBeenCalled();
});

it('save_failure_keeps_previous_value_and_shows_error', async () => {
  apiMock.getAlarmSettings.mockResolvedValue({ mode: 'until_dismissed', timed_seconds: 10 });
  apiMock.saveAlarmSettings.mockRejectedValueOnce(new Error('offline'));
  render(<OffMoveAlarmSettings />);
  await flush();

  fireEvent.click(radio('Timed'));
  await flush();
  expect(radio('Until dismissed').getAttribute('aria-checked')).toBe('true');
  expect(seconds().disabled).toBe(true);
  expect(screen.getByRole('alert').textContent).toMatch(/Couldn't save/);

  // Seconds failure reverts the box to the last saved value.
  fireEvent.click(radio('Timed'));
  await flush();
  expect(screen.queryByRole('alert')).toBeNull();
  apiMock.saveAlarmSettings.mockRejectedValueOnce(new Error('offline'));
  fireEvent.change(seconds(), { target: { value: '30' } });
  fireEvent.blur(seconds());
  await flush();
  expect(seconds().value).toBe('10');
  expect(screen.getByRole('alert').textContent).toMatch(/Couldn't save/);
});
