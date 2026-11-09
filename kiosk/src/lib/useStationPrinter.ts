/**
 * The Label Station's saved printer, ready to print: reads the station's
 * settings (`labelBackend().getSettings()`: the edge's `GET
 * /edge/label-station` on a laptop, this kiosk's own saved settings on the
 * web) and turns them into a `StationPrinter`.
 *
 * - Network: straight from the saved IP, through the edge.
 * - USB: connects to the printer this browser already allowed whose
 *   serial number is the saved one. The only allowed Zebra (the browser
 *   only allows Zebras here) stands in only when no serial was saved or
 *   that device reports none — a saved serial is never swapped for a
 *   different printer. Anything else needs the person to pick one
 *   (`connectUsb`, the browser's picker): `needs_usb`.
 * - A connected USB printer is checked ONCE against the saved one before
 *   it is ready (the picker, or the only allowed Zebra standing in, can
 *   connect any Zebra): serials on both sides decide it outright;
 *   otherwise one `~HI` does (same model and DPI). A different printer is
 *   read (`~HI` plus the peeler) and saved as this station's printer with
 *   its own DPI, offsets reset, and only then is ready (`switched` says
 *   so). Until the check ends the state is `loading` with no printer, so
 *   nothing prints at the old DPI or offsets. A printer that won't
 *   identify itself is taken as the saved one (as before); a save that
 *   fails is `needs_usb` with `switchError`. Network printers are never
 *   checked. Nothing here runs per label.
 *   `holdUsbCheck` puts the check off (still not ready) while another
 *   screen owns the choice of printer: Printer Setup's Change printer
 *   modal, whose Save printer saves the printer it checked (with its
 *   offsets and peel) and whose Close lets go of an unsaved pick. The
 *   check runs once the hold is lifted, against the settings then saved.
 * - No settings saved (or none readable): `no_settings`.
 *
 * On the web the settings live in this page's own store, so a save from
 * anywhere (the printer step, the offsets) reloads them here at once; the
 * laptop's are re-read on `reload()`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { HostIdentification } from '@portal/labels/zebraUsb';

import { ApiError, type LabelStationSettings } from './api';
import { useKioskSetup } from './kioskSetup';
import { labelBackend } from './labelBackend';
import { networkStationPrinter, usbStationPrinter, type StationPrinter } from './stationPrinter';
import { useZebraPrinter, type ZebraPrinter } from './useZebraPrinter';
import { subscribeWebLabelSettings } from './webLabelSettings';

export type StationPrinterState = 'loading' | 'ready' | 'needs_usb' | 'no_settings';

export interface UseStationPrinter {
  settings: LabelStationSettings | null;
  printer: StationPrinter | null;
  zebra: ZebraPrinter;
  state: StationPrinterState;
  /** Set when a connected USB printer that wasn't the saved one was read
   *  and saved as this station's printer: `${model} · ${dpi} DPI` labels. */
  switched: { from: string; to: string } | null;
  /** Why saving a different connected printer failed (state `needs_usb`). */
  switchError: string | null;
  /** Opens the browser's USB picker. */
  connectUsb(): Promise<void>;
  /** Reads the settings again (and reconnects a USB printer). */
  reload(): Promise<void>;
}

export interface UseStationPrinterOptions {
  /** Don't check (or switch to) a newly connected USB printer yet. */
  holdUsbCheck?: boolean;
}

