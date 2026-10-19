/**
 * Label Station step 5: the printer. Pick a USB Zebra (WebUSB, printers
 * the browser already allowed listed first) or a network Zebra on the
 * laptop's LAN (a scan for port 9100, or a typed IP, sent through the
 * laptop edge). Either way the printer becomes one `StationPrinter`, and
 * the same checks run against it, each a row that turns green:
 * - Printer answers (`~HI`);
 * - DPI: at least one downloaded template of the station's kind is at the
 *   printer's DPI;
 * - Ready to print: `~HS` reports no paper out, head open or pause;
 * - Fonts: every E: font those templates use is on the printer. A missing
 *   font that's in the portal's library installs from here; one that isn't
 *   stays red with what to do.
 *
 * Problems say what to fix, with Recheck. Finish needs every row green;
 * "Finish anyway" is for a person signed in with a user account and never
 * shows to a move-password session. Either saves the station's settings
 * on the edge (`PUT /edge/label-station`), including the offsets set in
 * the test labels modal.
 */

import { useEffect, useMemo, useRef, useState } from 'react';

import type { HostIdentification, HostStatus, UsbDeviceLike } from '@portal/labels/zebraUsb';

import { useKioskAuth } from '../../auth/KioskAuthContext';
import {
  ApiError, fetchKioskLabelFonts, getPrinterScan, putLabelStation, startPrinterScan,
  type KioskLabelFont, type KioskLabelTemplate, type LabelKind, type LabelStationSettings,
  type PrinterScan,
} from '../../lib/api';
import { getLabelTemplates } from '../../lib/labelTemplates';
import {
  checkDpi, KIND_LABEL, neededFonts, networkStationPrinter, readFonts, statusProblems,
  templatesOfKind, usbStationPrinter, type StationPrinter,
} from '../../lib/stationPrinter';
import { useSyncStatus } from '../../lib/sync';
import { useZebraPrinter } from '../../lib/useZebraPrinter';
import PrinterHealth from '../printers/PrinterHealth';
import CheckList, { type CheckRowResult } from './CheckList';
import TestLabelModal, { type Offsets } from './TestLabelModal';

type CheckKey = 'answers' | 'dpi' | 'status' | 'fonts';
type PrinterType = 'usb' | 'network';

const ITEMS: { name: CheckKey; label: string }[] = [
  { name: 'answers', label: 'Printer answers' },
  { name: 'dpi', label: 'DPI matches the templates' },
  { name: 'status', label: 'Ready to print' },
  { name: 'fonts', label: 'Fonts installed' },
];

const TYPES: { type: PrinterType; title: string; meta: string }[] = [
  { type: 'usb', title: 'USB printer', meta: 'A Zebra plugged into this laptop. Printers this browser already allowed come first.' },
  { type: 'network', title: 'Network printer', meta: "A Zebra on this laptop's network, found by a scan for port 9100 or by its IP address." },
];

const UNSUPPORTED = "This browser can't talk to USB printers. Use Chrome or Edge over HTTPS or localhost.";

/** How long a printer gets to file a downloaded font before the re-check. */
const FONT_SETTLE_MS = 500;

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

function isIpv4(text: string): boolean {
  const m = IPV4_RE.exec(text);
  return m !== null && m.slice(1).every((p) => Number(p) <= 255);
}

function codeOf(err: unknown): string {
  return err instanceof ApiError ? err.code : 'unknown_error';
}

function noAnswer(err: unknown, printer: StationPrinter): string {
  const code = codeOf(err);
  if (code === 'bad_printer_ip') return "That address isn't a printer on this laptop's local network.";
  if (code === 'printer_unreachable') return `Nothing answered at ${printer.ip} on port 9100.`;
  return printer.kind === 'usb'
    ? "The printer didn't answer. Check that it's on and plugged in."
    : "The printer didn't answer. Check that it's on and connected to the network.";
}

interface Props {
  initiativeId: string;
  labelKind: LabelKind;
  /** The station's saved settings, when it has some: their offsets carry over. */
  initial: LabelStationSettings | null;
  onBack: () => void;
  onFinish: () => void;
}

