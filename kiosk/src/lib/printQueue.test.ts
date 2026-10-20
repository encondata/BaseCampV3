/** The Printing Station's queue against a fake printer: what it sends,
 *  when it records a Labeled scan, the peel wait, failures and Retry. */
import type { HostStatus } from '@portal/labels/zebraUsb';
import { applyPrintSettings, DEFAULT_PRINT_SETTINGS } from '@portal/lib/printLabels';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type LabelStationSettings, type StationLabel } from './api';
import {
  createPrintQueue, PRINTER_SILENT_TEXT, type PrintAsset, type PrintedJob, type QueueState,
} from './printQueue';
import { withPrintMode, type StationPrinter } from './stationPrinter';

const ZPL = '^XA^FO10,10^FDHELLO^FS^XZ';

const asset = (n: number): PrintAsset => ({
  id: `a-${n}`, asset_id: String(10000 + n), name: `Server ${n}`, rfid: null,
  serial_number: `SN-${n}`, make: 'Dell', model: 'R640', make_model: 'Dell R640',
});

function hs(over: Partial<HostStatus> = {}): HostStatus {
  return {
    paperOut: false, paused: false, labelLength: 0, formatsQueued: 0, bufferFull: false,
    partialFormat: false, corruptRam: false, underTemp: false, overTemp: false,
    headOpen: false, ribbonOut: false, thermalTransfer: false, printMode: 'T',
    labelWaiting: false, labelsRemaining: 0, ...over,
  };
}

function settings(over: Partial<LabelStationSettings> = {}): LabelStationSettings {
  return {
    label_kind: 'top', dpi: 203, offset_x: 0, offset_y: 0, peel: false,
    printer: { type: 'network', ip: '10.0.0.40', model: 'ZD421', serial: null }, ...over,
  };
}

function label(assetId: string, over: Partial<StationLabel> = {}): StationLabel {
  return { asset_id: assetId, zpl: ZPL, error: null, template_name: 'Generic', dpi: 203, label_kind: 'top', ...over };
}

/** A fake printer: `statuses` are answered in turn (the last one repeats);
 *  a status that is an Error is thrown. */
