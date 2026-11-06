// @vitest-environment jsdom
/** The Dock screen: the open pass and its countdown, recent passes and
 *  their outcome copy, the pass-detail modal, the dry-run switch, the
 *  Window, the reader's Start / Pause / Stop and its state, the 1 s
 *  overview poll and the 5 s reader check. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getDock: vi.fn(), getDockPass: vi.fn(), saveDockSettings: vi.fn(), getEdgeSetup: vi.fn(),
  controlDock: vi.fn(), getReaderStatus: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...api };
});
vi.mock('../lib/sync', async (importOriginal) => ({
  ...(await importOriginal<object>()), runSync: vi.fn(() => Promise.resolve()),
}));

import {
  ApiError, type DockControl, type DockControlResult, type DockOverview, type DockPassDetail,
  type DockPassRow, type DockPassTag, type EdgeSetup, type ReaderStatus,
} from '../lib/api';
import { writeKioskSetup } from '../lib/kioskSetup';
import { hydrateLaptopSetup } from '../lib/laptopSetup';
import DockStation from './DockStation';

const SETUP = {
  initiativeId: 'init-1', initiativeName: 'NAP11 Hall Migration',
  siteId: 'site-1', siteName: 'ACC4', siteRole: 'source' as const,
  scanStatus: 'dock_out', scanLabel: 'RFID 2 - Dock Out', stationType: 'dock' as const,
};

/** The same Dock setup as the laptop's edge serves it to a new browser. */
const EDGE_DOCK: EdgeSetup = {
  initiative_id: 'init-1', initiative_name: 'NAP11 Hall Migration', site_id: 'site-1',
  site_name: 'ACC4', site_role: 'source', scan_status: 'dock_out',
  scan_status_label: 'RFID 2 - Dock Out', station_type: 'dock', reader: null,
  updated_at: '2026-11-05T13:00:00+00:00',
};

/** A local wall-clock time on the test day, as the edge's UTC ISO. */
const at = (h: number, m: number, s: number) => new Date(2026, 10, 5, h, m, s).toISOString();

const passRow = (over: Partial<DockPassRow> = {}): DockPassRow => ({
  id: 1, opened_at: at(14, 3, 22), closed_at: at(14, 3, 30), status: 'packed', flag: null,
  dry_run: false, container_name: 'Crate A', asset_count: 3, moved_count: 0, refused_count: 0,
  refuse_code: null, ...over,
});

const overview = (over: Partial<DockOverview> = {}): DockOverview => ({
  settings: { dry_run: true, quiet_gap_s: 5 }, open: null, passes: [], control: null, ...over,
});

const READER = { ip: '10.10.48.119', serial: '1234ABCD', model: 'FX9600', endpoint_url: null };
/** A reachable reader, not reading unless told. */
const readerStatus = (over: Partial<ReaderStatus> = {}): ReaderStatus => ({
  reader: READER, reachable: true, reading: false, radio: 'on', antennas: ['1', '2'], ...over,
});

const passTag = (over: Partial<DockPassTag>): DockPassTag => ({
  epc: '000000000000000000001001', kind: 'asset', label: 'host-a', result: null,
  moved_from: null, reason: null, ...over,
});

const detail = (over: Partial<DockPassDetail> = {}): DockPassDetail => ({
  pass: passRow({ id: 7, status: 'packed', moved_count: 1 }),
  tags: [
    passTag({ epc: '0000000000000000000000C1', kind: 'container', label: 'Crate A' }),
    passTag({ epc: '000000000000000000001001', label: 'host-a', result: 'moved', moved_from: 'Crate B' }),
    passTag({ epc: '000000000000000000001002', label: 'host-b', result: 'packed' }),
  ],
  reads: [
    { id: 41, read_at: at(14, 3, 22), epc: '000000000000000000001001', kind: 'asset', antenna: 2, peak_rssi: -52 },
    { id: 42, read_at: at(14, 3, 23), epc: '0000000000000000000000C1', kind: 'container', antenna: 1, peak_rssi: -61 },
    { id: 43, read_at: at(14, 3, 24), epc: '00000000000000000000BEEF', kind: 'unknown', antenna: null, peak_rssi: null },
  ],
  ...over,
});

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function renderPage() {
  render(
    <MemoryRouter initialEntries={['/dock']}>
      <Routes>
        <Route path="/dock" element={<DockStation />} />
        <Route path="/" element={<p>HOME PAGE</p>} />
      </Routes>
    </MemoryRouter>,
  );
  await flush();
}

