// @vitest-environment jsdom
/** The Dock screen: the crate card (Scanning, the newest crate, two crates
 *  in red, a decided pass's result held until the next tag, Stopped), the
 *  count card, the crate's running device list (and a held result's), the
 *  reader's Start and Stop and its state, the 1 s overview poll and the 5 s
 *  reader check. No countdown, dry run, Window, Pause or Recent passes. */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getDock: vi.fn(), getEdgeSetup: vi.fn(),
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
  type DockOpenTag, type DockOverview, type DockPassRow, type EdgeSetup, type ReaderStatus,
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
  open: null, passes: [], control: null, ...over,
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
    id: 9, opened_at: at(14, 4, 57),
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

const readerGroup = () => screen.getByRole('group', { name: 'Reader' });
const readerBtn = (name: 'Start' | 'Stop') =>
  within(readerGroup()).getByRole('button', { name }) as HTMLButtonElement;
/** A reader button's line under its title. */
const btnSub = (name: 'Start' | 'Stop') =>
  readerBtn(name).querySelector('.rfid-dash-btn-sub')?.textContent;
/** Whether Start and Stop are enabled. */
const enabled = () => (['Start', 'Stop'] as const).map((n) => !readerBtn(n).disabled);
const crateCard = () => screen.getByRole('region', { name: 'Crate' });
const crateName = () => crateCard().querySelector('.dock-crate-name') as HTMLElement;
const crateMeta = () => crateCard().querySelector('.dock-crate-meta')?.textContent;
/** The card's look: is-scanning, is-found (a crate, or a result waiting to
 *  send), is-done, is-would (a legacy dry run), is-flag or is-idle. */
const cardIs = (look: string) => crateCard().classList.contains(`is-${look}`);
/** With no crate and no result, the crate card shows the reader's state. */
const readerShown = crateName;
/** The chip in the crate card's label row: the reader's state while a
 *  result holds the card and the reader isn't reading. */