export default function PrinterStep({ initiativeId, labelKind, initial, onBack, onFinish }: Props) {
  const { kioskMove } = useKioskAuth();
  const zebra = useZebraPrinter();
  const sync = useSyncStatus();
  const [type, setType] = useState<PrinterType>(initial?.printer.type ?? 'usb');
  const [known, setKnown] = useState<UsbDeviceLike[]>([]);
  const [scan, setScan] = useState<PrinterScan | null>(null);
  const [scanError, setScanError] = useState('');
  const [typedIp, setTypedIp] = useState(initial?.printer.type === 'network' ? initial.printer.ip ?? '' : '');
  const [ip, setIp] = useState<string | null>(null);
  const [templates, setTemplates] = useState<KioskLabelTemplate[] | null>(null);
  const [results, setResults] = useState<Partial<Record<CheckKey, CheckRowResult>>>({});
  const [running, setRunning] = useState<CheckKey | null>(null);
  const [identity, setIdentity] = useState<HostIdentification | null>(null);
  const [hostStatus, setHostStatus] = useState<HostStatus | null>(null);
  const [fontFix, setFontFix] = useState<{ installable: KioskLabelFont[]; notInLibrary: string[] } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState('');
  const [offsets, setOffsets] = useState<Offsets>({ x: initial?.offset_x ?? 0, y: initial?.offset_y ?? 0 });
  const [testOpen, setTestOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const runId = useRef(0);
  const scanTimer = useRef<number | undefined>(undefined);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    void zebra.knownDevices().then((d) => { if (mounted.current) setKnown(d); });
    return () => {
      mounted.current = false;
      runId.current += 1;
      window.clearTimeout(scanTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The move's templates land with the sync Kiosk Setup started after Site.
  useEffect(() => {
    if (sync.phase === 'running') return undefined;
    let alive = true;
    getLabelTemplates()
      .then((ts) => { if (alive) setTemplates(ts); })
      .catch(() => { if (alive) setTemplates([]); });
    return () => { alive = false; };
  }, [sync.phase]);

  const printer = useMemo<StationPrinter | null>(() => {
    if (type === 'usb') return zebra.connected ? usbStationPrinter(zebra, initiativeId) : null;
    return ip ? networkStationPrinter(ip, initiativeId) : null;
    // zebra's methods are stable; a different device is a different printer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, zebra.device, zebra.connected, ip, initiativeId]);

  const runChecks = async (p: StationPrinter, ts: KioskLabelTemplate[]) => {
    const id = ++runId.current;
    const live = () => id === runId.current && mounted.current;
    const put = (key: CheckKey, result: CheckRowResult) => {
      if (live()) setResults((prev) => ({ ...prev, [key]: result }));
    };
    setResults({});
    setIdentity(null);
    setHostStatus(null);
    setFontFix(null);
    setInstallError('');

    setRunning('answers');
    let ident: HostIdentification | null = null;
    let failure: unknown = null;
    try {
      ident = await p.identify();
    } catch (err) {
      failure = err;
    }
    if (!live()) return;
    if (!ident) {
      put('answers', { state: 'fail', detail: noAnswer(failure, p) });
      setRunning(null);
      return;
    }
    setIdentity(ident);
    put('answers', { state: 'ok', detail: `${ident.model} · ${ident.dpi} DPI` });

    put('dpi', checkDpi(ts, labelKind, ident.dpi));

    setRunning('status');
    let st: HostStatus | null = null;
    try {
      st = await p.status();
    } catch {
      st = null;
    }
    if (!live()) return;
    setHostStatus(st);
    if (!st) {
      put('status', { state: 'fail', detail: "Couldn't read the printer's status." });
    } else {
      const problems = statusProblems(st);
      put('status', problems.length ? { state: 'fail', detail: problems.join(' ') } : { state: 'ok' });
    }

    setRunning('fonts');
    const needed = neededFonts(templatesOfKind(ts, labelKind));
    if (needed.length === 0) {
      put('fonts', { state: 'ok', detail: 'No printer fonts needed.' });
    } else {
      let present: Set<string> | null = null;
      try {
        const listing = await readFonts(p);
        if (listing) present = new Set(listing.objects.map((o) => o.name.toUpperCase()));
      } catch {
        present = null;
      }
      if (!live()) return;
      if (!present) {
        put('fonts', { state: 'fail', detail: "Couldn't read the fonts on the printer." });
      } else {
        const missing = needed.filter((n) => !present.has(n));
        if (missing.length === 0) {
          put('fonts', { state: 'ok' });
        } else {
          try {
            const library = await fetchKioskLabelFonts(initiativeId);
            if (!live()) return;
            const installable = library.fonts.filter((f) => missing.includes(f.name.toUpperCase()));
            const inLibrary = new Set(installable.map((f) => f.name.toUpperCase()));
            setFontFix({ installable, notInLibrary: missing.filter((n) => !inLibrary.has(n)) });
            put('fonts', { state: 'fail', detail: `Missing: ${missing.join(', ')}.` });
          } catch (err) {
            put('fonts', {
              state: 'fail',
              detail: `Missing: ${missing.join(', ')}. Couldn't load the font library (${codeOf(err)}).`,
            });
          }
        }
      }
    }
    if (live()) setRunning(null);
  };

  useEffect(() => {
    runId.current += 1;
    setResults({});
    setRunning(null);
    setIdentity(null);
    setHostStatus(null);
    setFontFix(null);
    if (printer && templates) void runChecks(printer, templates);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printer, templates]);

  const recheck = () => { if (printer && templates) void runChecks(printer, templates); };

  const installFonts = async () => {
    if (!printer || !fontFix) return;
    setInstalling(true);
    setInstallError('');
    try {
      for (const font of fontFix.installable) {
        try {
          await printer.sendFont(font);
        } catch (err) {
          setInstallError(`Couldn't install ${font.name} (${codeOf(err)}).`);
          break;
        }
      }
      await new Promise((r) => { window.setTimeout(r, FONT_SETTLE_MS); });
    } finally {
      if (mounted.current) setInstalling(false);
    }
    if (mounted.current) recheck();
  };

  const pollScan = async () => {
    try {
      const next = await getPrinterScan();
      if (!mounted.current) return;
      setScan(next);
      if (next.state === 'running') scanTimer.current = window.setTimeout(() => { void pollScan(); }, 1000);
    } catch (err) {
      if (mounted.current) setScanError(codeOf(err));
    }
  };

  const startScan = async () => {
    window.clearTimeout(scanTimer.current);
    setScanError('');
    setScan({ scan_id: null, state: 'running', probed: 0, total: 0, printers: [] });
    try {
      await startPrinterScan();
      await pollScan();
    } catch (err) {
      if (mounted.current) { setScan(null); setScanError(codeOf(err)); }
    }
  };

  const chooseType = (next: PrinterType) => {
    if (next === type) return;
    setType(next);
    setSaveError('');
  };

  const allOk = ITEMS.every((i) => results[i.name]?.state === 'ok') && running === null;
  const anyFailed = ITEMS.some((i) => results[i.name]?.state === 'fail') && running === null;
  const busy = saving || installing || running !== null;

  const save = async () => {
    if (!printer || !identity) return;
    setSaving(true);
    setSaveError('');
    try {
      await putLabelStation({
        label_kind: labelKind,
        printer: {
          type: printer.kind, ip: printer.kind === 'network' ? printer.ip : null,
          model: identity.model, serial: printer.serial,
        },
        dpi: identity.dpi,
        offset_x: offsets.x,
        offset_y: offsets.y,
      });
      onFinish();
    } catch (err) {
      const code = codeOf(err);
      setSaveError(code === 'not_label_station'
        ? "This laptop isn't set up as a Label Station yet. Go back and pick the site again."
        : `Couldn't save the printer settings (${code}). Try again.`);
    } finally {
      if (mounted.current) setSaving(false);
    }
  };

  const syncing = sync.phase === 'running' && templates === null;
  const usbNoticeError = zebra.notice?.type === 'error' ? zebra.notice.message : '';

  return (
    <>
      <h2>Which printer?</h2>
      <p className="page-hint">
        This station prints {KIND_LABEL[labelKind]} labels. Pick its printer, then check it&apos;s ready.
      </p>
      <div className="setup-cards" role="listbox" aria-label="Printer types">
        {TYPES.map((t) => (
          <button key={t.type} type="button" role="option" aria-selected={type === t.type}
                  className="setup-card" onClick={() => chooseType(t.type)}>
            <div className="setup-card-title">{t.title}</div>
            <div className="setup-card-meta">{t.meta}</div>
          </button>
        ))}
      </div>

      {type === 'usb' && (
        !zebra.supported ? (
          <p className="form-error" role="alert">{UNSUPPORTED}</p>
        ) : (
          <div className="pf-form-actions">
            {known.map((d, i) => (
              <button key={`${d.productName ?? 'zebra'}-${i}`} type="button" className="mini-btn"
                      aria-pressed={zebra.device === d} disabled={busy}
                      onClick={() => void zebra.connectTo(d)}>
                Use {d.productName || 'Zebra printer'}
              </button>
            ))}
            <button type="button" className="mini-btn" disabled={busy} onClick={() => void zebra.connect()}>
              Connect a USB printer
            </button>
          </div>
        )
      )}
      {type === 'usb' && usbNoticeError && <p className="form-error" role="alert">{usbNoticeError}</p>}

      {type === 'network' && (
        <>
          <div className="pf-form-actions">
            <button type="button" className="mini-btn" disabled={scan?.state === 'running'}
                    onClick={() => void startScan()}>
              {scan?.state === 'running' ? 'Scanning…' : 'Scan the network'}
            </button>
          </div>
          {scan?.state === 'running' && scan.total > 0 && (
            <p className="page-hint" role="status">Scanning… {scan.probed} of {scan.total} addresses</p>
          )}
          {scan?.state === 'failed' && (
            <p className="form-error" role="alert">
              The scan couldn&apos;t run: this laptop&apos;s network address isn&apos;t known yet. Type the
              printer&apos;s IP address instead.
            </p>
          )}
          {scanError && <p className="form-error" role="alert">Couldn&apos;t scan the network ({scanError}).</p>}
          {scan?.state === 'done' && scan.printers.length === 0 && (
            <p className="page-hint">No printers answered on port 9100. Type the printer&apos;s IP address instead.</p>
          )}
          {scan && scan.printers.length > 0 && (
            <div className="setup-cards" role="group" aria-label="Printers found">
              {scan.printers.map((p) => (
                <button key={p.ip} type="button" className="setup-card" aria-pressed={ip === p.ip}
                        disabled={busy} onClick={() => setIp(p.ip)}>
                  <span className="setup-card-title">{p.ip}</span>
                </button>
              ))}
            </div>
          )}
          <form className="pf-form" onSubmit={(e) => {
            e.preventDefault();
            const value = typedIp.trim();
            if (isIpv4(value)) setIp(value);
          }}>
            <div>
              <label htmlFor="ls-printer-ip">Printer IP</label>
              <input id="ls-printer-ip" inputMode="decimal" autoComplete="off" placeholder="192.168.1.50"
                     value={typedIp} onChange={(e) => setTypedIp(e.target.value)} />
            </div>
            <div className="pf-form-actions">
              <button type="submit" className="mini-btn" disabled={busy || !isIpv4(typedIp.trim())}>
                Use this address
              </button>
            </div>
          </form>
        </>
      )}

      {syncing && <p className="page-hint" role="status">Downloading the move&apos;s label templates…</p>}

      {printer && (
        <div className="check-info">
          <PrinterHealth identity={identity} status={hostStatus}
                         productName={printer.kind === 'usb' ? zebra.productName : printer.ip} />
          <CheckList items={ITEMS} results={results} running={running} />
          {fontFix && fontFix.installable.length > 0 && results.fonts?.state === 'fail' && (
            <div className="pf-form-actions">
              <button type="button" className="mini-btn" disabled={busy} onClick={() => void installFonts()}>
                {installing
                  ? 'Installing fonts…'
                  : `Install ${fontFix.installable.length} missing font${fontFix.installable.length === 1 ? '' : 's'}`}
              </button>
            </div>
          )}
          {fontFix?.notInLibrary.map((name) => (
            <p key={name} className="form-error">
              {name} isn&apos;t in the font library. Upload it in the portal&apos;s font library.
            </p>
          ))}
          {installError && <p className="form-error" role="alert">{installError}</p>}
          {anyFailed && (
            <div className="pf-form-actions">
              <button type="button" className="mini-btn" disabled={busy} onClick={recheck}>Recheck</button>
            </div>
          )}
        </div>
      )}

      {saveError && <p className="form-error" role="alert">{saveError}</p>}

      <div className="pf-form-actions">
        <button type="button" className="mini-btn" disabled={saving} onClick={onBack}>Back</button>
        <button type="button" className="mini-btn" disabled={!printer || !identity || busy}
                onClick={() => setTestOpen(true)}>
          Print test labels
        </button>
        {/* A move-password session must resolve every check: never offered. */}
        {!kioskMove && !allOk && (
          <button type="button" className="mini-btn" disabled={!printer || !identity || busy}
                  onClick={() => void save()}>
            Finish anyway
          </button>
        )}
        <button type="button" className="btn-solid" disabled={!allOk || !printer || !identity || busy}
                onClick={() => void save()}>
          {saving ? 'Saving…' : 'Finish'}
        </button>
      </div>

      {testOpen && printer && identity && (
        <TestLabelModal printer={printer} dpi={identity.dpi} labelKind={labelKind}
                        templates={templates ?? []} initiativeId={initiativeId}
                        offsets={offsets} onOffsets={setOffsets} onClose={() => setTestOpen(false)} />
      )}
    </>
  );
}
