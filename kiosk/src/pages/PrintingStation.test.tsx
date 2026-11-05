// @vitest-environment jsdom
/** The Printing Station against a real (fake) IndexedDB roster, a fake
 *  station printer and stubbed edge label routes: scanning prints and
 *  shows the asset, and the problems say what's wrong. The laptop cases
 *  run in laptop mode (the edge backend); the web kiosk's cases, at the
 *  end, run on the web backend: labels from the browser build's store,
 *  the Labeled scan through the real outbox, and never an edge route. */
import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostStatus } from '@portal/labels/zebraUsb';
import { applyPrintSettings, DEFAULT_PRINT_SETTINGS } from '@portal/lib/printLabels';

const api = vi.hoisted(() => ({
  getStationLabel: vi.fn(), postLabelPrinted: vi.fn(), getLabelRunStatus: vi.fn(), getRecordedScans: vi.fn(),
  // the web kiosk's outbox sender, and a sync that is still downloading
  postScans: vi.fn(),
  fetchAssetsSyncRaw: vi.fn(), fetchPeopleSync: vi.fn(), fetchContainersSync: vi.fn(), fetchTrucksSync: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...api };
});

const sound = vi.hoisted(() => ({ playScanSound: vi.fn() }));
vi.mock('../lib/sound', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/sound')>();
  return { ...actual, playScanSound: sound.playScanSound };
});

// The real outbox, with its sender's start and stop counted.
const sender = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn() }));
vi.mock('../lib/outbox', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/outbox')>();
  return {
    ...actual,
    startSender: () => { sender.start(); return actual.startSender(); },
    stopSender: () => { sender.stop(); actual.stopSender(); },
  };
});

// The web build's status is Task 3's (labelBuild.test.ts); here a test
// can set it and say it changed. Null is the real (idle) one.
const build = vi.hoisted(() => ({
  status: null as null | Record<string, unknown>,
  listeners: new Set<() => void>(),
}));
vi.mock('../lib/webLabels/labelBuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/webLabels/labelBuild')>();
  return {
    ...actual,
    readWebLabelStatus: () => build.status ?? actual.readWebLabelStatus(),
    subscribeWebLabelStatus: (fn: () => void) => {
      build.listeners.add(fn);
      return () => build.listeners.delete(fn);
    },
  };
});

const station = vi.hoisted(() => ({
  state: 'ready' as 'loading' | 'ready' | 'needs_usb' | 'no_settings',
  sent: [] as string[],
  connectUsb: vi.fn(),
  /** The saved settings the hook reports (the laptop's network printer
   *  unless a test says otherwise). */
  settings: null as null | Record<string, unknown>,
}));
vi.mock('../lib/useStationPrinter', () => {
  const status: HostStatus = {
    paperOut: false, paused: false, labelLength: 0, formatsQueued: 0, bufferFull: false,
    partialFormat: false, corruptRam: false, underTemp: false, overTemp: false,
    headOpen: false, ribbonOut: false, thermalTransfer: false, printMode: 'T',
    labelWaiting: false, labelsRemaining: 0,
  };
  const printer = {
    kind: 'network', ip: '10.0.0.40', serial: null,
    status: async () => status,
    send: async (zpl: string) => { station.sent.push(zpl); },
  };
  const settings = {
    label_kind: 'top', dpi: 203, offset_x: 0, offset_y: 0, peel: false,
    printer: { type: 'network', ip: '10.0.0.40', model: 'ZD421', serial: null },
  };
  return {
    useStationPrinter: () => ({
      settings: station.state === 'no_settings' ? null : station.settings ?? settings,
      printer: station.state === 'ready' ? printer : null,
      zebra: {},
      state: station.state,
      connectUsb: station.connectUsb,
      reload: async () => {},
    }),
  };
});

import { ApiError, type KioskScanIn, type LabelStationSettings } from '../lib/api';
import { clearFlash } from '../lib/flash';
import { writeKioskSetup } from '../lib/kioskSetup';
import { closeDb, putRows, replaceAll, writeMeta } from '../lib/localDb';
import { BATCH_DELAY, readOutbox, resetOutboxForTest, type OutboxRow } from '../lib/outbox';
import { notDownloadedText, SYNCING_TEXT } from '../lib/printQueue';
import { withPrintMode } from '../lib/stationPrinter';
import { resetSyncStatus, runSync } from '../lib/sync';
import { writeWebLabelSettings } from '../lib/webLabelSettings';
import { LABELS_META_KEY, type WebLabelRow } from '../lib/webLabels/labelBuild';
import PrintingStation, { FAILED_ROW_MS, RECORDED_POLL_MS } from './PrintingStation';