const dryRun = () => screen.getByRole('switch', { name: 'Dry run' });
const windowInput = () => screen.getByLabelText('Window') as HTMLInputElement;
const saveBtn = () => screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement;
const readerGroup = () => screen.getByRole('group', { name: 'Reader' });
const readerShown = () => readerGroup().querySelector('.rfid-dash-state') as HTMLElement;
const readerBtn = (name: 'Start' | 'Pause' | 'Stop') =>
  within(readerGroup()).getByRole('button', { name }) as HTMLButtonElement;
/** Whether Start, Pause and Stop are enabled. */
const enabled = () => (['Start', 'Pause', 'Stop'] as const).map((n) => !readerBtn(n).disabled);
const BANNER = 'Dry run · nothing is sent to the portal.';
const UNREACHABLE = "Can't reach the station. Retrying…";
/** The Recent passes row whose Crate cell (or other cell) holds `text`. */
const rowOf = (text: string) => screen.getByText(text).closest('tr') as HTMLElement;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date(2026, 10, 5, 14, 5, 0));
  localStorage.clear();
  writeKioskSetup(SETUP);
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  api.getDock.mockReset().mockResolvedValue(overview());
  api.getDockPass.mockReset().mockResolvedValue(detail());
  api.saveDockSettings.mockReset().mockImplementation(
    async (s: object) => ({ dry_run: true, quiet_gap_s: 5, ...s }));
  api.getEdgeSetup.mockReset().mockResolvedValue(null);
  api.getReaderStatus.mockReset().mockResolvedValue(readerStatus());
  api.controlDock.mockReset().mockImplementation(
    async (action: DockControl): Promise<DockControlResult> =>
      ({ reading: action === 'start', control: action, decided: 0 }));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.__KIOSK_CONFIG__;
});

