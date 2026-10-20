// @vitest-environment jsdom
/** /labels/printers on a Label Station laptop: the station's saved printer
 *  (a fake network one here) with its health, peeler and offsets; the
 *  alignment test saves offsets to the station and prints in its mode;
 *  Full Printer Setup talks to a network printer through the edge; and
 *  every other kiosk keeps the USB-only tools. */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { HostIdentification, HostStatus } from '@portal/labels/zebraUsb';

import type { LabelStationSettings, LabelVocab } from '../lib/api';

const api = vi.hoisted(() => ({
  fetchLabelVocab: vi.fn(), putLabelStation: vi.fn(), printerQuery: vi.fn(), printerSend: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

const station = vi.hoisted(() => ({
  state: 'ready' as 'loading' | 'ready' | 'needs_usb' | 'no_settings',
  settings: null as LabelStationSettings | null,
  peeler: true as boolean | null,
  sent: [] as string[],
  reload: vi.fn(async () => {}),
  connectUsb: vi.fn(async () => {}),
}));
vi.mock('../lib/useStationPrinter', () => {
  const identity: HostIdentification = { model: 'ZD421-203dpi ZPL', firmware: 'V92.21.16Z', dotsPerMm: 8, dpi: 203, memory: '8192KB' };
  const status: HostStatus = {
    paperOut: false, paused: false, labelLength: 0, formatsQueued: 0, bufferFull: false,
    partialFormat: false, corruptRam: false, underTemp: false, overTemp: false,
    headOpen: false, ribbonOut: false, thermalTransfer: false, printMode: 'T',
    labelWaiting: false, labelsRemaining: 0,
  };
  const printer = {
    kind: 'network', ip: '10.0.0.40', serial: null,
    identify: async () => identity,
    status: async () => status,
    peeler: async () => ({ present: station.peeler }),
    send: async (zpl: string) => { station.sent.push(zpl); },
  };
  return {
    useStationPrinter: () => ({
      settings: station.state === 'no_settings' ? null : station.settings,
      printer: station.state === 'ready' ? printer : null,
      zebra: { connected: false, log: [], clearLog: () => {} },
      state: station.state,
      connectUsb: station.connectUsb,
      reload: station.reload,
    }),
  };
});

// Step 5 has its own tests; here only what the modal hands it matters.
const step = vi.hoisted(() => ({ props: null as Record<string, unknown> | null }));
vi.mock('../components/setup/PrinterStep', () => ({
  default: (props: Record<string, unknown>) => {
    step.props = props;
    return (
      <button type="button" onClick={() => (props.onFinish as () => void)()}>
        {props.finishLabel as string}
      </button>
    );
  },
}));

import { writeKioskSetup } from '../lib/kioskSetup';
import PrinterTools from './PrinterTools';

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

const SETTINGS: LabelStationSettings = {
  label_kind: 'top', dpi: 203, offset_x: 4, offset_y: -2, peel: true,
  printer: { type: 'network', ip: '10.0.0.40', model: 'ZD421-203dpi ZPL', serial: null },
};

function laptopLabelStation(stationType: 'label' | 'rfid' = 'label') {
  window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
  writeKioskSetup({
    initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration', siteId: 's-1', siteName: 'ACC4',
    siteRole: 'source', scanStatus: 'k', scanLabel: 'Labels', stationType,
  });
}

beforeEach(() => {
  localStorage.clear();
  laptopLabelStation();
  station.state = 'ready';
  station.settings = { ...SETTINGS, printer: { ...SETTINGS.printer } };
  station.peeler = true;
  station.sent = [];
  station.reload.mockClear();
  step.props = null;
  api.fetchLabelVocab.mockReset().mockResolvedValue(VOCAB);
  api.putLabelStation.mockReset().mockImplementation(async (s: LabelStationSettings) => s);
  api.printerSend.mockReset().mockResolvedValue(undefined);
  api.printerQuery.mockReset().mockImplementation(async (_ip: string, command: string) => ({
    response: command === '~HI' ? HI : command === '~HS' ? HS : command === '^XA^HH^XZ' ? HH : '',
    truncated: false,
  }));
});
afterEach(() => { cleanup(); delete window.__KIOSK_CONFIG__; vi.clearAllMocks(); });

const renderPage = () => render(<MemoryRouter><PrinterTools /></MemoryRouter>);

it('shows the saved network printer with its health, peeler and offsets', async () => {
  renderPage();
  expect(screen.getByRole('heading', { name: 'Printer Setup / Troubleshooting' })).toBeTruthy();
  expect(screen.getByText('Network printer · 10.0.0.40')).toBeTruthy();
  expect(await screen.findByText('V92.21.16Z')).toBeTruthy();
  expect(screen.getByText('203 DPI')).toBeTruthy();
  expect(await screen.findByText('Ready')).toBeTruthy();
  expect(await screen.findByText('Peeler detected · printing in peel-off mode')).toBeTruthy();
  expect(screen.getByText('Horizontal 4 dots · Vertical -2 dots')).toBeTruthy();
  expect(screen.queryByText('Managed from the portal')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Connect via USB' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Change printer' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Check printer' })).toBeTruthy();
});

it('says when the printer does not report a peeler, and when there is none', async () => {
  station.peeler = null;
  renderPage();
  expect(await screen.findByText("Printer doesn't report a peeler · printing in tear-off mode")).toBeTruthy();
  cleanup();
  station.peeler = false;
  renderPage();
  expect(await screen.findByText('No peeler · printing in tear-off mode')).toBeTruthy();
});

it('the alignment test saves offsets to the station and prints in peel-off mode', async () => {
  renderPage();
  await screen.findByText('Ready');
  await userEvent.click(screen.getByRole('button', { name: 'Print test label' }));
  const dialog = await screen.findByRole('dialog', { name: 'Test label alignment' });
  expect((within(dialog).getByLabelText('Horizontal offset') as HTMLInputElement).value).toBe('4');
  expect((within(dialog).getByLabelText('Vertical offset') as HTMLInputElement).value).toBe('-2');

  const h = within(dialog).getByLabelText('Horizontal offset');
  fireEvent.change(h, { target: { value: '10' } });
  fireEvent.blur(h);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save offsets' }));
  await waitFor(() => expect(api.putLabelStation).toHaveBeenCalledWith({ ...SETTINGS, offset_x: 10, offset_y: -2 }));
  expect(localStorage.getItem('labels.print.settings')).toBeNull();
  expect(station.reload).toHaveBeenCalled();

  await userEvent.click(within(dialog).getByRole('button', { name: 'Print test label' }));
  await waitFor(() => expect(station.sent.length).toBe(1));
  expect(station.sent[0]).toMatch(/^\^XA\^MMP/);
  expect(station.sent[0]).toContain('^LS-10');
});

it('Full Printer Setup reads a network printer through the edge', async () => {
  renderPage();
  await screen.findByText('Ready');
  await userEvent.click(screen.getByRole('button', { name: 'Start setup' }));
  await waitFor(() => expect(api.printerQuery).toHaveBeenCalledWith('10.0.0.40', '^XA^HH^XZ'));
});

it('Factory Reset is offered for a network printer', async () => {
  renderPage();
  await screen.findByText('Ready');
  expect((screen.getByRole('button', { name: 'Reset printer' }) as HTMLButtonElement).disabled).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: 'Reset printer' }));
  expect(await screen.findByRole('dialog', { name: 'Factory reset' })).toBeTruthy();
});

it('Check printer & fonts opens step 5 on the current printer and reloads after saving', async () => {
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: 'Check printer' }));
  const dialog = await screen.findByRole('dialog', { name: 'Check printer & fonts' });
  expect(step.props).toMatchObject({
    initiativeId: 'i-1', labelKind: 'top', initial: SETTINGS, finishLabel: 'Save printer', preselect: true,
  });
  expect(step.props?.onBack).toBeUndefined();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save printer' }));
  expect(screen.queryByRole('dialog', { name: 'Check printer & fonts' })).toBeNull();
  expect(station.reload).toHaveBeenCalled();
});