const SERVER = {
  id: 'a-1', asset_id: '10042', name: 'Rack 4 server', rfid: null,
  serial_number: 'SN-4242', make: 'Dell', model: 'R640', make_model: 'Dell R640',
  label: { source_raw: 'A12', source_ru: '22', destination_raw: 'B07', destination_ru: '14' },
};

beforeEach(async () => {
  // These cases are the laptop's (the edge backend); the web kiosk's set
  // web mode in their own beforeEach.
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  localStorage.clear();
  closeDb();
  (globalThis as unknown as { indexedDB: IDBFactory }).indexedDB = new IDBFactory();
  await replaceAll('assets', [SERVER]);
  writeKioskSetup({
    initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration', siteId: 's-1', siteName: 'ACC4',
    siteRole: 'source', scanStatus: 'k', scanLabel: 'Labels', stationType: 'label',
  });
  station.state = 'ready';
  station.sent = [];
  station.settings = null;
  build.status = null;
  build.listeners.clear();
  resetOutboxForTest();
  api.getStationLabel.mockReset().mockImplementation(async (id: string) => ({
    asset_id: id, zpl: '^XA^FDLABEL^FS^XZ', error: null, template_name: 'Generic', dpi: 203, label_kind: 'top',
  }));
  api.postLabelPrinted.mockReset().mockResolvedValue('scan-1');
  api.getRecordedScans.mockReset().mockResolvedValue([]);
  api.getLabelRunStatus.mockReset().mockResolvedValue(runStatus(0));
});

function runStatus(unsupported: number | undefined) {
  return { state: 'idle', reason: 'setup', total: 1, done: 1, ready: 1, errors: 0, unsupported };
}

afterEach(() => { cleanup(); clearFlash(); vi.clearAllMocks(); delete window.__KIOSK_CONFIG__; });

const render_ = () => render(<MemoryRouter><PrintingStation /></MemoryRouter>);

async function scan(value: string) {
  const input = await screen.findByLabelText('Scan value') as HTMLInputElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  await userEvent.type(input, `${value}{Enter}`);
}

it.each([['asset id', '10042'], ['serial', 'sn-4242']])('scanning by %s prints and shows the asset', async (_, value) => {
  render_();
  await scan(value);
  await screen.findAllByText('Printed');
  expect(station.sent).toHaveLength(1);
  expect(station.sent[0]).toContain('^FDLABEL');
  expect(api.getStationLabel).toHaveBeenCalledWith('a-1');
  expect(api.postLabelPrinted).toHaveBeenCalledWith(expect.objectContaining({
    asset_id: 'a-1', scanned_value: value,
  }));
  const card = screen.getByTestId('station-asset');
  expect(card.textContent).toContain('Rack 4 server');
  expect(card.textContent).toContain('Dell R640');
  expect(card.textContent).toContain('SN-4242');
  expect(card.textContent).toContain('A12');
  expect(card.textContent).toContain('B07');
  expect(screen.getByRole('button', { name: 'Reprint' })).toBeTruthy();
  expect(sound.playScanSound).toHaveBeenCalledWith('good');
});

it('an unknown value says the asset is not on the move and sends nothing', async () => {
  render_();
  await scan('NOPE-1');
  expect((await screen.findAllByText("This asset isn't on this move.")).length).toBeGreaterThan(0);
  expect(station.sent).toEqual([]);
  expect(api.getStationLabel).not.toHaveBeenCalled();
  expect(api.postLabelPrinted).not.toHaveBeenCalled();
  expect(sound.playScanSound).toHaveBeenCalledWith('not_found');
});

it('labels_regenerating shows a waiting message', async () => {
  api.getStationLabel.mockRejectedValue(new ApiError(409, 'labels_regenerating'));
  render_();
  await scan('10042');
  expect((await screen.findAllByText('Labels are being regenerated. Scan again when it finishes.')).length)
    .toBeGreaterThan(0);
  expect(station.sent).toEqual([]);
  expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
});

