// @vitest-environment jsdom
/** The Label Station's saved printer: network straight from the settings,
 *  USB by the saved serial (the only allowed Zebra only when no serial is
 *  saved or it reports none), else the person
 *  has to connect one. */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LabelStationSettings } from './api';

const apiMock = vi.hoisted(() => ({ getLabelStation: vi.fn(), putLabelStation: vi.fn() }));
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, ...apiMock };
});

type Dev = { productName: string; serialNumber: string };
const usb = vi.hoisted(() => ({
  known: [] as { productName: string; serialNumber: string }[],
  connectTo: vi.fn(),
  connect: vi.fn(),
  picked: { productName: 'ZD621', serialNumber: 'PICKED' },
  /** Every command `query` was given, in order. */
  queries: [] as string[],
  /** The printer's `~HI` reply, or an error to throw. */
  hi: '' as string | Error,
  /** The `sensor.peeler_present` reply. */
  peeler: '"present"',
}));
vi.mock('./useZebraPrinter', async () => {
  const { useState } = await import('react');
  return {
    useZebraPrinter: () => {
      const [device, setDevice] = useState<Dev | null>(null);
      return {
        supported: true, connected: device !== null, productName: device?.productName ?? null, device,
        notice: null, clearNotice: () => {},
        connect: async () => { usb.connect(); setDevice(usb.picked); },
        connectTo: async (d: Dev) => { usb.connectTo(d); setDevice(d); },
        knownDevices: async () => usb.known,
        query: async (command: string) => {
          usb.queries.push(command);
          if (command === '~HI') {
            if (usb.hi instanceof Error) throw usb.hi;
            return usb.hi;
          }
          return command.includes('sensor.peeler_present') ? usb.peeler : '';
        },
        send: async () => {}, sendBytes: async () => {},
      };
    },
  };
});

import { ApiError } from './api';
import { writeKioskSetup } from './kioskSetup';
import { useStationPrinter } from './useStationPrinter';
import { readWebLabelSettings, writeWebLabelSettings } from './webLabelSettings';

function settings(printer: Partial<LabelStationSettings['printer']>): LabelStationSettings {
  return {
    label_kind: 'top', dpi: 203, offset_x: 0, offset_y: 0, peel: false,
    printer: { type: 'usb', ip: null, model: 'ZD421', serial: null, ...printer },
  };
}

