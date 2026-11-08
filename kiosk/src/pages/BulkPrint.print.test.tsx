// @vitest-environment jsdom
/** Bulk Print's printing: each label goes through the saved printer with
 *  its offsets and print mode, a selection larger than the batch size runs
 *  in batches that wait for the printer at the end of each, rack blanks
 *  and Front separators, Custom ZPL, missing labels, a failed send and
 *  Reprint, auto print next — and never a Labeled scan. */
import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  blankLabelsZpl, labelDots, rackSeparatorZpl, readPrintSettings, writePrintSettings,
  type PrintSettings,
} from '@portal/lib/printLabels';

import type { FakeStation } from './bulkPrintTestHarness';

const api = vi.hoisted(() => ({
  fetchLabelVocab: vi.fn(), fetchKioskLabelBundle: vi.fn(), postLabelPrinted: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, ...api };
});

const station = vi.hoisted(() => ({
  state: 'ready', sent: [], sendError: null, settings: null,
  connectUsb: async () => undefined,
  waitForIdle: async () => undefined,
}) as unknown as FakeStation);
vi.mock('../lib/useStationPrinter', async () => (
  (await import('./bulkPrintTestHarness')).stationPrinterModule(station)));

vi.mock('../auth/KioskAuthContext', () => ({
  useKioskAuth: () => ({ status: 'authed', preferences: { list_size: 'default' }, can: () => true }),
}));

import type { KioskAssetRow, LabelStationSettings } from '../lib/api';
import { stationZpl } from '../lib/bulkPrintSettings';
import { getAll } from '../lib/localDb';
import BulkPrint from './BulkPrint';
import {
  ASSETS, bundle, deferred, findRow, label, labelChip, resetStation, seedMove, typeCard,
  USB_SETTINGS, VOCAB,
} from './bulkPrintTestHarness';

/** The saved printer: offsets and peel come from Printer Setup. */
const SAVED: LabelStationSettings = {
  ...USB_SETTINGS, offset_x: 8, offset_y: -3, peel: true, printer: { ...USB_SETTINGS.printer },
};

/** Three assets: two in rack A01 (RU 20 and RU 10), one in A02. */
const THREE: KioskAssetRow[] = [
  ASSETS[0],
  ASSETS[1],
  {
    ...ASSETS[0], id: 'a-3', asset_id: '10003', name: 'Rack A01 storage', serial_number: 'SN-3',
    legacy_id: 10003, source_rack: 'A01', source_ru: '10',
  },
];
const NAMES = ['Rack A01 server', 'Spare switch', 'Rack A01 storage'];
const ID_OF = new Map(THREE.map((a) => [a.name, a.id]));

/** The asset ids in the list's displayed order. */
function listedIds(): string[] {
  return screen.getAllByRole('checkbox', { name: /^Select (?!all)/ })
    .map((b) => ID_OF.get((b.getAttribute('aria-label') ?? '').replace(/^Select /, '')) ?? '');
}

const code = (id: string) => `^XA^FD${id}^FS^XZ`;
/** A Front label's code carries its stock (^PW / ^LL), as compiled. */
const frontCode = (id: string) => `^XA^PW812^LL406^FD${id}^FS^XZ`;

beforeEach(async () => {
  await seedMove('i-1', 'i-1', THREE);
  resetStation(station);
  station.settings = SAVED;
  station.waitForIdle = vi.fn(async () => undefined);
  api.postLabelPrinted.mockReset();
  api.fetchLabelVocab.mockReset().mockResolvedValue(VOCAB);
  api.fetchKioskLabelBundle.mockReset().mockImplementation(async (id: string, type: string) => (
    bundle(type, ['a-1', 'a-2', 'a-3'].map((e) => label(e, '203', {
      code: type === 'front' ? frontCode(e) : code(e),
    })), id)));
});

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

const render_ = () => render(<MemoryRouter><BulkPrint /></MemoryRouter>);

/** The page's settings as stored (copies 1 unless a test wrote others). */
const expected = (zpl: string, opts?: { singleCopy?: boolean }, s: PrintSettings = readPrintSettings()) => (
  stationZpl(zpl, s, SAVED, opts));

const writeSettings = (patch: Partial<PrintSettings>) => writePrintSettings({ ...readPrintSettings(), ...patch });

async function labelsReady(name = 'Rack A01 server') {
  await waitFor(async () => expect(labelChip(await findRow(name))).toBe('Ready'));
}

async function tick(...names: string[]) {
  for (const name of names) await userEvent.click(screen.getByRole('checkbox', { name: `Select ${name}` }));
}