describe('DockStation', () => {
  it('goes home in web mode', async () => {
    delete window.__KIOSK_CONFIG__;
    await renderPage();
    expect(screen.getByText('HOME PAGE')).toBeTruthy();
    expect(api.getDock).not.toHaveBeenCalled();
  });

  it('goes home on a setup that is not a Dock', async () => {
    writeKioskSetup({ ...SETUP, stationType: 'rfid' });
    await renderPage();
    expect(screen.getByText('HOME PAGE')).toBeTruthy();
    expect(api.getDock).not.toHaveBeenCalled();
  });

  /** A new browser with no setup: KioskShell's look for the laptop's is
   *  running, waiting on the edge. Answer it with the returned function. */
  function lookingForLaptopSetup() {
    let answer!: (setup: EdgeSetup | null) => void;
    api.getEdgeSetup.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const looked = hydrateLaptopSetup();
    return async (setup: EdgeSetup | null) => {
      await act(async () => {
        answer(setup);
        await looked;
      });
    };
  }

  it("waits for the laptop's setup on a new browser, then shows the Dock", async () => {
    localStorage.clear();
    const answer = lookingForLaptopSetup();
    await renderPage();
    expect(screen.queryByText('HOME PAGE')).toBeNull();
    expect(api.getDock).not.toHaveBeenCalled();
    await answer(EDGE_DOCK);
    await flush();
    expect(screen.queryByText('HOME PAGE')).toBeNull();
    expect(dryRun()).toBeTruthy();
    expect(api.getDock).toHaveBeenCalled();
  });

  it('goes home once the laptop turns out to have no setup', async () => {
    localStorage.clear();
    const answer = lookingForLaptopSetup();
    await renderPage();
    expect(screen.queryByText('HOME PAGE')).toBeNull();
    await answer(null);
    expect(screen.getByText('HOME PAGE')).toBeTruthy();
    expect(api.getDock).not.toHaveBeenCalled();
  });

  it('the open pass counts down in whole seconds and lists its tags', async () => {
    api.getDock.mockResolvedValue(overview({
      open: {
        id: 9, opened_at: at(14, 4, 58), seconds_left: 2.4, crate_count: 1, asset_count: 1,
        tags: [
          { epc: '0000000000000000000000C1', kind: 'container', label: 'Crate A' },
          { epc: '000000000000000000001001', kind: 'asset', label: 'host-a' },
          { epc: '00000000000000000000BEEF', kind: 'unknown', label: null },
        ],
      },
    }));
    await renderPage();
    const panel = screen.getByRole('region', { name: 'Open pass' });
    expect(within(panel).getByText('Closes in 3 s')).toBeTruthy();
    expect(within(panel).getByText('Crate A')).toBeTruthy();
    expect(within(panel).getByText('host-a')).toBeTruthy();
    expect(within(panel).getByText('Unknown tag')).toBeTruthy();
    expect(within(panel).getByText('BEEF')).toBeTruthy();
    expect(within(panel).getByText('1 crate · 1 asset')).toBeTruthy();
    expect(within(panel).queryByText('Waiting for tags…')).toBeNull();
  });

  it('the open pass lists crates first, then the other tags newest first', async () => {
    api.getDock.mockResolvedValue(overview({
      open: {
        id: 9, opened_at: at(14, 4, 58), seconds_left: 3, crate_count: 1, asset_count: 2,
        tags: [
          { epc: '000000000000000000001001', kind: 'asset', label: 'host-a' },
          { epc: '0000000000000000000000C1', kind: 'container', label: 'Crate A' },
          { epc: '00000000000000000000BEEF', kind: 'unknown', label: null },
          { epc: '000000000000000000001002', kind: 'asset', label: 'host-b' },
        ],
      },
    }));
    await renderPage();
    const panel = screen.getByRole('region', { name: 'Open pass' });
    const labels = [...panel.querySelectorAll('.dock-dash-tag-label')].map((el) => el.textContent);
    expect(labels).toEqual(['Crate A', 'host-b', 'Unknown tag', 'host-a']);
  });

  it('an open pass at zero seconds says Closing…', async () => {
    api.getDock.mockResolvedValue(overview({
      open: { id: 9, opened_at: at(14, 4, 58), seconds_left: 0, crate_count: 0, asset_count: 2, tags: [] },
    }));
    await renderPage();
    expect(screen.getByText('Closing…')).toBeTruthy();
    expect(screen.getByText('0 crates · 2 assets')).toBeTruthy();
  });

  it('no open pass says Waiting for tags…', async () => {
    await renderPage();
    const panel = screen.getByRole('region', { name: 'Open pass' });
    expect(within(panel).getByText('Waiting for tags…')).toBeTruthy();
  });

  it('each recent pass reads its outcome; flagged and refused rows stand out', async () => {
    const rows: [Partial<DockPassRow>, string, boolean][] = [
      [{ status: 'would_pack', container_name: 'Crate W', asset_count: 4, dry_run: true }, 'Would pack 4 into Crate W', false],
      [{ status: 'waiting' }, 'Waiting to send', false],
      [{ status: 'packed' }, 'Packed', false],
      [{ status: 'packed', refused_count: 2 }, 'Packed · 2 not packed', false],
      [{ status: 'refused', refuse_code: 'container_not_found' }, 'Not packed: crate not found in the portal', true],
      [{ status: 'refused', refuse_code: 'move_locked' }, 'Not packed: crate is on another move', true],
      [{ status: 'refused', refuse_code: 'move_inactive' }, 'Not packed: the move is closed', true],
      [{ status: 'refused', refuse_code: 'http_400' }, 'Not packed: http_400', true],
      [{ status: 'flagged', flag: 'no_crate', container_name: null }, 'Flagged: No crate read', true],
      [{ status: 'flagged', flag: 'many_crates', container_name: null }, 'Flagged: More than one crate', true],
      [{ status: 'nothing', container_name: null, asset_count: 0 }, 'Nothing to pack', false],
    ];
    api.getDock.mockResolvedValue(overview({
      passes: rows.map(([over], i) => passRow({ id: 100 - i, ...over })),
    }));
    await renderPage();
    const panel = screen.getByRole('region', { name: 'Recent passes' });
    const shown = within(panel).getAllByRole('row').slice(1);   // past the header
    expect(shown).toHaveLength(rows.length);
    rows.forEach(([, text, flagged], i) => {
      expect(shown[i].querySelector('.dock-dash-outcome')?.textContent).toBe(text);
      expect(shown[i].classList.contains('is-flagged')).toBe(flagged);
    });
  });

  it('the time cell is the local 24-hour HH:MM:SS', async () => {
    api.getDock.mockResolvedValue(overview({ passes: [passRow({ opened_at: at(14, 3, 22) })] }));
    await renderPage();
    const row = rowOf('Crate A');
    expect(within(row).getByText('14:03:22')).toBeTruthy();
    expect(row.textContent).not.toMatch(/AM|PM/);
  });

  it('Dry run: the banner shows while on, and the switch saves the change', async () => {
    api.getDock.mockResolvedValueOnce(overview())
      .mockResolvedValue(overview({ settings: { dry_run: false, quiet_gap_s: 5 } }));
    await renderPage();
    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(dryRun().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(dryRun());
    await flush();
    expect(api.saveDockSettings).toHaveBeenCalledWith({ dry_run: false });
    expect(screen.queryByText(BANNER)).toBeNull();
    expect(dryRun().getAttribute('aria-checked')).toBe('false');
  });

  it('a poll that began before a save never puts the old setting back', async () => {
    let release: (o: DockOverview) => void = () => {};
    api.getDock.mockResolvedValueOnce(overview())
      .mockReturnValueOnce(new Promise<DockOverview>((r) => { release = r; }))
      .mockResolvedValue(overview({ settings: { dry_run: false, quiet_gap_s: 5 } }));
    await renderPage();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });   // second poll, in flight
    expect(api.getDock).toHaveBeenCalledTimes(2);
    fireEvent.click(dryRun());
    await flush();
    expect(screen.queryByText(BANNER)).toBeNull();
    await act(async () => { release(overview()); await vi.advanceTimersByTimeAsync(0); });
    expect(screen.queryByText(BANNER)).toBeNull();
    expect(dryRun().getAttribute('aria-checked')).toBe('false');
  });

  it('a failed dry-run save keeps the switch where it was and says so', async () => {
    api.saveDockSettings.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    fireEvent.click(dryRun());
    await flush();
    expect(api.saveDockSettings).toHaveBeenCalledWith({ dry_run: false });
    expect(dryRun().getAttribute('aria-checked')).toBe('true');
    expect(screen.getByText(BANNER)).toBeTruthy();
    expect(screen.getByText("Couldn't save. Try again.")).toBeTruthy();
  });

  it('no banner while dry run is off', async () => {
    api.getDock.mockResolvedValue(overview({ settings: { dry_run: false, quiet_gap_s: 5 } }));
    await renderPage();
    expect(screen.queryByText(BANNER)).toBeNull();
  });

  it('Window: Save is enabled once the value differs and saves it', async () => {
    await renderPage();
    expect(windowInput().value).toBe('5');
    expect(saveBtn().disabled).toBe(true);
    fireEvent.change(windowInput(), { target: { value: '8' } });
    expect(saveBtn().disabled).toBe(false);
    fireEvent.click(saveBtn());
    await flush();
    expect(api.saveDockSettings).toHaveBeenCalledWith({ quiet_gap_s: 8 });
    expect(windowInput().value).toBe('8');
    expect(saveBtn().disabled).toBe(true);
  });

  it('Window: an out-of-range value shows the hint as an error and saves nothing', async () => {
    await renderPage();
    fireEvent.change(windowInput(), { target: { value: '0' } });
    fireEvent.click(saveBtn());
    await flush();
    expect(api.saveDockSettings).not.toHaveBeenCalled();
    expect(screen.getByText('1–60 seconds').classList.contains('form-error')).toBe(true);
    expect(windowInput().getAttribute('aria-invalid')).toBe('true');
  });

  it('Window: the label, the hint, and 1–60 seconds as the error', async () => {
    await renderPage();
    const hint = () => document.getElementById(windowInput().getAttribute('aria-describedby') ?? '');
    expect(windowInput().id).toBe('dock-window');
    expect(hint()?.textContent).toBe('Seconds before and after the crate tag');
    expect(hint()?.classList.contains('form-error')).toBe(false);
    expect(windowInput().getAttribute('aria-invalid')).toBeNull();
    fireEvent.change(windowInput(), { target: { value: '61' } });
    fireEvent.click(saveBtn());
    await flush();
    expect(hint()?.textContent).toBe('1–60 seconds');
    expect(hint()?.classList.contains('form-error')).toBe(true);
    expect(screen.queryByText('Seconds before and after the crate tag')).toBeNull();
    expect(windowInput().getAttribute('aria-invalid')).toBe('true');
    // typing again puts the hint back
    fireEvent.change(windowInput(), { target: { value: '6' } });
    expect(hint()?.textContent).toBe('Seconds before and after the crate tag');
    expect(windowInput().getAttribute('aria-invalid')).toBeNull();
  });

  it('a failed save says so', async () => {
    api.saveDockSettings.mockRejectedValue(new ApiError(422, 'invalid_dock_settings'));
    await renderPage();
    fireEvent.change(windowInput(), { target: { value: '8' } });
    fireEvent.click(saveBtn());
    await flush();
    expect(screen.getByText("Couldn't save. Try again.")).toBeTruthy();
  });

  it('shows the reader as Reading, Paused or Stopped', async () => {
    let answer: (s: ReaderStatus) => void = () => {};
    api.getReaderStatus.mockReturnValueOnce(new Promise<ReaderStatus>((r) => { answer = r; }));
    await renderPage();
    expect(readerShown().textContent).toBe('Checking…');
    expect(readerShown().classList.contains('is-loading')).toBe(true);
    await act(async () => { answer(readerStatus({ reading: true })); await vi.advanceTimersByTimeAsync(0); });
    expect(readerShown().textContent).toBe('Reading');
    expect(readerShown().classList.contains('is-reading')).toBe(true);
    cleanup();

    // Not reading: the last Dock button says whether it was paused.
    const cases: [DockControl | null, string, string][] = [
      ['pause', 'Paused', 'is-paused'], ['stop', 'Stopped', 'is-stopped'],
      [null, 'Stopped', 'is-stopped'], ['start', 'Stopped', 'is-stopped'],
    ];
    for (const [control, text, tone] of cases) {
      api.getDock.mockResolvedValue(overview({ control }));
      await renderPage();
      expect(readerShown().textContent).toBe(text);
      expect(readerShown().classList.contains(tone)).toBe(true);
      cleanup();
    }

    api.getReaderStatus.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    expect(readerShown().textContent).toBe('Unreachable');
    expect(readerShown().classList.contains('is-unreachable')).toBe(true);
  });

  it('Start, Pause and Stop send their action and check the reader again', async () => {
    // The edge remembers the last button, as the overview's control.
    let edgeControl: DockControl | null = null;
    api.getDock.mockImplementation(async () => overview({ control: edgeControl }));
    api.controlDock.mockImplementation(async (action: DockControl) => {
      edgeControl = action;
      return { reading: action === 'start', control: action, decided: 0 };
    });
    await renderPage();
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);

    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    fireEvent.click(readerBtn('Start'));
    await flush();
    expect(api.controlDock).toHaveBeenLastCalledWith('start');
    expect(api.getReaderStatus).toHaveBeenCalledTimes(2);
    expect(readerShown().textContent).toBe('Reading');

    api.getReaderStatus.mockResolvedValue(readerStatus());
    fireEvent.click(readerBtn('Pause'));
    await flush();
    expect(api.controlDock).toHaveBeenLastCalledWith('pause');
    expect(api.getReaderStatus).toHaveBeenCalledTimes(3);
    expect(readerShown().textContent).toBe('Paused');

    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(api.controlDock).toHaveBeenLastCalledWith('stop');
    expect(api.getReaderStatus).toHaveBeenCalledTimes(4);
    expect(readerShown().textContent).toBe('Stopped');
    expect(api.controlDock).toHaveBeenCalledTimes(3);
  });

  it('a poll that began before a press never shows the old button', async () => {
    let release: (o: DockOverview) => void = () => {};
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockResolvedValueOnce(overview({ control: 'start' }))
      .mockReturnValueOnce(new Promise<DockOverview>((r) => { release = r; }))
      .mockResolvedValue(overview({ control: 'pause' }));
    await renderPage();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });   // second poll, in flight
    expect(api.getDock).toHaveBeenCalledTimes(2);
    api.getReaderStatus.mockResolvedValue(readerStatus());
    fireEvent.click(readerBtn('Pause'));
    await flush();
    expect(readerShown().textContent).toBe('Paused');
    await act(async () => { release(overview({ control: 'start' })); await vi.advanceTimersByTimeAsync(0); });
    expect(readerShown().textContent).toBe('Paused');
  });

  it('Start and Pause follow the reader; Stop is always enabled', async () => {
    api.getReaderStatus.mockReturnValueOnce(new Promise<ReaderStatus>(() => {}));
    await renderPage();
    expect(readerShown().textContent).toBe('Checking…');
    expect(enabled()).toEqual([false, false, true]);
    cleanup();

    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    await renderPage();
    expect(readerShown().textContent).toBe('Reading');
    expect(enabled()).toEqual([false, true, true]);
    cleanup();

    api.getReaderStatus.mockResolvedValue(readerStatus());
    await renderPage();
    expect(readerShown().textContent).toBe('Stopped');
    expect(enabled()).toEqual([true, false, true]);
    cleanup();

    api.getReaderStatus.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    expect(readerShown().textContent).toBe('Unreachable');
    expect(enabled()).toEqual([false, false, true]);
  });

  it('Stop stays enabled while another call runs', async () => {
    const finish: Partial<Record<DockControl, (r: DockControlResult) => void>> = {};
    api.controlDock.mockImplementation((action: DockControl) =>
      new Promise<DockControlResult>((r) => { finish[action] = r; }));
    await renderPage();
    fireEvent.click(readerBtn('Start'));
    await flush();
    expect(readerShown().textContent).toBe('Starting…');
    expect(readerShown().classList.contains('is-loading')).toBe(true);
    expect(enabled()).toEqual([false, false, true]);

    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(api.controlDock).toHaveBeenLastCalledWith('stop');
    expect(readerShown().textContent).toBe('Stopping…');
    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(api.controlDock).toHaveBeenCalledTimes(2);

    // Start answering first leaves Stop's call showing.
    await act(async () => {
      finish.start?.({ reading: true, control: 'start', decided: 0 });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readerShown().textContent).toBe('Stopping…');
    await act(async () => {
      finish.stop?.({ reading: false, control: 'stop', decided: 1 });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(readerShown().textContent).toBe('Stopped');
    expect(enabled()).toEqual([true, false, true]);

    // Stop works again once its call has settled.
    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(api.controlDock).toHaveBeenCalledTimes(3);
  });

  it('a failed Stop says what went wrong', async () => {
    api.controlDock.mockRejectedValueOnce(new ApiError(502, 'reader_unreachable'))
      .mockRejectedValueOnce(new ApiError(500, 'boom'));
    await renderPage();
    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe("Can't reach 10.10.48.119.");
    expect(screen.getByRole('alert').classList.contains('form-error')).toBe(true);
    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe("Couldn't stop the reader (boom).");
    // shown until the next press
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(screen.getByRole('alert').textContent).toBe("Couldn't stop the reader (boom).");
    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('the reader is checked again 5 s after the previous check settles', async () => {
    let release: (s: ReaderStatus) => void = () => {};
    api.getReaderStatus.mockReturnValueOnce(new Promise<ReaderStatus>((r) => { release = r; }));
    await renderPage();
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
    await act(async () => { release(readerStatus({ reading: true })); await vi.advanceTimersByTimeAsync(4999); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
    // A busy edge didn't ask the reader: what's shown stays.
    api.getReaderStatus.mockResolvedValue(readerStatus({ reachable: false, reading: false, busy: true }));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(2);
    expect(readerShown().textContent).toBe('Reading');
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(3);
  });

  it('Details opens the pass: every read, what packing did, and closes', async () => {
    api.getDock.mockResolvedValue(overview({
      passes: [passRow({ id: 7, status: 'packed', moved_count: 1 })],
    }));
    await renderPage();
    fireEvent.click(within(rowOf('Crate A')).getByRole('button', { name: 'Details' }));
    await flush();
    expect(api.getDockPass).toHaveBeenCalledWith(7);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Dock pass')).toBeTruthy();
    expect(within(dialog).getByText('Pass at 14:03:22')).toBeTruthy();
    expect(within(dialog).getByText('Moved from Crate B')).toBeTruthy();
    const read = within(dialog).getByText('1001').closest('tr') as HTMLElement;
    expect(within(read).getByText('-52 dBm')).toBeTruthy();
    expect(within(read).getByText('Asset host-a')).toBeTruthy();
    expect(within(read).getByText('2')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the pass modal names every match, and Escape closes it', async () => {
    api.getDockPass.mockResolvedValue(detail({
      reads: [
        { id: 1, read_at: at(14, 3, 22), epc: '0000000000000000000000C1', kind: 'container', antenna: 1, peak_rssi: -61 },
        { id: 2, read_at: at(14, 3, 22), epc: '000000000000000000000E01', kind: 'person', antenna: 1, peak_rssi: -70 },
        { id: 3, read_at: at(14, 3, 23), epc: '000000000000000000000F01', kind: 'off_move', antenna: 3, peak_rssi: -66 },
        { id: 4, read_at: at(14, 3, 23), epc: '00000000000000000000BEEF', kind: 'unknown', antenna: null, peak_rssi: null },
      ],
    }));
    api.getDock.mockResolvedValue(overview({ passes: [passRow({ id: 7 })] }));
    await renderPage();
    fireEvent.click(within(rowOf('Crate A')).getByRole('button', { name: 'Details' }));
    await flush();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Crate Crate A')).toBeTruthy();
    expect(within(dialog).getByText('Person')).toBeTruthy();
    expect(within(dialog).getByText('Off-move asset')).toBeTruthy();
    expect(within(dialog).getByText('Unknown')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('the Packing table follows the pass: dry run, waiting, not sent, and raw results', async () => {
    const tags = [
      passTag({ epc: '000000000000000000001001', label: 'host-a', result: 'already_there' }),
      passTag({ epc: '000000000000000000001002', label: 'host-b', result: 'refused', reason: 'changed_since_pass' }),
      passTag({ epc: '000000000000000000001003', label: 'host-c', result: 'refused', reason: 'not_on_move' }),
      passTag({ epc: '000000000000000000001004', label: 'host-d', result: 'refused', reason: 'asset_not_found' }),
      // a result this build doesn't know is shown as the edge sent it
      passTag({ epc: '000000000000000000001005', label: 'host-e', result: 'teleported' as DockPassTag['result'] }),
    ];
    api.getDock.mockResolvedValue(overview({ passes: [passRow({ id: 7 })] }));
    const open = async (status: DockPassRow['status']) => {
      api.getDockPass.mockResolvedValue(detail({ pass: passRow({ id: 7, status }), tags }));
      fireEvent.click(within(rowOf('Crate A')).getByRole('button', { name: 'Details' }));
      await flush();
      const dialog = screen.getByRole('dialog');
      const result = (label: string) =>
        (within(dialog).getByText(label).closest('tr') as HTMLTableRowElement).cells[1].textContent;
      return { dialog, result };
    };
    await renderPage();

    let { dialog, result } = await open('packed');
    expect(result('host-a')).toBe('Already there');
    expect(result('host-b')).toBe('Not packed: Changed since this pass');
    expect(result('host-c')).toBe('Not packed: not on this move');
    expect(result('host-d')).toBe('Not packed: not found in the portal');
    expect(result('host-e')).toBe('teleported');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    ({ dialog, result } = await open('would_pack'));
    expect(result('host-a')).toBe('Would pack');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    ({ dialog, result } = await open('waiting'));
    expect(result('host-a')).toBe('Waiting to send');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    ({ dialog, result } = await open('flagged'));
    expect(result('host-a')).toBe('Not sent');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));

    ({ dialog, result } = await open('refused'));
    expect(result('host-a')).toBe('Not sent');
  });

  it('an open modal follows a waiting pass until it is sent', async () => {
    const tags = [passTag({ epc: '000000000000000000001001', label: 'host-a' })];
    api.getDockPass
      .mockResolvedValueOnce(detail({ pass: passRow({ id: 7, status: 'waiting' }), tags }))
      .mockRejectedValueOnce(new ApiError(0, 'network'))   // a failed refresh keeps what's shown
      .mockResolvedValue(detail({
        pass: passRow({ id: 7, status: 'packed' }),
        tags: [{ ...tags[0], result: 'packed' }],
      }));
    api.getDock.mockResolvedValue(overview({ passes: [passRow({ id: 7, status: 'waiting' })] }));
    await renderPage();
    fireEvent.click(within(rowOf('Crate A')).getByRole('button', { name: 'Details' }));
    await flush();
    const dialog = () => screen.getByRole('dialog');
    const result = () => (within(dialog()).getByText('host-a').closest('tr') as HTMLTableRowElement).cells[1].textContent;
    expect(result()).toBe('Waiting to send');
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.getDockPass).toHaveBeenCalledTimes(2);
    expect(result()).toBe('Waiting to send');
    expect(within(dialog()).queryByText("Couldn't load this pass.")).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.getDockPass).toHaveBeenCalledTimes(3);
    expect(result()).toBe('Packed');
    expect(within(dialog()).getByText('Pass at 14:03:22').parentElement?.textContent).toContain('Packed');
    // sent: no more re-reads
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(api.getDockPass).toHaveBeenCalledTimes(3);
  });

  it('closing the modal of a waiting pass stops its re-reads', async () => {
    api.getDockPass.mockResolvedValue(detail({ pass: passRow({ id: 7, status: 'waiting' }) }));
    api.getDock.mockResolvedValue(overview({ passes: [passRow({ id: 7, status: 'waiting' })] }));
    await renderPage();
    fireEvent.click(within(rowOf('Crate A')).getByRole('button', { name: 'Details' }));
    await flush();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(api.getDockPass).toHaveBeenCalledTimes(1);
  });

  it("a pass that can't be loaded says so, and the modal still closes", async () => {
    api.getDockPass.mockRejectedValue(new ApiError(404, 'pass_not_found'));
    api.getDock.mockResolvedValue(overview({ passes: [passRow({ id: 7 })] }));
    await renderPage();
    fireEvent.click(within(rowOf('Crate A')).getByRole('button', { name: 'Details' }));
    await flush();
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText("Couldn't load this pass.")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('before the first answer both panels say Checking…', async () => {
    api.getDock.mockReturnValue(new Promise<DockOverview>(() => {}));
    await renderPage();
    expect(within(screen.getByRole('region', { name: 'Open pass' })).getByText('Checking…')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Recent passes' })).getByText('Checking…')).toBeTruthy();
    expect(screen.queryByText('Waiting for tags…')).toBeNull();
    expect(screen.queryByText('No passes yet.')).toBeNull();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });

  it('a failing poll says the station can\'t be reached', async () => {
    api.getDock.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    expect(screen.getByRole('alert').textContent).toBe(UNREACHABLE);
    expect(screen.getAllByText('Checking…')).toHaveLength(2);
  });

  it('the line clears once a poll works, and a failure keeps the last passes under it', async () => {
    api.getDock.mockResolvedValueOnce(overview({ passes: [passRow()] }))
      .mockRejectedValueOnce(new ApiError(0, 'network'))
      .mockResolvedValue(overview({ passes: [passRow()] }));
    await renderPage();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(rowOf('Crate A')).toBeTruthy();
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });

  it('runs one poll loop under StrictMode, and none after unmount', async () => {
    const { unmount } = render(
      <StrictMode>
        <MemoryRouter initialEntries={['/dock']}>
          <Routes><Route path="/dock" element={<DockStation />} /></Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    await flush();
    const first = api.getDock.mock.calls.length;   // the double mount polls twice
    const firstCheck = api.getReaderStatus.mock.calls.length;   // and checks twice
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.getDock).toHaveBeenCalledTimes(first + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(api.getDock).toHaveBeenCalledTimes(first + 2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(firstCheck + 1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(firstCheck + 2);
    const polls = api.getDock.mock.calls.length;
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(api.getDock).toHaveBeenCalledTimes(polls);
    expect(api.getReaderStatus).toHaveBeenCalledTimes(firstCheck + 2);
  });

  it('polls again 1 s after the previous poll settles, never overlapping', async () => {
    let release: (o: DockOverview) => void = () => {};
    api.getDock.mockReturnValueOnce(new Promise<DockOverview>((r) => { release = r; }));
    await renderPage();
    expect(api.getDock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
    expect(api.getDock).toHaveBeenCalledTimes(1);
    await act(async () => { release(overview()); await vi.advanceTimersByTimeAsync(999); });
    expect(api.getDock).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(api.getDock).toHaveBeenCalledTimes(2);
  });

  it('stops polling and checking the reader on unmount', async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={['/dock']}>
        <Routes><Route path="/dock" element={<DockStation />} /></Routes>
      </MemoryRouter>,
    );
    await flush();
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(api.getDock).toHaveBeenCalledTimes(1);
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
  });
});