beforeEach(() => {
  // A laptop Label Station: settings from the edge. The web cases below
  // clear this.
  window.__KIOSK_CONFIG__ = { mode: 'laptop' };
  usb.known = [];
  usb.queries = [];
  usb.hi = '';
  usb.peeler = '"present"';
  apiMock.putLabelStation.mockImplementation(async (s: LabelStationSettings) => s);
  writeKioskSetup({
    initiativeId: 'i-1', initiativeName: 'Move', siteId: 's-1', siteName: 'ORD1',
    siteRole: 'source', scanStatus: 'k', scanLabel: 'Dock', stationType: 'label',
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); delete window.__KIOSK_CONFIG__; });

it('a network printer is ready from the saved IP', async () => {
  apiMock.getLabelStation.mockResolvedValue(settings({ type: 'network', ip: '10.0.0.40' }));
  const { result } = renderHook(() => useStationPrinter());
  expect(result.current.state).toBe('loading');
  await waitFor(() => expect(result.current.state).toBe('ready'));
  expect(result.current.printer).toMatchObject({ kind: 'network', ip: '10.0.0.40' });
  expect(result.current.settings?.printer.ip).toBe('10.0.0.40');
  expect(usb.connectTo).not.toHaveBeenCalled();
});

it('a USB printer connects to the allowed device with the saved serial', async () => {
  usb.known = [{ productName: 'ZD421', serialNumber: 'OTHER' }, { productName: 'ZD421', serialNumber: 'SAVED' }];
  apiMock.getLabelStation.mockResolvedValue(settings({ serial: 'SAVED' }));
  const { result } = renderHook(() => useStationPrinter());
  await waitFor(() => expect(result.current.state).toBe('ready'));
  expect(usb.connectTo).toHaveBeenCalledWith(usb.known[1]);
  expect(result.current.printer).toMatchObject({ kind: 'usb', serial: 'SAVED' });
  // the same serial is the same printer: nothing is asked, nothing saved
  expect(usb.queries).toEqual([]);
  expect(apiMock.putLabelStation).not.toHaveBeenCalled();
  expect(result.current.switched).toBeNull();
});

it('a saved serial the only allowed Zebra does not match is needs_usb, never a different printer', async () => {
  usb.known = [{ productName: 'ZD421', serialNumber: 'ONLY' }];
  apiMock.getLabelStation.mockResolvedValue(settings({ serial: 'SAVED' }));
  const { result } = renderHook(() => useStationPrinter());
  await waitFor(() => expect(result.current.state).toBe('needs_usb'));
  expect(usb.connectTo).not.toHaveBeenCalled();
  expect(result.current.printer).toBeNull();
});

it('no saved serial uses the only allowed Zebra', async () => {
  usb.known = [{ productName: 'ZD421', serialNumber: 'ONLY' }];
  apiMock.getLabelStation.mockResolvedValue(settings({ serial: null }));
  const { result } = renderHook(() => useStationPrinter());
  await waitFor(() => expect(result.current.state).toBe('ready'));
  expect(usb.connectTo).toHaveBeenCalledWith(usb.known[0]);
});

it('the only allowed Zebra reporting no serial stands in for a saved one', async () => {
  usb.known = [{ productName: 'ZD421', serialNumber: '' }];
  apiMock.getLabelStation.mockResolvedValue(settings({ serial: 'SAVED' }));
  const { result } = renderHook(() => useStationPrinter());
  await waitFor(() => expect(result.current.state).toBe('ready'));
  expect(usb.connectTo).toHaveBeenCalledWith(usb.known[0]);
});

it('needs_usb when no allowed device can be picked, and connectUsb opens the picker', async () => {
  usb.known = [{ productName: 'ZD421', serialNumber: 'A' }, { productName: 'ZD421', serialNumber: 'B' }];
  apiMock.getLabelStation.mockResolvedValue(settings({ serial: 'SAVED' }));
  const { result } = renderHook(() => useStationPrinter());
  await waitFor(() => expect(result.current.state).toBe('needs_usb'));
  expect(result.current.printer).toBeNull();
  expect(usb.connectTo).not.toHaveBeenCalled();
  // the picked printer isn't the saved one: it answers ~HI and is switched to
  usb.hi = hi('ZD621-203dpi', 8);
  await act(async () => { await result.current.connectUsb(); });
  expect(usb.connect).toHaveBeenCalled();
  await waitFor(() => expect(result.current.state).toBe('ready'));
});

it('needs_usb when the browser has allowed no printer', async () => {
  apiMock.getLabelStation.mockResolvedValue(settings({ serial: 'SAVED' }));
  const { result } = renderHook(() => useStationPrinter());
  await waitFor(() => expect(result.current.state).toBe('needs_usb'));
});

it('no_settings when the station has none saved', async () => {
  apiMock.getLabelStation.mockResolvedValue(null);
  const { result } = renderHook(() => useStationPrinter());
  await waitFor(() => expect(result.current.state).toBe('no_settings'));
  expect(result.current.settings).toBeNull();
  expect(result.current.printer).toBeNull();
});

it('reload reads the settings again', async () => {
  apiMock.getLabelStation.mockResolvedValue(null);
  const { result } = renderHook(() => useStationPrinter());
  await waitFor(() => expect(result.current.state).toBe('no_settings'));
  apiMock.getLabelStation.mockResolvedValue(settings({ type: 'network', ip: '10.0.0.41' }));
  await act(async () => { await result.current.reload(); });
  await waitFor(() => expect(result.current.state).toBe('ready'));
  expect(result.current.printer).toMatchObject({ ip: '10.0.0.41' });
});

// ── a different USB printer connected ─────────────────────────────────

/** `~HI` as a Zebra answers it: 8 dots/mm is 203 DPI, 12 is 300. */
const hi = (model: string, dotsPerMm: number) => `\x02${model},V84.20.18Z,${dotsPerMm},8192KB\x03`;

/** The ZD421 at 300 DPI Printer Setup saved, with offsets and no peel. */
const SAVED_300 = (serial: string | null): LabelStationSettings => ({
  ...settings({ model: 'ZD421-300dpi', serial }), dpi: 300, offset_x: 4, offset_y: -3, peel: false,
});

type Seen = { state: string; dpi: number | undefined; printer: boolean };
function renderRecorded() {
  const seen: Seen[] = [];
  const hook = renderHook(() => {
    const r = useStationPrinter();
    seen.push({ state: r.state, dpi: r.settings?.dpi, printer: r.printer !== null });
    return r;
  });
  return { ...hook, seen };
}

describe('a USB printer that is not the saved one', () => {
  it('a different serial is read, saved as the printer, and only then ready', async () => {
    apiMock.getLabelStation.mockResolvedValue(SAVED_300('SAVED'));
    usb.hi = hi('ZD411-203dpi', 8);
    usb.peeler = '"present"';
    const { result, seen } = renderRecorded();
    await waitFor(() => expect(result.current.state).toBe('needs_usb'));
    const before = seen.length;

    await act(async () => { await result.current.connectUsb(); });   // picks PICKED
    await waitFor(() => expect(result.current.state).toBe('ready'));

    expect(apiMock.putLabelStation).toHaveBeenCalledTimes(1);
    expect(apiMock.putLabelStation).toHaveBeenCalledWith({
      label_kind: 'top',
      printer: { type: 'usb', ip: null, model: 'ZD411-203dpi', serial: 'PICKED' },
      dpi: 203, offset_x: 0, offset_y: 0, peel: true,
    });
    expect(result.current.settings).toMatchObject({ dpi: 203, offset_x: 0, offset_y: 0, peel: true });
    expect(result.current.settings?.printer.model).toBe('ZD411-203dpi');
    expect(result.current.switched).toEqual({ from: 'ZD421-300dpi · 300 DPI', to: 'ZD411-203dpi · 203 DPI' });
    expect(result.current.switchError).toBeNull();
    expect(usb.queries.filter((q) => q === '~HI')).toHaveLength(1);

    // never ready (nor holding a printer) with the old printer's settings
    const after = seen.slice(before);
    expect(after.some((s) => s.state === 'loading')).toBe(true);
    expect(after.filter((s) => s.state === 'ready' || s.printer).every((s) => s.dpi === 203)).toBe(true);
  });

  it('no serial on either side and the same model and DPI is the saved printer', async () => {
    usb.known = [{ productName: 'ZD421', serialNumber: '' }];
    apiMock.getLabelStation.mockResolvedValue(SAVED_300(null));
    usb.hi = hi('ZD421-300dpi', 12);
    const { result } = renderHook(() => useStationPrinter());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(usb.queries.filter((q) => q === '~HI')).toHaveLength(1);
    expect(apiMock.putLabelStation).not.toHaveBeenCalled();
    expect(result.current.settings).toEqual(SAVED_300(null));
    expect(result.current.switched).toBeNull();
  });

  it('a device with no serial that reports another model switches', async () => {
    usb.known = [{ productName: 'ZD411', serialNumber: '' }];
    apiMock.getLabelStation.mockResolvedValue(SAVED_300('SAVED'));
    usb.hi = hi('ZD411-203dpi', 8);
    usb.peeler = '"not present"';
    const { result } = renderHook(() => useStationPrinter());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(apiMock.putLabelStation).toHaveBeenCalledWith({
      label_kind: 'top',
      printer: { type: 'usb', ip: null, model: 'ZD411-203dpi', serial: null },
      dpi: 203, offset_x: 0, offset_y: 0, peel: false,
    });
    expect(result.current.settings?.dpi).toBe(203);
    expect(result.current.switched).toEqual({ from: 'ZD421-300dpi · 300 DPI', to: 'ZD411-203dpi · 203 DPI' });
  });

  it('a printer that will not identify itself is taken as the saved one', async () => {
    usb.known = [{ productName: 'ZD421', serialNumber: '' }];
    apiMock.getLabelStation.mockResolvedValue(SAVED_300(null));
    usb.hi = new Error('timeout');
    const { result } = renderHook(() => useStationPrinter());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.settings).toEqual(SAVED_300(null));
    expect(apiMock.putLabelStation).not.toHaveBeenCalled();
    expect(result.current.switched).toBeNull();
    expect(result.current.switchError).toBeNull();
  });

  it.each([
    ['throws', new Error('timeout') as string | Error],
    ['answers nothing readable', 'garbage' as string | Error],
  ])('a printer whose serial differs and whose ~HI %s is needs_usb, never the old settings', async (_why, reply) => {
    apiMock.getLabelStation.mockResolvedValue(SAVED_300('SAVED'));
    usb.hi = reply;
    const { result, seen } = renderRecorded();
    await waitFor(() => expect(result.current.state).toBe('needs_usb'));
    const before = seen.length;
    await act(async () => { await result.current.connectUsb(); });   // picks PICKED
    await waitFor(() => expect(result.current.switchError).not.toBeNull());
    expect(result.current.switchError).toBe("the connected printer didn't say what it is");
    expect(result.current.state).toBe('needs_usb');
    expect(result.current.printer).toBeNull();
    expect(result.current.switched).toBeNull();
    expect(apiMock.putLabelStation).not.toHaveBeenCalled();
    expect(seen.slice(before).some((s) => s.state === 'ready' || s.printer)).toBe(false);
  });

  it('an unreadable identity is taken as the saved printer too', async () => {
    usb.known = [{ productName: 'ZD421', serialNumber: '' }];
    apiMock.getLabelStation.mockResolvedValue(SAVED_300(null));
    usb.hi = 'garbage';
    const { result } = renderHook(() => useStationPrinter());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(apiMock.putLabelStation).not.toHaveBeenCalled();
    expect(result.current.settings?.dpi).toBe(300);
  });

  it('a save that fails is needs_usb with the reason, never the old settings as if they matched', async () => {
    apiMock.getLabelStation.mockResolvedValue(SAVED_300('SAVED'));
    apiMock.putLabelStation.mockRejectedValue(new ApiError(409, 'not_label_station'));
    usb.hi = hi('ZD411-203dpi', 8);
    const { result } = renderHook(() => useStationPrinter());
    await waitFor(() => expect(result.current.state).toBe('needs_usb'));
    await act(async () => { await result.current.connectUsb(); });
    await waitFor(() => expect(result.current.switchError).not.toBeNull());
    expect(result.current.state).toBe('needs_usb');
    expect(result.current.printer).toBeNull();
    expect(result.current.switched).toBeNull();
    expect(result.current.switchError).toBe("this laptop isn't set up as a Label Station");

    // Connect printer again (the same printer) tries the switch again
    apiMock.putLabelStation.mockImplementation(async (s: LabelStationSettings) => s);
    await act(async () => { await result.current.connectUsb(); });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.switchError).toBeNull();
    expect(result.current.settings?.dpi).toBe(203);
  });

  it('network settings never ask a connected USB printer who it is', async () => {
    apiMock.getLabelStation.mockResolvedValue(settings({ type: 'network', ip: '10.0.0.40', model: 'ZD421-300dpi' }));
    usb.hi = hi('ZD411-203dpi', 8);
    const { result } = renderHook(() => useStationPrinter());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    await act(async () => { await result.current.connectUsb(); });
    expect(result.current.state).toBe('ready');
    expect(result.current.printer).toMatchObject({ kind: 'network', ip: '10.0.0.40' });
    expect(usb.queries).toEqual([]);
    expect(apiMock.putLabelStation).not.toHaveBeenCalled();
  });

  it('after a switch the next page finds the new printer by its saved serial', async () => {
    // Printer Setup: Connect printer picks the ZD411, which is saved
    let stored = SAVED_300('SAVED');
    apiMock.getLabelStation.mockImplementation(async () => stored);
    apiMock.putLabelStation.mockImplementation(async (s: LabelStationSettings) => { stored = s; return s; });
    usb.hi = hi('ZD411-203dpi', 8);
    const first = renderHook(() => useStationPrinter());
    await waitFor(() => expect(first.result.current.state).toBe('needs_usb'));
    await act(async () => { await first.result.current.connectUsb(); });
    await waitFor(() => expect(first.result.current.state).toBe('ready'));
    first.unmount();

    // Back to Label Printing: Bulk Print's own hook connects it by serial
    // (the old ZD421 is still allowed in this browser, too)
    usb.known = [{ productName: 'ZD421', serialNumber: 'SAVED' }, usb.picked];
    usb.queries = [];
    usb.connectTo.mockClear();
    const next = renderHook(() => useStationPrinter());
    await waitFor(() => expect(next.result.current.state).toBe('ready'));
    expect(usb.connectTo).toHaveBeenCalledWith(usb.picked);
    expect(next.result.current.settings).toMatchObject({
      printer: { model: 'ZD411-203dpi', serial: 'PICKED' }, dpi: 203,
    });
    expect(usb.queries).toEqual([]);   // same serial: nothing asked
    expect(next.result.current.switched).toBeNull();
  });

  it('holdUsbCheck puts the check off, and the settings saved meanwhile win', async () => {
    // Printer Setup's Change printer modal is open: its step picks the ZD411
    let stored = SAVED_300('SAVED');
    apiMock.getLabelStation.mockImplementation(async () => stored);
    usb.hi = hi('ZD411-203dpi', 8);
    const { result, rerender } = renderHook(({ hold }) => useStationPrinter({ holdUsbCheck: hold }), {
      initialProps: { hold: true },
    });
    await waitFor(() => expect(result.current.state).toBe('needs_usb'));
    await act(async () => { await result.current.zebra.connect(); });
    expect(result.current.state).toBe('loading');
    expect(result.current.printer).toBeNull();
    expect(usb.queries).toEqual([]);

    // Save printer stores what the step checked (its offsets and peel)
    stored = {
      ...SAVED_300('PICKED'), printer: { type: 'usb', ip: null, model: 'ZD411-203dpi', serial: 'PICKED' },
      dpi: 203, offset_x: 7, offset_y: 2, peel: true,
    };
    await act(async () => { await result.current.reload(); });
    rerender({ hold: false });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(apiMock.putLabelStation).not.toHaveBeenCalled();
    expect(result.current.settings).toEqual(stored);
    expect(result.current.switched).toBeNull();
    expect(usb.queries).toEqual([]);
  });

  it('on the web the switch is saved to this kiosk and read only once', async () => {
    delete window.__KIOSK_CONFIG__;
    writeWebLabelSettings(SAVED_300('SAVED'));
    usb.hi = hi('ZD411-203dpi', 8);
    const { result } = renderHook(() => useStationPrinter());
    await waitFor(() => expect(result.current.state).toBe('needs_usb'));
    await act(async () => { await result.current.connectUsb(); });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(readWebLabelSettings()).toMatchObject({
      printer: { type: 'usb', model: 'ZD411-203dpi', serial: 'PICKED' }, dpi: 203, offset_x: 0, offset_y: 0, peel: true,
    });
    expect(result.current.settings?.dpi).toBe(203);
    expect(result.current.switched).toEqual({ from: 'ZD421-300dpi · 300 DPI', to: 'ZD411-203dpi · 203 DPI' });
    expect(usb.queries.filter((q) => q === '~HI')).toHaveLength(1);
    expect(apiMock.putLabelStation).not.toHaveBeenCalled();
  });
});

