/**
 * The label builder's Printer dialog (spec §4.7): the USB Zebra the page
 * already holds (LabelBuilder's `useZebraPrinter`, passed in; never a
 * second one), checked for this template.
 *
 *  - Connection: Connect / Disconnect as on Labels › Printers, the identity
 *    and health chips (PrinterHealth), and a note when the printer's DPI
 *    isn't the one the canvas shows.
 *  - Alignment label: Labels › Printers' alignment boxes for the
 *    template's size at the printer's DPI, with the offsets saved for Print
 *    Labels (AlignmentTestModal's `alignmentLabelZpl`).
 *  - Fonts: each printer object the design's text prints with (zplPreview
 *    `designFonts`, the TS side of `design_fonts`), checked against the
 *    printer's E: and Z: TrueType listings (`fontStates`: a built-in font
 *    counts on either drive, a library font only on E:, where templates
 *    name it). A missing library font has Install (labels:add), the same
 *    push as Install Fonts (`installFont`), one at a time; a missing
 *    built-in font can't be installed and says so.
 *  - Send raw ZPL: the text as typed, straight to the printer.
 *
 * The printer is read in one sequence (identity, status, E:, Z:), and every
 * exchange with it waits for the one before (`serial`): a second read (a
 * StrictMode remount, a reconnect) never interleaves its queries with the
 * first, and the buttons stay off while a read, an install or a send runs.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { familyInfo } from '../../../labels/builder/fonts';
import type { DesignV2 } from '../../../labels/builder/model';
import { designFonts } from '../../../labels/builder/zplPreview';
import { directoryQuery } from '../../../labels/zebraCommands';
import {
  parseDirectory, type DirectoryListing, type HostIdentification, type HostStatus, type UsbDeviceLike,
} from '../../../labels/zebraUsb';
import type { LabelFont, LabelVocab } from '../../../lib/api';
import { readPrintSettings } from '../../../lib/printLabels';
import type { ZebraPrinter } from '../../../lib/useZebraPrinter';
import DataTable from '../../DataTable';
import { alignmentLabelZpl } from '../../printers/AlignmentTestModal';
import { fontStates, installFont } from '../../printers/InstallFontsModal';
import PrinterHealth from '../../printers/PrinterHealth';
import '../../../styles/directory.css';
import '../../../styles/profile.css';   /* .pf-form, .btn-solid, .pf-error */
import '../../../styles/reports.css';   /* rgm-* modal header */
import '../../../styles/printers.css';
import '../../../styles/labelBuilder.css';

export type BuilderPrinter = Pick<ZebraPrinter,
  'supported' | 'connected' | 'productName' | 'connect' | 'disconnect' | 'connectTo' | 'knownDevices'
  | 'identify' | 'status' | 'query' | 'send' | 'sendBytes'>;

export interface BuilderPrinterModalProps {
  templateName: string;
  /** The template's size: the alignment label's. */
  sizeKey: string;
  vocab: LabelVocab[];
  /** The design on the canvas: its fonts are checked. */
  design: DesignV2;
  library: LabelFont[];
  /** The DPI the canvas shows, in dots. */
  viewDpi: number;
  printer: BuilderPrinter;
  /** labels:add — Install shows. */
  canInstall: boolean;
  onFetchBytes: (id: string) => Promise<Uint8Array>;
  onClose: () => void;
}

type Note = { type: 'success' | 'error'; message: string };
type Progress = { sent: number; total: number } | { error: string };

interface Read {
  identity: HostIdentification | null;
  status: HostStatus | null;
  e: DirectoryListing | null;
  z: DirectoryListing | null;
  error: string | null;
}

const NOTHING_READ: Read = { identity: null, status: null, e: null, z: null, error: null };

const message = (err: unknown, fallback: string) => (err instanceof Error && err.message ? err.message : fallback);

/** Each font row's words: the family as the dropdown names it, and the weight. */
function fontLabel(family: string, weight: string): string {
  return `${familyInfo(family)?.label ?? family} · ${weight === 'bold' ? 'Bold' : 'Regular'}`;
}