function fakePrinter(statuses: (HostStatus | Error | null)[] = [hs()]) {
  const sent: string[] = [];
  let i = 0;
  const printer = {
    kind: 'network', ip: '10.0.0.40', serial: null,
    identify: vi.fn(), peeler: vi.fn(), query: vi.fn(), sendFont: vi.fn(),
    status: vi.fn(async () => {
      const s = statuses[Math.min(i, statuses.length - 1)];
      i += 1;
      if (s instanceof Error) throw s;
      return s;
    }),
    send: vi.fn(async (zpl: string) => { sent.push(zpl); }),
  } as unknown as StationPrinter & { status: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
  return { printer, sent };
}

function setup(opts: {
  printer?: StationPrinter | null;
  settings?: LabelStationSettings;
  getLabel?: (id: string) => Promise<StationLabel>;
  recordPrinted?: (job: PrintedJob) => Promise<void>;
  sleep?: (ms: number) => Promise<void>;
} = {}) {
  let state: QueueState = { entries: [] };
  const recordPrinted = vi.fn(opts.recordPrinted ?? (async (_job: PrintedJob) => {}));
  const getLabel = vi.fn(opts.getLabel ?? (async (id: string) => label(id)));
  const printer = opts.printer === undefined ? fakePrinter().printer : opts.printer;
  const queue = createPrintQueue({
    printer: () => printer,
    settings: () => opts.settings ?? settings(),
    getLabel,
    recordPrinted,
    sleep: opts.sleep ?? (async () => {}),
    onChange: (s) => { state = s; },
  });
  return { queue, recordPrinted, getLabel, state: () => state };
}

const settled = (get: () => QueueState) => vi.waitFor(() => {
  const entries = get().entries;
  if (entries.length === 0 || entries.some((e) => !['printed', 'failed'].includes(e.state))) {
    throw new Error('still printing');
  }
});

describe('createPrintQueue', () => {
  it('prints with the saved offsets and ^MMP in peel mode', async () => {
    const { printer, sent } = fakePrinter();
    const s = settings({ offset_x: 12, offset_y: -4, peel: true });
    const q = setup({ printer, settings: s });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    const expected = withPrintMode(applyPrintSettings(ZPL, {
      ...DEFAULT_PRINT_SETTINGS, horizontalOffset: 12, verticalOffset: -4,
    }, { singleCopy: true }), true);
    expect(sent).toEqual([expected]);
    expect(sent[0]).toContain('^MMP');
    expect(sent[0]).toContain('^LS-12');
    expect(sent[0]).toContain('^LT-4');
    expect(q.state().entries[0].state).toBe('printed');
  });

  it('prints tear-off (^MMT) when peel is off', async () => {
    const { printer, sent } = fakePrinter();
    const q = setup({ printer });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    expect(sent[0]).toContain('^MMT');
    expect(sent[0]).not.toContain('^MMP');
  });

  it('records a Labeled scan once per scan, repeat scans included, with the exact value scanned', async () => {
    const q = setup();
    q.queue.enqueue({ asset: asset(1), scannedValue: 'sn-1' });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await vi.waitFor(() => expect(q.state().entries).toHaveLength(2));
    await settled(q.state);
    expect(q.recordPrinted).toHaveBeenCalledTimes(2);
    expect(q.recordPrinted.mock.calls[0][0]).toMatchObject({ assetId: 'a-1', scannedValue: 'sn-1' });
    expect(q.recordPrinted.mock.calls[1][0]).toMatchObject({ assetId: 'a-1', scannedValue: '10001' });
    expect(typeof q.recordPrinted.mock.calls[0][0].scannedAt).toBe('string');
  });

  it('Reprint and Retry never record', async () => {
    const { printer, sent } = fakePrinter([hs({ paperOut: true }), hs()]);
    const q = setup({ printer });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    expect(q.state().entries[0].state).toBe('failed');
    q.queue.retry(q.state().entries[0].id);
    await vi.waitFor(() => expect(q.state().entries[0].state).toBe('printed'));
    q.queue.reprint(q.state().entries[0].id);
    await vi.waitFor(() => expect(q.state().entries).toHaveLength(2));
    await settled(q.state);
    expect(q.state().entries[0]).toMatchObject({ state: 'printed', reprint: true });
    expect(sent).toHaveLength(2);
    expect(q.recordPrinted).not.toHaveBeenCalled();
  });

  it('a printer status problem fails the entry, sends nothing and records nothing', async () => {
    const { printer, sent } = fakePrinter([hs({ headOpen: true, paused: true })]);
    const q = setup({ printer });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    expect(q.state().entries[0]).toMatchObject({
      state: 'failed', message: 'Head open: close the print head. Paused: press Pause on the printer to resume.',
    });
    expect(sent).toEqual([]);
    expect(q.recordPrinted).not.toHaveBeenCalled();
  });

  it('peel mode waits while a label is waiting to be taken, and the next job waits too', async () => {
    const { printer, sent } = fakePrinter([
      hs(),                         // job 1: before sending
      hs({ labelWaiting: true }),   // job 1: polls
      new Error('timeout'),         // a failed poll keeps waiting
      hs({ labelWaiting: true }),
      hs(),                         // taken
      hs(),                         // job 2: before sending
      hs(),                         // job 2: taken at once
    ]);
    let release: () => void = () => {};
    const sleeps: number[] = [];
    const sleep = vi.fn((ms: number) => {
      sleeps.push(ms);
      // Hold the second poll until the test has looked.
      if (sleeps.length === 2) return new Promise<void>((r) => { release = r; });
      return Promise.resolve();
    });
    const q = setup({ printer, settings: settings({ peel: true }), sleep });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    q.queue.enqueue({ asset: asset(2), scannedValue: '10002' });
    await vi.waitFor(() => expect(sleeps).toHaveLength(2));
    const byAsset = (id: string) => q.state().entries.find((e) => e.asset?.id === id)!;
    expect(byAsset('a-1').state).toBe('take_label');
    expect(byAsset('a-2').state).toBe('queued');
    expect(sent).toHaveLength(1);
    release();
    await settled(q.state);
    expect(byAsset('a-1').state).toBe('printed');
    expect(byAsset('a-2').state).toBe('printed');
    expect(sent).toHaveLength(2);
    expect(sleeps.every((ms) => ms === 500)).toBe(true);
  });

  it('a printer that throws fails the entry, and Retry resends the same ZPL', async () => {
    const { printer, sent } = fakePrinter();
    printer.send.mockImplementationOnce(async () => { throw new Error('network'); });
    const q = setup({ printer, settings: settings({ offset_x: 5 }) });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    expect(q.state().entries[0]).toMatchObject({ state: 'failed', message: PRINTER_SILENT_TEXT });
    expect(q.recordPrinted).not.toHaveBeenCalled();
    const first = printer.send.mock.calls[0][0];
    q.queue.retry(q.state().entries[0].id);
    await vi.waitFor(() => expect(q.state().entries[0].state).toBe('printed'));
    expect(sent).toEqual([first]);
    expect(q.getLabel).toHaveBeenCalledTimes(1);
    expect(q.state().entries).toHaveLength(1);
  });

  it('a status that throws fails the entry before anything is sent', async () => {
    const { printer, sent } = fakePrinter([new Error('timeout')]);
    const q = setup({ printer });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    expect(q.state().entries[0]).toMatchObject({ state: 'failed', message: PRINTER_SILENT_TEXT });
    expect(sent).toEqual([]);
  });

  it('runs jobs strictly one at a time in arrival order', async () => {
    const { printer, sent } = fakePrinter();
    const pending: (() => void)[] = [];
    const getLabel = vi.fn((id: string) => new Promise<StationLabel>((r) => {
      pending.push(() => r({ ...label(id), zpl: `^XA^FD${id}^FS^XZ` }));
    }));
    const q = setup({ printer, getLabel });
    for (const n of [1, 2, 3]) q.queue.enqueue({ asset: asset(n), scannedValue: String(10000 + n) });
    await vi.waitFor(() => expect(pending).toHaveLength(1));
    expect(getLabel).toHaveBeenCalledTimes(1);
    for (let n = 0; n < 3; n += 1) {
      await vi.waitFor(() => expect(pending).toHaveLength(n + 1));
      pending[n]();
    }
    await settled(q.state);
    expect(sent.map((z) => z.match(/\^FD(a-\d)/)?.[1])).toEqual(['a-1', 'a-2', 'a-3']);
    // Newest first.
    expect(q.state().entries.map((e) => e.asset?.id)).toEqual(['a-3', 'a-2', 'a-1']);
  });

  it('an asset that is not on the move fails at once and sends nothing', async () => {
    const { printer, sent } = fakePrinter();
    const q = setup({ printer });
    q.queue.enqueue({ asset: null, scannedValue: 'NOPE' });
    await settled(q.state);
    expect(q.state().entries[0]).toMatchObject({ state: 'failed', message: "This asset isn't on this move." });
    expect(sent).toEqual([]);
    expect(q.recordPrinted).not.toHaveBeenCalled();
  });

  it('a label error says the stored reason', async () => {
    const q = setup({ getLabel: async (id) => label(id, { zpl: null, error: 'no_template_at_dpi' }) });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    expect(q.state().entries[0].message).toBe("No label for this asset: no template at this printer's DPI");
    const q2 = setup({ getLabel: async (id) => label(id, { zpl: null, error: 'template_failed' }) });
    q2.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q2.state);
    expect(q2.state().entries[0].message).toBe("No label for this asset: the label template couldn't be built");
  });

  it('labels_regenerating asks to scan again when it finishes', async () => {
    const q = setup({ getLabel: async () => { throw new ApiError(409, 'labels_regenerating'); } });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    expect(q.state().entries[0].message).toBe('Labels are being regenerated. Scan again when it finishes.');
  });

  it('a failed record still counts as printed, with a warning, and never reprints', async () => {
    const { printer, sent } = fakePrinter();
    const q = setup({ printer, recordPrinted: async () => { throw new ApiError(422, 'scan_value_mismatch'); } });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    expect(q.state().entries[0].state).toBe('printed');
    expect(q.state().entries[0].recordWarning).toMatch(/^Printed, but the scan wasn't recorded: /);
    expect(sent).toHaveLength(1);
  });
});
