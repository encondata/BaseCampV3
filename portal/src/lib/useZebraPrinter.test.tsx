// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { UsbDeviceLike } from '../labels/zebraUsb';
import { useZebraPrinter } from './useZebraPrinter';

function fakeDevice(name = 'ZD421'): UsbDeviceLike & { log: string[] } {
  const dev = {
    opened: false, productName: name, log: [] as string[],
    configuration: { interfaces: [{ alternate: { endpoints: [{ direction: 'out' as const, type: 'bulk' as const, endpointNumber: 1 }, { direction: 'in' as const, type: 'bulk' as const, endpointNumber: 2 }] } }] },
    async open() { dev.opened = true; dev.log.push('open'); },
    async close() { dev.opened = false; dev.log.push('close'); },
    async selectConfiguration() { dev.log.push('select'); },
    async claimInterface() { dev.log.push('claim'); },
    async releaseInterface() { dev.log.push('release'); },
    async transferOut(_e: number, data: BufferSource) { dev.log.push(`out:${new TextDecoder().decode(data as ArrayBuffer)}`); },
    async transferIn() { return new Promise<{ data?: DataView }>(() => undefined); },
  };
  return dev;
}

function fakeUsb(device: UsbDeviceLike | Error) {
  const listeners: Record<string, ((e: { device: UsbDeviceLike }) => void)[]> = {};
  return {
    requestDevice: vi.fn(async () => { if (device instanceof Error) throw device; return device; }),
    addEventListener: (type: string, fn: (e: { device: UsbDeviceLike }) => void) => { (listeners[type] ??= []).push(fn); },
    removeEventListener: (type: string, fn: (e: { device: UsbDeviceLike }) => void) => { listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn); },
    emitDisconnect: (d: UsbDeviceLike) => listeners.disconnect?.forEach((fn) => fn({ device: d })),
    listeners,
  };
}

describe('useZebraPrinter', () => {
  it('reports unsupported when no usb object exists', () => {
    const { result } = renderHook(() => useZebraPrinter(null));
    expect(result.current.supported).toBe(false);
    expect(result.current.connected).toBe(false);
  });

  it('connects (request → open → claim) and reports the product name', async () => {
    const dev = fakeDevice();
    const usb = fakeUsb(dev);
    const { result } = renderHook(() => useZebraPrinter(usb));
    expect(result.current.supported).toBe(true);
    await act(async () => { await result.current.connect(); });
    expect(dev.log).toEqual(['open', 'claim']);
    expect(result.current.connected).toBe(true);
    expect(result.current.productName).toBe('ZD421');
    expect(result.current.notice).toEqual({ type: 'success', message: 'Printer connected: ZD421' });
  });

  it('surfaces a connect failure as an error notice and stays disconnected', async () => {
    const usb = fakeUsb(new Error('No device selected.'));
    const { result } = renderHook(() => useZebraPrinter(usb));
    await act(async () => { await result.current.connect(); });
    expect(result.current.connected).toBe(false);
    expect(result.current.notice).toEqual({ type: 'error', message: 'No device selected.' });
  });

  it('sends raw ZPL through the device and disconnects cleanly', async () => {
    const dev = fakeDevice();
    const usb = fakeUsb(dev);
    const { result } = renderHook(() => useZebraPrinter(usb));
    await act(async () => { await result.current.connect(); });
    await act(async () => { await result.current.send('^XA^XZ'); });
    expect(dev.log).toContain('out:^XA^XZ');
    await act(async () => { await result.current.disconnect(); });
    expect(dev.log.slice(-2)).toEqual(['release', 'close']);
    expect(result.current.connected).toBe(false);
    expect(result.current.notice).toEqual({ type: 'info', message: 'Printer disconnected' });
    await expect(result.current.send('^XA^XZ')).rejects.toThrow('Printer not connected');
  });

  it('drops the connection with a warning when the USB device disconnects, and releases on unmount', async () => {
    const dev = fakeDevice();
    const usb = fakeUsb(dev);
    const { result, unmount } = renderHook(() => useZebraPrinter(usb));
    await act(async () => { await result.current.connect(); });
    act(() => { usb.emitDisconnect(fakeDevice('other')); });
    expect(result.current.connected).toBe(true);
    act(() => { usb.emitDisconnect(dev); });
    expect(result.current.connected).toBe(false);
    expect(result.current.notice).toEqual({ type: 'warning', message: 'Printer was disconnected' });

    const dev2 = fakeDevice();
    const usb2 = fakeUsb(dev2);
    const h2 = renderHook(() => useZebraPrinter(usb2));
    await act(async () => { await h2.result.current.connect(); });
    h2.unmount();
    await new Promise((r) => setTimeout(r, 0));
    expect(dev2.log.slice(-2)).toEqual(['release', 'close']);
    expect(usb2.listeners.disconnect?.length ?? 0).toBe(0);
    unmount();
  });
});
