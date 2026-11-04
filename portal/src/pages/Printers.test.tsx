// @vitest-environment jsdom
/** Labels → Printers: the Zebra tab's printer card (connect, known printers,
 *  identity/health), the tool rows gated on a connection, and the modals
 *  they open (Factory Reset hands off into Full Printer Setup); the Brother
 *  tab stays a placeholder. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LabelVocab } from '../lib/api';

const api = vi.hoisted(() => ({ listLabelVocab: vi.fn(), listLabelFonts: vi.fn(), uploadLabelFont: vi.fn(), deleteLabelFont: vi.fn(), getLabelFontBytes: vi.fn(), postLabelPrinterEvent: vi.fn(async () => true) }));
vi.mock('../lib/api', async (importActual) => ({ ...(await importActual<typeof import('../lib/api')>()), ...api }));

const printer = vi.hoisted(() => ({
  supported: true, connected: false, productName: null as string | null, notice: null as null | { type: string; message: string },
  device: { serialNumber: 'D2J000001' } as unknown, ensureOpen: vi.fn(async () => undefined),
  clearNotice: vi.fn(), connect: vi.fn(async () => undefined), disconnect: vi.fn(async () => undefined), connectTo: vi.fn(async () => undefined),
  send: vi.fn(async () => undefined), query: vi.fn(async (_cmd: string) => ''), sendBytes: vi.fn(async () => undefined), waitForIdle: vi.fn(async () => undefined),
  identify: vi.fn(async () => ({ model: 'ZD421-203dpi ZPL', firmware: 'V92.21.16Z', dotsPerMm: 8, memory: '8192KB', dpi: 203 })),
  status: vi.fn(async () => ({ paperOut: true, paused: false, labelLength: 0, formatsQueued: 0, bufferFull: false, partialFormat: false, corruptRam: false, underTemp: false, overTemp: false, headOpen: false, ribbonOut: false, thermalTransfer: false, printMode: '0', labelWaiting: false, labelsRemaining: 0 })),
  knownDevices: vi.fn(async () => [] as unknown[]), log: [] as unknown[], clearLog: vi.fn(),
}));
vi.mock('../lib/useZebraPrinter', () => ({ useZebraPrinter: () => printer }));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ can: () => true, preferences: { list_prefs: {} }, updatePreferences: vi.fn() }) }));
if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};

const { default: Printers } = await import('./Printers');

const HH = '\x02' + Object.entries({
  DARKNESS: '+10.0', 'PRINT SPEED': '6.0 IPS', 'PRINT MODE': 'CUTTER', 'MEDIA TYPE': 'GAP/NOTCH',
  'PRINT METHOD': 'DIRECT-THERMAL', 'PRINT WIDTH': '812', 'LABEL LENGTH': '1218', FIRMWARE: 'V72.19.15Z <-',
}).map(([k, v]) => `${v.padEnd(20)}${k}`).join('\r\n') + '\x03';

const vocab: LabelVocab[] = [
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: null },
  { kind: 'dpi', key: '203', label: '203 DPI', description: '', meta: { dots: 203 }, sort_order: 1, is_active: true, usage_count: null },
];

beforeEach(() => {
  printer.connected = false; printer.productName = null; printer.notice = null;
  printer.knownDevices.mockResolvedValue([]);
  printer.query.mockReset(); printer.query.mockResolvedValue('');
  api.postLabelPrinterEvent.mockClear();
  api.listLabelVocab.mockResolvedValue(vocab);
  api.listLabelFonts.mockResolvedValue([]);
});
afterEach(cleanup);

it('shows the tools disconnected with gated actions, and Connect via USB', async () => {
  render(<Printers />);
  expect(screen.getByText('Test Label Alignment')).toBeTruthy();
  expect(screen.getByText('Install Fonts')).toBeTruthy();
  expect(screen.getByText('Full Printer Setup')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Print test label' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Start setup' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Manage fonts' }) as HTMLButtonElement).disabled).toBe(false);
  expect(screen.getAllByText('Connect a printer first').length).toBe(3);
  await userEvent.click(screen.getByRole('button', { name: 'Connect via USB' }));
  expect(printer.connect).toHaveBeenCalled();
});

it('lists known printers and connects to one', async () => {
  const dev = { productName: 'ZD621' };
  printer.knownDevices.mockResolvedValue([dev]);
  render(<Printers />);
  await userEvent.click(await screen.findByRole('button', { name: 'Connect ZD621' }));
  expect(printer.connectTo).toHaveBeenCalledWith(dev);
});

it('when connected, shows identity and health and enables the tools', async () => {
  printer.connected = true; printer.productName = 'ZD421';
  render(<Printers />);
  expect(await screen.findByText('ZD421-203dpi ZPL')).toBeTruthy();
  expect(screen.getByText('Paper out')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Print test label' }) as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Refresh status' }));
  await waitFor(() => expect(printer.status).toHaveBeenCalledTimes(2));
});

it('opens the three modals', async () => {
  printer.connected = true; printer.productName = 'ZD421';
  render(<Printers />);
  await screen.findByText('ZD421-203dpi ZPL');
  await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
  expect(screen.getByRole('dialog', { name: 'Test label alignment' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
  await userEvent.click(screen.getByRole('button', { name: 'Manage fonts' }));
  expect(screen.getByRole('dialog', { name: 'Install fonts' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
  await userEvent.click(screen.getByRole('button', { name: 'Start setup' }));
  expect(screen.getByRole('dialog', { name: 'Full printer setup' })).toBeTruthy();
});

it('the Factory Reset row is last, gated on a connection, with the danger button', () => {
  const lastRow = () => document.querySelector('.dir-list > .dir-row:last-child')!;
  render(<Printers />);
  expect(within(lastRow() as HTMLElement).getByText('Factory Reset')).toBeTruthy();
  expect(within(lastRow() as HTMLElement).getByText("Restore the printer's factory defaults, then set it up again.")).toBeTruthy();
  const disconnected = screen.getByRole('button', { name: 'Reset printer' }) as HTMLButtonElement;
  expect(disconnected.disabled).toBe(true);
  expect(disconnected.classList.contains('btn-danger')).toBe(true);
  expect(within(lastRow() as HTMLElement).getByText('Connect a printer first')).toBeTruthy();

  cleanup();
  printer.connected = true; printer.productName = 'ZD421';
  render(<Printers />);
  const connected = screen.getByRole('button', { name: 'Reset printer' }) as HTMLButtonElement;
  expect(connected.disabled).toBe(false);
  expect(connected.className).toBe('btn-solid btn-danger');
  expect(lastRow().contains(connected)).toBe(true);
});

it("a finished reset opens Full Printer Setup with the reset's configuration", async () => {
  printer.connected = true; printer.productName = 'ZD421';
  printer.query.mockImplementation(async (cmd: string) => (cmd === '^XA^HH^XZ' ? HH : ''));
  render(<Printers />);
  await screen.findByText('ZD421-203dpi ZPL');
  // the restart wait polls on 2 s timers; userEvent never settles under fake ones
  vi.useFakeTimers();
  try {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Reset printer' })); });
    expect(screen.getByRole('dialog', { name: 'Factory reset' })).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Factory reset' })); });
    await act(async () => { for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(2000); });
  } finally { vi.useRealTimers(); }
  expect(screen.queryByRole('dialog', { name: 'Factory reset' })).toBeNull();
  const setup = screen.getByRole('dialog', { name: 'Full printer setup' });
  expect(within(setup).getByText('Printers · After factory reset')).toBeTruthy();
  // seeded with the reset's own ^HH: shown at once, and not read a second time
  expect(within(setup).getByText('CUTTER')).toBeTruthy();
  expect(printer.query.mock.calls.filter(([cmd]) => cmd === '^XA^HH^XZ')).toHaveLength(1);
  expect(api.postLabelPrinterEvent).toHaveBeenCalledWith(expect.objectContaining({ event: 'factory_reset', outcome: 'completed', printer_serial: 'D2J000001' }));
});

it('unsupported browsers get an explanation instead of the connect button', () => {
  printer.supported = false;
  render(<Printers />);
  expect(screen.getByText('USB printing needs Chrome or Edge on a secure (https or localhost) address.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Connect via USB' })).toBeNull();
  printer.supported = true;
});

it('the Brother tab stays a placeholder', async () => {
  render(<Printers />);
  await userEvent.click(screen.getByRole('tab', { name: 'Brother Printers' }));
  expect(screen.getByText('Brother printer tools are coming soon.')).toBeTruthy();
  expect(screen.queryByText('Test Label Alignment')).toBeNull();
});
