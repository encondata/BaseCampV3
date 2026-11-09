// @vitest-environment jsdom
/** Printer Setup on a USB Label Station with the real `useStationPrinter`
 *  over a fake WebUSB Zebra: a different printer picked with Connect
 *  printer is read and saved as the station's (so the next page finds it
 *  by serial), and the Change printer modal owns the choice while it is
 *  open — Save printer's checked settings win, Close leaves nothing
 *  switched. */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LabelStationSettings } from '../lib/api';

const api = vi.hoisted(() => ({
  fetchLabelVocab: vi.fn(), getLabelStation: vi.fn(), putLabelStation: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

type Dev = { productName: string; serialNumber: string };
const usb = vi.hoisted(() => ({
  known: [] as { productName: string; serialNumber: string }[],
  picked: { productName: 'ZD411', serialNumber: 'ZD411-SN' },
  /** `~HI` per connected serial. */
  hi: {} as Record<string, string>,
  queries: [] as string[],
}));
vi.mock('../lib/useZebraPrinter', async () => {
  const { useState } = await import('react');
  return {
    useZebraPrinter: () => {
      const [device, setDevice] = useState<Dev | null>(null);
      return {
        supported: true, connected: device !== null, productName: device?.productName ?? null, device,
        notice: null, clearNotice: () => {}, log: [], clearLog: () => {},
        connect: async () => { setDevice(usb.picked); },
        connectTo: async (d: Dev) => { setDevice(d); },
        disconnect: async () => { setDevice(null); },
        knownDevices: async () => usb.known,
        query: async (command: string) => {
          usb.queries.push(command);
          if (command === '~HI') return device ? usb.hi[device.serialNumber] ?? '' : '';
          return command.includes('sensor.peeler_present') ? '"present"' : '';
        },
        send: async () => {}, sendBytes: async () => {},
      };
    },
  };
});

// Step 5 has its own tests: here it picks a printer on the shared hook and
// Save printer stores what it checked.
const step = vi.hoisted(() => ({ save: null as LabelStationSettings | null }));
vi.mock('../components/setup/PrinterStep', () => {
  return {
    default: (props: { zebra: { connect(): Promise<void> }; onFinish(): void; finishLabel: string }) => (
      <>
        <button type="button" onClick={() => { void props.zebra.connect(); }}>Pick a printer</button>
        <button
          type="button"
          onClick={async () => {
            if (step.save) await api.putLabelStation(step.save);
            props.onFinish();
          }}
        >
          {props.finishLabel}
        </button>
      </>
    ),
  };
});

import { writeKioskSetup } from '../lib/kioskSetup';
import StationPrinterTools from './StationPrinterTools';

const hi = (model: string, dotsPerMm: number) => `\x02${model},V84.20.18Z,${dotsPerMm},8192KB\x03`;

const ZD421: LabelStationSettings = {
  label_kind: 'top', dpi: 300, offset_x: 4, offset_y: -3, peel: false,
  printer: { type: 'usb', ip: null, model: 'ZD421-300dpi', serial: 'ZD421-SN' },
};

let stored: LabelStationSettings = ZD421;

beforeEach(() => {
  window.__KIOSK_CONFIG__ = { mode: 'laptop', identity: { serial: 'kiosk-laptop-1', name: 'Kiosk 0001' } };
  localStorage.clear();
  writeKioskSetup({
    initiativeId: 'i-1', initiativeName: 'NAP11 Hall Migration', siteId: 's-1', siteName: 'ACC4',
    siteRole: 'source', scanStatus: 'k', scanLabel: 'Labels', stationType: 'label',
  });
  stored = { ...ZD421, printer: { ...ZD421.printer } };
  usb.known = [];
  usb.queries = [];
  usb.hi = { 'ZD421-SN': hi('ZD421-300dpi', 12), 'ZD411-SN': hi('ZD411-203dpi', 8) };
  step.save = null;
  api.fetchLabelVocab.mockReset().mockResolvedValue([]);
  api.getLabelStation.mockReset().mockImplementation(async () => stored);
  api.putLabelStation.mockReset().mockImplementation(async (s: LabelStationSettings) => { stored = s; return s; });
});
afterEach(() => { cleanup(); delete window.__KIOSK_CONFIG__; vi.clearAllMocks(); });

const renderPage = () => render(<MemoryRouter><StationPrinterTools /></MemoryRouter>);

it('Connect printer on a different printer saves it as the station printer', async () => {
  renderPage();   // the saved ZD421 isn't allowed in this browser
  await userEvent.click(await screen.findByRole('button', { name: 'Connect printer' }));
  await waitFor(() => expect(api.putLabelStation).toHaveBeenCalledTimes(1));
  expect(stored).toEqual({
    label_kind: 'top', dpi: 203, offset_x: 0, offset_y: 0, peel: true,
    printer: { type: 'usb', ip: null, model: 'ZD411-203dpi', serial: 'ZD411-SN' },
  });
  expect(await screen.findByText('Horizontal 0 dots · Vertical 0 dots')).toBeTruthy();
});

it('Change printer closed without saving leaves the station on the saved printer', async () => {
  usb.known = [{ productName: 'ZD421', serialNumber: 'ZD421-SN' }];
  renderPage();
  expect(await screen.findByText('Horizontal 4 dots · Vertical -3 dots')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Change printer' }));
  const dialog = await screen.findByRole('dialog', { name: 'Change printer' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Pick a printer' }));   // the ZD411
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(api.putLabelStation).not.toHaveBeenCalled();

  await userEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
  expect(await screen.findByText('Horizontal 4 dots · Vertical -3 dots')).toBeTruthy();
  expect(api.putLabelStation).not.toHaveBeenCalled();
  expect(stored).toEqual(ZD421);
});

it("Change printer's Save printer wins over the switch: its offsets and peel are kept", async () => {
  usb.known = [{ productName: 'ZD421', serialNumber: 'ZD421-SN' }];
  renderPage();
  expect(await screen.findByText('Horizontal 4 dots · Vertical -3 dots')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Change printer' }));
  const dialog = await screen.findByRole('dialog', { name: 'Change printer' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Pick a printer' }));
  step.save = {
    label_kind: 'top', dpi: 203, offset_x: 7, offset_y: 2, peel: false,
    printer: { type: 'usb', ip: null, model: 'ZD411-203dpi', serial: 'ZD411-SN' },
  };
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save printer' }));
  expect(await screen.findByText('Horizontal 7 dots · Vertical 2 dots')).toBeTruthy();
  await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  expect(api.putLabelStation).toHaveBeenCalledTimes(1);   // the step's save only
  expect(stored).toEqual(step.save);
});
