/** The Printing Station's queue against a fake printer: what it sends,
 *  when it records a Labeled scan, failures and Retry. */
import { applyPrintSettings, DEFAULT_PRINT_SETTINGS } from '@portal/lib/printLabels';
import { describe, expect, it, vi } from 'vitest';

import { ApiError, type LabelStationSettings, type StationLabel } from './api';
import {
  createPrintQueue, NEEDS_UPDATE_TEXT, NO_SETTINGS_TEXT, noLabelText, PRINTER_SILENT_TEXT,
  type PrintAsset, type PrintedJob, type QueueState,
} from './printQueue';
import { withPrintMode, type StationPrinter } from './stationPrinter';

const ZPL = '^XA^FO10,10^FDHELLO^FS^XZ';

const asset = (n: number): PrintAsset => ({
  id: `a-${n}`, asset_id: String(10000 + n), name: `Server ${n}`, rfid: null,
  serial_number: `SN-${n}`, make: 'Dell', model: 'R640', make_model: 'Dell R640',
});

function settings(over: Partial<LabelStationSettings> = {}): LabelStationSettings {
  return {
    label_kind: 'top', dpi: 203, offset_x: 0, offset_y: 0, peel: false,
    printer: { type: 'network', ip: '10.0.0.40', model: 'ZD421', serial: null }, ...over,
  };
}

function label(assetId: string, over: Partial<StationLabel> = {}): StationLabel {
  return { asset_id: assetId, zpl: ZPL, error: null, template_name: 'Generic', dpi: 203, label_kind: 'top', ...over };
}

/** A fake printer that records what it is sent. `status` exists only so a
 *  test can prove it is never called. */
function fakePrinter() {
  const sent: string[] = [];
  const printer = {
    kind: 'network', ip: '10.0.0.40', serial: null,
    identify: vi.fn(), peeler: vi.fn(), query: vi.fn(), sendFont: vi.fn(),
    status: vi.fn(async () => null),
    send: vi.fn(async (zpl: string) => { sent.push(zpl); }),
  } as unknown as StationPrinter & { status: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn> };
  return { printer, sent };
}

function setup(opts: {
  printer?: StationPrinter | null;
  printerRef?: { current: StationPrinter | null };
  settings?: LabelStationSettings | null;
  getLabel?: (id: string) => Promise<StationLabel>;
  recordPrinted?: (job: PrintedJob) => Promise<void>;
} = {}) {
  let state: QueueState = { entries: [] };
  const recordPrinted = vi.fn(opts.recordPrinted ?? (async (_job: PrintedJob) => {}));
  const getLabel = vi.fn(opts.getLabel ?? (async (id: string) => label(id)));
  const ref = opts.printerRef
    ?? { current: opts.printer === undefined ? fakePrinter().printer : opts.printer };
  const queue = createPrintQueue({
    printer: () => ref.current,
    settings: () => (opts.settings === undefined ? settings() : opts.settings),
    getLabel,
    recordPrinted,
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

  it('sends straight to the printer: no status check before or after, even in peel mode', async () => {
    // Jimmy: no status checks between labels. In peel mode the printer
    // itself holds the next label until this one is taken.
    const { printer, sent } = fakePrinter();
    const q = setup({ printer, settings: settings({ peel: true }) });
    for (const n of [1, 2, 3]) q.queue.enqueue({ asset: asset(n), scannedValue: String(10000 + n) });
    await settled(q.state);
    expect(sent).toHaveLength(3);
    expect(printer.status).not.toHaveBeenCalled();
    expect(q.state().entries.every((e) => e.state === 'printed')).toBe(true);
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

  it('a scan that fails and then prints on Retry records exactly once', async () => {
    const { printer, sent } = fakePrinter();
    printer.send.mockImplementationOnce(async () => { throw new Error('network'); });
    const q = setup({ printer });
    q.queue.enqueue({ asset: asset(1), scannedValue: 'SN-1' });
    await settled(q.state);
    expect(q.state().entries[0].state).toBe('failed');
    expect(q.recordPrinted).not.toHaveBeenCalled();
    const id = q.state().entries[0].id;
    q.queue.retry(id);
    await vi.waitFor(() => expect(q.state().entries[0].state).toBe('printed'));
    expect(q.recordPrinted).toHaveBeenCalledTimes(1);
    expect(q.recordPrinted.mock.calls[0][0]).toMatchObject({ assetId: 'a-1', scannedValue: 'SN-1' });
    // A printed entry can't be retried, so it never records twice.
    q.queue.retry(id);
    await settled(q.state);
    expect(sent).toHaveLength(1);
    expect(q.recordPrinted).toHaveBeenCalledTimes(1);
  });

  it('a send that fails after the record would have run records once, on the Retry that prints', async () => {
    const { printer } = fakePrinter();
    printer.send.mockImplementationOnce(async () => { throw new Error('network'); });
    const q = setup({ printer });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    q.queue.retry(q.state().entries[0].id);
    await vi.waitFor(() => expect(q.state().entries[0].state).toBe('printed'));
    expect(q.recordPrinted).toHaveBeenCalledTimes(1);
  });

  it('Reprint never records', async () => {
    const { printer, sent } = fakePrinter();
    const q = setup({ printer });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    expect(q.recordPrinted).toHaveBeenCalledTimes(1);
    q.queue.reprint(q.state().entries[0].id);
    await vi.waitFor(() => expect(q.state().entries).toHaveLength(2));
    await settled(q.state);
    expect(q.state().entries[0]).toMatchObject({ state: 'printed', reprint: true });
    expect(sent).toHaveLength(2);
    expect(q.recordPrinted).toHaveBeenCalledTimes(1);
  });

  it('no readable settings fails the entry and prints nothing', async () => {
    const { printer, sent } = fakePrinter();
    const q = setup({ printer, settings: null });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    expect(q.state().entries[0]).toMatchObject({ state: 'failed', message: NO_SETTINGS_TEXT });
    expect(sent).toEqual([]);
    expect(q.recordPrinted).not.toHaveBeenCalled();
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
    expect(q.state().entries[0].message).toBe("No label for this asset: this move has no active label template "
      + "at this printer's DPI. Someone with label access needs to activate one on Labels › Templates.");
    const q2 = setup({ getLabel: async (id) => label(id, { zpl: null, error: 'template_failed' }) });
    q2.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q2.state);
    expect(q2.state().entries[0].message).toBe("No label for this asset: the label template couldn't be built");
  });

  it('a template too new for this laptop says to update it, and prints nothing', async () => {
    const { printer, sent } = fakePrinter();
    const q = setup({ printer, getLabel: async (id) => label(id, { zpl: null, error: 'template_unsupported' }) });
    q.queue.enqueue({ asset: asset(1), scannedValue: '10001' });
    await settled(q.state);
    const entry = q.state().entries[0];
    expect(entry.state).toBe('failed');
    expect(entry.message).toBe('This laptop needs an update to print this template.');
    expect(entry.message).toBe(NEEDS_UPDATE_TEXT);
    expect(noLabelText('template_unsupported')).toBe(NEEDS_UPDATE_TEXT);
    expect(sent).toEqual([]);
    expect(q.recordPrinted).not.toHaveBeenCalled();
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