it('a printed label whose scan was not recorded says so without reprinting', async () => {
  api.postLabelPrinted.mockRejectedValue(new ApiError(422, 'scan_value_mismatch'));
  render_();
  await scan('10042');
  await screen.findAllByText('Printed');
  expect((await screen.findAllByText(/^Printed, but the scan wasn't recorded: /)).length).toBeGreaterThan(0);
  expect(station.sent).toHaveLength(1);
});

it('needs_usb offers Connect printer', async () => {
  station.state = 'needs_usb';
  render_();
  await userEvent.click(await screen.findByRole('button', { name: 'Connect printer' }));
  expect(station.connectUsb).toHaveBeenCalled();
  expect((screen.getByLabelText('Scan value') as HTMLInputElement).disabled).toBe(true);
});

it('no_settings points to Kiosk Setup', async () => {
  station.state = 'no_settings';
  render_();
  expect(await screen.findByText(/No label printer is saved for this station/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Kiosk Setup' }).getAttribute('href')).toBe('/setup');
});

it('Reprint prints again without recording, and the scan box gets focus back', async () => {
  render_();
  await scan('10042');
  await screen.findAllByText('Printed');
  await userEvent.click(screen.getByRole('button', { name: 'Reprint' }));
  await waitFor(() => expect(station.sent).toHaveLength(2));
  expect(api.postLabelPrinted).toHaveBeenCalledTimes(1);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Scan value')));
});

it('Retry prints a failed scan, records it once, and the scan box gets focus back', async () => {
  api.getStationLabel.mockRejectedValueOnce(new ApiError(409, 'labels_regenerating'));
  render_();
  await scan('10042');
  await userEvent.click(await screen.findByRole('button', { name: 'Retry' }));
  await screen.findAllByText('Printed');
  expect(station.sent).toHaveLength(1);
  expect(api.postLabelPrinted).toHaveBeenCalledTimes(1);
  expect(api.postLabelPrinted).toHaveBeenCalledWith(expect.objectContaining({ asset_id: 'a-1', scanned_value: '10042' }));
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Scan value')));
});

it('a template too new for this laptop says to update it, and prints nothing', async () => {
  api.getStationLabel.mockImplementation(async (id: string) => ({
    asset_id: id, zpl: null, error: 'template_unsupported', template_name: 'Vegas · 203', dpi: 203,
    label_kind: 'top',
  }));
  render_();
  await scan('10042');
  expect((await screen.findAllByText('This laptop needs an update to print this template.')).length)
    .toBeGreaterThan(0);
  expect(station.sent).toEqual([]);
  expect(api.postLabelPrinted).not.toHaveBeenCalled();
  expect(sound.playScanSound).toHaveBeenCalledWith('not_found');
});

it('the header says how many templates need a laptop update', async () => {
  api.getLabelRunStatus.mockResolvedValue(runStatus(1));
  render_();
  expect(await screen.findByText('1 template needs a laptop update.')).toBeTruthy();
  cleanup();

  api.getLabelRunStatus.mockResolvedValue(runStatus(2));
  render_();
  expect(await screen.findByText('2 templates need a laptop update.')).toBeTruthy();
  cleanup();

  // none, an older edge that doesn't count them, or no answer: nothing to say
  for (const answer of [runStatus(0), runStatus(undefined), null]) {
    if (answer) api.getLabelRunStatus.mockResolvedValue(answer);
    else api.getLabelRunStatus.mockRejectedValue(new Error('offline'));
    api.getLabelRunStatus.mockClear();
    render_();
    await waitFor(() => expect(api.getLabelRunStatus).toHaveBeenCalled());
    await screen.findByLabelText('Scan value');
    expect(screen.queryByText(/need(s)? a laptop update/)).toBeNull();
    cleanup();
  }
});

it('a scan that hits a too-new template refreshes the header count', async () => {
  api.getStationLabel.mockImplementation(async (id: string) => ({
    asset_id: id, zpl: null, error: 'template_unsupported', template_name: 'Vegas · 203', dpi: 203,
    label_kind: 'top',
  }));
  render_();
  await waitFor(() => expect(api.getLabelRunStatus).toHaveBeenCalledTimes(1));
  api.getLabelRunStatus.mockResolvedValue(runStatus(1));
  await scan('10042');
  expect(await screen.findByText('1 template needs a laptop update.')).toBeTruthy();
});

const statusCell = () => screen.getAllByRole('row')[1].querySelector('.scan-chip') as HTMLElement;

it('a printed scan the portal accepted reads Printed + Recorded in the list', async () => {
  api.getRecordedScans.mockResolvedValue(['scan-1']);
  render_();
  await scan('10042');
  await waitFor(() => expect(statusCell().textContent).toBe('Printed + Recorded'));
  expect(api.getRecordedScans).toHaveBeenCalledWith(['scan-1']);
});

it('stays Printed until the portal accepts the scan, then reads Printed + Recorded', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    render_();
    await scan('10042');
    await waitFor(() => expect(api.getRecordedScans).toHaveBeenCalled());
    expect(statusCell().textContent).toBe('Printed');
    api.getRecordedScans.mockResolvedValue(['scan-1']);
    await act(async () => { await vi.advanceTimersByTimeAsync(RECORDED_POLL_MS); });
    await waitFor(() => expect(statusCell().textContent).toBe('Printed + Recorded'));
  } finally {
    vi.useRealTimers();
  }
});

it('a reprint never asks and never reads Recorded', async () => {
  api.getRecordedScans.mockResolvedValue(['scan-1']);
  render_();
  await scan('10042');
  await waitFor(() => expect(statusCell().textContent).toBe('Printed + Recorded'));
  await userEvent.click(screen.getByRole('button', { name: 'Reprint' }));
  await waitFor(() => expect(screen.getAllByRole('row')).toHaveLength(3));
  expect(statusCell().textContent).toBe('Printed (reprint)');
});

it('the card reads Printed + Recorded too once the portal accepts the scan', async () => {
  api.getRecordedScans.mockResolvedValue(['scan-1']);
  render_();
  await scan('10042');
  const card = () => document.querySelector('.station-result .station-status') as HTMLElement;
  await waitFor(() => expect(card().textContent).toBe('Printed + Recorded'));
});

it('a red row leaves the list 5 s after it fails; the card keeps showing it', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    render_();
    await scan('10042');            // a good row that stays
    await screen.findAllByText('Printed');
    await scan('NOPE-1');           // a red row that goes
    const rowCount = () => screen.queryAllByRole('row').length;
    await waitFor(() => expect(rowCount()).toBe(3));   // header + 2
    await act(async () => { await vi.advanceTimersByTimeAsync(FAILED_ROW_MS - 500); });
    expect(rowCount()).toBe(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    await waitFor(() => expect(rowCount()).toBe(2));   // header + the printed row
    const rows = screen.getAllByRole('row');
    expect(rows[1].textContent).toContain('10042');
    const card = document.querySelector('.station-result .station-status') as HTMLElement;
    expect(card.textContent).toBe("This asset isn't on this move.");
  } finally {
    vi.useRealTimers();
  }
});

it('when only red rows were left, the list goes back to its empty note', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    render_();
    await scan('NOPE-1');
    await waitFor(() => expect(screen.queryAllByRole('row').length).toBe(2));
    await act(async () => { await vi.advanceTimersByTimeAsync(FAILED_ROW_MS + 100); });
    await waitFor(() => expect(screen.getByText('Nothing printed yet.')).toBeTruthy());
  } finally {
    vi.useRealTimers();
  }
});

