// @vitest-environment jsdom
/** Settings › Devices › RFID reader card: pill states (busy is never
 *  Offline), the details list (missing values hide their rows), Check
 *  reader, web mode, and the 5 s / 30 s polls. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getReaderStatus: vi.fn(), getReaderDevice: vi.fn(), runCheck: vi.fn(),
}));
vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, ...api };
});

import type { ReaderDevice, ReaderStatus } from '../../lib/api';
import { clearKioskSetup, writeKioskSetup } from '../../lib/kioskSetup';
import ReaderCard from './ReaderCard';

const NOW = new Date('2026-10-17T15:00:00Z');
const READER = { ip: '10.10.48.119', serial: '22131010562035', model: 'FX9600', endpoint_url: null };
const SETUP = {
  initiativeId: 'i', initiativeName: 'Move', siteId: 's', siteName: 'Site', siteRole: 'source' as const,
  scanStatus: 'x', scanLabel: 'X', stationType: 'rfid' as const,
};

const status = (over: Partial<ReaderStatus> = {}): ReaderStatus => ({
  reader: READER, reachable: true, reading: true, radio: 'on', antennas: ['1', '2'], ...over,
});
const device = (over: Partial<ReaderDevice> = {}): ReaderDevice => ({
  reader: { serial: READER.serial, model: 'FX9600', ip: READER.ip, paired_at: '2026-10-17T13:00:00Z' },
  snapshot: {
    serial: READER.serial, make: 'Zebra', model: 'FX9600', firmware: '3.21.18',
    uptime_seconds: 6 * 86400 + 100, antennas_connected: 2, antennas_total: 4,
    reading: true, tags_24h: 1284, reachable: true, taken_at: '2026-10-17T14:59:00Z',
  },
  last_read_at: '2026-10-17T14:55:00Z',
  ...over,
});

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function renderCard() {
  const view = render(
    <MemoryRouter initialEntries={['/settings']}>
      <Routes>
        <Route path="/settings" element={<ReaderCard />} />
        <Route path="/rfid_status" element={<p>DASHBOARD</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await flush();
  return view;
}

const pill = () => document.querySelector('.device-card-head .chip') as HTMLElement | null;
const dd = (label: string) => {
  const dt = [...document.querySelectorAll('dt')].find((d) => d.textContent === label);
  return dt ? (dt.nextElementSibling as HTMLElement) : null;
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(NOW);
  localStorage.clear();
  writeKioskSetup(SETUP);
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  api.getReaderStatus.mockReset().mockResolvedValue(status());
  api.getReaderDevice.mockReset().mockResolvedValue(device());
  api.runCheck.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.__KIOSK_CONFIG__;
  clearKioskSetup();
});

describe('ReaderCard', () => {
  it('reader_card_shows_details_and_reading_pill', async () => {
    await renderCard();
    expect(pill()?.textContent).toBe('Reading');
    expect(pill()?.className).toContain('c-green');
    expect(dd('Model')?.textContent).toBe('Zebra FX9600');
    expect(dd('Serial')?.textContent).toBe('22131010562035');
    expect(dd('Address')?.textContent).toBe('10.10.48.119');
    expect(dd('Firmware')?.textContent).toBe('3.21.18');
    expect(dd('Antennas')?.textContent).toBe('2 of 4 connected (1, 2)');
    expect(dd('Last tag read')?.textContent).toBe('5 minutes ago');
    expect(dd('Last tag read')?.getAttribute('title')).toBe(new Date('2026-10-17T14:55:00Z').toLocaleString());
    expect(dd('Tags, last 24 h')?.textContent).toBe('1,284');
    expect(dd('Up for')?.textContent).toBe('6 days');
    expect(dd('Paired')?.textContent).toBe('2 hours ago');
    expect(dd('Paired')?.getAttribute('title')).toBe(new Date('2026-10-17T13:00:00Z').toLocaleString());
    expect(screen.getByRole('button', { name: 'Open RFID dashboard' })).toBeTruthy();
  });

  it('shows Standby when reachable but not reading', async () => {
    api.getReaderStatus.mockResolvedValue(status({ reading: false }));
    await renderCard();
    expect(pill()?.textContent).toBe('Standby');
    expect(pill()?.className).toContain('c-slate');
  });

  it('busy_status_shows_checking_not_offline', async () => {
    api.getReaderStatus.mockResolvedValue({ reader: READER, busy: true });
    await renderCard();
    expect(pill()?.textContent).toBe('Checking…');
    expect(pill()?.className).toContain('c-slate');
    expect(screen.queryByText('Offline')).toBeNull();
    // Busy after a good answer still reads Checking…, never Offline.
    api.getReaderStatus.mockResolvedValue(status());
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(pill()?.textContent).toBe('Reading');
    api.getReaderStatus.mockResolvedValue({ reader: READER, busy: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(pill()?.textContent).toBe('Checking…');
    expect(dd('Serial')?.textContent).toBe('22131010562035');
  });

  it('unreachable_shows_offline', async () => {
    api.getReaderStatus.mockResolvedValue(status({ reachable: false, reading: false }));
    await renderCard();
    expect(pill()?.textContent).toBe('Offline');
    expect(pill()?.className).toContain('c-red');
  });

  it('a failed status call shows Offline', async () => {
    api.getReaderStatus.mockRejectedValue(new Error('down'));
    await renderCard();
    expect(pill()?.textContent).toBe('Offline');
  });

  it('not_paired_shows_not_paired_and_no_check_button', async () => {
    api.getReaderStatus.mockResolvedValue({ reader: null });
    api.getReaderDevice.mockResolvedValue({ reader: null });
    await renderCard();
    expect(pill()?.textContent).toBe('Not paired');
    expect(pill()?.className).toContain('c-slate');
    expect(screen.queryByRole('button', { name: 'Check reader' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Open RFID dashboard' })).toBeNull();
    expect(dd('Serial')).toBeNull();
  });

  it('missing_values_hide_their_rows', async () => {
    api.getReaderStatus.mockResolvedValue(status({ antennas: [] }));
    api.getReaderDevice.mockResolvedValue(device({ snapshot: null, last_read_at: null }));
    await renderCard();
    for (const label of ['Firmware', 'Antennas', 'Last tag read', 'Tags, last 24 h', 'Up for']) {
      expect(dd(label)).toBeNull();
    }
    expect(dd('Model')?.textContent).toBe('FX9600');
    expect(dd('Serial')?.textContent).toBe('22131010562035');
    expect(dd('Paired')?.textContent).toBe('2 hours ago');
    expect(document.body.textContent).not.toMatch(/undefined|null|NaN/);
  });

  it('a snapshot with some keys absent hides only those rows', async () => {
    api.getReaderDevice.mockResolvedValue(device({
      snapshot: { serial: READER.serial, antennas_total: 4, taken_at: '2026-10-17T14:59:00Z' },
    }));
    await renderCard();
    expect(dd('Firmware')).toBeNull();
    expect(dd('Up for')).toBeNull();
    expect(dd('Tags, last 24 h')).toBeNull();
    expect(dd('Antennas')?.textContent).toBe('2 of 4 connected (1, 2)');
    expect(document.body.textContent).not.toMatch(/undefined|null|NaN/);
  });

  it('check_reader_runs_the_check_and_shows_the_result', async () => {
    api.runCheck.mockResolvedValue({ name: 'reader', ok: true, state: 'ok', detail: 'Answered, radio on' });
    await renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Check reader' }));
    await flush();
    expect(api.runCheck).toHaveBeenCalledWith('reader');
    expect(screen.getByRole('status').textContent).toContain('Reader check passed');
    expect(screen.getByRole('status').textContent).toContain('Answered, radio on');

    api.runCheck.mockResolvedValue({ name: 'reader', ok: false, state: 'fail', detail: 'No answer' });
    fireEvent.click(screen.getByRole('button', { name: 'Check reader' }));
    await flush();
    expect(screen.getByRole('status').textContent).toContain('Reader check failed');
    expect(screen.getByRole('status').textContent).toContain('No answer');

    api.runCheck.mockRejectedValue(new Error('boom'));
    fireEvent.click(screen.getByRole('button', { name: 'Check reader' }));
    await flush();
    expect(screen.getByRole('status').textContent).toContain('Couldn’t run the reader check');
  });

  it('Open RFID dashboard goes to /rfid_status, and only on an RFID Station', async () => {
    await renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Open RFID dashboard' }));
    expect(screen.getByText('DASHBOARD')).toBeTruthy();
    cleanup();
    writeKioskSetup({ ...SETUP, stationType: 'label' });
    await renderCard();
    expect(screen.queryByRole('button', { name: 'Open RFID dashboard' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Check reader' })).toBeTruthy();
  });

  it('web_mode_shows_note_and_makes_no_edge_calls', async () => {
    delete window.__KIOSK_CONFIG__;
    await renderCard();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(screen.getByText('RFID readers connect to a laptop RFID Station.')).toBeTruthy();
    expect(pill()).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
    expect(api.getReaderStatus).not.toHaveBeenCalled();
    expect(api.getReaderDevice).not.toHaveBeenCalled();
    expect(api.runCheck).not.toHaveBeenCalled();
  });

  it('polls_status_every_5s_and_device_every_30s_and_stops_on_unmount', async () => {
    const { unmount } = await renderCard();
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
    expect(api.getReaderDevice).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(2);
    expect(api.getReaderDevice).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(25_000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(7);
    expect(api.getReaderDevice).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(7);
    expect(api.getReaderDevice).toHaveBeenCalledTimes(2);
  });

  it('button_rows_use_the_bottom_pinned_actions_slot', async () => {
    await renderCard();
    const actions = document.querySelector('.device-card > .device-card-actions') as HTMLElement;
    expect(actions).toBeTruthy();
    expect(actions.parentElement?.lastElementChild).toBe(actions);
    expect(actions.contains(screen.getByRole('button', { name: 'Check reader' }))).toBe(true);
    expect(actions.contains(screen.getByRole('button', { name: 'Open RFID dashboard' }))).toBe(true);
  });
});
