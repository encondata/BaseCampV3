// @vitest-environment jsdom
/** The Label Station's saved printer: network straight from the settings,
 *  USB by the saved serial (the only allowed Zebra only when no serial is
 *  saved or it reports none), else the person
 *  has to connect one. */
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { LabelStationSettings } from './api';

const apiMock = vi.hoisted(() => ({ getLabelStation: vi.fn() }));
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
        query: async () => '', send: async () => {}, sendBytes: async () => {},
      };
    },
  };
});

import { writeKioskSetup } from './kioskSetup';
import { useStationPrinter } from './useStationPrinter';

function settings(printer: Partial<LabelStationSettings['printer']>): LabelStationSettings {
  return {
    label_kind: 'top', dpi: 203, offset_x: 0, offset_y: 0, peel: false,
    printer: { type: 'usb', ip: null, model: 'ZD421', serial: null, ...printer },
  };
}

beforeEach(() => {
  usb.known = [];
  writeKioskSetup({
    initiativeId: 'i-1', initiativeName: 'Move', siteId: 's-1', siteName: 'ORD1',
    siteRole: 'source', scanStatus: 'k', scanLabel: 'Dock', stationType: 'label',
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

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
