// @vitest-environment jsdom
/** The Dock screen: the crate card (Scanning, the newest crate and its
 *  countdown, two crates in red, a decided pass's result for 6 s, Paused /
 *  Stopped), the count card, the crate's running device list, recent
 *  passes and their outcome copy, the pass-detail modal, the dry-run
 *  switch, the Window, the reader's Start / Pause / Stop and its state, the
 *  1 s overview poll and the 5 s reader check. */
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
  ApiError, type DockControl, type DockControlResult, type DockCrate, type DockOpenPass,
  type DockOpenTag, type DockOverview, type DockPassDetail, type DockPassRow, type DockPassTag,
  type EdgeSetup, type ReaderStatus,
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

/** A crate read in the open burst. */
const crate = (over: Partial<DockCrate> = {}): DockCrate => ({
  epc: '0000000000000000000000C1', label: 'Crate A', first_read_at: at(14, 4, 58),
  conflict: false, ...over,
});

/** An asset read in the open burst, before any crate. */
const asset = (over: Partial<DockOpenTag> = {}): DockOpenTag => ({
  epc: '000000000000000000001001', kind: 'asset', label: 'host-a', first_read_at: at(14, 4, 57),
  serial: 'SN-1001', in_window: null, crate_label: null, ...over,
});

/** The open burst; its crates go into its tags too, as the edge lists them. */
const openPass = (over: Partial<DockOpenPass> = {}): DockOpenPass => {
  const crates = over.crates ?? [];
  const tags = over.tags ?? [];
  return {
    id: 9, opened_at: at(14, 4, 57), seconds_left: 8, window_s: 5,
    crate_count: crates.length, asset_count: tags.filter((t) => t.kind === 'asset').length,
    conflict: crates.some((c) => c.conflict), added_count: 0, ...over,
    crates,
    tags: [
      ...crates.map((c): DockOpenTag => ({
        epc: c.epc, kind: 'container', label: c.label, first_read_at: c.first_read_at,
        serial: null, in_window: null, crate_label: null,
      })),
      ...tags,
    ],
  };
};

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

async function tick(ms: number) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
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
const readerBtn = (name: 'Start' | 'Pause' | 'Stop') =>
  within(readerGroup()).getByRole('button', { name }) as HTMLButtonElement;
/** A reader button's line under its title. */
const btnSub = (name: 'Start' | 'Pause' | 'Stop') =>
  readerBtn(name).querySelector('.rfid-dash-btn-sub')?.textContent;
