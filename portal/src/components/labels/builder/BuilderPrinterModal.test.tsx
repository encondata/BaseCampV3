// @vitest-environment jsdom
/**
 * The builder's Printer dialog over a fake USB printer: the connection and
 * its health, the DPI note, the alignment label for the template's size at
 * the printer's DPI, and the design's fonts checked against E: and Z:
 * (present on E:, present only on Z:, a missing library font with Install,
 * a missing built-in font without), Install going through the same path as
 * Labels › Printers.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addElement, newDesign, type DesignV2, type ElementV2 } from '../../../labels/builder/model';
import type { HostIdentification, HostStatus } from '../../../labels/zebraUsb';
import type { LabelFont, LabelVocab } from '../../../lib/api';
import BuilderPrinterModal, { type BuilderPrinter } from './BuilderPrinterModal';

afterEach(cleanup);
beforeEach(() => localStorage.clear());

const vocabRow = (kind: string, key: string, label: string, meta: Record<string, unknown> = {}): LabelVocab => ({
  kind, key, label, description: '', meta, sort_order: 0, is_active: true, usage_count: null,
});
const VOCAB: LabelVocab[] = [
  vocabRow('size', '4x2', '4" x 2"', { width_in: 4, height_in: 2 }),
  vocabRow('size', '3x1', '3" x 1"', { width_in: 3, height_in: 1 }),
  vocabRow('dpi', '203', '203 DPI', { dots: 203 }),
  vocabRow('dpi', '300', '300 DPI', { dots: 300 }),
];

const font = (id: string, name: string, family: string, weight: 'regular' | 'bold', resident = false): LabelFont => ({
  id, name, display_name: name, size_bytes: resident ? 0 : 6, content_type: 'font/ttf', uploaded_by: null,
  uploaded_by_name: null, created_at: '', used_by: [], family, weight, resident,
});
const LIBRARY: LabelFont[] = [
  font('f-swiss', 'TT0003M_.TTF', 'swiss721-cond-bold', 'regular', true),
  font('f-rr', 'ROBOTO_R.TTF', 'roboto', 'regular'),
  font('f-rb', 'ROBOTO_B.TTF', 'roboto', 'bold'),
  font('f-mono', 'ROBOMO_R.TTF', 'roboto-mono', 'regular'),
];

function text(id: string, family: string, weight: 'regular' | 'bold'): ElementV2 {
  return { id, type: 'text', content: 'X', x: 0, y: 0, w: 1, h: 0.1, rotation: 0,
    font: { family, weight }, sizePt: 8, baselineIn: 0.08 };
}

/** Swiss (faux Bold: its Regular file only), Roboto Regular and Bold, Oswald. */
const DESIGN: DesignV2 = [
  text('t1', 'swiss721-cond-bold', 'bold'),
  text('t2', 'roboto', 'regular'),
  text('t3', 'roboto', 'bold'),
  text('t4', 'oswald', 'regular'),
].reduce(addElement, newDesign({ w: 4, h: 2 }));

const dirReply = (drive: string, names: string[]) => `\x02- DIR ${drive}:*.TTF\r\n${
  names.map((n) => `* ${drive}:${n}    124336\r\n`).join('')}-1928576 bytes free ${drive}: ONBOARD FLASH\r\n\x03`;

const IDENTITY: HostIdentification = { model: 'ZD421-300dpi', firmware: 'V93.21.26Z', dotsPerMm: 12, memory: '8192k', dpi: 300 };
const STATUS: HostStatus = {
  paperOut: false, paused: false, labelLength: 600, formatsQueued: 0, bufferFull: false, partialFormat: false,
  corruptRam: false, underTemp: false, overTemp: false, headOpen: false, ribbonOut: false, thermalTransfer: false,
  printMode: '0', labelWaiting: false, labelsRemaining: 0,
};

function fakePrinter(over: Partial<BuilderPrinter> = {}, drives = { E: ['ROBOTO_R.TTF'], Z: ['TT0003M_.TTF'] }) {
  const listing = { ...drives };
  const printer = {
    supported: true, connected: true, productName: 'ZD421',
    connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined),
    connectTo: vi.fn(async () => undefined), knownDevices: vi.fn(async () => []),
    identify: vi.fn(async () => IDENTITY), status: vi.fn(async () => STATUS),
    query: vi.fn(async (cmd: string) => {
      const m = cmd.match(/^\^XA\^HW([A-Z]):\*\.TTF\^XZ$/);
      return m ? dirReply(m[1], listing[m[1] as 'E' | 'Z'] ?? []) : '';
    }),
    send: vi.fn(async (_zpl: string): Promise<void> => undefined),
    sendBytes: vi.fn(async (bytes: Uint8Array, onProgress?: (s: number, t: number) => void) => {
      onProgress?.(bytes.length, bytes.length);
      listing.E = [...listing.E, 'ROBOTO_B.TTF'];
    }),
  };
  return { ...printer, ...over } as typeof printer;
}

