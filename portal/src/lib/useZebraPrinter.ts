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
  type UsbDeviceLike, type UsbLike,
} from '../labels/zebraUsb';

export interface PrinterNotice { type: 'success' | 'info' | 'warning' | 'error'; message: string }

type UsbEvents = {
  addEventListener?: (type: 'disconnect', fn: (e: { device: UsbDeviceLike }) => void) => void;
  removeEventListener?: (type: 'disconnect', fn: (e: { device: UsbDeviceLike }) => void) => void;
};

export type UsbApi = UsbLike & UsbEvents;

export interface ZebraPrinter {
  supported: boolean;
  connected: boolean;
  productName: string | null;
  notice: PrinterNotice | null;
  clearNotice(): void;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(zpl: string): Promise<void>;
  waitForIdle(labelsSent: number, onQueued?: (n: number) => void): Promise<void>;
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

  const drop = useCallback((next: PrinterNotice | null) => {
    deviceRef.current = null;
    setDevice(null);
    if (next) setNotice(next);
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
      deviceRef.current = next;
      setDevice(next);
      setNotice({ type: 'success', message: `Printer connected: ${next.productName || 'Zebra Printer'}` });
    } catch (err) {
      drop({ type: 'error', message: err instanceof Error && err.message ? err.message : 'Failed to connect to printer' });
    }
  }, [usb, drop]);

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
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Printer connection lost')) drop(null);
      throw err;
    }
  }, [drop]);

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
    connect, disconnect, send, waitForIdle,
  };
}
