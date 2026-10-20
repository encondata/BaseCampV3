// @vitest-environment jsdom
/** Settings › Devices › Label printer card: WebUSB support, auto-connect to
 *  an already-allowed printer, details and pills from `~HI` / `~HS`, the
 *  10 s status poll (a failure never throws), the test label, switching
 *  printers, release on disconnect and unmount, and the Printer tools link. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { StrictMode, useSyncExternalStore } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { HostIdentification, HostStatus, UsbDeviceLike } from '@portal/labels/zebraUsb';

const hook = vi.hoisted(() => ({ impl: null as null | ((...a: unknown[]) => unknown) }));
vi.mock('../../lib/useZebraPrinter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/useZebraPrinter')>();
  return { ...actual, useZebraPrinter: (...a: unknown[]) => (hook.impl ? hook.impl(...a) : useFakePrinter()) };
});

import { writeDevMode } from '../../lib/devMode';
import { setKioskName } from '../../lib/identity';
import { clearKioskSetup, writeKioskSetup } from '../../lib/kioskSetup';
import { writeSetupState } from '../../lib/setupState';
import PrinterCard, { testLabelZpl } from './PrinterCard';

// ── A fake hook backed by a tiny store, so connect / disconnect re-render ──
const store = {
  version: 0, supported: true, connected: false,
  device: null as UsbDeviceLike | null,
  listeners: new Set<() => void>(),
};
function setStore(patch: Partial<typeof store>) {
  Object.assign(store, patch);
  store.version += 1;
  store.listeners.forEach((l) => l());
}
const dev = (name: string) => ({ productName: name }) as unknown as UsbDeviceLike;
const PICKED = dev('ZD621 picked');

const IDENT: HostIdentification = { model: 'ZD621-203dpi', firmware: 'V93.21.18Z', dotsPerMm: 8, memory: '8192k', dpi: 203 };
const OK: HostStatus = {
  paperOut: false, paused: false, labelLength: 203, formatsQueued: 0, bufferFull: false, partialFormat: false,
  corruptRam: false, underTemp: false, overTemp: false, headOpen: false, ribbonOut: false,
  thermalTransfer: false, printMode: '0', labelWaiting: false, labelsRemaining: 0,
};

const fns = {
  connect: vi.fn(), connectTo: vi.fn(), disconnect: vi.fn(), identify: vi.fn(),
  status: vi.fn(), send: vi.fn(), knownDevices: vi.fn(),
};

function useFakePrinter() {
  useSyncExternalStore(
    (l) => { store.listeners.add(l); return () => { store.listeners.delete(l); }; },
    () => store.version,
  );
  return {
    supported: store.supported, connected: store.connected, device: store.device,
    productName: store.device?.productName ?? null,
    notice: null, clearNotice: () => {}, log: [], clearLog: () => {},
    ensureOpen: vi.fn(), waitForIdle: vi.fn(), query: vi.fn(), sendBytes: vi.fn(),
    ...fns,
  };
}

async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function renderCard() {
  const view = render(<MemoryRouter initialEntries={['/settings']}><PrinterCard /></MemoryRouter>);
  await flush();
  return view;
}

const pill = () => document.querySelector('.device-card-head .chip') as HTMLElement | null;
const dd = (label: string) => {
  const dt = [...document.querySelectorAll('dt')].find((d) => d.textContent === label);
  return dt ? (dt.nextElementSibling as HTMLElement) : null;
};

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false });
  vi.setSystemTime(new Date('2026-10-17T15:00:00'));
  localStorage.clear();
  hook.impl = null;
  store.listeners.clear();
  Object.assign(store, { version: 0, supported: true, connected: false, device: null });
  fns.connect.mockReset().mockImplementation(async () => setStore({ connected: true, device: PICKED }));
  fns.connectTo.mockReset().mockImplementation(async (d: UsbDeviceLike) => setStore({ connected: true, device: d }));
  fns.disconnect.mockReset().mockImplementation(async () => setStore({ connected: false, device: null }));
  fns.identify.mockReset().mockResolvedValue(IDENT);
  fns.status.mockReset().mockResolvedValue(OK);
  fns.send.mockReset().mockResolvedValue(undefined);
  fns.knownDevices.mockReset().mockResolvedValue([]);
  writeSetupState('complete');
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  delete window.__KIOSK_CONFIG__;
  clearKioskSetup();
  writeDevMode(false);
});

describe('PrinterCard', () => {
  it('no_webusb_shows_chrome_or_edge_note', async () => {
    store.supported = false;
    await renderCard();
    expect(screen.getByText('Use Chrome or Edge to connect a Zebra printer.')).toBeTruthy();
    const connect = screen.getByRole('button', { name: 'Connect printer' }) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(pill()?.textContent).toBe('Not connected');
    expect(fns.knownDevices).not.toHaveBeenCalled();
  });

  it('not_connected_shows_connect_button', async () => {
    await renderCard();
    expect(pill()?.textContent).toBe('Not connected');
    expect(pill()?.className).toContain('c-slate');
    expect(screen.queryByRole('button', { name: 'Print test label' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Connect printer' }));
    await flush();
    expect(fns.connect).toHaveBeenCalledTimes(1);
    expect(dd('Model')?.textContent).toBe('ZD621-203dpi');
  });

  it('auto_connects_to_an_already_allowed_printer', async () => {
    const a = dev('ZD621');
    const b = dev('ZD421');
    fns.knownDevices.mockResolvedValue([a, b]);
    await renderCard();
    expect(fns.connectTo).toHaveBeenCalledTimes(1);
    expect(fns.connectTo).toHaveBeenCalledWith(a);
    expect(fns.identify).toHaveBeenCalled();
    expect(fns.status).toHaveBeenCalled();
  });

  it('connected_shows_model_firmware_dpi_usb_and_ready_pill', async () => {
    fns.knownDevices.mockResolvedValue([dev('ZD621')]);
    await renderCard();
    expect(pill()?.textContent).toBe('Ready');
    expect(pill()?.className).toContain('c-green');
    expect(dd('Model')?.textContent).toBe('ZD621-203dpi');
    expect(dd('Firmware')?.textContent).toBe('V93.21.18Z');
    expect(dd('Resolution')?.textContent).toBe('203 dpi');
    expect(dd('Connection')?.textContent).toBe('USB');
    expect(dd('Labels queued')?.textContent).toBe('0');
    for (const name of ['Print test label', 'Refresh', 'Disconnect']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    expect(document.body.textContent).not.toMatch(/undefined|null/);
  });

  it('hides rows the printer did not report', async () => {
    fns.knownDevices.mockResolvedValue([dev('ZD621')]);
    fns.identify.mockResolvedValue(null);
    fns.status.mockResolvedValue(null);
    await renderCard();
    expect(dd('Model')?.textContent).toBe('ZD621');
    expect(dd('Firmware')).toBeNull();
    expect(dd('Resolution')).toBeNull();
    expect(dd('Labels queued')).toBeNull();
    expect(dd('Connection')?.textContent).toBe('USB');
    expect(document.body.textContent).not.toMatch(/undefined|null/);
  });

  it('paper_out_status_shows_amber_paper_out_pill_and_chips', async () => {
    fns.knownDevices.mockResolvedValue([dev('ZD621')]);
    fns.status.mockResolvedValue({ ...OK, paperOut: true, ribbonOut: true, formatsQueued: 2 });
    await renderCard();
    expect(pill()?.textContent).toBe('Paper out');
    expect(pill()?.className).toContain('c-amber');
    const chips = [...document.querySelectorAll('.device-chips .chip')].map((c) => c.textContent);
    expect(chips).toEqual(['Paper out', 'Ribbon out']);
    expect(dd('Labels queued')?.textContent).toBe('2');
  });

  it.each([
    [{ ribbonOut: true, paused: true }, 'Ribbon out'],
    [{ headOpen: true, paused: true }, 'Head open'],
    [{ paused: true, overTemp: true }, 'Paused'],
    [{ overTemp: true, underTemp: true }, 'Too hot'],
    [{ underTemp: true }, 'Too cold'],
  ])('first problem wins: %o → %s', async (patch, label) => {
    fns.knownDevices.mockResolvedValue([dev('ZD621')]);
    fns.status.mockResolvedValue({ ...OK, ...patch });
    await renderCard();
    expect(pill()?.textContent).toBe(label);
    expect(pill()?.className).toContain('c-amber');
  });

  it('status_refreshes_every_10s_and_a_failure_never_throws', async () => {
    fns.knownDevices.mockResolvedValue([dev('ZD621')]);
    const view = await renderCard();
    expect(fns.status).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999); });
    expect(fns.status).toHaveBeenCalledTimes(1);
    fns.status.mockRejectedValueOnce(new Error('Printer read timed out'));
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(fns.status).toHaveBeenCalledTimes(2);
    // The last good status stays on screen and the chain keeps going.
    expect(pill()?.textContent).toBe('Ready');
    fns.status.mockResolvedValueOnce({ ...OK, paperOut: true });
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(fns.status).toHaveBeenCalledTimes(3);
    expect(pill()?.textContent).toBe('Paper out');
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(fns.status).toHaveBeenCalledTimes(3);
  });

  it('under StrictMode connects once and polls ~HS once per 10 s', async () => {
    fns.knownDevices.mockResolvedValue([dev('ZD621')]);
    const view = render(<StrictMode><MemoryRouter><PrinterCard /></MemoryRouter></StrictMode>);
    await flush();
    expect(fns.connectTo).toHaveBeenCalledTimes(1);
    const first = fns.status.mock.calls.length;
    expect(first).toBe(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fns.status).toHaveBeenCalledTimes(first + 3);
    view.unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(fns.status).toHaveBeenCalledTimes(first + 3);
  });

  it('printer calls run one at a time: Refresh waits for a pending ~HS poll', async () => {
    fns.knownDevices.mockResolvedValue([dev('ZD621')]);
    const calls: string[] = [];
    let release: (() => void) | null = null;
    fns.identify.mockImplementation(async () => { calls.push('HI'); return IDENT; });
    fns.status.mockImplementation(async () => {
      calls.push('HS');
      if (calls.filter((c) => c === 'HS').length === 2) {
        await new Promise<void>((r) => { release = r; });
        calls.push('HS done');
      }
      return OK;
    });
    await renderCard();
    expect(calls).toEqual(['HI', 'HS']);
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(calls).toEqual(['HI', 'HS', 'HS']);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    fireEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    await flush();
    // Nothing else goes to the printer while that ~HS is still out.
    expect(calls).toEqual(['HI', 'HS', 'HS']);
    expect(fns.send).not.toHaveBeenCalled();
    await act(async () => { release!(); await vi.advanceTimersByTimeAsync(0); });
    expect(calls).toEqual(['HI', 'HS', 'HS', 'HS done', 'HI', 'HS']);
    expect(fns.send).toHaveBeenCalledTimes(1);
    expect(dd('Model')?.textContent).toBe('ZD621-203dpi');
    expect(dd('Firmware')?.textContent).toBe('V93.21.18Z');
  });

  it('Refresh reads identity and status again', async () => {
    fns.knownDevices.mockResolvedValue([dev('ZD621')]);
    await renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flush();
    expect(fns.identify).toHaveBeenCalledTimes(2);
    expect(fns.status).toHaveBeenCalledTimes(2);
  });

  it('print_test_label_sends_zpl_with_kiosk_name_and_dpi_sizing', async () => {
    setKioskName('Dock 3 kiosk');
    fns.knownDevices.mockResolvedValue([dev('ZD621')]);
    fns.identify.mockResolvedValue({ ...IDENT, dpi: 300 });
    await renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    await flush();
    expect(fns.send).toHaveBeenCalledTimes(1);
    const zpl = fns.send.mock.calls[0][0] as string;
    expect(zpl).toBe(testLabelZpl('Dock 3 kiosk', new Date('2026-10-17T15:00:00'), 300));
    expect(screen.getByRole('status').textContent).toBe('Test label sent.');

    fns.send.mockRejectedValueOnce(new Error('Printer connection lost. Please reconnect.'));
    fireEvent.click(screen.getByRole('button', { name: 'Print test label' }));
    await flush();
    expect(screen.getByRole('status').textContent)
      .toBe('Couldn’t print the test label: Printer connection lost. Please reconnect.');
  });

  it('testLabelZpl fits 2×1 in at 203 dpi, scales by dpi, and has a border and three lines', () => {
    const when = new Date('2026-10-17T15:00:00');
    const z203 = testLabelZpl('Dock 3', when, 203);
    expect(z203.startsWith('^XA')).toBe(true);
    expect(z203.endsWith('^XZ')).toBe(true);
    expect(z203).toContain('^PW406');
    expect(z203).toContain('^LL203');
    expect(z203).toMatch(/\^GB\d+,\d+,\d+\^FS/);
    expect(z203.match(/\^FD/g)).toHaveLength(3);
    expect(z203).toContain('^FDServerSherpa test label^FS');
    expect(z203).toContain('^FDDock 3^FS');
    expect(z203).toContain('Oct 17, 2026');
    const z300 = testLabelZpl('Dock 3', when, 300);
    expect(z300).toContain('^PW600');
    expect(z300).toContain('^LL300');
    const z600 = testLabelZpl('Dock 3', when, 600);
    expect(z600).toContain('^PW1200');
    // ZPL control characters in a kiosk name can't break the format.
    const odd = testLabelZpl('A^XZ~JR', when, 203);
    expect(odd.match(/\^XZ/g)).toHaveLength(1);
    expect(odd).not.toContain('~JR');
  });

  it('other_allowed_printers_are_listed_and_switchable', async () => {
    const a = dev('ZD621');
    const b = dev('ZD421');
    fns.knownDevices.mockResolvedValue([a, b]);
    await renderCard();
    const note = document.querySelector('.device-note') as HTMLElement;
    expect(note.textContent).toContain('Other printers this browser can use:');
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await flush();
    expect((document.querySelector('.device-note') as HTMLElement).textContent)
      .toMatch(/^Printers this browser can use:/);
    fireEvent.click(screen.getByRole('button', { name: 'ZD621' }));
    await flush();
    expect(screen.queryByRole('button', { name: 'ZD621' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'ZD421' }));
    await flush();
    expect(fns.connectTo).toHaveBeenLastCalledWith(b);
    expect(screen.getByRole('button', { name: 'ZD621' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'ZD421' })).toBeNull();
  });

  it('disconnect_and_unmount_release_the_printer', async () => {
    fns.knownDevices.mockResolvedValue([dev('ZD621')]);
    await renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    await flush();
    expect(fns.disconnect).toHaveBeenCalledTimes(1);
    expect(pill()?.textContent).toBe('Not connected');
    cleanup();

    // Unmount through the real hook: the USB interface is released and the
    // device closed, so Printer tools can claim it.
    const actual = await vi.importActual<typeof import('../../lib/useZebraPrinter')>('../../lib/useZebraPrinter');
    const log: string[] = [];
    const real = {
      opened: false, productName: 'ZD621',
      configuration: { interfaces: [{ alternate: { endpoints: [] } }] },
      async open() { real.opened = true; log.push('open'); },
      async close() { real.opened = false; log.push('close'); },
      async selectConfiguration() {},
      async claimInterface() { log.push('claim'); },
      async releaseInterface() { log.push('release'); },
      async transferOut() {},
      transferIn: () => new Promise<{ data?: DataView }>(() => {}),
    };
    const usb = { requestDevice: vi.fn(), getDevices: async () => [real as unknown as UsbDeviceLike] };
    hook.impl = () => actual.useZebraPrinter(usb);
    const view = await renderCard();
    expect(log).toEqual(['open', 'claim']);
    view.unmount();
    await flush();
    expect(log).toEqual(['open', 'claim', 'release', 'close']);
  });

  describe('printer_tools_link_only_where_label_printing_is_reachable', () => {
    const SETUP = {
      initiativeId: 'i', initiativeName: 'Move', siteId: 's', siteName: 'Site', siteRole: 'source' as const,
      scanStatus: 'x', scanLabel: 'X',
    };
    const link = () => screen.queryByRole('link', { name: 'Printer tools' });

    beforeEach(() => { fns.knownDevices.mockResolvedValue([dev('ZD621')]); });

    it('web kiosk with setup complete shows it', async () => {
      await renderCard();
      expect(link()?.getAttribute('href')).toBe('/labels/printers');
    });

    it('setup incomplete hides it, developer mode shows it', async () => {
      writeSetupState('incomplete');
      await renderCard();
      expect(link()).toBeNull();
      cleanup();
      writeDevMode(true);
      await renderCard();
      expect(link()).toBeTruthy();
    });

    it('shows it on an RFID Station and a Label Station alike', async () => {
      window.__KIOSK_CONFIG__ = { mode: 'laptop' };
      writeKioskSetup({ ...SETUP, stationType: 'rfid' });
      await renderCard();
      expect(link()).toBeTruthy();
      cleanup();
      writeKioskSetup({ ...SETUP, stationType: 'label' });
      await renderCard();
      expect(link()).toBeTruthy();
    });

    it('not connected hides it', async () => {
      fns.knownDevices.mockResolvedValue([]);
      await renderCard();
      expect(link()).toBeNull();
    });
  });
});