export function useStationPrinter({ holdUsbCheck = false }: UseStationPrinterOptions = {}): UseStationPrinter {
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
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  // The connected USB device checked against the saved printer (it
  // matched, was switched to, or couldn't say), and the one whose switch
  // couldn't be saved. A device is checked once.
  const [verified, setVerified] = useState<unknown>(null);
  const [failed, setFailed] = useState<unknown>(null);
  // The check in flight: which device, and which `connectUsb` round (a
  // pick, the same printer included, checks it again).
  const checking = useRef<{ device: unknown; round: number } | null>(null);
  const [round, setRound] = useState(0);
  const [switched, setSwitched] = useState<{ from: string; to: string } | null>(null);
  const [switchError, setSwitchError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const id = ++loadId.current;
    const live = () => mounted.current && id === loadId.current;
    let next: LabelStationSettings | null = null;
    try {
      next = await labelBackend().getSettings();
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

  useEffect(() => {
    if (labelBackend().kind !== 'web') return undefined;
    return subscribeWebLabelSettings(() => { void load(); });
  }, [load]);

  const usbSaved = settings?.printer.type === 'usb';
  const device = zebra.connected ? zebra.device ?? null : null;
  // A connected USB printer not yet checked against the saved one.
  const unchecked = usbSaved && device !== null && verified !== device;

  useEffect(() => {
    if (holdUsbCheck) {
      // A check under way is dropped before it saves; it runs again after.
      checking.current = null;
      return;
    }
    if (!unchecked || (checking.current?.device === device && checking.current.round === round)) return;
    const saved = settingsRef.current;
    if (!saved || saved.printer.type !== 'usb') return;
    const token = { device, round };
    checking.current = token;
    const live = () => mounted.current && checking.current === token;
    void (async () => {
      const outcome = await checkUsbPrinter(saved, device, usbStationPrinter(zebraRef.current, initiativeId), live);
      if (!live()) return;
      if (outcome.kind === 'same') {
        setVerified(device);
        return;
      }
      if (outcome.kind === 'error') {
        setSwitchError(outcome.error);
        setSwitched(null);
        setFailed(device);
        return;
      }
      setSettings(outcome.settings);
      setSwitched({ from: printerLabel(saved), to: printerLabel(outcome.settings) });
      setSwitchError(null);
      setVerified(device);
    })();
  }, [holdUsbCheck, unchecked, device, round, initiativeId]);

  const printer = useMemo<StationPrinter | null>(() => {
    if (!settings) return null;
    if (settings.printer.type === 'network') {
      return settings.printer.ip ? networkStationPrinter(settings.printer.ip, initiativeId) : null;
    }
    return zebra.connected && !unchecked ? usbStationPrinter(zebra, initiativeId) : null;
    // zebra's methods are stable; a different device is a different printer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings, zebra.device, zebra.connected, unchecked, initiativeId]);

  let state: StationPrinterState;
  if (!loaded) state = 'loading';
  else if (!settings || (settings.printer.type === 'network' && !settings.printer.ip)) state = 'no_settings';
  else if (printer) state = 'ready';
  else if (unchecked) state = failed === device ? 'needs_usb' : 'loading';
  else state = findingUsb ? 'loading' : 'needs_usb';

  const connectUsb = useCallback(async () => {
    // Picking again (the same printer included) checks it again.
    setFailed(null);
    setVerified(null);
    setRound((n) => n + 1);
    await zebraRef.current.connect();
  }, []);

  return {
    settings, printer, zebra, state, switched, switchError: unchecked && failed === device ? switchError : null,
    connectUsb, reload: load,
  };
}

type CheckOutcome =
  | { kind: 'same' }
  | { kind: 'switched'; settings: LabelStationSettings }
  | { kind: 'error'; error: string };

/** Is the connected USB `device` the saved printer? When it isn't, reads
 *  it and saves it as the station's printer. At most one `~HI` and one
 *  peeler read; never throws. */
async function checkUsbPrinter(
  saved: LabelStationSettings, device: unknown, printer: StationPrinter, live: () => boolean,
): Promise<CheckOutcome> {
  const savedSerial = saved.printer.serial || null;
  const serial = serialOf(device);
  let ident: HostIdentification | null = null;
  if (savedSerial && serial) {
    if (savedSerial === serial) return { kind: 'same' };
  } else {
    ident = await identifyOrNull(printer);
    if (!ident || (ident.model === saved.printer.model && ident.dpi === saved.dpi)) return { kind: 'same' };
  }
  ident ??= await identifyOrNull(printer);
  // A printer that won't say what it is can't be saved: as before, it
  // stands for the saved one.
  if (!ident) return { kind: 'same' };
  const peeler = await printer.peeler();
  // Dropped (held, unmounted, another pick): nothing is saved.
  if (!live()) return { kind: 'same' };
  try {
    const next = await labelBackend().saveSettings({
      ...saved,
      printer: { type: 'usb', ip: null, model: ident.model, serial },
      dpi: ident.dpi,
      offset_x: 0,
      offset_y: 0,
      peel: peeler.present === true,
    });
    return { kind: 'switched', settings: next };
  } catch (err) {
    return { kind: 'error', error: saveErrorText(err) };
  }
}

async function identifyOrNull(printer: StationPrinter): Promise<HostIdentification | null> {
  try {
    return await printer.identify();
  } catch {
    return null;
  }
}

/** `${model} · ${dpi} DPI`, for the switched notice. */
function printerLabel(s: LabelStationSettings): string {
  return `${s.printer.model || 'USB printer'} · ${s.dpi} DPI`;
}

/** Why the switch's save failed, as a clause the pages finish. */
function saveErrorText(err: unknown): string {
  const word = labelBackend().deviceWord;
  if (err instanceof ApiError) {
    if (err.code === 'not_label_station') return `this ${word} isn't set up as a Label Station`;
    if (err.code === 'storage') return "this browser's storage is full or turned off for this site";
    if (err.code === 'bad_dpi') return "the printer didn't report its DPI";
    return `the settings weren't saved (${err.code})`;
  }
  const message = err instanceof Error ? err.message.replace(/[.\s]+$/, '') : '';
  return message || "the settings weren't saved";
}

function serialOf(device: unknown): string | null {
  const serial = (device as { serialNumber?: unknown } | null)?.serialNumber;
  return typeof serial === 'string' && serial ? serial : null;
}