export default function BuilderPrinterModal({
  templateName, sizeKey, vocab, design, library, viewDpi, printer, canInstall, onFetchBytes, onClose,
}: BuilderPrinterModalProps) {
  const [read, setRead] = useState<Read>(NOTHING_READ);
  const [reading, setReading] = useState(false);
  const [known, setKnown] = useState<UsbDeviceLike[]>([]);
  const [installing, setInstalling] = useState<string | null>(null);
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [aligning, setAligning] = useState(false);
  const [alignNote, setAlignNote] = useState<Note | null>(null);
  const [raw, setRaw] = useState('');
  const [sending, setSending] = useState(false);
  const [rawNote, setRawNote] = useState<Note | null>(null);

  const printerRef = useRef(printer);
  printerRef.current = printer;
  const busy = reading || installing !== null || aligning || sending;

  /** Runs `job` once every earlier one has finished. */
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const serial = useCallback(<T,>(job: () => Promise<T>): Promise<T> => {
    const run = queue.current.then(job, job);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && installing === null) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, installing]);

  useEffect(() => {
    if (!printer.connected) void printerRef.current.knownDevices().then(setKnown).catch(() => setKnown([]));
  }, [printer.connected]);

  const readE = async (): Promise<DirectoryListing | null> =>
    parseDirectory(await printerRef.current.query(directoryQuery('E', '*.TTF')));

  /** Identity, status, then the E: and Z: font listings, one after another.
   *  A newer read (a reconnect) makes an older one's answers moot. */
  const generation = useRef(0);
  const readPrinter = useCallback(async () => {
    const gen = ++generation.current;
    if (!printerRef.current.connected) {
      setRead(NOTHING_READ);
      return;
    }
    setReading(true);
    const next: Read = { ...NOTHING_READ };
    await serial(async () => {
      if (gen !== generation.current) return;   // a newer read is queued
      try {
        next.identity = await printerRef.current.identify();
        next.status = await printerRef.current.status();
        next.e = await readE();
        next.z = parseDirectory(await printerRef.current.query(directoryQuery('Z', '*.TTF')));
        if (!next.e || !next.z) next.error = "Couldn't read the printer's font drives.";
      } catch (err) {
        next.error = message(err, "Couldn't read the printer.");
      }
    });
    if (gen === generation.current) {
      setRead(next);
      setReading(false);
    }
  }, [serial]);

  useEffect(() => { void readPrinter(); }, [readPrinter, printer.connected]);

  // ── fonts ─────────────────────────────────────────────────────────

  const used = useMemo(() => designFonts(design).map((f) => ({
    ...f,
    resident: familyInfo(f.family)?.resident === true,
    row: library.find((r) => r.name.toUpperCase() === f.object) ?? null,
  })), [design, library]);

  const states = useMemo(() => fontStates(used.map((u) => ({ name: u.object, resident: u.resident })),
    read.e && read.z ? read.e : null, read.z), [used, read.e, read.z]);

  const install = async (font: LabelFont) => {
    if (busy) return;
    setInstalling(font.name);
    setProgress((p) => ({ ...p, [font.name]: { sent: 0, total: font.size_bytes } }));
    try {
      const e = await serial(async () => {
        await installFont(printerRef.current, font, onFetchBytes,
          (sent, total) => setProgress((p) => ({ ...p, [font.name]: { sent, total } })));
        return readE();
      });
      setRead((r) => ({ ...r, e: e ?? r.e }));
      setProgress((p) => {
        const rest = { ...p };
        delete rest[font.name];
        return rest;
      });
    } catch (err) {
      setProgress((p) => ({ ...p, [font.name]: { error: message(err, 'Install failed') } }));
    } finally {
      setInstalling(null);
    }
  };

  const stateCell = (u: (typeof used)[number]) => {
    if (!printer.connected) return <span className="cell-sub">Not checked</span>;
    const state = u.resident ? states.resident[u.object] : states.library[u.object];
    if (!state) return <span className="cell-sub">{reading ? 'Reading…' : '—'}</span>;
    return state === 'installed'
      ? <span className="chip c-green">Present</span>
      : <span className="chip c-amber">Missing</span>;
  };

  const actionCell = (u: (typeof used)[number]) => {
    const state = u.resident ? states.resident[u.object] : states.library[u.object];
    if (state !== 'missing') return null;
    if (u.resident) return <span className="cell-sub">Built into Zebra printers; this one doesn&apos;t have it</span>;
    if (!u.row) return <span className="cell-sub">Not in the font library</span>;
    const p = progress[u.object];
    if (p && 'error' in p) {
      return (
        <span className="zp-inline-actions">
          <span className="pf-error">{p.error}</span>
          {canInstall && (
            <button type="button" className="mini-btn" disabled={busy} onClick={() => void install(u.row as LabelFont)}>
              Install
            </button>
          )}
        </span>
      );
    }
    if (p) {
      const pct = p.total ? Math.round((p.sent / p.total) * 100) : 0;
      return (
        <div className="zp-font-progress" role="progressbar" aria-label={`Installing ${u.object}`}
          aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
          <div className="zp-font-progress-fill" style={{ width: `${pct}%` }} />
        </div>
      );
    }
    if (!canInstall) return <span className="cell-sub">Installing needs labels add access</span>;
    return (
      <button type="button" className="mini-btn" disabled={busy} onClick={() => void install(u.row as LabelFont)}>
        Install
      </button>
    );
  };

  // ── alignment label ───────────────────────────────────────────────

  const size = vocab.find((v) => v.kind === 'size' && v.key === sizeKey) ?? null;
  const printerDpi = read.identity?.dpi ?? null;

  const printAlignment = async () => {
    if (!size || !printerDpi || busy) return;
    setAligning(true);
    setAlignNote(null);
    try {
      await serial(() => printerRef.current.send(alignmentLabelZpl(size, printerDpi, readPrintSettings())));
      setAlignNote({ type: 'success', message: `Sent an alignment label (${size.label} at ${printerDpi} DPI).` });
    } catch (err) {
      setAlignNote({ type: 'error', message: `Couldn't print: ${message(err, 'the printer did not answer')}` });
    } finally {
      setAligning(false);
    }
  };

  // ── raw ZPL ───────────────────────────────────────────────────────

  const sendRaw = async () => {
    if (!raw.trim() || busy || !printer.connected) return;
    setSending(true);
    setRawNote(null);
    try {
      await serial(() => printerRef.current.send(raw));
      setRawNote({ type: 'success', message: 'Sent the ZPL to the printer.' });
    } catch (err) {
      setRawNote({ type: 'error', message: `Couldn't send: ${message(err, 'the printer did not answer')}` });
    } finally {
      setSending(false);
    }
  };

  const note = (n: Note | null) => n && (
    <div className={`zp-notice ${n.type}`} role={n.type === 'error' ? 'alert' : 'status'}>
      <p className="page-hint">{n.message}</p>
    </div>
  );

  const closeOff = installing !== null;

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !closeOff) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card lbb-printer-card" role="dialog" aria-modal="true"
        aria-label="Printer">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">{templateName} · Printer</div>
            <h3>Printer</h3>
            <p className="page-hint">
              Check the USB Zebra printer for this label: print an alignment label and make sure it has the
              fonts.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={closeOff}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="zp-stack">
            <section className="zp-col" aria-label="Connection">
              <div className="zp-card-head">
                <div className="modal-section">Connection</div>
                <div className="zp-printer-actions">
                  {printer.connected && (
                    <button type="button" className="mini-btn" disabled={busy} onClick={() => void readPrinter()}>
                      Refresh
                    </button>
                  )}
                  {!printer.supported ? null : printer.connected
                    ? <button type="button" className="btn-ghost" disabled={busy}
                        onClick={() => void printer.disconnect()}>Disconnect</button>
                    : <button type="button" className="btn-solid" onClick={() => void printer.connect()}>
                        Connect via USB
                      </button>}
                </div>
              </div>
              <div className="zp-printer-status">
                <span className={`dot ${printer.connected ? 'on' : 'off'}`} />
                <span className="cell-top">
                  {printer.connected
                    ? `Printer connected${printer.productName ? ` · ${printer.productName}` : ''}`
                    : 'No printer connected'}
                </span>
              </div>
              {!printer.supported && (
                <p className="page-hint">USB printing needs Chrome or Edge on a secure (https or localhost) address.</p>
              )}
              {printer.connected && (
                <PrinterHealth identity={read.identity} status={read.status} productName={printer.productName} />
              )}
              {!printer.connected && known.length > 0 && (
                <div className="zp-known">
                  <span className="cell-sub">Known printers:</span>
                  {known.map((d, i) => (
                    <button key={i} type="button" className="mini-btn" onClick={() => void printer.connectTo(d)}>
                      Connect {d.productName || 'Zebra printer'}
                    </button>
                  ))}
                </div>
              )}
              {printerDpi !== null && printerDpi !== viewDpi && (
                <div className="zp-notice warning" role="note">
                  <p className="page-hint">Prints at {printerDpi} DPI; the canvas is showing {viewDpi}.</p>
                </div>
              )}
              {read.error && <p className="pf-error" role="alert">{read.error}</p>}
            </section>

            <section className="zp-col" aria-label="Alignment label">
              <div className="modal-section">Alignment label</div>
              <p className="page-hint">
                Concentric boxes 25 dots apart on this template&apos;s {size?.label ?? sizeKey} label
                {printerDpi ? ` at the printer's ${printerDpi} DPI` : ''}, with the offsets saved for Print Labels
                (set them on Labels › Printers).
              </p>
              <div className="zp-actions">
                <button type="button" className="btn-solid" disabled={!printer.connected || !printerDpi || !size || busy}
                  onClick={() => void printAlignment()}>
                  {aligning ? 'Sending…' : 'Print alignment label'}
                </button>
                {printer.connected && !reading && !printerDpi && (
                  <span className="cell-sub">The printer didn&apos;t say its DPI.</span>
                )}
              </div>
              {note(alignNote)}
            </section>

            <section className="zp-col" aria-label="Fonts">
              <div className="modal-section">Fonts</div>
              <p className="page-hint">
                {printer.connected
                  ? "The fonts this label prints with, on the printer's E: drive (a built-in font may be on Z:)."
                  : 'Connect a printer to check its fonts.'}
              </p>
              <DataTable ariaLabel="Fonts on the printer" emptyText="This label prints no text."
                rows={used.map((u) => ({
                  key: u.object,
                  cells: [
                    <b className="cell-top" key="f">{fontLabel(u.family, u.weight)}</b>,
                    <span key="o">{u.object}</span>,
                    <span key="s">{stateCell(u)}</span>,
                    <span key="a">{actionCell(u)}</span>,
                  ],
                }))}
                columns={[
                  { key: 'font', label: 'Font', width: 'minmax(200px, 1.4fr)' },
                  { key: 'object', label: 'Printer object', width: '140px', mono: true },
                  { key: 'state', label: 'On the printer', width: '120px' },
                  { key: 'action', label: '', width: 'minmax(160px, 1fr)', align: 'right' },
                ]} />
            </section>

            <section className="zp-col" aria-label="Send raw ZPL">
              <div className="modal-section">Send raw ZPL</div>
              <div className="pf-form lbb-raw-form">
                <div className="full">
                  <label htmlFor="lbb-raw-zpl">Raw ZPL</label>
                  <textarea id="lbb-raw-zpl" className="lbb-raw-zpl mono" rows={6} value={raw} spellCheck={false}
                    placeholder={'^XA\n^FO50,50^A0N,40,40^FDHello^FS\n^XZ'} onChange={(e) => setRaw(e.target.value)} />
                  <p className="page-hint">Sent to the printer exactly as typed.</p>
                </div>
              </div>
              <div className="zp-actions">
                <button type="button" className="btn-solid" disabled={!printer.connected || !raw.trim() || busy}
                  onClick={() => void sendRaw()}>
                  {sending ? 'Sending…' : 'Send'}
                </button>
              </div>
              {note(rawNote)}
            </section>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" onClick={onClose} disabled={closeOff}>Done</button>
        </div>
      </div>
    </div>
  );
}