it('a laptop station leaves the outbox sender alone: its edge records the scans', async () => {
  const view = render_();
  await scan('10042');
  await screen.findAllByText('Printed');
  view.unmount();
  expect(sender.start).not.toHaveBeenCalled();
  expect(sender.stop).not.toHaveBeenCalled();
  expect(readOutbox().rows).toEqual([]);
});

// ── the web kiosk ───────────────────────────────────────────────────

describe('web kiosk', () => {
  /** What the web kiosk saved in Printer Setup: a USB Zebra with offsets,
   *  printing peel-off. */
  const WEB: LabelStationSettings = {
    label_kind: 'top', dpi: 203, offset_x: 12, offset_y: -4, peel: true,
    printer: { type: 'usb', ip: null, model: 'ZD421', serial: 'ZD-1' },
  };
  const ZPL = '^XA^FDLABEL^FS^XZ';

  function labelRow(over: Partial<WebLabelRow> = {}): WebLabelRow {
    return {
      asset_id: 'a-1', zpl: ZPL, error: null, fingerprint: '0123456789abcd', template_name: 'Generic',
      dpi: 203, label_kind: 'top', initiativeId: 'i-1', ...over,
    };
  }

  function idle(over: Record<string, unknown> = {}) {
    return { state: 'idle', reason: 'setup', total: 1, done: 1, ready: 1, errors: 0, unsupported: 0, ...over };
  }

  /** The build finished: a new status, and the station is told. */
  function buildChanged(next: Record<string, unknown>) {
    build.status = next;
    act(() => { for (const fn of build.listeners) fn(); });
  }

  const accepting = async ({ scans }: { scans: KioskScanIn[] }) => ({
    accepted: scans.map((x) => x.client_scan_id), rejected: [],
  });
  /** The portal turns every scan down by name: the outbox fails it at once. */
  const rejecting = async ({ scans }: { scans: KioskScanIn[] }) => ({
    accepted: [], rejected: scans.map((x) => ({ client_scan_id: x.client_scan_id, code: 'bad_status' })),
  });

  beforeEach(async () => {
    delete window.__KIOSK_CONFIG__;   // web mode
    writeWebLabelSettings(WEB);
    station.settings = WEB as unknown as Record<string, unknown>;
    build.status = idle();
    await putRows('labels', [labelRow()]);
    // Offline unless a test says otherwise: the Labeled scan waits in the outbox.
    api.postScans.mockReset().mockRejectedValue(new ApiError(0, 'network_error'));
    for (const fn of [api.fetchAssetsSyncRaw, api.fetchPeopleSync, api.fetchContainersSync, api.fetchTrucksSync]) {
      fn.mockReset().mockReturnValue(new Promise(() => {}));   // a download that never finishes
    }
  });

  afterEach(() => {
    // The web kiosk has no edge: not one /edge/* route, whatever happened.
    expect(api.getStationLabel).not.toHaveBeenCalled();
    expect(api.postLabelPrinted).not.toHaveBeenCalled();
    expect(api.getLabelRunStatus).not.toHaveBeenCalled();
    expect(api.getRecordedScans).not.toHaveBeenCalled();
    resetOutboxForTest();
    resetSyncStatus();
  });

  it("prints a scanned asset's stored label to the USB printer with offsets and print mode", async () => {
    render_();
    await scan('10042');
    await screen.findAllByText('Printed');
    expect(station.sent).toEqual([withPrintMode(applyPrintSettings(ZPL, {
      ...DEFAULT_PRINT_SETTINGS, horizontalOffset: 12, verticalOffset: -4,
    }, { singleCopy: true }), true)]);
    expect(station.sent[0]).toContain('^MMP');
    expect(screen.getByTestId('station-asset').textContent).toContain('Rack 4 server');
  });

  it('records a Labeled scan in the outbox, never on Reprint', async () => {
    render_();
    await scan('sn-4242');
    await screen.findAllByText('Printed');
    await waitFor(() => expect(readOutbox().rows).toHaveLength(1));
    expect(readOutbox().rows[0]).toMatchObject({
      scanned_value: 'sn-4242', scan_type: 'barcode', scan_status: 'labeled',
      site_id: 's-1', initiative_id: 'i-1', asset: { id: 'a-1', asset_id: '10042' },
    });
    await userEvent.click(screen.getByRole('button', { name: 'Reprint' }));
    await waitFor(() => expect(station.sent).toHaveLength(2));
    expect(readOutbox().rows).toHaveLength(1);
  });

  it('row reads Printed + Recorded once the outbox row is accepted', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render_();
      await scan('10042');
      await screen.findAllByText('Printed');
      // offline: the sender tried, the scan waits in the outbox
      await act(async () => { await vi.advanceTimersByTimeAsync(BATCH_DELAY + 100); });
      await waitFor(() => expect(api.postScans).toHaveBeenCalled());
      await act(async () => { await vi.advanceTimersByTimeAsync(RECORDED_POLL_MS); });
      expect(statusCell().textContent).toBe('Printed');
      expect(readOutbox().rows[0].status).not.toBe('accepted');

      // back online: the retry lands and the next look says so
      api.postScans.mockImplementation(accepting);
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
      await waitFor(() => expect(readOutbox().rows[0].status).toBe('accepted'));
      await act(async () => { await vi.advanceTimersByTimeAsync(RECORDED_POLL_MS); });
      await waitFor(() => expect(statusCell().textContent).toBe('Printed + Recorded'));
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs the outbox sender while it is open', async () => {
    api.postScans.mockImplementation(accepting);
    const view = render_();
    await waitFor(() => expect(sender.start).toHaveBeenCalledTimes(1));
    await scan('10042');
    // the sender, not Scanning, takes the printed label's scan to the portal
    await waitFor(() => expect(api.postScans).toHaveBeenCalledTimes(1));
    expect(api.postScans.mock.calls[0][0].scans).toEqual([expect.objectContaining({
      scanned_value: '10042', scan_type: 'barcode', scan_status: 'labeled', asset_id: 'a-1',
    })]);
    expect(sender.stop).not.toHaveBeenCalled();
    view.unmount();
    expect(sender.stop).toHaveBeenCalledTimes(1);
  });

  it('a scan while syncing shows the syncing message and prints nothing', async () => {
    void runSync('i-1', 'NAP11 Hall Migration');   // still downloading
    render_();
    await scan('10042');
    expect((await screen.findAllByText(SYNCING_TEXT)).length).toBeGreaterThan(0);
    expect(station.sent).toEqual([]);
    expect(readOutbox().rows).toEqual([]);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
  });

  it("header shows labels ready and how many couldn't be made, by reason", async () => {
    await writeMeta(LABELS_META_KEY, {
      initiativeId: 'i-1', kind: 'top', dpi: 203, total: 121, ready: 118, errors: 3, unsupported: 1,
      problems: { template_unsupported: 1, no_template_at_dpi: 2 },
    });
    build.status = idle({ ready: 0, errors: 0 });
    render_();
    expect(await screen.findByText('0 labels ready')).toBeTruthy();

    // the build finished: the header follows without waiting for its next look
    buildChanged(idle({ total: 121, done: 121, ready: 118, errors: 3, unsupported: 1 }));
    expect(await screen.findByText("118 labels ready · 3 couldn't be made")).toBeTruthy();
    const reasons = [...document.querySelectorAll('.station-label-reasons li')].map((li) => li.textContent);
    expect(reasons).toEqual([
      "2 couldn't be made: this move has no active label template at this printer's DPI. "
        + 'Someone with label access needs to activate one on Labels › Templates.',
      "1 couldn't be made: the move's label template is newer than this kiosk can print. "
        + 'This kiosk needs an update.',
    ]);
    // web counts labels, not templates: no laptop notice
    expect(screen.queryByText(/need(s)? a (laptop|kiosk) update\.$/)).toBeNull();

    buildChanged(idle({ ready: 1 }));
    expect(await screen.findByText('1 label ready')).toBeTruthy();
    expect(document.querySelector('.station-label-reasons')).toBeNull();
  });

  it('every reason reads as a count with a sentence of its own', async () => {
    await writeMeta(LABELS_META_KEY, {
      initiativeId: 'i-1', kind: 'top', dpi: 203,
      problems: { template_failed: 1, odd_reason: 2, no_template_at_dpi: 1, template_unsupported: 3 },
    });
    build.status = idle({ ready: 5, errors: 7, unsupported: 3 });
    render_();
    expect(await screen.findByText("5 labels ready · 7 couldn't be made")).toBeTruthy();
    const reasons = [...document.querySelectorAll('.station-label-reasons li')].map((li) => li.textContent);
    expect(reasons).toEqual([
      "1 couldn't be made: this move has no active label template at this printer's DPI. "
        + 'Someone with label access needs to activate one on Labels › Templates.',
      "1 couldn't be made: the move's label template couldn't be built.",
      "3 couldn't be made: the move's label template is newer than this kiosk can print. "
        + 'This kiosk needs an update.',
      "2 couldn't be made: odd_reason.",
    ]);
  });

  /** The header's note box, as one string (links and all). */
  const headerNote = () => (document.querySelector('.station-label-count') as HTMLElement | null);

  it("with this move's label data not downloaded, the header and every scan say to sync from Kiosk Setup", async () => {
    build.status = idle({ total: 0, done: 0, ready: 0, blocked: 'not_downloaded' });
    render_();
    await waitFor(() => expect(headerNote()?.textContent)
      .toBe("This kiosk doesn't have this move's label data yet. Sync again from Kiosk Setup."));
    expect(within(headerNote()!).getByRole('link', { name: 'Kiosk Setup' }).getAttribute('href')).toBe('/setup');
    expect(screen.queryByText(/labels? ready/)).toBeNull();

    await scan('10042');
    expect((await screen.findAllByText(notDownloadedText('kiosk'))).length).toBeGreaterThan(0);
    expect(notDownloadedText('kiosk'))
      .toBe("This kiosk doesn't have this move's label data yet. Sync again from Kiosk Setup.");
    expect(station.sent).toEqual([]);
    expect(readOutbox().rows).toEqual([]);

    // a sync brings it: the build's status says so, and the note goes
    buildChanged(idle({ ready: 1 }));
    expect(await screen.findByText('1 label ready')).toBeTruthy();
    expect(headerNote()?.textContent).toBe('1 label ready');
  });

  it("with only this move's templates missing, the header says so", async () => {
    build.status = idle({ total: 0, done: 0, ready: 0, blocked: 'templates_missing' });
    render_();
    await waitFor(() => expect(headerNote()?.textContent)
      .toBe("This kiosk doesn't have this move's label templates yet. Sync again from Kiosk Setup."));
    expect(within(headerNote()!).getByRole('link', { name: 'Kiosk Setup' }).getAttribute('href')).toBe('/setup');
  });

  it("a build that failed says why under the counts, with Kiosk Setup's link", async () => {
    build.status = idle({ ready: 3, error: 'the label worker failed to run' });
    render_();
    expect(await screen.findByText('3 labels ready')).toBeTruthy();
    await waitFor(() => expect(headerNote()?.textContent).toContain(
      "Labels couldn't be made (the label worker failed to run). Sync again from Kiosk Setup."));
    expect(within(headerNote()!).getByRole('link', { name: 'Kiosk Setup' }).getAttribute('href')).toBe('/setup');

    buildChanged(idle({ ready: 4 }));
    expect(await screen.findByText('4 labels ready')).toBeTruthy();
    expect(screen.queryByText(/couldn't be made \(/)).toBeNull();
  });

  it('with no move data at all, only the roster note says to sync', async () => {
    await replaceAll('assets', []);
    build.status = idle({ total: 0, done: 0, ready: 0, blocked: 'not_downloaded' });
    render_();
    expect(await screen.findByText('No move data on this kiosk. Sync it from Kiosk Setup.')).toBeTruthy();
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText(/label data yet/)).toBeNull();
  });

  it('a Labeled scan the outbox gave up on reads "scan not recorded", and Retry sends it again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render_();
      await scan('10042');
      await waitFor(() => expect(readOutbox().rows).toHaveLength(1));
      await scan('sn-4242');
      await waitFor(() => expect(readOutbox().rows).toHaveLength(2));
      // offline all the way down the outbox's backoff ladder
      for (let i = 0; i < 6; i += 1) {
        await act(async () => { await vi.advanceTimersByTimeAsync(61_000); });
      }
      await waitFor(() => expect(readOutbox().rows.every((r) => r.status === 'failed')).toBe(true));
      await act(async () => { await vi.advanceTimersByTimeAsync(RECORDED_POLL_MS); });
      await waitFor(() => expect(statusCell().textContent).toBe('Printed · scan not recorded'));
      const card = document.querySelector('.station-result .station-status') as HTMLElement;
      expect(card.textContent).toBe('Printed · scan not recorded');
      expect(screen.getByText("The scans for 2 printed labels weren't recorded.")).toBeTruthy();

      api.postScans.mockImplementation(accepting);
      await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
      await waitFor(() => expect(readOutbox().rows.every((r) => r.status === 'accepted')).toBe(true));
      await act(async () => { await vi.advanceTimersByTimeAsync(RECORDED_POLL_MS); });
      await waitFor(() => expect(statusCell().textContent).toBe('Printed + Recorded'));
      expect(screen.queryByText(/printed labels? (wasn't|weren't) recorded/)).toBeNull();
      expect(screen.queryByText(/scan not recorded/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('one scan not recorded reads in the singular', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      api.postScans.mockImplementation(rejecting);
      render_();
      await scan('10042');
      await waitFor(() => expect(readOutbox().rows[0]?.status).toBe('failed'));
      await act(async () => { await vi.advanceTimersByTimeAsync(RECORDED_POLL_MS); });
      expect(await screen.findByText("The scan for 1 printed label wasn't recorded.")).toBeTruthy();
      expect(statusCell().textContent).toBe('Printed · scan not recorded');
    } finally {
      vi.useRealTimers();
    }
  });

  it('sends the scans the outbox gave up on again when the station opens', async () => {
    // a Labeled scan an earlier visit gave up on
    const old: OutboxRow = {
      client_scan_id: 'old-1', seq: 1, scanned_value: '10042', scan_type: 'barcode',
      scanned_at: '2026-11-04T09:00:00.000Z', asset: null, matched: true, status: 'failed', attempts: 5,
      last_error: 'network_error', site_id: 's-1', initiative_id: 'i-1', scan_status: 'labeled',
    };
    await putRows('outbox', [old]);
    api.postScans.mockImplementation(accepting);
    render_();
    await waitFor(() => expect(api.postScans).toHaveBeenCalledTimes(1));
    expect(api.postScans.mock.calls[0][0].scans.map((x: KioskScanIn) => x.client_scan_id)).toEqual(['old-1']);
    await waitFor(() => expect(readOutbox().rows[0].status).toBe('accepted'));
  });

  it('sends them again when the browser is back online, and stops listening once closed', async () => {
    api.postScans.mockImplementation(rejecting);
    const view = render_();
    await scan('10042');
    await waitFor(() => expect(readOutbox().rows[0]?.status).toBe('failed'));

    api.postScans.mockImplementation(accepting);
    act(() => { window.dispatchEvent(new Event('online')); });
    await waitFor(() => expect(readOutbox().rows[0].status).toBe('accepted'));

    const removed = vi.spyOn(window, 'removeEventListener');
    view.unmount();
    expect(removed).toHaveBeenCalledWith('online', expect.any(Function));
    removed.mockRestore();
  });

  it('a scan that hits a too-new template refreshes the header', async () => {
    build.status = idle({ ready: 1, errors: 0 });
    render_();
    expect(await screen.findByText('1 label ready')).toBeTruthy();
    // what the store holds now, though nobody said so yet
    await putRows('labels', [labelRow({ zpl: null, error: 'template_unsupported' })]);
    await writeMeta(LABELS_META_KEY, {
      initiativeId: 'i-1', kind: 'top', dpi: 203, problems: { template_unsupported: 1 },
    });
    build.status = idle({ ready: 0, errors: 1, unsupported: 1 });
    await scan('10042');
    expect((await screen.findAllByText('This kiosk needs an update to print this template.')).length)
      .toBeGreaterThan(0);
    expect(await screen.findByText("0 labels ready · 1 couldn't be made")).toBeTruthy();
    expect(station.sent).toEqual([]);
  });

  it("problems from another move's build aren't listed", async () => {
    await writeMeta(LABELS_META_KEY, {
      initiativeId: 'i-9', kind: 'top', dpi: 203, problems: { template_failed: 4 },
    });
    build.status = idle({ ready: 2, errors: 4 });
    render_();
    expect(await screen.findByText("2 labels ready · 4 couldn't be made")).toBeTruthy();
    expect(document.querySelector('.station-label-reasons')).toBeNull();
  });

  /** Printer Setup's stand-in: shows the state it was opened with, and
   *  goes back the way the real page's Back does. */
  function PrinterSetupStub() {
    const location = useLocation();
    const navigate = useNavigate();
    const state = location.state as { returnTo?: string } | null;
    return (
      <div>
        <p>Printer Setup page</p>
        <p data-testid="setup-state">{JSON.stringify(state)}</p>
        <button type="button" onClick={() => navigate(state?.returnTo ?? '/labels', {
          replace: true, state: { fromPrinterSetup: true },
        })}>Stub back</button>
      </div>
    );
  }

  const renderRouted = () => render(
    <MemoryRouter initialEntries={['/labels/station']}>
      <Routes>
        <Route path="/labels/station" element={<PrintingStation />} />
        <Route path="/labels/printers" element={<PrinterSetupStub />} />
      </Routes>
    </MemoryRouter>,
  );

  function noPrinter() {
    localStorage.removeItem('ss.kiosk.labelPrinting');
    station.state = 'no_settings';
  }

  it('with no printer saved, the first visit opens Printer Setup', async () => {
    noPrinter();
    renderRouted();
    expect(await screen.findByText('Printer Setup page')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('setup-state').textContent ?? 'null'))
      .toEqual({ returnTo: '/labels/station' });
  });

  it('with a printer saved, the station stays put', async () => {
    renderRouted();
    await screen.findByLabelText('Scan value');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText('Printer Setup page')).toBeNull();
  });

  it('coming back from Printer Setup without saving shows the note linking to Printer Setup, not Kiosk Setup', async () => {
    noPrinter();
    renderRouted();
    await userEvent.click(await screen.findByRole('button', { name: 'Stub back' }));
    expect(await screen.findByText(/No label printer is saved for this kiosk/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Printing Station' })).toBeTruthy();
    // once per visit: it doesn't send the person straight back
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByText('Printer Setup page')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Kiosk Setup' })).toBeNull();
    const link = screen.getByRole('link', { name: 'Printer Setup' });
    expect(link.getAttribute('href')).toBe('/labels/printers');
    // the link opens Printer Setup to come back here again
    await userEvent.click(link);
    expect(await screen.findByText('Printer Setup page')).toBeTruthy();
    expect(JSON.parse(screen.getByTestId('setup-state').textContent ?? 'null'))
      .toEqual({ returnTo: '/labels/station' });
  });
});