function setup(over: Partial<Parameters<typeof BuilderPrinterModal>[0]> = {}) {
  const printer = (over.printer as ReturnType<typeof fakePrinter> | undefined) ?? fakePrinter();
  const onFetchBytes = vi.fn(async (_id: string) => new Uint8Array([0, 1, 0, 0, 7, 7]));
  const onClose = vi.fn();
  render(<BuilderPrinterModal templateName="Vegas Destination" sizeKey="4x2" vocab={VOCAB} design={DESIGN}
    library={LIBRARY} viewDpi={300} canInstall onFetchBytes={onFetchBytes} onClose={onClose} {...over}
    printer={printer} />);
  return { printer, onFetchBytes, onClose };
}

const fontRow = (object: string) => screen.getByText(object).closest('tr') as HTMLElement;

describe('BuilderPrinterModal', () => {
  it('has the report-generate header: the template name, Printer, one line', () => {
    setup();
    const dialog = screen.getByRole('dialog', { name: 'Printer' });
    expect(within(dialog).getByText('Vegas Destination · Printer')).toBeTruthy();
    expect(within(dialog).getByRole('heading', { name: 'Printer' })).toBeTruthy();
    expect(dialog.className).toContain('rgm-card');
  });

  it('shows the connected printer with its identity and health', async () => {
    const { printer } = setup();
    expect(screen.getByText('Printer connected · ZD421')).toBeTruthy();
    expect(await screen.findByText('ZD421-300dpi')).toBeTruthy();
    expect(screen.getByText('300 DPI')).toBeTruthy();
    expect(screen.getByText('Ready')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    expect(printer.disconnect).toHaveBeenCalled();
  });

  it('offers Connect via USB with no printer, and checks nothing', async () => {
    const printer = fakePrinter({ connected: false });
    setup({ printer });
    expect(screen.getByText('No printer connected')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Connect via USB' }));
    expect(printer.connect).toHaveBeenCalled();
    expect(printer.query).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Print alignment label' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Connect a printer to check its fonts.')).toBeTruthy();
  });

  it('notes a printer DPI other than the canvas DPI', async () => {
    const printer = fakePrinter({ identify: vi.fn(async () => ({ ...IDENTITY, dotsPerMm: 8, dpi: 203 })) });
    setup({ printer });
    expect(await screen.findByText('Prints at 203 DPI; the canvas is showing 300.')).toBeTruthy();
  });

  it('says nothing about DPI when they match', async () => {
    setup();
    await screen.findByText('ZD421-300dpi');
    expect(screen.queryByText(/the canvas is showing/)).toBeNull();
  });

  it('prints the alignment label for the template size at the printer DPI with the saved offsets', async () => {
    localStorage.setItem('labels.print.settings', JSON.stringify({ verticalOffset: 5, horizontalOffset: 0 }));
    const printer = fakePrinter({ identify: vi.fn(async () => ({ ...IDENTITY, dotsPerMm: 8, dpi: 203 })) });
    setup({ printer });
    await screen.findByText(/Prints at 203 DPI/);
    await userEvent.click(screen.getByRole('button', { name: 'Print alignment label' }));
    await waitFor(() => expect(printer.send).toHaveBeenCalled());
    const zpl = printer.send.mock.calls[0][0];
    expect(zpl).toContain('^PW812');
    expect(zpl).toContain('^LL406');
    expect(zpl).toContain('ALIGN 4x2 203DPI');
    expect(zpl).toContain('^LT5');
    expect(await screen.findByText('Sent an alignment label (4" x 2" at 203 DPI).')).toBeTruthy();
  });

  it('reads E: then Z: for TrueType fonts, after the identity', async () => {
    const { printer } = setup();
    await waitFor(() => expect(printer.query).toHaveBeenCalledTimes(2));
    expect(printer.query.mock.calls.map((c) => c[0])).toEqual(['^XA^HWE:*.TTF^XZ', '^XA^HWZ:*.TTF^XZ']);
    expect(printer.identify.mock.invocationCallOrder[0]).toBeLessThan(printer.query.mock.invocationCallOrder[0]);
  });

  it('lists each printer object the design uses with its state', async () => {
    setup();
    await waitFor(() => expect(within(fontRow('ROBOTO_R.TTF')).getByText('Present')).toBeTruthy());
    // faux Bold Swiss needs only its Regular file, here only on Z:
    expect(within(fontRow('TT0003M_.TTF')).getByText('Present')).toBeTruthy();
    expect(within(fontRow('ROBOTO_B.TTF')).getByText('Missing')).toBeTruthy();
    expect(within(fontRow('ROBOTO_B.TTF')).getByRole('button', { name: 'Install' })).toBeTruthy();
    // a family whose file isn't in the library
    expect(within(fontRow('OSWALD_R.TTF')).getByText('Missing')).toBeTruthy();
    expect(within(fontRow('OSWALD_R.TTF')).getByText('Not in the font library')).toBeTruthy();
    expect(within(fontRow('OSWALD_R.TTF')).queryByRole('button', { name: 'Install' })).toBeNull();
    expect(screen.getAllByRole('row')).toHaveLength(5);   // the header and four objects
  });

  it('a built-in font on neither drive says so, with no Install', async () => {
    const printer = fakePrinter({}, { E: ['ROBOTO_R.TTF'], Z: [] });
    setup({ printer });
    await waitFor(() => expect(within(fontRow('TT0003M_.TTF')).getByText('Missing')).toBeTruthy());
    expect(within(fontRow('TT0003M_.TTF')).getByText("Built into Zebra printers; this one doesn't have it"))
      .toBeTruthy();
    expect(within(fontRow('TT0003M_.TTF')).queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('a built-in font on E: counts as present', async () => {
    const printer = fakePrinter({}, { E: ['TT0003M_.TTF'], Z: [] });
    setup({ printer });
    await waitFor(() => expect(within(fontRow('TT0003M_.TTF')).getByText('Present')).toBeTruthy());
  });

  it('Install pushes the library file the way Labels › Printers does, then re-reads E:', async () => {
    const { printer, onFetchBytes } = setup();
    const install = await waitFor(() => within(fontRow('ROBOTO_B.TTF')).getByRole('button', { name: 'Install' }));
    await userEvent.click(install);
    await waitFor(() => expect(printer.sendBytes).toHaveBeenCalled());
    expect(onFetchBytes).toHaveBeenCalledWith('f-rb');
    expect(printer.send).toHaveBeenCalledWith('~DYE:ROBOTO_B.TTF,B,T,6,,');
    await waitFor(() => expect(within(fontRow('ROBOTO_B.TTF')).getByText('Present')).toBeTruthy(), { timeout: 3000 });
    expect(printer.query.mock.calls.filter((c) => c[0] === '^XA^HWE:*.TTF^XZ').length).toBe(2);
  });

  it('runs one install at a time', async () => {
    let release: () => void = () => {};
    const printer = fakePrinter({}, { E: [], Z: ['TT0003M_.TTF'] });
    printer.sendBytes.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    setup({ printer });
    const rr = await waitFor(() => within(fontRow('ROBOTO_R.TTF')).getByRole('button', { name: 'Install' }));
    await userEvent.click(rr);
    await waitFor(() => expect(printer.sendBytes).toHaveBeenCalledTimes(1));
    expect((within(fontRow('ROBOTO_B.TTF')).getByRole('button', { name: 'Install' }) as HTMLButtonElement).disabled)
      .toBe(true);
    release();
  });

  it('hides Install without labels:add', async () => {
    setup({ canInstall: false });
    await waitFor(() => expect(within(fontRow('ROBOTO_B.TTF')).getByText('Missing')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Install' })).toBeNull();
  });

  it('sends raw ZPL as typed, and says so', async () => {
    const { printer } = setup();
    await screen.findByText('ZD421-300dpi');   // the printer has been read
    const box = screen.getByRole('textbox', { name: 'Raw ZPL' }) as HTMLTextAreaElement;
    const send = screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement;
    expect(box.rows).toBe(6);
    expect(box.className).toContain('mono');
    expect(send.disabled).toBe(true);   // nothing typed
    fireEvent.change(box, { target: { value: '^XA\n^FO50,50^A0N,40,40^FDHi^FS\n^XZ' } });
    await userEvent.click(send);
    await waitFor(() => expect(printer.send).toHaveBeenCalledWith('^XA\n^FO50,50^A0N,40,40^FDHi^FS\n^XZ'));
    expect(await screen.findByText('Sent the ZPL to the printer.')).toBeTruthy();
  });

  it('shows a raw ZPL send failure', async () => {
    const printer = fakePrinter();
    setup({ printer });
    await screen.findByText('ZD421-300dpi');
    printer.send.mockRejectedValueOnce(new Error('Printer connection lost. Please reconnect.'));
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw ZPL' }), { target: { value: '~HS' } });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText("Couldn't send: Printer connection lost. Please reconnect.")).toBeTruthy();
  });

  it('keeps Send off with no printer, and while a send is under way', async () => {
    let release: () => void = () => {};
    const printer = fakePrinter();
    printer.send.mockImplementationOnce(() => new Promise<void>((r) => { release = r; }));
    setup({ printer });
    await screen.findByText('ZD421-300dpi');
    const box = screen.getByRole('textbox', { name: 'Raw ZPL' });
    fireEvent.change(box, { target: { value: '^XA^XZ' } });
    await userEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect((screen.getByRole('button', { name: 'Sending…' }) as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Send' })).toBeTruthy());
    cleanup();
    setup({ printer: fakePrinter({ connected: false }) });
    fireEvent.change(screen.getByRole('textbox', { name: 'Raw ZPL' }), { target: { value: '^XA^XZ' } });
    expect((screen.getByRole('button', { name: 'Send' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('closes on Done, × and Escape', async () => {
    const { onClose } = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Done' }));
    await userEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
