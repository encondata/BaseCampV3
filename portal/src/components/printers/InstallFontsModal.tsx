/**
 * Printers › Install fonts — the V3 font library (TrueType files admins
 * upload once) on the left, the connected printer's E: drive on the
 * right. Install streams a `~DY` header + the TTF bytes over WebUSB and
 * re-reads the directory to confirm. Presentational for the API side
 * (callbacks); talks to the printer through the hook's query/send.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { LabelFont } from '../../lib/api';
import { relativeTime } from '../../lib/format';
import type { ZebraPrinter } from '../../lib/useZebraPrinter';
import { deleteObject, directoryQuery, downloadFontHeader, fontObjectName, isTrueType } from '../../labels/zebraCommands';
import { parseDirectory, type DirectoryListing } from '../../labels/zebraUsb';
import DataTable from '../DataTable';

export type FontState = 'installed' | 'missing' | 'printer-only';

export function fontStates(library: LabelFont[], listing: DirectoryListing | null) {
  const onPrinter = new Map((listing?.objects ?? []).map((o) => [o.name.toUpperCase(), o]));
  const lib: Record<string, FontState> = {};
  if (listing) for (const f of library) lib[f.name.toUpperCase()] = onPrinter.has(f.name.toUpperCase()) ? 'installed' : 'missing';
  const libNames = new Set(library.map((f) => f.name.toUpperCase()));
  const printerOnly = (listing?.objects ?? []).filter((o) => !libNames.has(o.name.toUpperCase())).map((o) => ({ name: o.name, bytes: o.bytes }));
  return { library: lib, printerOnly };
}

const kb = (bytes: number) => `${Math.round(bytes / 1024).toLocaleString()} KB`;
const NAME_HINT = 'Use up to 8 letters, digits, or underscores plus .TTF';

interface Props {
  printer: Pick<ZebraPrinter, 'connected' | 'query' | 'send' | 'sendBytes'>;
  fonts: LabelFont[] | null;
  canAdd: boolean; canDelete: boolean;
  onUpload: (file: File, name: string) => Promise<void>;
  onDeleteFont: (id: string) => Promise<void>;
  onFetchBytes: (id: string) => Promise<Uint8Array>;
  onClose: () => void;
}

type Progress = { sent: number; total: number } | 'done' | { error: string };

export default function InstallFontsModal({ printer, fonts, canAdd, canDelete, onUpload, onDeleteFont, onFetchBytes, onClose }: Props) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [listError, setListError] = useState('');
  const [progress, setProgress] = useState<Record<string, Progress>>({});
  const [busy, setBusy] = useState(false);
  const [batching, setBatching] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [uploadError, setUploadError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<LabelFont | null>(null);

  const printerRef = useRef(printer);
  printerRef.current = printer;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !busy && !uploading && !batching) onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose, busy, uploading, batching]);

  const readDirectory = useCallback(async () => {
    if (!printerRef.current.connected) { setListing(null); return; }
    try {
      const parsed = parseDirectory(await printerRef.current.query(directoryQuery()));
      setListing(parsed);
      setListError(parsed ? '' : "Couldn't read the printer's E: drive.");
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Couldn't read the printer's E: drive.");
    }
  }, [printer.connected]);

  useEffect(() => { void readDirectory(); }, [readDirectory]);

  const states = useMemo(() => fontStates(fonts ?? [], listing), [fonts, listing]);

  const install = async (f: LabelFont) => {
    setBusy(true);
    setProgress((p) => ({ ...p, [f.id]: { sent: 0, total: f.size_bytes } }));
    try {
      const bytes = await onFetchBytes(f.id);
      await printerRef.current.send(downloadFontHeader('E', f.name, bytes.length));
      await printerRef.current.sendBytes(bytes, (sent, total) => setProgress((p) => ({ ...p, [f.id]: { sent, total } })));
      await new Promise((r) => setTimeout(r, 500));
      await readDirectory();
      setProgress((p) => ({ ...p, [f.id]: 'done' }));
    } catch (err) {
      setProgress((p) => ({ ...p, [f.id]: { error: err instanceof Error ? err.message : 'Install failed' } }));
    } finally {
      setBusy(false);
    }
  };

  const installAllMissing = async () => {
    setBatching(true);
    try {
      for (const f of fonts ?? []) if (states.library[f.name.toUpperCase()] === 'missing') await install(f);
    } finally {
      setBatching(false);
    }
  };

  const removeFromPrinter = async (objectName: string) => {
    setBusy(true);
    try {
      await printerRef.current.send(deleteObject('E', objectName));
      await new Promise((r) => setTimeout(r, 300));
      await readDirectory();
    } catch (err) {
      setListError(err instanceof Error ? err.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  };

  const pickFile = (f: File | null) => {
    setFile(f);
    setUploadError('');
    setName(f ? (fontObjectName(f.name) ?? f.name.toUpperCase()) : '');
  };
  const nameValid = fontObjectName(name) !== null;

  const upload = async () => {
    if (!file || !nameValid) return;
    setUploading(true);
    setUploadError('');
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      if (!isTrueType(bytes)) throw new Error('That file is not a TrueType font.');
      await onUpload(file, fontObjectName(name) as string);
      pickFile(null);
    } catch (err) {
      setUploadError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const progressCell = (f: LabelFont) => {
    const p = progress[f.id];
    if (!p) return null;
    if (p === 'done') return <span className="chip c-green">Installed ✓</span>;
    if ('error' in p) return <span className="pf-error">{p.error}</span>;
    const pct = p.total ? Math.round((p.sent / p.total) * 100) : 0;
    return <div className="zp-font-progress" role="progressbar" aria-label={`Installing ${f.name}`} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><div className="zp-font-progress-fill" style={{ width: `${pct}%` }} /></div>;
  };

  const libraryRows = (fonts ?? []).map((f) => {
    const state = states.library[f.name.toUpperCase()];
    return {
      key: f.id,
      cells: [
        <span className="mono" key="n">{f.name}</span>,
        <span className="cell-sub" key="d">{f.display_name}</span>,
        <span className="mono" key="s">{kb(f.size_bytes)}</span>,
        <span className="zp-chips" key="u">{f.used_by.length === 0 ? <span className="cell-sub">—</span> : f.used_by.map((u) => <span key={u.template_id} className="chip tag">{u.template_name}</span>)}</span>,
        <span className="mono" key="t">{relativeTime(f.created_at)}</span>,
        <span className="zp-inline-actions" key="a">
          {printer.connected && state && (
            <button type="button" className="mini-btn" disabled={busy || batching} onClick={() => void install(f)}>{state === 'installed' ? 'Reinstall' : 'Install'}</button>
          )}
          {canDelete && <button type="button" className="mini-btn danger" disabled={busy || batching} onClick={() => setConfirmDelete(f)}>Remove</button>}
        </span>,
        <span key="p">{state && !progress[f.id] ? <span className={`chip ${state === 'installed' ? 'c-green' : 'c-amber'}`}>{state === 'installed' ? 'Installed' : 'Missing'}</span> : progressCell(f)}</span>,
      ],
    };
  });

  const printerRows = states.printerOnly.map((o) => ({
    key: o.name,
    cells: [
      <span className="mono" key="n">{o.name}</span>,
      <span className="mono" key="s">{kb(o.bytes)}</span>,
      <span className="chip c-slate" key="c">Printer only</span>,
      <button type="button" className="mini-btn danger" key="r" disabled={busy || batching} onClick={() => void removeFromPrinter(o.name)}>Remove from printer</button>,
    ],
  }));

  const missingCount = Object.values(states.library).filter((s) => s === 'missing').length;

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy && !uploading && !batching) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card zp-fonts-card" role="dialog" aria-label="Install fonts">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Printers</div>
            <h3>Install fonts</h3>
            <p className="page-hint">Fonts referenced by label templates must live on the printer's E: drive. Upload TrueType fonts here once, then install them on each printer.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy || uploading || batching}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          <div className="zp-two-col">
            <section className="zp-col" aria-label="Font library">
              <div className="modal-section">Font library</div>
              {canAdd && (
                <div className="zp-upload">
                  <div className="pf-form zp-upload-row">
                    <div>
                      <label htmlFor="zp-font-file">TrueType font file</label>
                      <input id="zp-font-file" type="file" accept=".ttf" aria-label="TrueType font file" disabled={uploading}
                             onChange={(e) => pickFile(e.target.files?.[0] ?? null)} />
                    </div>
                    <div>
                      <label htmlFor="zp-font-name">Printer name</label>
                      <input id="zp-font-name" aria-label="Printer name" value={name} disabled={!file || uploading}
                             onChange={(e) => setName(e.target.value.toUpperCase())} />
                    </div>
                    <button type="button" className="btn-solid" disabled={!file || !nameValid || uploading} onClick={() => void upload()}>{uploading ? 'Uploading…' : 'Upload'}</button>
                  </div>
                  {file && !nameValid && <p className="pf-error">{NAME_HINT}</p>}
                  {uploadError && <p className="pf-error">{uploadError}</p>}
                </div>
              )}
              {fonts === null ? <p className="page-hint">Loading fonts…</p> : fonts.length === 0 ? <div className="dir-empty">No fonts uploaded yet.</div> : (
                <DataTable ariaLabel="Font library" rows={libraryRows} columns={[
                  { key: 'name', label: 'Name', width: '1.2fr', mono: true }, { key: 'display', label: 'File', width: '1fr' },
                  { key: 'size', label: 'Size', width: '0.6fr', mono: true, align: 'right' }, { key: 'used', label: 'Used by', width: '1.2fr' },
                  { key: 'when', label: 'Uploaded', width: '0.7fr', mono: true }, { key: 'actions', label: '', width: '1fr', align: 'right' },
                  { key: 'state', label: 'On printer', width: '0.9fr' },
                ]} />
              )}
              {confirmDelete && (
                <div className="zp-guard">
                  <span className="cell-sub">Remove {confirmDelete.name} from the library? Printers keep their copy.</span>
                  <button type="button" className="mini-btn danger" onClick={() => { const f = confirmDelete; setConfirmDelete(null); void onDeleteFont(f.id); }}>Yes, remove</button>
                  <button type="button" className="mini-btn" onClick={() => setConfirmDelete(null)}>Keep</button>
                </div>
              )}
            </section>
            <section className="zp-col" aria-label="On the printer">
              <div className="zp-card-head">
                <div className="modal-section">On the printer</div>
                {printer.connected && listing && (
                  <div className="zp-actions">
                    <span className="cell-sub">{listing.bytesFree !== null ? `${kb(listing.bytesFree)} free` : ''}</span>
                    <button type="button" className="mini-btn" disabled={busy || batching} onClick={() => void readDirectory()}>Refresh</button>
                    <button type="button" className="mini-btn" disabled={busy || batching || missingCount === 0} onClick={() => void installAllMissing()}>Install all missing</button>
                  </div>
                )}
              </div>
              {!printer.connected ? <p className="page-hint">Connect a printer to install fonts.</p>
                : listError ? <p className="pf-error">{listError}</p>
                : !listing ? <p className="page-hint">Reading the printer's E: drive…</p>
                : (
                  <>
                    <p className="page-hint">Library fonts show their state in the table on the left. Objects only on the printer:</p>
                    {printerRows.length === 0 ? <div className="dir-empty">No other objects on E:.</div> : (
                      <DataTable ariaLabel="Printer objects" rows={printerRows} columns={[
                        { key: 'name', label: 'Name', width: '1.4fr', mono: true }, { key: 'size', label: 'Size', width: '0.6fr', mono: true, align: 'right' },
                        { key: 'state', label: 'State', width: '0.8fr' }, { key: 'remove', label: '', width: '1fr', align: 'right' },
                      ]} />
                    )}
                  </>
                )}
            </section>
          </div>
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-solid" onClick={onClose} disabled={busy || uploading || batching}>Done</button>
        </div>
      </div>
    </div>
  );
}