describe('on the web', () => {
  beforeEach(() => { delete window.__KIOSK_CONFIG__; });

  it('reads saved web settings and reloads when they change', async () => {
    usb.known = [{ productName: 'ZD421', serialNumber: 'SAVED' }];
    writeWebLabelSettings(settings({ serial: 'SAVED' }));
    const { result } = renderHook(() => useStationPrinter());
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(result.current.settings).toEqual(settings({ serial: 'SAVED' }));
    expect(usb.connectTo).toHaveBeenCalledWith(usb.known[0]);
    expect(result.current.printer).toMatchObject({ kind: 'usb', serial: 'SAVED' });

    // a save elsewhere on the page (the offsets, the printer step) shows
    // up here without anyone calling reload
    act(() => { writeWebLabelSettings({ ...settings({ serial: 'SAVED' }), offset_x: 6, peel: true }); });
    await waitFor(() => expect(result.current.settings).toMatchObject({ offset_x: 6, peel: true }));
    expect(apiMock.getLabelStation).not.toHaveBeenCalled();
  });

  it('no_settings until a printer is saved on this kiosk, then picks it up', async () => {
    const { result } = renderHook(() => useStationPrinter());
    await waitFor(() => expect(result.current.state).toBe('no_settings'));
    usb.known = [{ productName: 'ZD421', serialNumber: 'NEW' }];
    act(() => { writeWebLabelSettings(settings({ serial: 'NEW' })); });
    await waitFor(() => expect(result.current.state).toBe('ready'));
    expect(apiMock.getLabelStation).not.toHaveBeenCalled();
  });
});