/** Whether Start, Pause and Stop are enabled. */
const enabled = () => (['Start', 'Pause', 'Stop'] as const).map((n) => !readerBtn(n).disabled);
const crateCard = () => screen.getByRole('region', { name: 'Crate' });
const crateName = () => crateCard().querySelector('.dock-crate-name') as HTMLElement;
const crateMeta = () => crateCard().querySelector('.dock-crate-meta')?.textContent;
/** The card's look: is-scanning, is-found, is-done, is-would, is-flag or is-idle. */
const cardIs = (look: string) => crateCard().classList.contains(`is-${look}`);
/** With no crate and no result, the crate card shows the reader's state. */
const readerShown = crateName;
const countCard = () => screen.getByRole('region', { name: 'Assets added to crate' });
const countValue = () => countCard().querySelector('.dock-stat-value')?.textContent;
const countSub = () => countCard().querySelector('.dock-stat-sub')?.textContent;
const crateList = () => screen.getByRole('region', { name: 'In this crate' });
const recentList = () => screen.getByRole('region', { name: 'Recent passes' });
/** A panel's count chip. */
const chipOf = (panel: HTMLElement) => panel.querySelector('.dock-panel-head .chip')?.textContent;
/** The crate list's rows, past the header. */
const listRows = () => within(crateList()).getAllByRole('row').slice(1) as HTMLTableRowElement[];
const UNREACHABLE = "Can't reach the station. Retrying…";
const EMPTY_LIST = 'Devices appear here as they pass the curtain.';
/** The Recent passes row whose Crate cell (or other cell) holds `text`. */
const rowOf = (text: string) => within(recentList()).getByText(text).closest('tr') as HTMLElement;

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

  // ── the crate card and the count ──────────────────────────────────

  it('the crate card says Scanning and Waiting for a crate tag with no crate', async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockResolvedValueOnce(overview())
      .mockResolvedValue(overview({
        open: openPass({ tags: [asset(), asset({ epc: '000000000000000000001002', label: 'host-b' })] }),
      }));
    await renderPage();
    expect(cardIs('scanning')).toBe(true);
    expect(crateName().textContent).toBe('Scanning');
    expect(crateName().querySelector('.dock-dots')).toBeTruthy();   // the animated ellipsis
    expect(crateMeta()).toBe('Waiting for a crate tag');
    expect(crateCard().querySelector('.dock-window')).toBeNull();
    expect(countValue()).toBe('0');
    expect(countSub()).toBe('no crate yet');

    // devices read, still no crate
    await tick(1000);
    expect(cardIs('scanning')).toBe(true);
    expect(crateMeta()).toBe('2 devices read · waiting for a crate tag');
    expect(countValue()).toBe('0');
    expect(countSub()).toBe('waiting for a crate tag');
  });

  it("names the newest crate and counts down to the burst's decision", async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockResolvedValueOnce(overview({
      open: openPass({ seconds_left: 2.4, window_s: 5, crates: [crate()], tags: [asset()] }),
    })).mockResolvedValueOnce(overview({
      open: openPass({
        seconds_left: 7.5, window_s: 5,
        crates: [crate(), crate({ epc: '0000000000000000000000C2', label: 'Crate B', first_read_at: at(14, 4, 59) })],
      }),
    })).mockResolvedValue(overview({
      // an unnamed crate goes by its trimmed tag; at zero the bar is empty
      open: openPass({ seconds_left: 0, window_s: 5, crates: [crate({ label: null })] }),
    }));
    await renderPage();
    expect(cardIs('found')).toBe(true);
    expect(crateName().textContent).toBe('Crate A');
    expect(crateMeta()).toBe('Tag C1 · read at 14:04:58');
    const bar = () => crateCard().querySelector('.dock-window') as HTMLElement;
    expect(within(bar()).getByText('Finishing in')).toBeTruthy();
    expect(within(bar()).getByText('3 s')).toBeTruthy();
    // 2.4 s of 2W = 10 s
    expect((bar().querySelector('.dock-window-bar > span') as HTMLElement).style.width).toBe('24%');

    await tick(1000);
    expect(crateName().textContent).toBe('Crate B');
    expect(crateMeta()).toBe('Tag C2 · read at 14:04:59');
    expect(within(bar()).getByText('8 s')).toBeTruthy();
    expect(cardIs('flag')).toBe(false);

    await tick(1000);
    expect(crateName().textContent).toBe('C1');
    expect(within(bar()).getByText('0 s')).toBeTruthy();
    expect((bar().querySelector('.dock-window-bar > span') as HTMLElement).style.width).toBe('0%');
  });

  it('two crates within 2W turn the card red', async () => {
    const a = crate({ conflict: true });
    const b = crate({ epc: '0000000000000000000000C2', label: 'Crate B', first_read_at: at(14, 4, 59), conflict: true });
    api.getDock.mockResolvedValueOnce(overview({ open: openPass({ seconds_left: 6, crates: [a, b] }) }))
      // only an older pair is flagged: the newest crate stands on its own
      .mockResolvedValue(overview({
        open: openPass({
          crates: [a, b, crate({ epc: '0000000000000000000000C3', label: 'Crate C', first_read_at: at(14, 5, 0) })],
        }),
      }));
    await renderPage();
    expect(cardIs('flag')).toBe(true);
    expect(crateName().textContent).toBe('More than one crate');
    expect(crateMeta()).toBe('Crate A and Crate B were read together');
    expect(within(crateCard()).getByText('6 s')).toBeTruthy();   // still counting down to the decision

    await tick(1000);
    expect(cardIs('flag')).toBe(false);
    expect(cardIs('found')).toBe(true);
    expect(crateName().textContent).toBe('Crate C');
  });

  it('a flagged newest crate goes red and names every flagged crate when its run is alone', async () => {
    // B stands between them unflagged: the run ending at C is C alone.
    api.getDock.mockResolvedValue(overview({
      open: openPass({
        crates: [
          crate({ conflict: true }),
          crate({ epc: '0000000000000000000000C2', label: 'Crate B', first_read_at: at(14, 4, 59) }),
          crate({ epc: '0000000000000000000000C3', label: 'Crate C', first_read_at: at(14, 5, 0), conflict: true }),
        ],
      }),
    }));
    await renderPage();
    expect(cardIs('flag')).toBe(true);
    expect(crateName().textContent).toBe('More than one crate');
    expect(crateMeta()).toBe('Crate A and Crate C were read together');
  });

  it('while the newest crate is flagged nothing says it will pack', async () => {
    const a = crate({ conflict: true });
    const b = crate({ epc: '0000000000000000000000C2', label: 'Crate B', first_read_at: at(14, 4, 59), conflict: true });
    api.getDock.mockResolvedValue(overview({
      open: openPass({
        crates: [a, b], added_count: 2,
        tags: [
          asset({ epc: '000000000000000000001001', first_read_at: at(14, 4, 58), in_window: true, crate_label: 'Crate A' }),
          asset({ epc: '000000000000000000001002', first_read_at: at(14, 4, 59), in_window: true, crate_label: 'Crate B' }),
          asset({ epc: '000000000000000000001003', first_read_at: at(14, 4, 40), in_window: false }),
        ],
      }),
    }));
    await renderPage();
    const rows = listRows();
    expect(rows.map((r) => r.querySelector('.chip')?.textContent))
      .toEqual(['More than one crate', 'More than one crate', 'Outside window']);
    expect(rows[0].querySelector('.chip')?.classList.contains('c-red')).toBe(true);
    expect(rows[0].querySelector('.dock-row-crate')?.textContent).toBe('Crate B');
    expect(countValue()).toBe('2');
    const value = countCard().querySelector('.dock-stat-value');
    expect(value?.classList.contains('is-muted')).toBe(true);
    expect(value?.classList.contains('is-bump')).toBe(false);
    expect(countSub()).toBe('More than one crate · nothing will be packed');
  });

  it('the count card shows added_count and where they go', async () => {
    api.getDock.mockResolvedValueOnce(overview({
      open: openPass({ crates: [crate()], added_count: 2 }),
    })).mockResolvedValueOnce(overview({
      settings: { dry_run: false, quiet_gap_s: 5 },
      open: openPass({ crates: [crate()], added_count: 3 }),
    })).mockResolvedValue(overview({
      settings: { dry_run: false, quiet_gap_s: 5 },
      open: openPass({ crates: [crate({ label: null })], added_count: 3 }),
    }));
    await renderPage();
    expect(countValue()).toBe('2');
    expect(countSub()).toBe('would go into Crate A');
    await tick(1000);
    expect(countValue()).toBe('3');
    expect(countSub()).toBe('in Crate A');
    await tick(1000);
    expect(countSub()).toBe('in C1');
  });

  it('a new count bumps', async () => {
    api.getDock.mockResolvedValueOnce(overview({ open: openPass({ crates: [crate()], added_count: 1 }) }))
      .mockResolvedValue(overview({ open: openPass({ crates: [crate()], added_count: 2 }) }));
    await renderPage();
    const first = countCard().querySelector('.dock-stat-value');
    expect(first?.classList.contains('is-bump')).toBe(true);
    await tick(1000);
    const second = countCard().querySelector('.dock-stat-value');
    expect(second).not.toBe(first);   // a fresh element replays the animation
    expect(second?.classList.contains('is-bump')).toBe(true);
    await tick(1000);
    expect(countCard().querySelector('.dock-stat-value')).toBe(second);   // the same count: no replay
  });

  it('a zero count is the muted zero, never bumped', async () => {
    await renderPage();
    const value = countCard().querySelector('.dock-stat-value');
    expect(value?.classList.contains('is-zero')).toBe(true);
    expect(value?.classList.contains('is-bump')).toBe(false);
  });

  it('Paused and Stopped show on the crate card with Press Start to read again', async () => {
    const cases: [DockControl | null, string][] = [['pause', 'Paused'], ['stop', 'Stopped'], [null, 'Stopped']];
    for (const [control, text] of cases) {
      api.getDock.mockResolvedValue(overview({ control }));
      await renderPage();
      expect(cardIs('idle')).toBe(true);
      expect(crateName().textContent).toBe(text);
      expect(crateMeta()).toBe('Press Start to read again');
      cleanup();
    }
  });

  it('a paused reader still shows the open crate it left', async () => {
    api.getDock.mockResolvedValue(overview({
      control: 'pause', open: openPass({ seconds_left: 4, crates: [crate()] }),
    }));
    await renderPage();
    expect(cardIs('found')).toBe(true);
    expect(crateName().textContent).toBe('Crate A');
    expect(btnSub('Start')).toBe('Start reading tags');
  });

  it('a Dry run chip sits on the crate card while dry run is on', async () => {
    api.getDock.mockResolvedValueOnce(overview())
      .mockResolvedValue(overview({ settings: { dry_run: false, quiet_gap_s: 5 } }));
    await renderPage();
    expect(within(crateCard()).getByText('Dry run').classList.contains('chip')).toBe(true);
    await tick(1000);
    expect(within(crateCard()).queryByText('Dry run')).toBeNull();
  });

  // ── a decided pass's result ───────────────────────────────────────

  it('a pass decided while watching flashes once', async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    const first = passRow({ id: 1, container_name: 'Crate A' });
    const decided = passRow({
      id: 2, status: 'would_pack', dry_run: true, container_name: 'Crate B', asset_count: 3,
    });
    api.getDock.mockResolvedValueOnce(overview({ passes: [first] }))
      .mockResolvedValue(overview({ passes: [decided, first] }));
    await renderPage();
    // listed when the page opened: no flash
    expect(cardIs('scanning')).toBe(true);

    await tick(1000);
    expect(cardIs('would')).toBe(true);
    expect(crateName().textContent).toBe('Crate B');
    expect(crateMeta()).toBe('Would pack 3 devices · dry run, nothing sent');
    expect(countValue()).toBe('3');
    expect(countSub()).toBe('would go into Crate B');
    await tick(5999);   // polls keep landing with it on top
    expect(cardIs('would')).toBe(true);
    await tick(1);
    expect(cardIs('scanning')).toBe(true);
    expect(crateName().textContent).toBe('Scanning');
    expect(countValue()).toBe('0');
    await tick(10000);
    expect(cardIs('scanning')).toBe(true);
  });

  it('passes listed on the first answer never flash, even after polls failed', async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockRejectedValueOnce(new ApiError(0, 'network'))
      .mockResolvedValueOnce(overview({ passes: [passRow({ id: 4 })] }))
      .mockResolvedValue(overview({ passes: [passRow({ id: 4 })] }));
    await renderPage();
    await tick(1000);
    expect(rowOf('Crate A')).toBeTruthy();
    expect(cardIs('scanning')).toBe(true);
    await tick(1000);
    expect(cardIs('scanning')).toBe(true);
  });

  it('a first pass after an empty list flashes', async () => {
    api.getDock.mockResolvedValueOnce(overview())
      .mockResolvedValue(overview({ passes: [passRow({ id: 1, status: 'packed', asset_count: 1 })] }));
    await renderPage();
    await tick(1000);
    expect(cardIs('done')).toBe(true);
    expect(crateName().textContent).toBe('Crate A');
    expect(crateMeta()).toBe('Packed 1 device');
    expect(countSub()).toBe('in Crate A');
  });

  it('each outcome has its look on the crate card', async () => {
    const cases: [Partial<DockPassRow>, string, string, string][] = [
      [{ status: 'packed', asset_count: 4 }, 'done', 'Crate A', 'Packed 4 devices'],
      [{ status: 'packed', asset_count: 4, refused_count: 1 }, 'done', 'Crate A', 'Packed · 1 not packed'],
      [{ status: 'waiting' }, 'done', 'Crate A', 'Waiting to send'],
      [{ status: 'refused', refuse_code: 'move_locked' }, 'flag', 'Crate A', 'Not packed: crate is on another move'],
      [{ status: 'flagged', flag: 'no_crate', container_name: null, asset_count: 2 }, 'flag',
        'No crate read', '2 devices read with no crate tag. Nothing was packed.'],
      [{ status: 'nothing', asset_count: 0 }, 'idle', 'Crate A', 'Nothing to pack'],
    ];
    for (const [over, look, name, meta] of cases) {
      api.getDock.mockResolvedValueOnce(overview())
        .mockResolvedValue(overview({ passes: [passRow({ id: 5, ...over })] }));
      await renderPage();
      await tick(1000);
      expect(cardIs(look)).toBe(true);
      expect(crateName().textContent).toBe(name);
      expect(crateMeta()).toBe(meta);
      cleanup();
    }
  });

  it('a red result leaves the count to the open burst', async () => {
    api.getDock.mockResolvedValueOnce(overview())
      .mockResolvedValue(overview({
        passes: [passRow({ id: 5, status: 'flagged', flag: 'no_crate', container_name: null })],
      }));
    await renderPage();
    await tick(1000);
    expect(cardIs('flag')).toBe(true);
    expect(countValue()).toBe('0');
    expect(countSub()).toBe('no crate yet');
  });

  it('More than one crate names the crates the burst read together', async () => {
    const a = crate({ conflict: true });
    const b = crate({ epc: '0000000000000000000000C2', label: 'Crate B', first_read_at: at(14, 4, 59), conflict: true });
    api.getDock.mockResolvedValueOnce(overview({ open: openPass({ crates: [a, b] }) }))
      .mockResolvedValue(overview({
        passes: [passRow({ id: 5, status: 'flagged', flag: 'many_crates', container_name: null })],
      }));
    await renderPage();
    await tick(1000);
    expect(cardIs('flag')).toBe(true);
    expect(crateName().textContent).toBe('More than one crate');
    expect(crateMeta()).toBe('Crate A and Crate B were read together. Nothing was packed.');
  });

  it("a burst's crate result wins over its No crate read leftover", async () => {
    // A split burst writes its groups by first read: a trailing straggler
    // makes the leftover the top pass, though the crate packed.
    const older = passRow({ id: 9, container_name: 'Crate A' });
    const leftover = passRow({ id: 11, status: 'flagged', flag: 'no_crate', container_name: null, asset_count: 1 });
    const crateB = passRow({ id: 10, status: 'would_pack', dry_run: true, container_name: 'Crate B', asset_count: 3 });
    api.getDock.mockResolvedValueOnce(overview({ passes: [older] }))
      .mockResolvedValue(overview({ passes: [leftover, crateB, older] }));
    await renderPage();
    await tick(1000);
    expect(cardIs('would')).toBe(true);
    expect(crateName().textContent).toBe('Crate B');
    expect(crateMeta()).toBe('Would pack 3 devices · dry run, nothing sent');
    expect(countValue()).toBe('3');
    expect(countSub()).toBe('would go into Crate B');
    // the leftover still stands out in Recent passes
    expect(rowOf('Flagged: No crate read').classList.contains('is-flagged')).toBe(true);
  });

  it('a No crate read leftover flashes when it is the only new pass', async () => {
    api.getDock.mockResolvedValueOnce(overview({ passes: [passRow({ id: 9 })] }))
      .mockResolvedValue(overview({
        passes: [passRow({ id: 11, status: 'flagged', flag: 'no_crate', container_name: null, asset_count: 2 }),
          passRow({ id: 9 })],
      }));
    await renderPage();
    await tick(1000);
    expect(cardIs('flag')).toBe(true);
    expect(crateName().textContent).toBe('No crate read');
  });

  it('a result follows its pass until it is sent', async () => {
    api.getDock.mockResolvedValueOnce(overview())
      .mockResolvedValueOnce(overview({ passes: [passRow({ id: 5, status: 'waiting', asset_count: 2 })] }))
      .mockResolvedValue(overview({ passes: [passRow({ id: 5, status: 'packed', asset_count: 2 })] }));
    await renderPage();
    await tick(1000);
    expect(crateMeta()).toBe('Waiting to send');
    await tick(1000);
    expect(crateMeta()).toBe('Packed 2 devices');
  });

  it('a crate read during a result takes the card', async () => {
    api.getDock.mockResolvedValueOnce(overview())
      .mockResolvedValueOnce(overview({ passes: [passRow({ id: 5 })] }))
      .mockResolvedValue(overview({
        passes: [passRow({ id: 5 })],
        open: openPass({ crates: [crate({ epc: '0000000000000000000000C9', label: 'Crate Z' })] }),
      }));
    await renderPage();
    await tick(1000);
    expect(cardIs('done')).toBe(true);
    await tick(1000);
    expect(cardIs('found')).toBe(true);
    expect(crateName().textContent).toBe('Crate Z');
    // once its burst is gone too, the old result doesn't come back
    api.getDock.mockResolvedValue(overview({ passes: [passRow({ id: 5 })] }));
    await tick(1000);
    expect(cardIs('done')).toBe(false);
  });

  // ── In this crate ─────────────────────────────────────────────────

  it("In this crate lists the burst's assets newest first with serial, tag, read time and status", async () => {
    api.getDock.mockResolvedValueOnce(overview({
      open: openPass({
        tags: [
          asset({ epc: '000000000000000000001001', label: 'host-a', serial: 'SN-A', first_read_at: at(14, 4, 50) }),
          asset({ epc: '000000000000000000001002', label: 'host-b', serial: null, first_read_at: at(14, 4, 55) }),
          { ...asset({ epc: '000000000000000000000E01', label: 'Person A' }), kind: 'person' },
          { ...asset({ epc: '00000000000000000000BEEF', label: null }), kind: 'unknown' },
        ],
      }),
    })).mockResolvedValueOnce(overview({
      settings: { dry_run: true, quiet_gap_s: 5 },
      open: openPass({
        crates: [crate()],
        tags: [
          asset({ epc: '000000000000000000001001', label: 'host-a', serial: 'SN-A', first_read_at: at(14, 4, 50), in_window: false }),
          asset({ epc: '000000000000000000001002', label: 'host-b', serial: null, first_read_at: at(14, 4, 55), in_window: true, crate_label: 'Crate A' }),
        ],
      }),
    })).mockResolvedValue(overview({
      settings: { dry_run: false, quiet_gap_s: 5 },
      open: openPass({
        crates: [crate()],
        tags: [
          asset({ epc: '000000000000000000001002', label: 'host-b', serial: null, first_read_at: at(14, 4, 55), in_window: true, crate_label: 'Crate A' }),
        ],
      }),
    }));
    await renderPage();
    // assets only (no crates, people or unknown tags), newest first, no crate yet
    let rows = listRows();
    expect(rows).toHaveLength(2);
    expect([...rows[0].cells].map((c) => c.textContent)).toEqual(['host-b', '—', '1002', '14:04:55', 'Waiting for crate']);
    expect([...rows[1].cells].map((c) => c.textContent)).toEqual(['host-a', 'SN-A', '1001', '14:04:50', 'Waiting for crate']);
    expect(rows[0].querySelector('.chip')?.classList.contains('c-slate')).toBe(true);
    expect(rows[0].classList.contains('is-new')).toBe(true);
    expect(rows[1].classList.contains('is-new')).toBe(false);
    expect(chipOf(crateList())).toBe('2 devices');
    expect(within(crateList()).getByText('Devices read at the curtain, newest first.')).toBeTruthy();
    expect(within(crateList()).getAllByRole('columnheader').map((h) => h.textContent))
      .toEqual(['Device', 'Serial', 'Tag', 'Read', 'Status']);

    // a crate read: inside its window or outside it (dry run)
    await tick(1000);
    rows = listRows();
    expect(rows[0].cells[4].textContent).toBe('Would add');
    expect(rows[0].querySelector('.chip')?.classList.contains('c-green')).toBe(true);
    expect(rows[1].cells[4].textContent).toBe('Outside window');
    expect(rows[1].querySelector('.chip')?.classList.contains('c-red')).toBe(true);

    // live
    await tick(1000);
    rows = listRows();
    expect(rows[0].cells[4].textContent).toBe('Adding');
    expect(chipOf(crateList())).toBe('1 device');
  });

  it('with more than one crate each added row names its crate', async () => {
    const b = crate({ epc: '0000000000000000000000C2', label: null, first_read_at: at(14, 5, 20) });
    api.getDock.mockResolvedValue(overview({
      settings: { dry_run: false, quiet_gap_s: 5 },
      open: openPass({
        crates: [crate(), b],
        tags: [
          asset({ epc: '000000000000000000001001', first_read_at: at(14, 4, 58), in_window: true, crate_label: 'Crate A' }),
          // an unnamed crate goes by its trimmed tag
          asset({ epc: '000000000000000000001002', first_read_at: at(14, 5, 19), in_window: true, crate_label: null }),
          asset({ epc: '000000000000000000001003', first_read_at: at(14, 5, 10), in_window: false }),
        ],
      }),
    }));
    await renderPage();
    const status = listRows().map((r) => r.cells[4].textContent);
    expect(status).toEqual(['AddingC2', 'Outside window', 'AddingCrate A']);
    expect(listRows()[2].querySelector('.dock-row-crate')?.textContent).toBe('Crate A');
  });

  it('one crate: added rows name no crate', async () => {
    api.getDock.mockResolvedValue(overview({
      open: openPass({ crates: [crate()], tags: [asset({ in_window: true, crate_label: 'Crate A' })] }),
    }));
    await renderPage();
    expect(listRows()[0].querySelector('.dock-row-crate')).toBeNull();
  });

  it('an empty crate list says where devices appear, or that the reader is not reading', async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    await renderPage();
    expect(within(crateList()).getByText(EMPTY_LIST)).toBeTruthy();
    expect(chipOf(crateList())).toBe('0 devices');
    cleanup();

    api.getReaderStatus.mockResolvedValue(readerStatus());
    await renderPage();
    expect(within(crateList()).getByText('The reader is not reading.')).toBeTruthy();
  });

  // ── Recent passes ─────────────────────────────────────────────────

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
    const panel = recentList();
    const shown = within(panel).getAllByRole('row').slice(1);   // past the header
    expect(shown).toHaveLength(rows.length);
    rows.forEach(([, text, flagged], i) => {
      expect(shown[i].querySelector('.dock-outcome')?.textContent).toBe(text);
      expect(shown[i].classList.contains('is-flagged')).toBe(flagged);
    });
    // a dry-run pass reads amber
    expect(shown[0].querySelector('.dock-outcome')?.classList.contains('is-would')).toBe(true);
    expect(shown[1].querySelector('.dock-outcome')?.classList.contains('is-would')).toBe(false);
    expect(chipOf(panel)).toBe('11 passes');
    expect(within(panel).getByText('Newest first.')).toBeTruthy();
    expect(within(panel).getAllByRole('columnheader').map((h) => h.textContent))
      .toEqual(['Time', 'Crate', 'Assets', 'Outcome', '']);
  });

  it('the time cell is the local 24-hour HH:MM:SS', async () => {
    api.getDock.mockResolvedValue(overview({ passes: [passRow({ opened_at: at(14, 3, 22) })] }));
    await renderPage();
    const row = rowOf('Crate A');
    expect(within(row).getByText('14:03:22')).toBeTruthy();
    expect(row.textContent).not.toMatch(/AM|PM/);
    expect(chipOf(recentList())).toBe('1 pass');
  });

  it('no passes says so', async () => {
    await renderPage();
    expect(within(recentList()).getByText('No passes yet.')).toBeTruthy();
    expect(chipOf(recentList())).toBe('0 passes');
  });

  // ── settings ──────────────────────────────────────────────────────

  it('Dry run: the switch saves the change, and the hint says nothing is sent', async () => {
    api.getDock.mockResolvedValueOnce(overview())
      .mockResolvedValue(overview({ settings: { dry_run: false, quiet_gap_s: 5 } }));
    await renderPage();
    expect(screen.getByText('Nothing is sent to the portal.')).toBeTruthy();
    expect(within(crateCard()).getByText('Dry run')).toBeTruthy();
    expect(dryRun().getAttribute('aria-checked')).toBe('true');
    fireEvent.click(dryRun());
    await flush();
    expect(api.saveDockSettings).toHaveBeenCalledWith({ dry_run: false });
    expect(within(crateCard()).queryByText('Dry run')).toBeNull();
    expect(dryRun().getAttribute('aria-checked')).toBe('false');
  });

  it('a poll that began before a save never puts the old setting back', async () => {
    let release: (o: DockOverview) => void = () => {};
    api.getDock.mockResolvedValueOnce(overview())
      .mockReturnValueOnce(new Promise<DockOverview>((r) => { release = r; }))
      .mockResolvedValue(overview({ settings: { dry_run: false, quiet_gap_s: 5 } }));
    await renderPage();
    await tick(1000);   // second poll, in flight
    expect(api.getDock).toHaveBeenCalledTimes(2);
    fireEvent.click(dryRun());
    await flush();
    expect(within(crateCard()).queryByText('Dry run')).toBeNull();
    await act(async () => { release(overview()); await vi.advanceTimersByTimeAsync(0); });
    expect(within(crateCard()).queryByText('Dry run')).toBeNull();
    expect(dryRun().getAttribute('aria-checked')).toBe('false');
  });

  it('a failed dry-run save keeps the switch where it was and says so', async () => {
    api.saveDockSettings.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    fireEvent.click(dryRun());
    await flush();
    expect(api.saveDockSettings).toHaveBeenCalledWith({ dry_run: false });
    expect(dryRun().getAttribute('aria-checked')).toBe('true');
    expect(within(crateCard()).getByText('Dry run')).toBeTruthy();
    expect(screen.getByText("Couldn't save. Try again.")).toBeTruthy();
  });

  it('no Dry run chip while dry run is off', async () => {
    api.getDock.mockResolvedValue(overview({ settings: { dry_run: false, quiet_gap_s: 5 } }));
    await renderPage();
    expect(within(crateCard()).queryByText('Dry run')).toBeNull();
  });

  it('the settings wait for the edge before they can be changed', async () => {
    api.getDock.mockReturnValue(new Promise<DockOverview>(() => {}));
    await renderPage();
    expect((screen.getByRole('group', { name: 'Dock settings' }) as HTMLFieldSetElement).disabled).toBe(true);
    expect(readerBtn('Stop').disabled).toBe(false);
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

  // ── the reader and its buttons ────────────────────────────────────

  it('shows the reader as Reading, Paused or Stopped', async () => {
    let answer: (s: ReaderStatus) => void = () => {};
    api.getReaderStatus.mockReturnValueOnce(new Promise<ReaderStatus>((r) => { answer = r; }));
    await renderPage();
    expect(readerShown().textContent).toBe('Checking…');
    expect(readerShown().classList.contains('is-loading')).toBe(true);
    expect(cardIs('idle')).toBe(true);
    await act(async () => { answer(readerStatus({ reading: true })); await vi.advanceTimersByTimeAsync(0); });
    expect(readerShown().textContent).toBe('Scanning');
    expect(readerShown().classList.contains('is-reading')).toBe(true);
    expect(btnSub('Start')).toBe('Reading');
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
      expect(btnSub('Start')).toBe('Start reading tags');
      cleanup();
    }

    api.getReaderStatus.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    expect(readerShown().textContent).toBe('Unreachable');
    expect(readerShown().classList.contains('is-unreachable')).toBe(true);
  });

  it('the buttons carry their lines', async () => {
    await renderPage();
    expect(btnSub('Start')).toBe('Start reading tags');
    expect(btnSub('Pause')).toBe('Stop reading, keep this crate');
    expect(btnSub('Stop')).toBe('Stop reading, finish this crate now');
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
    expect(readerShown().textContent).toBe('Scanning');
    expect(btnSub('Start')).toBe('Reading');

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
    await tick(1000);   // second poll, in flight
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
    expect(readerShown().textContent).toBe('Scanning');
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
    await tick(10000);
    expect(screen.getByRole('alert').textContent).toBe("Couldn't stop the reader (boom).");
    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('a failed Stop names the reader when no reader status has landed yet', async () => {
    // A hung reader call holds the edge's pair lock, so the status answers busy and stays null.
    api.getReaderStatus.mockReset().mockRejectedValue(new ApiError(503, 'busy'));
    api.controlDock.mockRejectedValueOnce(new ApiError(502, 'reader_unreachable'));
    await renderPage();
    expect(readerShown().textContent).toBe('Unreachable');
    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(screen.getByRole('alert').textContent).toBe("Can't reach the reader.");
    expect(screen.queryByText(/Can't reach \./)).toBeNull();
  });

  it('the reader is checked again 5 s after the previous check settles', async () => {
    let release: (s: ReaderStatus) => void = () => {};
    api.getReaderStatus.mockReturnValueOnce(new Promise<ReaderStatus>((r) => { release = r; }));
    await renderPage();
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
    await tick(10000);
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
    await act(async () => { release(readerStatus({ reading: true })); await vi.advanceTimersByTimeAsync(4999); });
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
    // A busy edge didn't ask the reader: what's shown stays.
    api.getReaderStatus.mockResolvedValue(readerStatus({ reachable: false, reading: false, busy: true }));
    await tick(1);
    expect(api.getReaderStatus).toHaveBeenCalledTimes(2);
    expect(readerShown().textContent).toBe('Scanning');
    await tick(5000);
    expect(api.getReaderStatus).toHaveBeenCalledTimes(3);
  });

  // ── the pass modal ────────────────────────────────────────────────

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
    await tick(2000);
    expect(api.getDockPass).toHaveBeenCalledTimes(2);
    expect(result()).toBe('Waiting to send');
    expect(within(dialog()).queryByText("Couldn't load this pass.")).toBeNull();
    await tick(2000);
    expect(api.getDockPass).toHaveBeenCalledTimes(3);
    expect(result()).toBe('Packed');
    expect(within(dialog()).getByText('Pass at 14:03:22').parentElement?.textContent).toContain('Packed');
    // sent: no more re-reads
    await tick(10000);
    expect(api.getDockPass).toHaveBeenCalledTimes(3);
  });

  it('closing the modal of a waiting pass stops its re-reads', async () => {
    api.getDockPass.mockResolvedValue(detail({ pass: passRow({ id: 7, status: 'waiting' }) }));
    api.getDock.mockResolvedValue(overview({ passes: [passRow({ id: 7, status: 'waiting' })] }));
    await renderPage();
    fireEvent.click(within(rowOf('Crate A')).getByRole('button', { name: 'Details' }));
    await flush();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Close' }));
    await tick(10000);
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

  // ── Checking…, unreachable and the polls ──────────────────────────

  it('before the first answer both lists say Checking…', async () => {
    api.getDock.mockReturnValue(new Promise<DockOverview>(() => {}));
    await renderPage();
    expect(within(crateList()).getByText('Checking…')).toBeTruthy();
    expect(within(recentList()).getByText('Checking…')).toBeTruthy();
    expect(screen.queryByText(EMPTY_LIST)).toBeNull();
    expect(screen.queryByText('No passes yet.')).toBeNull();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });

  it('a failing poll says the station can\'t be reached', async () => {
    api.getDock.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    expect(screen.getByRole('alert').textContent).toBe(UNREACHABLE);
    expect(screen.getAllByText('Checking…')).toHaveLength(2);
  });

  it('unreachable keeps Stop enabled', async () => {
    // The edge doesn't answer at all: neither the overview nor the reader.
    api.getDock.mockRejectedValue(new ApiError(0, 'network'));
    api.getReaderStatus.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    expect(screen.getByRole('alert').textContent).toBe(UNREACHABLE);
    expect(readerShown().textContent).toBe('Unreachable');
    expect(within(crateList()).getByText('Checking…')).toBeTruthy();
    expect(within(recentList()).getByText('Checking…')).toBeTruthy();
    expect(enabled()).toEqual([false, false, true]);
    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(api.controlDock).toHaveBeenCalledWith('stop');
    cleanup();

    // It stops answering mid-crate: the last overview stays under the line.
    api.getDock.mockReset()
      .mockResolvedValueOnce(overview({ open: openPass({ crates: [crate()], tags: [asset()] }) }))
      .mockRejectedValue(new ApiError(0, 'network'));
    api.getReaderStatus.mockResolvedValueOnce(readerStatus({ reading: true }))
      .mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    await tick(5000);
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(crateName().textContent).toBe('Crate A');
    expect(listRows()).toHaveLength(1);
    expect(enabled()).toEqual([false, false, true]);
  });

  it('the line clears once a poll works, and a failure keeps the last passes under it', async () => {
    api.getDock.mockResolvedValueOnce(overview({ passes: [passRow()] }))
      .mockRejectedValueOnce(new ApiError(0, 'network'))
      .mockResolvedValue(overview({ passes: [passRow()] }));
    await renderPage();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    await tick(1000);
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(rowOf('Crate A')).toBeTruthy();
    await tick(1000);
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
    await tick(1000);
    expect(api.getDock).toHaveBeenCalledTimes(first + 1);
    await tick(1000);
    expect(api.getDock).toHaveBeenCalledTimes(first + 2);
    await tick(3000);
    expect(api.getReaderStatus).toHaveBeenCalledTimes(firstCheck + 1);
    await tick(5000);
    expect(api.getReaderStatus).toHaveBeenCalledTimes(firstCheck + 2);
    const polls = api.getDock.mock.calls.length;
    unmount();
    await tick(10000);
    expect(api.getDock).toHaveBeenCalledTimes(polls);
    expect(api.getReaderStatus).toHaveBeenCalledTimes(firstCheck + 2);
  });

  it('a result under StrictMode flashes and clears like any other', async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockResolvedValueOnce(overview()).mockResolvedValueOnce(overview())
      .mockResolvedValue(overview({ passes: [passRow({ id: 3 })] }));
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/dock']}>
          <Routes><Route path="/dock" element={<DockStation />} /></Routes>
        </MemoryRouter>
      </StrictMode>,
    );
    await flush();
    await tick(1000);
    expect(cardIs('done')).toBe(true);
    await tick(6000);
    expect(cardIs('scanning')).toBe(true);
  });

  it('polls again 1 s after the previous poll settles, never overlapping', async () => {
    let release: (o: DockOverview) => void = () => {};
    api.getDock.mockReturnValueOnce(new Promise<DockOverview>((r) => { release = r; }));
    await renderPage();
    expect(api.getDock).toHaveBeenCalledTimes(1);
    await tick(5000);
    expect(api.getDock).toHaveBeenCalledTimes(1);
    await act(async () => { release(overview()); await vi.advanceTimersByTimeAsync(999); });
    expect(api.getDock).toHaveBeenCalledTimes(1);
    await tick(1);
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
    await tick(10000);
    expect(api.getDock).toHaveBeenCalledTimes(1);
    expect(api.getReaderStatus).toHaveBeenCalledTimes(1);
  });
});
