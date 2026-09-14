// @vitest-environment jsdom
/** /labels/printers: the Zebra card, the two live tool rows and the
 *  disabled Install Fonts row, the WebUSB banner on a browser that has
 *  no `navigator.usb`, and a real `useZebraPrinter` driven by a fake USB
 *  device — Connect goes through `requestZebraDevice` (a Zebra
 *  vendor-filtered requestDevice) and the `~HI`/`~HS` chips follow. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ZEBRA_VENDOR_ID, type UsbDeviceLike } from '@portal/labels/zebraUsb';

import type { LabelVocab } from '../lib/api';

const api = vi.hoisted(() => ({ fetchLabelVocab: vi.fn() }));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

const { default: PrinterTools } = await import('./PrinterTools');

const VOCAB: LabelVocab[] = [
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: 0 },
  { kind: 'dpi', key: '203', label: '203 DPI', description: '', meta: { dots: 203 }, sort_order: 1, is_active: true, usage_count: 0 },
];

const HI = '\x02ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\x03';
const HS = '\x02030,0,0,1218,000,0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,0,2,4,0,00000000,1,000\x03';

/** A fake Zebra: transferIn always resolves (empty when nothing is
 *  queued), so the transport's drain reads finish instantly instead of
 *  waiting out real timeouts. Replies are keyed on the command sent. */
function fakeDevice(name = 'ZD421') {
  let pending = '';
  const dev = {
    opened: false, productName: name, sent: [] as string[],
    configuration: { interfaces: [{ alternate: { endpoints: [
      { direction: 'out' as const, type: 'bulk' as const, endpointNumber: 1 },
      { direction: 'in' as const, type: 'bulk' as const, endpointNumber: 2 },
    ] } }] },
    async open() { dev.opened = true; },
    async close() { dev.opened = false; },
    async selectConfiguration() {},
    async claimInterface() {},
    async releaseInterface() {},
    async transferOut(_e: number, data: BufferSource) {
      const cmd = new TextDecoder().decode(data as ArrayBuffer);
      dev.sent.push(cmd);
      if (cmd === '~HI') pending = HI;
      else if (cmd === '~HS') pending = HS;
    },
    async transferIn() {
      const text = pending;
      pending = '';
      return { data: new DataView(new TextEncoder().encode(text).buffer) };
    },
  };
  return dev;
}

function fakeUsb(device: UsbDeviceLike) {
  return {
    requestDevice: vi.fn(async () => device),
    getDevices: vi.fn(async () => [] as UsbDeviceLike[]),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function setUsb(usb: unknown) {
  Object.defineProperty(navigator, 'usb', { value: usb, configurable: true, writable: true });
}

beforeEach(() => {
  api.fetchLabelVocab.mockResolvedValue(VOCAB);
  setUsb(undefined);
});
afterEach(() => { cleanup(); setUsb(undefined); });

const renderPage = () => render(<MemoryRouter><PrinterTools /></MemoryRouter>);

it('renders the printer card, the three tool rows, and a way back', async () => {
  renderPage();
  expect(screen.getByRole('heading', { name: 'Printer Setup / Troubleshooting' })).toBeTruthy();
  expect(screen.getByText('Kiosk · Label Printing')).toBeTruthy();
  expect(screen.getByText('Connect, align, and test the label printer.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Back to Label Printing' }).getAttribute('href')).toBe('/labels');
  expect(screen.getByRole('region', { name: 'Printer' })).toBeTruthy();
  expect(screen.getByText('No printer connected')).toBeTruthy();
  expect(screen.getByText('Test Label Alignment')).toBeTruthy();
  expect(screen.getByText('Full Printer Setup')).toBeTruthy();
  expect(screen.getByText('Install Fonts')).toBeTruthy();
  await waitFor(() => expect(api.fetchLabelVocab).toHaveBeenCalled());
});

it('without navigator.usb shows the browser banner and disables Connect', async () => {
  renderPage();
  expect(screen.getByText(
    "This browser can't talk to USB printers. Use Chrome or Edge over HTTPS or localhost.",
  )).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Connect via USB' }) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect(api.fetchLabelVocab).toHaveBeenCalled());
});

it('Install Fonts stays disabled and points at the portal', async () => {
  renderPage();
  expect((screen.getByRole('button', { name: 'Manage fonts' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getByText('Managed from the portal')).toBeTruthy();
  await waitFor(() => expect(api.fetchLabelVocab).toHaveBeenCalled());
});

it('the two live tool rows are gated until a printer is connected', async () => {
  renderPage();
  expect((screen.getByRole('button', { name: 'Print test label' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Start setup' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByText('Connect a printer first').length).toBe(2);
  await waitFor(() => expect(api.fetchLabelVocab).toHaveBeenCalled());
});

it('Connect asks for a Zebra device and then shows the identity and health chips', async () => {
  const dev = fakeDevice();
  const usb = fakeUsb(dev);
  setUsb(usb);
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: 'Connect via USB' }));
  expect(usb.requestDevice).toHaveBeenCalledWith({ filters: [{ vendorId: ZEBRA_VENDOR_ID }] });
  expect(dev.opened).toBe(true);
  expect(await screen.findByText('ZD421-203dpi ZPL')).toBeTruthy();
  expect(screen.getByText('V92.21.16Z')).toBeTruthy();
  expect(screen.getByText('203 DPI')).toBeTruthy();
  expect(await screen.findByText('Ready')).toBeTruthy();
  expect(screen.getByText('Printer connected · ZD421')).toBeTruthy();
  expect(dev.sent).toContain('~HI');
  expect(dev.sent).toContain('~HS');
});

it('opens the alignment and setup modals once a printer is connected', async () => {
  setUsb(fakeUsb(fakeDevice()));
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: 'Connect via USB' }));
  await screen.findByText('ZD421-203dpi ZPL');

  await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
  const align = screen.getByRole('dialog', { name: 'Test label alignment' });
  expect(align).toBeTruthy();
  // the vocab endpoint fed the picker and the DPI came from ~HI
  expect((screen.getByLabelText('Label size') as HTMLSelectElement).value).toBe('4x2');
  expect(screen.getByRole('tab', { name: '203 DPI' }).getAttribute('aria-selected')).toBe('true');
  await userEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(screen.queryByRole('dialog', { name: 'Test label alignment' })).toBeNull();

  await userEvent.click(screen.getByRole('button', { name: 'Start setup' }));
  expect(screen.getByRole('dialog', { name: 'Full printer setup' })).toBeTruthy();
});

it('lists a previously authorized printer and connects to it without the chooser', async () => {
  const dev = fakeDevice('ZD621');
  const usb = fakeUsb(dev);
  usb.getDevices.mockResolvedValue([dev as unknown as UsbDeviceLike]);
  setUsb(usb);
  renderPage();
  await userEvent.click(await screen.findByRole('button', { name: 'Connect ZD621' }));
  expect(usb.requestDevice).not.toHaveBeenCalled();
  expect(await screen.findByText('Printer connected · ZD621')).toBeTruthy();
});