it('a print sends each label with the saved offsets and print mode', async () => {
  render_();
  await labelsReady();
  await tick('Rack A01 server', 'Spare switch');
  const order = listedIds().filter((id) => id === 'a-1' || id === 'a-2');
  await userEvent.click(screen.getByRole('button', { name: 'Print 2 labels' }));
  expect(await screen.findByText('Successfully printed 2 label(s)')).toBeTruthy();
  expect(station.sent).toEqual(order.map((e) => expected(code(e))));
  for (const zpl of station.sent) {
    expect(zpl).toContain('^MMP');
    expect(zpl).toContain('^LS-8');
    expect(zpl).toContain('^LT-3');
  }
  expect(station.waitForIdle).not.toHaveBeenCalled();
});

it('at the end of a batch waitForIdle gets the labels sent and progress follows onQueued', async () => {
  const gate = deferred<void>();
  station.waitForIdle = vi.fn(async (_labels: number, onQueued?: (queued: number) => void) => {
    onQueued?.(1);
    await gate.promise;
  });
  render_();
  await labelsReady();

  await userEvent.click(screen.getByRole('button', { name: 'Print settings' }));
  const size = screen.getByLabelText('Batch size');
  await userEvent.clear(size);
  await userEvent.type(size, '2{Enter}');
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));

  await tick(...NAMES);
  const order = listedIds();
  await userEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  const dialog = await screen.findByRole('dialog', { name: 'Printing labels' });
  expect(within(dialog).getByText('Move i-1 · Top Label · 3 labels in 2 batches of 2')).toBeTruthy();
  await waitFor(() => expect(station.waitForIdle).toHaveBeenCalledTimes(1));
  expect(station.waitForIdle).toHaveBeenNthCalledWith(1, 2, expect.any(Function));
  expect(await within(dialog).findByText('1 of 3')).toBeTruthy();
  expect(within(dialog).getByText('Batch 1 sent - waiting for printer to finish printing…')).toBeTruthy();

  await act(async () => { gate.resolve(); await gate.promise; });
  expect(await within(dialog).findByText('Batch 1 complete! Ready to print next batch.')).toBeTruthy();
  expect(within(dialog).getByText('2 of 3')).toBeTruthy();

  await userEvent.click(within(dialog).getByRole('button', { name: 'Print next batch (1 labels)' }));
  expect(await within(dialog).findByText('All 3 labels printed successfully!')).toBeTruthy();
  expect(station.waitForIdle).toHaveBeenCalledTimes(2);
  expect(station.waitForIdle).toHaveBeenNthCalledWith(2, 1, expect.any(Function));
  expect(station.sent).toEqual(order.map((e) => expected(code(e))));

  await userEvent.click(within(dialog).getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('dialog', { name: 'Printing labels' })).toBeNull();
  expect(await screen.findByText('Successfully printed 3 label(s)')).toBeTruthy();
});

it('copies count in the wait', async () => {
  writeSettings({ copies: 2, batchSize: 1 });
  render_();
  await labelsReady();
  await tick('Rack A01 server', 'Spare switch');
  await userEvent.click(screen.getByRole('button', { name: 'Print 2 labels' }));
  await waitFor(() => expect(station.waitForIdle).toHaveBeenCalledWith(2, expect.any(Function)));
  expect(station.sent).toHaveLength(1);
  expect(station.sent[0]).toContain('^PQ2^XZ');
});

it('print by rack feeds blanks between racks', async () => {
  writeSettings({ printByRack: true, blanksBetweenRacks: 2 });
  render_();
  await labelsReady();
  await tick(...NAMES);
  await userEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  expect(await screen.findByText('Successfully printed 3 label(s)')).toBeTruthy();
  expect(station.sent).toEqual([
    expected(code('a-1')),
    expected(code('a-3')),
    expected(blankLabelsZpl(2), { singleCopy: true }),
    expected(code('a-2')),
  ]);
});

it('a Front job leads with a named separator', async () => {
  writeSettings({ printByRack: true, blanksBetweenRacks: 2 });
  render_();
  await labelsReady();
  await userEvent.click(typeCard('Front Label'));
  await labelsReady();
  await tick(...NAMES);
  await userEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  expect(await screen.findByText('Successfully printed 3 label(s)')).toBeTruthy();
  const item = label('a-1', '203', { code: frontCode('a-1') });
  const separator = rackSeparatorZpl('A01', 2, labelDots(item, VOCAB));
  expect(separator).toContain('^FDA01^FS');
  expect(station.sent[0]).toBe(expected(separator, { singleCopy: true }));
  expect(station.sent).toHaveLength(5);
  expect(station.sent[3]).toContain('^FDA02^FS');
});

it('custom ZPL sends once with nothing ticked', async () => {
  render_();
  await labelsReady();
  await userEvent.click(typeCard('Custom'));
  await userEvent.type(screen.getByLabelText('Raw ZPL'), '^XA^FDHi^FS^XZ');
  await userEvent.click(screen.getByRole('button', { name: 'Print 1 label' }));
  expect(await screen.findByText('Successfully printed 1 label(s)')).toBeTruthy();
  expect(station.sent).toEqual([expected('^XA^FDHi^FS^XZ')]);
});

