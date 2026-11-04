// @vitest-environment jsdom
/** /labels/printers: the Zebra card, the two live tool rows and the
 *  disabled Install Fonts row, the WebUSB banner on a browser that has
 *  no `navigator.usb`, and a real `useZebraPrinter` driven by a fake USB
 *  device — Connect goes through `requestZebraDevice` (a Zebra
 *  vendor-filtered requestDevice) and the `~HI`/`~HS` chips follow.
 *  Those generic tools are what a laptop that isn't a Label Station gets,
 *  so those cases run in laptop mode; the web kiosk's Printer Setup (the
 *  saved printer's tools, or the printer step) has its own cases at the
 *  end. */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ZEBRA_VENDOR_ID, type UsbDeviceLike } from '@portal/labels/zebraUsb';

import type { LabelVocab } from '../lib/api';

const api = vi.hoisted(() => ({
  fetchLabelVocab: vi.fn(),
  // the laptop edge's label routes: a web kiosk never calls them
  getLabelStation: vi.fn(), putLabelStation: vi.fn(), getLabelPlan: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

// The printer step has its own tests (PrinterStep.test.tsx); here it
// shows what it was given and saves like the real one when finished.
vi.mock('../components/setup/PrinterStep', async () => {
  const { writeWebLabelSettings } = await import('../lib/webLabelSettings');
  return {
    default: ({ initiativeId, labelKind, initial, onFinish, onBack }: {
      initiativeId: string; labelKind: string; initial: unknown; onFinish: () => void; onBack?: () => void;
    }) => (
      <div>
        <p>Printer step for {labelKind} on {initiativeId}</p>
        <p>Saved settings {initial ? 'given' : 'none'}</p>
        <button type="button" onClick={() => {
          writeWebLabelSettings({
            label_kind: labelKind as 'top' | 'front', dpi: 203, offset_x: 0, offset_y: 0, peel: false,
            printer: { type: 'usb', ip: null, model: 'ZD421', serial: 'ZD-1' },
          });
          onFinish();
        }}>Stub finish</button>
        {onBack && <button type="button" onClick={onBack}>Back</button>}
      </div>
    ),
  };
});

const { default: PrinterTools } = await import('./PrinterTools');
const { writeKioskSetup } = await import('../lib/kioskSetup');
const { writeWebLabelKind, writeWebLabelSettings } = await import('../lib/webLabelSettings');

const VOCAB: LabelVocab[] = [
  { kind: 'size', key: '4x2', label: '4" x 2"', description: '', meta: { width_in: 4, height_in: 2 }, sort_order: 1, is_active: true, usage_count: 0 },
  { kind: 'dpi', key: '203', label: '203 DPI', description: '', meta: { dots: 203 }, sort_order: 1, is_active: true, usage_count: 0 },
];

const HI = '\x02ZD421-203dpi ZPL,V92.21.16Z,8,8192KB,X\x03';
const HS = '\x02030,0,0,1218,000,0,0,0,000,0,0,0\x03\r\n\x02000,0,0,0,0,2,4,0,00000000,1,000\x03';
const HH = '\x02' + Object.entries({
  DARKNESS: '+10.0', 'PRINT SPEED': '6.0 IPS', 'PRINT MODE': 'TEAR OFF', 'MEDIA TYPE': 'GAP/NOTCH',
  'PRINT METHOD': 'DIRECT-THERMAL', 'PRINT WIDTH': '812', 'LABEL LENGTH': '1218', FIRMWARE: 'V72.19.15Z <-',
}).map(([k, v]) => `${v.padEnd(20)}${k}`).join('\r\n') + '\x03';

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
      else if (cmd === '^XA^HH^XZ') pending = HH;
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
  // A laptop that isn't a Label Station: the generic WebUSB tools.
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  api.fetchLabelVocab.mockResolvedValue(VOCAB);
  setUsb(undefined);
});
afterEach(() => { cleanup(); setUsb(undefined); delete window.__KIOSK_CONFIG__; localStorage.clear(); });

const renderPage = () => render(<MemoryRouter><PrinterTools /></MemoryRouter>);

it('renders the printer card, the four tool rows, and a way back', async () => {
  renderPage();
  expect(screen.getByRole('heading', { name: 'Printer Setup / Troubleshooting' })).toBeTruthy();
  expect(screen.getByText('Kiosk · Label Printing')).toBeTruthy();
  expect(screen.getByText('Connect, align, and test the label printer.')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Back to Label Printing' }).getAttribute('href')).toBe('/labels');
  expect(screen.getByRole('region', { name: 'Printer' })).toBeTruthy();
  expect(screen.getByText('No printer connected')).toBeTruthy();
  expect(screen.getByText('Test Label Alignment')).toBeTruthy();
  expect(screen.getByText('Full Printer Setup')).toBeTruthy();
  expect(screen.getByText('Factory Reset')).toBeTruthy();
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

it('the three live tool rows are gated until a printer is connected', async () => {
  renderPage();
  expect((screen.getByRole('button', { name: 'Print test label' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Start setup' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Reset printer' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByText('Connect a printer first').length).toBe(3);
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

it('the Factory Reset row sits after Full Printer Setup and is gated too', async () => {
  renderPage();
  const titles = [...document.querySelectorAll('.zp-tool-row .cell-top b')].map((n) => n.textContent);
  expect(titles).toEqual(['Test Label Alignment', 'Full Printer Setup', 'Factory Reset', 'Install Fonts']);
  expect((screen.getByRole('button', { name: 'Reset printer' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByText('Connect a printer first').length).toBe(3);
  await waitFor(() => expect(api.fetchLabelVocab).toHaveBeenCalled());
});

it('Factory Reset runs against the connected printer and hands off to the setup wizard', async () => {
  vi.useFakeTimers();
  try {
    // userEvent's pointer sequence never settles under fake timers, so
    // the clicks here are plain fireEvent inside act().
    const click = async (el: Element) => { await act(async () => { fireEvent.click(el); }); };
    const dev = fakeDevice();
    setUsb(fakeUsb(dev));
    renderPage();
    await click(screen.getByRole('button', { name: 'Connect via USB' }));
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });

    await click(screen.getByRole('button', { name: 'Reset printer' }));
    expect(screen.getByRole('dialog', { name: 'Factory reset' })).toBeTruthy();
    await click(screen.getByRole('button', { name: 'Factory reset' }));
    await act(async () => { for (let i = 0; i < 30; i++) await vi.advanceTimersByTimeAsync(2000); });

    expect(dev.sent).toContain('^XA^JUF^XZ');
    expect(dev.sent).toContain('^XA^JUS^XZ');
    expect(screen.queryByRole('dialog', { name: 'Factory reset' })).toBeNull();
    expect(screen.getByRole('dialog', { name: 'Full printer setup' })).toBeTruthy();
    expect(screen.getByText('Printers · After factory reset')).toBeTruthy();
    // seeded from the post-reset ^HH read rather than re-reading on mount
    expect(screen.getByText('GAP/NOTCH')).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});

// ── the web kiosk ───────────────────────────────────────────────────

describe('web kiosk', () => {
  beforeEach(() => {
    delete window.__KIOSK_CONFIG__;   // web mode
    localStorage.clear();
    writeKioskSetup({
      initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration', siteId: 's-1', siteName: 'ACC4',
      siteRole: 'source', scanStatus: 'k', scanLabel: 'Dock',
    });
    setUsb(fakeUsb(fakeDevice()));
  });
  afterEach(() => {
    expect(api.getLabelStation).not.toHaveBeenCalled();
    expect(api.putLabelStation).not.toHaveBeenCalled();
    expect(api.getLabelPlan).not.toHaveBeenCalled();
    vi.clearAllMocks();
  });

  const saved = () => writeWebLabelSettings({
    label_kind: 'top', dpi: 203, offset_x: 4, offset_y: -2, peel: false,
    printer: { type: 'usb', ip: null, model: 'ZD421', serial: 'ZD-1' },
  });

  it('web with saved settings shows the saved printer tools', async () => {
    saved();
    renderPage();
    expect(screen.getByRole('heading', { name: 'Printer Setup / Troubleshooting' })).toBeTruthy();
    expect(screen.getByText('Label Station printer')).toBeTruthy();
    expect(screen.getByText("Switch to another USB printer. The printer checks run before it's saved.")).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change printer' })).toBeTruthy();
    expect(screen.queryByText('Connected printer')).toBeNull();
    expect(screen.queryByText(/^Printer step for/)).toBeNull();
    // the saved USB printer isn't allowed in this browser yet
    expect(await screen.findByRole('button', { name: 'Connect printer' })).toBeTruthy();
    await waitFor(() => expect(api.fetchLabelVocab).toHaveBeenCalled());
  });

  it('web without saved settings opens the printer step', async () => {
    writeWebLabelKind('front');
    renderPage();
    expect(screen.getByRole('heading', { name: 'Printer Setup / Troubleshooting' })).toBeTruthy();
    expect(screen.getByText('Printer step for front on i-1')).toBeTruthy();
    expect(screen.getByText('Saved settings none')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Label Printing' }).getAttribute('href')).toBe('/labels');
    // opened from the tile, not by the station: no Back to go to
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(screen.queryByText('Label Station printer')).toBeNull();
  });

  it('saving the printer from the tile shows the saved printer tools', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Stub finish' }));
    expect(await screen.findByText('Label Station printer')).toBeTruthy();
    expect(screen.queryByText(/^Printer step for/)).toBeNull();
    await waitFor(() => expect(api.fetchLabelVocab).toHaveBeenCalled());
  });

  /** The Printing Station's stand-in: says how it was reached. */
  function StationStub() {
    const location = useLocation();
    return <p>Station page {JSON.stringify(location.state)}</p>;
  }

  const fromStation = () => render(
    <MemoryRouter initialEntries={[{ pathname: '/labels/printers', state: { returnTo: '/labels/station' } }]}>
      <Routes>
        <Route path="/labels/printers" element={<PrinterTools />} />
        <Route path="/labels/station" element={<StationStub />} />
      </Routes>
    </MemoryRouter>,
  );

  it('finishing the printer step from the station returns to the station', async () => {
    fromStation();
    await userEvent.click(screen.getByRole('button', { name: 'Stub finish' }));
    expect(await screen.findByText('Station page {"fromPrinterSetup":true}')).toBeTruthy();
  });

  it('Back from the printer step returns to the station, saying where it came from', async () => {
    fromStation();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Station page {"fromPrinterSetup":true}')).toBeTruthy();
  });

  it('without WebUSB the generic tools stay, with the browser banner', async () => {
    setUsb(undefined);
    saved();
    renderPage();
    expect(screen.getByText(
      "This browser can't talk to USB printers. Use Chrome or Edge over HTTPS or localhost.",
    )).toBeTruthy();
    expect(screen.getByText('Connected printer')).toBeTruthy();
    expect(screen.queryByText(/^Printer step for/)).toBeNull();
    await waitFor(() => expect(api.fetchLabelVocab).toHaveBeenCalled());
  });
});
