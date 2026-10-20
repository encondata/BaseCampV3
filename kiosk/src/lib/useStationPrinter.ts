/**
 * The Label Station's saved printer, ready to print: reads the station's
 * settings from the edge (`GET /edge/label-station`) and turns them into a
 * `StationPrinter`.
 *
 * - Network: straight from the saved IP, through the edge.
 * - USB: connects to the printer this browser already allowed whose
 *   serial number is the saved one. The only allowed Zebra (the browser
 *   only allows Zebras here) stands in only when no serial was saved or
 *   that device reports none — a saved serial is never swapped for a
 *   different printer. Anything else needs the person to pick one
 *   (`connectUsb`, the browser's picker): `needs_usb`.
 * - No settings saved (or none readable): `no_settings`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getLabelStation, type LabelStationSettings } from './api';
import { useKioskSetup } from './kioskSetup';
import { networkStationPrinter, usbStationPrinter, type StationPrinter } from './stationPrinter';
import { useZebraPrinter, type ZebraPrinter } from './useZebraPrinter';

export type StationPrinterState = 'loading' | 'ready' | 'needs_usb' | 'no_settings';

export interface UseStationPrinter {
  settings: LabelStationSettings | null;
  printer: StationPrinter | null;
  zebra: ZebraPrinter;
  state: StationPrinterState;
  /** Opens the browser's USB picker. */
  connectUsb(): Promise<void>;
  /** Reads the settings again (and reconnects a USB printer). */
  reload(): Promise<void>;
}

export function useStationPrinter(): UseStationPrinter {
  const [setup] = useKioskSetup();
  const initiativeId = setup?.initiativeId ?? '';
  const zebra = useZebraPrinter();
  const [settings, setSettings] = useState<LabelStationSettings | null>(null);
  const [loaded, setLoaded] = useState(false);
  // The saved USB printer is being looked for among the allowed ones.
  const [findingUsb, setFindingUsb] = useState(false);
  const loadId = useRef(0);
  const mounted = useRef(true);
  const zebraRef = useRef(zebra);
  zebraRef.current = zebra;

  const load = useCallback(async () => {
    const id = ++loadId.current;
    const live = () => mounted.current && id === loadId.current;
    let next: LabelStationSettings | null = null;
    try {
      next = await getLabelStation();
    } catch {
      next = null;
    }
    if (!live()) return;
    const usb = next?.printer.type === 'usb' && !zebraRef.current.connected;
    setFindingUsb(usb);
    setSettings(next);
    setLoaded(true);
    if (!usb || !next) return;
    try {
      const known = await zebraRef.current.knownDevices();
      if (!live()) return;
      const saved = next.printer.serial;
      const only = known.length === 1 && (!saved || serialOf(known[0]) === null) ? known[0] : undefined;
      const match = (saved ? known.find((d) => serialOf(d) === saved) : undefined) ?? only;
      if (match) await zebraRef.current.connectTo(match);
    } catch {
      /* stays needs_usb */
    } finally {
      if (live()) setFindingUsb(false);
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
      loadId.current += 1;
    };
  }, [load]);

  const printer = useMemo<StationPrinter | null>(() => {
    if (!settings) return null;
    if (settings.printer.type === 'network') {
      return settings.printer.ip ? networkStationPrinter(settings.printer.ip, initiativeId) : null;
    }
    return zebra.connected ? usbStationPrinter(zebra, initiativeId) : null;
    // zebra's methods are stable; a different device is a different printer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, zebra.device, zebra.connected, initiativeId]);

  let state: StationPrinterState;
  if (!loaded) state = 'loading';
  else if (!settings || (settings.printer.type === 'network' && !settings.printer.ip)) state = 'no_settings';
  else if (printer) state = 'ready';
  else state = findingUsb ? 'loading' : 'needs_usb';

  const connectUsb = useCallback(() => zebraRef.current.connect(), []);

  return { settings, printer, zebra, state, connectUsb, reload: load };
}

function serialOf(device: unknown): string | null {
  const serial = (device as { serialNumber?: unknown } | null)?.serialNumber;
  return typeof serial === 'string' && serial ? serial : null;
}