it('Change printer opens step 5 without preselecting', async () => {
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: 'Change printer' }));
  expect(await screen.findByRole('dialog', { name: 'Change printer' })).toBeTruthy();
  expect(step.props).toMatchObject({ finishLabel: 'Save printer', preselect: false });
});

it('a station with no saved printer points at Kiosk Setup and gates the tools', async () => {
  station.state = 'no_settings';
  renderPage();
  expect(screen.getByText(/No label printer is saved for this station/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Print test label' }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Check printer' }) as HTMLButtonElement).disabled).toBe(true);
  await waitFor(() => expect(api.fetchLabelVocab).toHaveBeenCalled());
});

it('a USB station that is not connected offers to connect it', async () => {
  station.state = 'needs_usb';
  station.settings = { ...SETTINGS, printer: { type: 'usb', ip: null, model: 'ZD421', serial: 'Z1' } };
  renderPage();
  await userEvent.click(screen.getByRole('button', { name: 'Connect printer' }));
  expect(station.connectUsb).toHaveBeenCalled();
});

it('an RFID Station laptop and a web kiosk keep the USB-only tools', async () => {
  laptopLabelStation('rfid');
  renderPage();
  expect(screen.getByRole('button', { name: 'Connect via USB' })).toBeTruthy();
  expect(screen.getByText('Managed from the portal')).toBeTruthy();
  cleanup();
  delete window.__KIOSK_CONFIG__;
  laptopLabelStation('label');
  delete window.__KIOSK_CONFIG__;
  renderPage();
  expect(screen.getByRole('button', { name: 'Connect via USB' })).toBeTruthy();
  await waitFor(() => expect(api.fetchLabelVocab).toHaveBeenCalled());
});
