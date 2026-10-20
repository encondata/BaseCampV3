// @vitest-environment jsdom
/** The Printing Station against a real (fake) IndexedDB roster, a fake
 *  station printer and stubbed edge label routes: scanning prints and
 *  shows the asset, and the problems say what's wrong. */
import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IDBFactory } from 'fake-indexeddb';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { HostStatus } from '@portal/labels/zebraUsb';

const api = vi.hoisted(() => ({
  getStationLabel: vi.fn(), postLabelPrinted: vi.fn(), getLabelRunStatus: vi.fn(), getRecordedScans: vi.fn(),
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

const station = vi.hoisted(() => ({
  state: 'ready' as 'loading' | 'ready' | 'needs_usb' | 'no_settings',
  sent: [] as string[],
  connectUsb: vi.fn(),
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
      settings: station.state === 'no_settings' ? null : settings,
      printer: station.state === 'ready' ? printer : null,
      zebra: {},
      state: station.state,
      connectUsb: station.connectUsb,
      reload: async () => {},
    }),
  };
});

import { ApiError } from '../lib/api';
import { clearFlash } from '../lib/flash';
import { writeKioskSetup } from '../lib/kioskSetup';
import { closeDb, replaceAll } from '../lib/localDb';
import PrintingStation, { RECORDED_POLL_MS } from './PrintingStation';

const SERVER = {
  id: 'a-1', asset_id: '10042', name: 'Rack 4 server', rfid: null,
  serial_number: 'SN-4242', make: 'Dell', model: 'R640', make_model: 'Dell R640',
  label: { source_raw: 'A12', source_ru: '22', destination_raw: 'B07', destination_ru: '14' },
};

beforeEach(async () => {
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

afterEach(() => { cleanup(); clearFlash(); vi.clearAllMocks(); });

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
