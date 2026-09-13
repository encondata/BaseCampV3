/**
 * React wrapper around `labels/zebraUsb.ts` — one printer per page, held
 * in a ref so USB disconnect events and the unmount release see the live
 * device; V2's connect/disconnect notices are exposed as `notice` for the
 * page's status strip. Pass a fake `usb` in tests; the default is
 * `navigator.usb`, and `supported` is false where WebUSB doesn't exist.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  closePrinter, openPrinter, requestZebraDevice, sendRaw, waitForPrinterIdle,
  query as usbQuery, sendBytes as usbSendBytes, parseHostIdentification, parseHostStatus,
  type UsbDeviceLike, type UsbLike, type HostIdentification, type HostStatus, type ReadOptions,
} from '../labels/zebraUsb';
import { HOST_IDENTIFICATION, HOST_STATUS } from '../labels/zebraCommands';

export interface PrinterNotice { type: 'success' | 'info' | 'warning' | 'error'; message: string }

export interface PrinterLogEntry { at: string; command: string; response: string }

type UsbEvents = {
  addEventListener?: (type: 'disconnect', fn: (e: { device: UsbDeviceLike }) => void) => void;
  removeEventListener?: (type: 'disconnect', fn: (e: { device: UsbDeviceLike }) => void) => void;
};

export type UsbApi = UsbLike & UsbEvents & { getDevices?: () => Promise<UsbDeviceLike[]> };

export interface ZebraPrinter {
  supported: boolean;
  connected: boolean;
  productName: string | null;
  notice: PrinterNotice | null;
  clearNotice(): void;
  connect(): Promise<void>;
  connectTo(device: UsbDeviceLike): Promise<void>;
  disconnect(): Promise<void>;
  send(zpl: string): Promise<void>;
  waitForIdle(labelsSent: number, onQueued?: (n: number) => void): Promise<void>;
  query(command: string, opts?: ReadOptions): Promise<string>;
  sendBytes(bytes: Uint8Array, onProgress?: (sent: number, total: number) => void): Promise<void>;
  identify(): Promise<HostIdentification | null>;
  status(): Promise<HostStatus | null>;
  knownDevices(): Promise<UsbDeviceLike[]>;
  log: PrinterLogEntry[];
  clearLog(): void;
}

function defaultUsb(): UsbApi | null {
  if (typeof navigator === 'undefined') return null;
  const usb = (navigator as unknown as { usb?: UsbApi }).usb;
  return usb ?? null;
}

export function useZebraPrinter(usbOverride?: UsbApi | null): ZebraPrinter {
  const usb = useMemo(() => (usbOverride === undefined ? defaultUsb() : usbOverride), [usbOverride]);
  const deviceRef = useRef<UsbDeviceLike | null>(null);
  const [device, setDevice] = useState<UsbDeviceLike | null>(null);
  const [notice, setNotice] = useState<PrinterNotice | null>(null);
  const [log, setLog] = useState<PrinterLogEntry[]>([]);

  const record = useCallback((command: string, response: string) => setLog((l) => [...l, {
    at: new Date().toISOString(), command: command.slice(0, 200), response: response.slice(0, 2000),
  }].slice(-200)), []);

  const drop = useCallback((next: PrinterNotice | null) => {
    deviceRef.current = null;
    setDevice(null);
    if (next) setNotice(next);
  }, []);

  // Shared by connect and connectTo once a device is open and claimed.
  const adopt = useCallback((next: UsbDeviceLike) => {
    deviceRef.current = next;
    setDevice(next);
    setNotice({ type: 'success', message: `Printer connected: ${next.productName || 'Zebra Printer'}` });
  }, []);

  // A physical unplug of OUR device drops the connection with V2's warning.
  useEffect(() => {
    if (!usb?.addEventListener) return undefined;
    const onDisconnect = (e: { device: UsbDeviceLike }) => {
      if (deviceRef.current && e.device === deviceRef.current) {
        drop({ type: 'warning', message: 'Printer was disconnected' });
      }
    };
    usb.addEventListener('disconnect', onDisconnect);
    return () => usb.removeEventListener?.('disconnect', onDisconnect);
  }, [usb, drop]);

  // Leaving the page releases the interface and closes the device (V2).
  useEffect(() => () => {
    const held = deviceRef.current;
    deviceRef.current = null;
    if (held) void closePrinter(held);
  }, []);

  const connect = useCallback(async () => {
    if (!usb) {
      setNotice({ type: 'error', message: 'USB printing needs Chrome or Edge on a secure (https or localhost) address.' });
      return;
    }
    if (deviceRef.current) {
      await closePrinter(deviceRef.current);
      drop(null);
    }
    try {
      const next = await requestZebraDevice(usb);
      await openPrinter(next);
      adopt(next);
    } catch (err) {
      drop({ type: 'error', message: err instanceof Error && err.message ? err.message : 'Failed to connect to printer' });
    }
  }, [usb, drop, adopt]);

  const connectTo = useCallback(async (nextDevice: UsbDeviceLike) => {
    if (deviceRef.current) {
      await closePrinter(deviceRef.current);
      drop(null);
    }
    try {
      await openPrinter(nextDevice);
      adopt(nextDevice);
    } catch (err) {
      drop({ type: 'error', message: err instanceof Error && err.message ? err.message : 'Failed to connect to printer' });
    }
  }, [drop, adopt]);

  const disconnect = useCallback(async () => {
    const held = deviceRef.current;
    if (held) await closePrinter(held);
    drop({ type: 'info', message: 'Printer disconnected' });
  }, [drop]);

  const send = useCallback(async (zpl: string) => {
    const held = deviceRef.current;
    if (!held) throw new Error('Printer not connected');
    try {
      await sendRaw(held, zpl);
      record(zpl, '');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Printer connection lost')) drop(null);
      throw err;
    }
  }, [drop, record]);

  const query = useCallback(async (command: string, opts?: ReadOptions) => {
    const held = deviceRef.current;
    if (!held) throw new Error('Printer not connected');
    try {
      const text = await usbQuery(held, command, opts);
      record(command, text);
      return text;
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Printer connection lost')) drop(null);
      throw err;
    }
  }, [drop, record]);

  const sendBytes = useCallback(async (bytes: Uint8Array, onProgress?: (sent: number, total: number) => void) => {
    const held = deviceRef.current;
    if (!held) throw new Error('Printer not connected');
    try {
      await usbSendBytes(held, bytes, { onProgress });
      record(`<${bytes.length} bytes>`, '');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Printer connection lost')) drop(null);
      throw err;
    }
  }, [drop, record]);

  const identify = useCallback(async () => parseHostIdentification(await query(HOST_IDENTIFICATION)), [query]);

  const status = useCallback(async () => parseHostStatus(await query(HOST_STATUS, { maxReads: 4 })), [query]);

  const knownDevices = useCallback(async () => (usb?.getDevices ? usb.getDevices() : []), [usb]);

  const waitForIdle = useCallback(async (labelsSent: number, onQueued?: (n: number) => void) => {
    const held = deviceRef.current;
    if (!held) return;
    await waitForPrinterIdle(held, labelsSent, { onQueued });
  }, []);

  return {
    supported: usb !== null,
    connected: device !== null,
    productName: device?.productName ?? null,
    notice,
    clearNotice: () => setNotice(null),
    connect, connectTo, disconnect, send, waitForIdle,
    query, sendBytes, identify, status, knownDevices,
    log, clearLog: () => setLog([]),
  };
}
