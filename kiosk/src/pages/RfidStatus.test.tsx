// @vitest-environment jsdom
/** The RFID Reader Dashboard: tiles, status pill, the START/STOP pair,
 *  the System Events feed, and its 5 s poll and 1 s clock. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getReaderStatus: vi.fn(), getRfidEvents: vi.fn(), startReader: vi.fn(), stopReader: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...api };
});

const sync = vi.hoisted(() => ({ value: { phase: 'done', assets: 500 } as Record<string, unknown> }));
vi.mock('../lib/sync', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sync')>();
  return { ...actual, useSyncStatus: () => sync.value };
});

import { ApiError, type ReaderStatus, type RfidEvent } from '../lib/api';
import { writeKioskSetup } from '../lib/kioskSetup';
import RfidStatus, { antennasLabel } from './RfidStatus';

const SETUP = {
  initiativeId: 'init-1', initiativeName: 'NAP11 Hall Migration',
  siteId: 'site-1', siteName: 'ACC4', siteRole: 'source' as const,
  scanStatus: 'cage_exit', scanLabel: 'RFID 1 - Cage Exit', stationType: 'rfid' as const,
};
const READER = { ip: '10.10.48.119', serial: '1234ABCD', model: 'FX9600', endpoint_url: null };

const status = (over: Partial<ReaderStatus> = {}): ReaderStatus => ({
  reader: READER, reachable: true, reading: true, radio: 'on', antennas: ['1', '2', '3', '4'],
  ...over,
});

const EVENTS: RfidEvent[] = [
  { id: 3, at: '2026-10-02T19:03:05Z', kind: 'reader_started', title: 'Reader started', detail: 'FX9600 1234ABCD' },
  { id: 2, at: '2026-10-02T19:02:00Z', kind: 'move_loaded', title: 'Move loaded', detail: 'NAP11 Hall Migration' },
  { id: 1, at: '2026-10-02T19:01:00Z', kind: 'portal_check_in', title: 'Portal check-in successful', detail: 'Portal reachable' },
];

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function renderPage() {
  render(
    <MemoryRouter initialEntries={['/rfid_status']}>
      <Routes>
        <Route path="/rfid_status" element={<RfidStatus />} />
        <Route path="/" element={<p>HOME PAGE</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await flush();
}

const startBtn = () => screen.getByRole('button', { name: 'Start RFID reader' }) as HTMLButtonElement;
const stopBtn = () => screen.getByRole('button', { name: 'Stop RFID reader' }) as HTMLButtonElement;
const tile = (label: string) => screen.getByText(label).closest('.rfid-dash-tile') as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date(2026, 9, 2, 14, 3, 5));
  localStorage.clear();
  writeKioskSetup(SETUP);
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  sync.value = { phase: 'done', assets: 500 };
  api.getReaderStatus.mockReset().mockResolvedValue(status());
  api.getRfidEvents.mockReset().mockResolvedValue({ events: EVENTS });
  api.startReader.mockReset().mockResolvedValue({ reading: true });
  api.stopReader.mockReset().mockResolvedValue({ reading: false });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.__KIOSK_CONFIG__;
});

describe('RfidStatus', () => {
  it('renders the title and the six tile labels', async () => {
    await renderPage();
    expect(screen.getByRole('heading', { name: 'RFID Reader Dashboard' })).toBeTruthy();
    expect(screen.getByText('Live asset reads and reader activity.')).toBeTruthy();
    for (const label of ['Tags read today', 'Move progress', 'Local time', 'Active move',
      'Scan type', 'Reader status']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it('fills the move, scan type and reader tiles', async () => {
    await renderPage();
    expect(within(tile('Active move')).getByText('NAP11 Hall Migration')).toBeTruthy();
    expect(within(tile('Active move')).getByText('ACC4 (source)')).toBeTruthy();
    expect(within(tile('Scan type')).getByText('RFID 1 - Cage Exit')).toBeTruthy();
    expect(within(tile('Scan type')).getByText('Station: RFID · Laptop')).toBeTruthy();
    expect(within(tile('Reader status')).getByText('FX9600 · Antennas 1 – 4')).toBeTruthy();
    expect(within(tile('Tags read today')).getByText('Waiting for tag data')).toBeTruthy();
  });

  it('MOVE PROGRESS shows — / 500 from the sync summary', async () => {
    await renderPage();
    expect(within(tile('Move progress')).getByText('— / 500')).toBeTruthy();
  });

  it('MOVE PROGRESS shows a dash when the asset count is unknown', async () => {
    sync.value = { phase: 'idle' };
    await renderPage();
    expect(within(tile('Move progress')).getByText('— / —')).toBeTruthy();
  });

  it('Reading: green pill, START disabled with Already reading, STOP enabled', async () => {
    await renderPage();
    expect(screen.getByTestId('rfid-dash-pill').textContent).toBe('Reading');
    expect(within(tile('Reader status')).getByText('Reading')).toBeTruthy();
    expect(startBtn().disabled).toBe(true);
    expect(startBtn().textContent).toContain('Already reading');
    expect(stopBtn().disabled).toBe(false);
    expect(stopBtn().textContent).toContain('Stop RFID reader');
  });

  it('Stopped: gray pill, START enabled, STOP stays enabled so a stuck reader can be stopped', async () => {
    api.getReaderStatus.mockResolvedValue(status({ reading: false }));
    await renderPage();
    expect(screen.getByTestId('rfid-dash-pill').textContent).toBe('Stopped');
    expect(within(tile('Reader status')).getByText('Stopped')).toBeTruthy();
    expect(startBtn().disabled).toBe(false);
    expect(startBtn().textContent).toContain('Start RFID reader');
    expect(stopBtn().disabled).toBe(false);
    expect(stopBtn().textContent).toContain('Send stop to the reader');
    expect(stopBtn().textContent).not.toContain('Already stopped');
  });

  it('Unreachable: red pill, START disabled, STOP still enabled', async () => {
    api.getReaderStatus.mockResolvedValue(status({ reachable: false, reading: false }));
    await renderPage();
    expect(screen.getByTestId('rfid-dash-pill').textContent).toBe('Unreachable');
    expect(within(tile('Reader status')).getByText('Unreachable')).toBeTruthy();
    expect(startBtn().disabled).toBe(true);
    expect(stopBtn().disabled).toBe(false);
    expect(startBtn().textContent).toContain('Reader unreachable');
    expect(stopBtn().textContent).toContain('Send stop to the reader');
  });

  it('STOP calls stopReader, then re-fetches status and events', async () => {
    await renderPage();
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
    expect(api.getRfidEvents).toHaveBeenCalledTimes(1);
    api.getReaderStatus.mockResolvedValue(status({ reading: false }));
    fireEvent.click(stopBtn());
    await flush();
    expect(api.stopReader).toHaveBeenCalledTimes(1);
    expect(api.getReaderStatus).toHaveBeenCalledTimes(2);
    expect(api.getRfidEvents).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('rfid-dash-pill').textContent).toBe('Stopped');
  });

  it('START calls startReader', async () => {
    api.getReaderStatus.mockResolvedValue(status({ reading: false }));
    await renderPage();
    fireEvent.click(startBtn());
    await flush();
    expect(api.startReader).toHaveBeenCalledTimes(1);
    expect(api.getReaderStatus).toHaveBeenCalledTimes(2);
  });

  it('shows Starting… while the start call runs', async () => {
    api.getReaderStatus.mockResolvedValue(status({ reading: false }));
    api.startReader.mockReturnValue(new Promise(() => {}));
    await renderPage();
    fireEvent.click(startBtn());
    await flush();
    expect(startBtn().textContent).toContain('Starting…');
  });

  it('a start error shows the reader error text in an alert', async () => {
    api.getReaderStatus.mockResolvedValue(status({ reading: false }));
    api.startReader.mockRejectedValue(new ApiError(502, 'reader_unreachable'));
    await renderPage();
    fireEvent.click(startBtn());
    await flush();
    expect(screen.getByRole('alert').textContent).toBe("Can't reach 10.10.48.119.");
  });

  it('events render newest first with titles and details', async () => {
    await renderPage();
    const titles = screen.getAllByTestId('rfid-event-title').map((el) => el.textContent);
    expect(titles).toEqual(['Reader started', 'Move loaded', 'Portal check-in successful']);
    expect(screen.getByText('FX9600 1234ABCD')).toBeTruthy();
    expect(screen.getByText('Portal reachable')).toBeTruthy();
  });

  it('shows the events empty state', async () => {
    api.getRfidEvents.mockResolvedValue({ events: [] });
    await renderPage();
    expect(screen.getByText('No activity yet.')).toBeTruthy();
  });

  it('shows the Live Tag Reads empty state', async () => {
    await renderPage();
    expect(screen.getByText('Live Tag Reads')).toBeTruthy();
    expect(screen.getByText('No tag reads yet — live reads arrive when tag data is connected.'))
      .toBeTruthy();
    expect(screen.getByText('Live view only · Older rows leave this screen.')).toBeTruthy();
  });

  it('the clock advances after 1000 ms', async () => {
    await renderPage();
    expect(within(tile('Local time')).getByText('14:03:05')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(within(tile('Local time')).getByText('14:03:06')).toBeTruthy();
  });

  it('polls status and events again after 5000 ms', async () => {
    await renderPage();
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(2);
    expect(api.getRfidEvents).toHaveBeenCalledTimes(2);
  });

  it('never overlaps polls while the status call hangs', async () => {
    api.getReaderStatus.mockReturnValue(new Promise(() => {}));
    await renderPage();
    await act(async () => { await vi.advanceTimersByTimeAsync(15000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
  });

  it('schedules the next poll 5000 ms after the previous one settles', async () => {
    let release: (s: ReaderStatus) => void = () => {};
    api.getReaderStatus.mockResolvedValueOnce(status())
      .mockReturnValueOnce(new Promise<ReaderStatus>((r) => { release = r; }));
    await renderPage();
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(7000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(2);
    await act(async () => { release(status()); await vi.advanceTimersByTimeAsync(4000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(3);
  });

  it('a stale poll answer does not overwrite a newer post-click refresh', async () => {
    await renderPage();
    let release: (s: ReaderStatus) => void = () => {};
    api.getReaderStatus.mockReturnValueOnce(new Promise<ReaderStatus>((r) => { release = r; }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    api.getReaderStatus.mockResolvedValue(status({ reading: false }));
    fireEvent.click(stopBtn());
    await flush();
    expect(screen.getByTestId('rfid-dash-pill').textContent).toBe('Stopped');
    await act(async () => { release(status({ reading: true })); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.getByTestId('rfid-dash-pill').textContent).toBe('Stopped');
  });

  it('a busy answer keeps the last known state', async () => {
    await renderPage();
    api.getReaderStatus.mockResolvedValue(
      status({ reachable: false, reading: false, radio: null, antennas: [], busy: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(screen.getByTestId('rfid-dash-pill').textContent).toBe('Reading');
  });

  it('a busy answer before any status shows Checking…', async () => {
    api.getReaderStatus.mockResolvedValue(
      status({ reachable: false, reading: false, radio: null, antennas: [], busy: true }));
    await renderPage();
    expect(screen.getByTestId('rfid-dash-pill').textContent).toBe('Checking…');
  });

  it('stops polling on unmount', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/rfid_status']}>
        <Routes><Route path="/rfid_status" element={<RfidStatus />} /></Routes>
      </MemoryRouter>,
    );
    await flush();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
  });

  it('redirects home when no reader is paired', async () => {
    api.getReaderStatus.mockResolvedValue({ reader: null });
    await renderPage();
    expect(screen.getByText('HOME PAGE')).toBeTruthy();
  });

  it('redirects home in web mode', async () => {
    delete window.__KIOSK_CONFIG__;
    await renderPage();
    expect(screen.getByText('HOME PAGE')).toBeTruthy();
    expect(api.getReaderStatus).not.toHaveBeenCalled();
  });
});

describe('antennasLabel', () => {
  it('collapses a contiguous run and lists the rest', () => {
    expect(antennasLabel(['1', '2', '3', '4'])).toBe('Antennas 1 – 4');
    expect(antennasLabel(['1', '3'])).toBe('Antennas 1, 3');
    expect(antennasLabel([])).toBe('No antennas connected');
  });
});