const labelChip = () => crateCard().querySelector('.dock-card-label .chip');
const countCard = () => screen.getByRole('region', { name: 'Assets added to crate' });
const countValue = () => countCard().querySelector('.dock-stat-value')?.textContent;
const countSub = () => countCard().querySelector('.dock-stat-sub')?.textContent;
const crateList = () => screen.getByRole('region', { name: 'In this crate' });
/** A panel's count chip. */
const chipOf = (panel: HTMLElement) => panel.querySelector('.dock-panel-head .chip')?.textContent;
/** The crate list's rows, past the header. */
const listRows = () => within(crateList()).getAllByRole('row').slice(1) as HTMLTableRowElement[];
/** The crate list's devices and status chips, top to bottom. */
const listNames = () => listRows().map((r) => r.cells[0].textContent);
const listChips = () => listRows().map((r) => r.querySelector('.chip')?.textContent);
const UNREACHABLE = "Can't reach the station. Retrying…";
const EMPTY_LIST = 'Devices appear here as they pass the curtain.';

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date(2026, 10, 5, 14, 5, 0));
  localStorage.clear();
  writeKioskSetup(SETUP);
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  api.getDock.mockReset().mockResolvedValue(overview());
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
    expect(readerBtn('Stop')).toBeTruthy();
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
    expect(within(crateCard()).queryByText(/Finishing in/)).toBeNull();
    expect(countValue()).toBe('0');
    expect(countSub()).toBe('no crate yet');

    // devices read, still no crate
    await tick(1000);
    expect(cardIs('scanning')).toBe(true);
    expect(crateMeta()).toBe('2 devices read · waiting for a crate tag');
    expect(countValue()).toBe('0');
    expect(countSub()).toBe('waiting for a crate tag');
  });

  it('names the newest crate, with nothing counting down', async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockResolvedValueOnce(overview({
      open: openPass({ crates: [crate()], tags: [asset()] }),
    })).mockResolvedValueOnce(overview({
      open: openPass({
        crates: [crate(), crate({ epc: '0000000000000000000000C2', label: 'Crate B', first_read_at: at(14, 4, 59) })],
      }),
    })).mockResolvedValue(overview({
      // an unnamed crate goes by its trimmed tag
      open: openPass({ crates: [crate({ label: null })] }),
    }));
    await renderPage();
    expect(cardIs('found')).toBe(true);
    expect(crateName().textContent).toBe('Crate A');
    expect(crateMeta()).toBe('Tag C1 · read at 14:04:58');
    expect(within(crateCard()).queryByText(/Finishing in/)).toBeNull();

    await tick(1000);
    expect(crateName().textContent).toBe('Crate B');
    expect(crateMeta()).toBe('Tag C2 · read at 14:04:59');
    expect(cardIs('flag')).toBe(false);

    await tick(1000);
    expect(crateName().textContent).toBe('C1');
    expect(crateCard().textContent).not.toMatch(/\d+ s\b/);
  });

  it('two crates within 10 s turn the card red', async () => {
    const a = crate({ conflict: true });
    const b = crate({ epc: '0000000000000000000000C2', label: 'Crate B', first_read_at: at(14, 4, 59), conflict: true });
    api.getDock.mockResolvedValueOnce(overview({ open: openPass({ crates: [a, b] }) }))
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
      open: openPass({ crates: [crate()], added_count: 3 }),
    })).mockResolvedValue(overview({
      open: openPass({ crates: [crate({ label: null })], added_count: 3 }),
    }));
    await renderPage();
    expect(countValue()).toBe('2');
    expect(countSub()).toBe('in Crate A');
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

  it('Stopped shows on the crate card with Press Start to read again', async () => {
    api.getDock.mockResolvedValue(overview({ control: 'stop' }));
    await renderPage();
    expect(cardIs('idle')).toBe(true);
    expect(crateName().textContent).toBe('Stopped');
    expect(crateMeta()).toBe('Press Start to read again');
    expect(labelChip()).toBeNull();   // the card already says it
  });

  it('a stopped reader still shows the open crate it left', async () => {
    // The reader stopped on its own: the edge decides the burst later.
    api.getDock.mockResolvedValue(overview({ control: 'start', open: openPass({ crates: [crate()] }) }));
    await renderPage();
    expect(cardIs('found')).toBe(true);
    expect(crateName().textContent).toBe('Crate A');
    expect(btnSub('Start')).toBe('Start reading tags');
  });

  it('no settings, no Pause, no bar, no Recent passes', async () => {
    const none = () => {
      expect(screen.queryByRole('switch')).toBeNull();
      expect(screen.queryByText('Dry run')).toBeNull();
      expect(screen.queryByLabelText('Window')).toBeNull();
      expect(screen.queryByRole('group', { name: 'Dock settings' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
      expect(screen.queryByText(/Finishing in/)).toBeNull();
      // decided passes take the crate card, never a list of their own
      expect(screen.queryByText('Recent passes')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Details' })).toBeNull();
      expect(document.querySelectorAll('.dock-panel')).toHaveLength(1);   // In this crate alone
    };
    let first: (o: DockOverview) => void = () => {};
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockReturnValueOnce(new Promise<DockOverview>((r) => { first = r; }))
      .mockResolvedValueOnce(overview({
        open: openPass({ crates: [crate()], tags: [asset({ in_window: true, crate_label: 'Crate A' })], added_count: 1 }),
      }))
      .mockResolvedValueOnce(overview({ passes: [passRow({ id: 5, status: 'waiting', asset_count: 1 })] }))
      .mockResolvedValue(overview({ passes: [passRow({ id: 5, status: 'packed', asset_count: 1 })] }));
    await renderPage();
    none();   // before the first answer
    await act(async () => { first(overview()); await vi.advanceTimersByTimeAsync(0); });
    expect(cardIs('scanning')).toBe(true);
    none();
    await tick(1000);
    expect(cardIs('found')).toBe(true);
    none();
    await tick(1000);
    expect(crateMeta()).toBe('Waiting to send');
    none();
    await tick(1000);
    expect(crateMeta()).toBe('Packed 1 device');
    none();
    cleanup();

    api.getReaderStatus.mockResolvedValue(readerStatus());
    api.getDock.mockResolvedValue(overview({ control: 'stop' }));
    await renderPage();
    expect(crateName().textContent).toBe('Stopped');
    none();
  });

  // ── a decided pass's result ───────────────────────────────────────

  it('a decided pass holds the card until the next tag', async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    const older = passRow({ id: 1, container_name: 'Crate Old' });
    const burst = openPass({
      crates: [crate()], added_count: 2,
      tags: [
        asset({ epc: '000000000000000000001001', label: 'host-a', first_read_at: at(14, 4, 57), in_window: true, crate_label: 'Crate A' }),
        asset({ epc: '000000000000000000001002', label: 'host-b', first_read_at: at(14, 4, 59), in_window: true, crate_label: 'Crate A' }),
      ],
    });
    const waiting = passRow({ id: 2, status: 'waiting', container_name: 'Crate A', asset_count: 2 });
    const packed = passRow({ ...waiting, status: 'packed' });
    let edge = overview({ passes: [older], open: burst });
    api.getDock.mockImplementation(async () => edge);
    await renderPage();
    expect(cardIs('found')).toBe(true);
    expect(listNames()).toEqual(['host-b', 'host-a']);

    // decided: the crate waits to be sent, in the found look (not green)
    edge = overview({ passes: [waiting, older], open: null });
    await tick(1000);
    expect(cardIs('found')).toBe(true);
    expect(cardIs('done')).toBe(false);
    expect(crateName().textContent).toBe('Crate A');
    expect(crateMeta()).toBe('Waiting to send');
    expect(countValue()).toBe('2');
    expect(countSub()).toBe('in Crate A');
    // the list keeps the burst's devices as last shown
    expect(listNames()).toEqual(['host-b', 'host-a']);
    expect(listChips()).toEqual(['Adding', 'Adding']);
    expect(chipOf(crateList())).toBe('2 devices');

    // 30 s of polls with the pass still on top: nothing times out
    const polls = api.getDock.mock.calls.length;
    await tick(30000);
    expect(api.getDock.mock.calls.length).toBeGreaterThanOrEqual(polls + 30);
    expect(cardIs('found')).toBe(true);
    expect(crateName().textContent).toBe('Crate A');
    expect(crateMeta()).toBe('Waiting to send');
    expect(listNames()).toEqual(['host-b', 'host-a']);

    // sent: green, Packed, and the devices read Added
    edge = overview({ passes: [packed, older], open: null });
    await tick(1000);
    expect(cardIs('done')).toBe(true);
    expect(crateName().textContent).toBe('Crate A');
    expect(crateMeta()).toBe('Packed 2 devices');
    expect(listChips()).toEqual(['Added', 'Added']);
    expect(listRows()[0].querySelector('.chip')?.classList.contains('c-green')).toBe(true);
    await tick(30000);
    expect(cardIs('done')).toBe(true);
    expect(crateMeta()).toBe('Packed 2 devices');
    expect(listChips()).toEqual(['Added', 'Added']);

    // the next tag, an asset with no crate yet, takes the card and the list
    edge = overview({
      passes: [packed, older],
      open: openPass({
        id: 10, opened_at: at(14, 6, 0),
        tags: [asset({ epc: '000000000000000000001003', label: 'host-c', first_read_at: at(14, 6, 0) })],
      }),
    });
    await tick(1000);
    expect(cardIs('scanning')).toBe(true);
    expect(crateName().textContent).toBe('Scanning');
    expect(crateMeta()).toBe('1 device read · waiting for a crate tag');
    expect(listNames()).toEqual(['host-c']);
    expect(listChips()).toEqual(['Waiting for crate']);
    expect(countValue()).toBe('0');
    // and the old result doesn't come back once that burst is gone
    edge = overview({ passes: [packed, older], open: null });
    await tick(1000);
    expect(cardIs('scanning')).toBe(true);
    expect(within(crateList()).getByText(EMPTY_LIST)).toBeTruthy();
  });

  it('a pass decided as the next burst starts leaves the card to that burst', async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockResolvedValueOnce(overview({ open: openPass({ crates: [crate()] }) }))
      .mockResolvedValue(overview({
        passes: [passRow({ id: 5 })],
        open: openPass({ id: 10, tags: [asset({ epc: '000000000000000000001003', label: 'host-c' })] }),
      }));
    await renderPage();
    await tick(1000);
    expect(cardIs('scanning')).toBe(true);
    expect(listNames()).toEqual(['host-c']);
    await tick(1000);
    expect(cardIs('scanning')).toBe(true);
  });

  it('a held result shows a reader that is not reading as a chip', async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockResolvedValueOnce(overview({
      open: openPass({ crates: [crate()], tags: [asset({ in_window: true, crate_label: 'Crate A' })], added_count: 1 }),
    })).mockResolvedValue(overview({ passes: [passRow({ id: 5, status: 'packed', asset_count: 1 })] }));
    await renderPage();
    await tick(1000);
    expect(cardIs('done')).toBe(true);
    expect(crateMeta()).toBe('Packed 1 device');
    expect(labelChip()).toBeNull();   // reading

    // the next reader check answers stopped: the result stays, with a chip
    api.getReaderStatus.mockResolvedValue(readerStatus());
    await tick(4500);
    expect(cardIs('done')).toBe(true);
    expect(crateName().textContent).toBe('Crate A');
    expect(crateMeta()).toBe('Packed 1 device');
    expect(labelChip()?.textContent).toBe('Stopped');
    expect(labelChip()?.classList.contains('c-slate')).toBe(true);
    expect(listChips()).toEqual(['Added']);

    // nothing while a call runs
    let finish: (r: DockControlResult) => void = () => {};
    api.controlDock.mockImplementation(() => new Promise<DockControlResult>((r) => { finish = r; }));
    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(labelChip()).toBeNull();
    await act(async () => {
      finish({ reading: false, control: 'stop', decided: 0 });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(labelChip()?.textContent).toBe('Stopped');

    api.getReaderStatus.mockRejectedValue(new ApiError(0, 'network'));
    await tick(5000);
    expect(labelChip()?.textContent).toBe('Unreachable');
    expect(labelChip()?.classList.contains('c-red')).toBe(true);
    expect(crateMeta()).toBe('Packed 1 device');

    // reading again: the chip goes, the result stays
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    await tick(5000);
    expect(labelChip()).toBeNull();
    expect(cardIs('done')).toBe(true);
    expect(crateMeta()).toBe('Packed 1 device');
  });

  it("a held No crate read result's devices read No crate read", async () => {
    api.getDock.mockResolvedValueOnce(overview({
      open: openPass({
        tags: [asset(), asset({ epc: '000000000000000000001002', label: 'host-b', first_read_at: at(14, 4, 58) })],
      }),
    })).mockResolvedValue(overview({
      passes: [passRow({ id: 5, status: 'flagged', flag: 'no_crate', container_name: null, asset_count: 2 })],
    }));
    await renderPage();
    expect(listChips()).toEqual(['Waiting for crate', 'Waiting for crate']);
    await tick(1000);
    expect(crateName().textContent).toBe('No crate read');
    expect(listNames()).toEqual(['host-b', 'host-a']);
    expect(listChips()).toEqual(['No crate read', 'No crate read']);
    expect(listRows().every((r) => r.querySelector('.chip')?.classList.contains('c-red'))).toBe(true);
  });

  it("a held refused pass's added devices read Not packed", async () => {
    api.getDock.mockResolvedValueOnce(overview({
      open: openPass({
        crates: [crate()], added_count: 2,
        tags: [
          asset({ epc: '000000000000000000001001', label: 'host-a', first_read_at: at(14, 4, 57), in_window: true, crate_label: 'Crate A' }),
          asset({ epc: '000000000000000000001002', label: 'host-b', first_read_at: at(14, 4, 59), in_window: true, crate_label: 'Crate A' }),
          asset({ epc: '000000000000000000001003', label: 'host-c', first_read_at: at(14, 4, 40), in_window: false }),
        ],
      }),
    })).mockResolvedValueOnce(overview({
      passes: [passRow({ id: 5, status: 'waiting', asset_count: 2 })],
    })).mockResolvedValue(overview({
      passes: [passRow({ id: 5, status: 'refused', refuse_code: 'move_locked', asset_count: 2 })],
    }));
    await renderPage();
    await tick(1000);
    expect(crateMeta()).toBe('Waiting to send');
    expect(listChips()).toEqual(['Adding', 'Adding', 'Outside window']);
    expect(listRows()[0].querySelector('.chip')?.classList.contains('c-green')).toBe(true);
    await tick(1000);
    expect(cardIs('flag')).toBe(true);
    expect(crateMeta()).toBe('Not packed: crate is on another move');
    expect(listChips()).toEqual(['Not packed', 'Not packed', 'Outside window']);
    expect(listRows().every((r) => r.querySelector('.chip')?.classList.contains('c-red'))).toBe(true);
  });

  it("a held legacy would_pack pass's added devices still read Adding", async () => {
    api.getDock.mockResolvedValueOnce(overview({
      open: openPass({ crates: [crate()], tags: [asset({ in_window: true, crate_label: 'Crate A' })], added_count: 1 }),
    })).mockResolvedValue(overview({
      passes: [passRow({ id: 5, status: 'would_pack', dry_run: true, asset_count: 1 })],
    }));
    await renderPage();
    await tick(1000);
    expect(cardIs('would')).toBe(true);
    expect(listChips()).toEqual(['Adding']);
    expect(listRows()[0].querySelector('.chip')?.classList.contains('c-green')).toBe(true);
  });

  it('a held result survives a failed poll and the poll that recovers', async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockResolvedValueOnce(overview({
      open: openPass({ crates: [crate()], tags: [asset({ in_window: true, crate_label: 'Crate A' })], added_count: 1 }),
    })).mockResolvedValueOnce(overview({ passes: [passRow({ id: 5, status: 'waiting', asset_count: 1 })] }))
      .mockRejectedValueOnce(new ApiError(0, 'network'))
      .mockResolvedValue(overview({ passes: [passRow({ id: 5, status: 'packed', asset_count: 1 })] }));
    await renderPage();
    await tick(1000);
    expect(crateMeta()).toBe('Waiting to send');
    await tick(1000);
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(crateName().textContent).toBe('Crate A');
    expect(crateMeta()).toBe('Waiting to send');
    expect(listNames()).toEqual(['host-a']);
    await tick(1000);
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    expect(cardIs('done')).toBe(true);
    expect(crateMeta()).toBe('Packed 1 device');
    expect(listNames()).toEqual(['host-a']);
    expect(listChips()).toEqual(['Added']);
  });

  it("a person's tag clears a held result: any tag does", async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockResolvedValueOnce(overview({
      open: openPass({ crates: [crate()], tags: [asset({ in_window: true, crate_label: 'Crate A' })], added_count: 1 }),
    })).mockResolvedValueOnce(overview({ passes: [passRow({ id: 5, asset_count: 1 })] }))
      .mockResolvedValue(overview({
        passes: [passRow({ id: 5, asset_count: 1 })],
        open: openPass({ id: 10, tags: [{ ...asset({ epc: '000000000000000000000E01', label: 'Person A' }), kind: 'person' }] }),
      }));
    await renderPage();
    await tick(1000);
    expect(cardIs('done')).toBe(true);
    expect(listNames()).toEqual(['host-a']);
    await tick(1000);
    expect(cardIs('scanning')).toBe(true);
    expect(crateMeta()).toBe('Waiting for a crate tag');   // a person isn't a device
    expect(chipOf(crateList())).toBe('0 devices');
  });

  it('a legacy would_pack result keeps its amber card', async () => {
    // Decided from reads an older build stamped dry run.
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    const first = passRow({ id: 1, container_name: 'Crate A' });
    const decided = passRow({
      id: 2, status: 'would_pack', dry_run: true, container_name: 'Crate B', asset_count: 3,
    });
    api.getDock.mockResolvedValueOnce(overview({ passes: [first] }))
      .mockResolvedValue(overview({ passes: [decided, first] }));
    await renderPage();
    expect(cardIs('scanning')).toBe(true);
    await tick(1000);
    expect(cardIs('would')).toBe(true);
    expect(crateName().textContent).toBe('Crate B');
    expect(crateMeta()).toBe('Would pack 3 devices · dry run, nothing sent');
    expect(countValue()).toBe('3');
    expect(countSub()).toBe('would go into Crate B');
  });

  it('passes listed on first load never take the card', async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockRejectedValueOnce(new ApiError(0, 'network'))
      .mockResolvedValueOnce(overview({ passes: [passRow({ id: 4 })] }))
      .mockResolvedValue(overview({ passes: [passRow({ id: 4 })] }));
    await renderPage();
    await tick(1000);   // the first answer, after a failed poll
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    expect(cardIs('scanning')).toBe(true);
    await tick(1000);
    expect(cardIs('scanning')).toBe(true);
    await tick(30000);
    expect(cardIs('scanning')).toBe(true);
  });

  it('a first pass after an empty list takes the card', async () => {
    api.getDock.mockResolvedValueOnce(overview())
      .mockResolvedValue(overview({ passes: [passRow({ id: 1, status: 'packed', asset_count: 1 })] }));
    await renderPage();
    await tick(1000);
    expect(cardIs('done')).toBe(true);
    expect(crateName().textContent).toBe('Crate A');
    expect(crateMeta()).toBe('Packed 1 device');
    expect(countSub()).toBe('in Crate A');
    // no burst was open on the last poll: no devices to keep
    expect(chipOf(crateList())).toBe('0 devices');
  });

  it('each outcome has its look on the crate card', async () => {
    const cases: [Partial<DockPassRow>, string, string, string][] = [
      [{ status: 'packed', asset_count: 4 }, 'done', 'Crate A', 'Packed 4 devices'],
      [{ status: 'packed', asset_count: 4, refused_count: 1 }, 'done', 'Crate A', 'Packed · 1 not packed'],
      [{ status: 'waiting' }, 'found', 'Crate A', 'Waiting to send'],
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
    api.getDock.mockResolvedValueOnce(overview({
      open: openPass({ crates: [a, b], tags: [asset({ in_window: true, crate_label: 'Crate A' })] }),
    })).mockResolvedValue(overview({
      passes: [passRow({ id: 5, status: 'flagged', flag: 'many_crates', container_name: null })],
    }));
    await renderPage();
    await tick(1000);
    expect(cardIs('flag')).toBe(true);
    expect(crateName().textContent).toBe('More than one crate');
    expect(crateMeta()).toBe('Crate A and Crate B were read together. Nothing was packed.');
    // its device stays listed, inside a flagged crate
    expect(listChips()).toEqual(['More than one crate']);
    expect(listRows()[0].querySelector('.dock-row-crate')?.textContent).toBe('Crate A');
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
  });

  it('a No crate read leftover takes the card when it is the only new pass', async () => {
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
    expect(cardIs('found')).toBe(true);
    expect(crateMeta()).toBe('Waiting to send');
    await tick(1000);
    expect(cardIs('done')).toBe(true);
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
      open: openPass({
        crates: [crate()],
        tags: [
          asset({ epc: '000000000000000000001001', label: 'host-a', serial: 'SN-A', first_read_at: at(14, 4, 50), in_window: false }),
          asset({ epc: '000000000000000000001002', label: 'host-b', serial: null, first_read_at: at(14, 4, 55), in_window: true, crate_label: 'Crate A' }),
        ],
      }),
    })).mockResolvedValue(overview({
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

    // a crate read: inside its window or outside it
    await tick(1000);
    rows = listRows();
    expect(rows[0].cells[4].textContent).toBe('Adding');
    expect(rows[0].querySelector('.chip')?.classList.contains('c-green')).toBe(true);
    expect(rows[1].cells[4].textContent).toBe('Outside window');
    expect(rows[1].querySelector('.chip')?.classList.contains('c-red')).toBe(true);

    await tick(1000);
    rows = listRows();
    expect(rows[0].cells[4].textContent).toBe('Adding');
    expect(chipOf(crateList())).toBe('1 device');
  });

  it('with more than one crate each added row names its crate', async () => {
    const b = crate({ epc: '0000000000000000000000C2', label: null, first_read_at: at(14, 5, 20) });
    api.getDock.mockResolvedValue(overview({
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

  // ── the reader and its buttons ────────────────────────────────────

  it('shows the reader as Reading or Stopped', async () => {
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

    api.getDock.mockResolvedValue(overview({ control: 'stop' }));
    await renderPage();
    expect(readerShown().textContent).toBe('Stopped');
    expect(readerShown().classList.contains('is-stopped')).toBe(true);
    expect(btnSub('Start')).toBe('Start reading tags');
    cleanup();

    api.getReaderStatus.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    expect(readerShown().textContent).toBe('Unreachable');
    expect(readerShown().classList.contains('is-unreachable')).toBe(true);
  });

  it('the buttons carry their lines', async () => {
    await renderPage();
    expect(btnSub('Start')).toBe('Start reading tags');
    expect(btnSub('Stop')).toBe('Stop reading, finish this crate now');
  });

  it('Start and Stop send their action and check the reader again', async () => {
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
    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(api.controlDock).toHaveBeenLastCalledWith('stop');
    expect(api.getReaderStatus).toHaveBeenCalledTimes(3);
    expect(readerShown().textContent).toBe('Stopped');
    expect(btnSub('Start')).toBe('Start reading tags');
    expect(api.controlDock).toHaveBeenCalledTimes(2);
  });

  it('Stop and Start only', async () => {
    // loading: the first reader check hasn't answered
    api.getReaderStatus.mockReturnValueOnce(new Promise<ReaderStatus>(() => {}));
    api.getDock.mockReturnValue(new Promise<DockOverview>(() => {}));
    await renderPage();
    expect(within(readerGroup()).getAllByRole('button').map((b) => b.getAttribute('aria-label')))
      .toEqual(['Start', 'Stop']);
    expect(readerShown().textContent).toBe('Checking…');
    expect(readerBtn('Stop').disabled).toBe(false);
    cleanup();

    // unreachable: neither the overview nor the reader answers
    api.getDock.mockRejectedValue(new ApiError(0, 'network'));
    api.getReaderStatus.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    expect(readerShown().textContent).toBe('Unreachable');
    expect(readerBtn('Stop').disabled).toBe(false);
    cleanup();

    // busy: a Start call is running
    api.getDock.mockResolvedValue(overview());
    api.getReaderStatus.mockResolvedValue(readerStatus());
    api.controlDock.mockImplementation(() => new Promise<DockControlResult>(() => {}));
    await renderPage();
    fireEvent.click(readerBtn('Start'));
    await flush();
    expect(readerShown().textContent).toBe('Starting…');
    expect(readerBtn('Stop').disabled).toBe(false);
    fireEvent.click(readerBtn('Stop'));
    await flush();
    expect(api.controlDock).toHaveBeenLastCalledWith('stop');
  });

  it('Start follows the reader; Stop is always enabled', async () => {
    api.getReaderStatus.mockReturnValueOnce(new Promise<ReaderStatus>(() => {}));
    await renderPage();
    expect(readerShown().textContent).toBe('Checking…');
    expect(enabled()).toEqual([false, true]);
    cleanup();

    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    await renderPage();
    expect(readerShown().textContent).toBe('Scanning');
    expect(enabled()).toEqual([false, true]);
    cleanup();

    api.getReaderStatus.mockResolvedValue(readerStatus());
    await renderPage();
    expect(readerShown().textContent).toBe('Stopped');
    expect(enabled()).toEqual([true, true]);
    cleanup();

    api.getReaderStatus.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    expect(readerShown().textContent).toBe('Unreachable');
    expect(enabled()).toEqual([false, true]);
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
    expect(enabled()).toEqual([false, true]);

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
    expect(enabled()).toEqual([true, true]);

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

  // ── Checking…, unreachable and the polls ──────────────────────────

  it('before the first answer the list says Checking…', async () => {
    api.getDock.mockReturnValue(new Promise<DockOverview>(() => {}));
    await renderPage();
    expect(within(crateList()).getByText('Checking…')).toBeTruthy();
    expect(screen.queryByText(EMPTY_LIST)).toBeNull();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
  });

  it('a failing poll says the station can\'t be reached', async () => {
    api.getDock.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    expect(screen.getByRole('alert').textContent).toBe(UNREACHABLE);
    expect(within(crateList()).getByText('Checking…')).toBeTruthy();
  });

  it('unreachable keeps Stop enabled', async () => {
    // The edge doesn't answer at all: neither the overview nor the reader.
    api.getDock.mockRejectedValue(new ApiError(0, 'network'));
    api.getReaderStatus.mockRejectedValue(new ApiError(0, 'network'));
    await renderPage();
    expect(screen.getByRole('alert').textContent).toBe(UNREACHABLE);
    expect(readerShown().textContent).toBe('Unreachable');
    expect(within(crateList()).getByText('Checking…')).toBeTruthy();
    expect(enabled()).toEqual([false, true]);
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
    expect(enabled()).toEqual([false, true]);
  });

  it('the line clears once a poll works, and a failure keeps the last overview under it', async () => {
    const o = overview({ open: openPass({ crates: [crate()], tags: [asset()] }) });
    api.getDock.mockResolvedValueOnce(o)
      .mockRejectedValueOnce(new ApiError(0, 'network'))
      .mockResolvedValue(o);
    await renderPage();
    expect(screen.queryByText(UNREACHABLE)).toBeNull();
    await tick(1000);
    expect(screen.getByText(UNREACHABLE)).toBeTruthy();
    expect(crateName().textContent).toBe('Crate A');
    expect(listRows()).toHaveLength(1);
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

  it('a result under StrictMode holds the card like any other', async () => {
    api.getReaderStatus.mockResolvedValue(readerStatus({ reading: true }));
    api.getDock.mockResolvedValueOnce(overview()).mockResolvedValueOnce(overview())
      .mockResolvedValueOnce(overview({ passes: [passRow({ id: 3 })] }))
      .mockResolvedValueOnce(overview({ passes: [passRow({ id: 3 })] }))
      .mockResolvedValueOnce(overview({ passes: [passRow({ id: 3 })] }))
      .mockResolvedValue(overview({ passes: [passRow({ id: 3 })], open: openPass({ tags: [asset()] }) }));
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
    await tick(2000);
    expect(cardIs('done')).toBe(true);
    await tick(1000);   // a tag
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