it('custom ZPL sends once per ticked asset', async () => {
  render_();
  await labelsReady();
  await userEvent.click(typeCard('Custom'));
  await userEvent.type(screen.getByLabelText('Raw ZPL'), '^XA^FDHi^FS^XZ');
  await tick('Rack A01 server', 'Spare switch');
  await userEvent.click(screen.getByRole('button', { name: 'Print 2 labels' }));
  expect(await screen.findByText('Successfully printed 2 label(s)')).toBeTruthy();
  expect(station.sent).toEqual([expected('^XA^FDHi^FS^XZ'), expected('^XA^FDHi^FS^XZ')]);
});

it('missing labels block the print', async () => {
  api.fetchKioskLabelBundle.mockImplementation(async (id: string, type: string) => (
    bundle(type, [label('a-1', '203', { code: code('a-1') }), label('a-2', '300')], id)));
  render_();
  await labelsReady();
  await tick('Rack A01 server', 'Spare switch');
  await userEvent.click(screen.getByRole('button', { name: 'Print 2 labels' }));
  expect(await screen.findByText(
    '1 selected asset(s) have no Top Label at 203 DPI — generate at 203 DPI.')).toBeTruthy();
  expect(station.sent).toEqual([]);
  await userEvent.click(screen.getByRole('button', { name: 'Deselect missing' }));
  expect((screen.getByRole('checkbox', { name: 'Select Spare switch' }) as HTMLInputElement).checked).toBe(false);
  expect((screen.getByRole('checkbox', { name: 'Select Rack A01 server' }) as HTMLInputElement).checked).toBe(true);
});

it('no outbox scan is queued', async () => {
  render_();
  await labelsReady();
  await tick('Rack A01 server', 'Spare switch');
  await userEvent.click(screen.getByRole('button', { name: 'Print 2 labels' }));
  expect(await screen.findByText('Successfully printed 2 label(s)')).toBeTruthy();
  expect(await getAll('outbox')).toEqual([]);
  expect(api.postLabelPrinted).not.toHaveBeenCalled();
});

it('a failed send stops the batch and Reprint resends it', async () => {
  writeSettings({ batchSize: 2 });
  let calls = 0;
  station.sendHook = () => {
    calls += 1;
    if (calls === 2) throw new Error('USB transfer failed');
  };
  render_();
  await labelsReady();
  await tick(...NAMES);
  const order = listedIds();
  await userEvent.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  const dialog = await screen.findByRole('dialog', { name: 'Printing labels' });
  expect(await within(dialog).findByText('Batch 1 failed: USB transfer failed')).toBeTruthy();
  expect(station.sent).toEqual([expected(code(order[0]))]);
  expect(station.waitForIdle).not.toHaveBeenCalled();
  const reprint = within(dialog).getByRole('button', { name: 'Reprint current batch' }) as HTMLButtonElement;
  const next = within(dialog).getByRole('button', { name: /^Print next batch/ }) as HTMLButtonElement;
  expect(reprint.disabled).toBe(false);
  expect(next.disabled).toBe(true);

  station.sendHook = null;
  await userEvent.click(reprint);
  expect(await within(dialog).findByText('Batch 1 complete! Ready to print next batch.')).toBeTruthy();
  expect(station.sent.slice(1)).toEqual([expected(code(order[0])), expected(code(order[1]))]);
  expect(station.waitForIdle).toHaveBeenCalledWith(2, expect.any(Function));
  expect(within(dialog).queryByText('Batch 1 failed: USB transfer failed')).toBeNull();
  expect(await getAll('outbox')).toEqual([]);
});

it('auto print next counts down from 5 s', async () => {
  writeSettings({ batchSize: 2 });
  const gate = deferred<void>();
  station.waitForIdle = vi.fn(async () => { await gate.promise; });
  render_();
  await labelsReady();
  await tick(...NAMES);
  const order = listedIds();

  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  await user.click(screen.getByRole('button', { name: 'Print 3 labels' }));
  const dialog = await screen.findByRole('dialog', { name: 'Printing labels' });
  await user.click(within(dialog).getByRole('switch', { name: 'Auto print next batch' }));
  await act(async () => { gate.resolve(); await gate.promise; });

  expect(await within(dialog).findByText(/in 5s…/)).toBeTruthy();
  expect(station.sent).toHaveLength(2);
  // the countdown re-arms one 1 s timer per render: step a second at a time
  for (let i = 0; i < 6; i += 1) await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
  await waitFor(() => expect(station.sent).toHaveLength(3));
  expect(await within(dialog).findByText('All 3 labels printed successfully!')).toBeTruthy();
  expect(station.sent[2]).toBe(expected(code(order[2])));
});
