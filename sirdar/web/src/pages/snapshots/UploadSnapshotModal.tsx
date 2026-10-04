/** Upload a snapshot bundle made by scripts/make-seed-snapshot.sh. The file
 *  goes up as the request body; Sirdar checks every checksum, encrypts the
 *  keys and keeps it. */
import { useEffect, useRef, useState } from 'react';

import { deployErrorText, errorDetail, uploadSnapshot, type Snapshot } from '../../lib/sirdarApi';
import { formatBytes } from '../environments/labels';

export const SNAPSHOT_NAME_HELP = 'Letters, numbers, dots, hyphens and underscores; up to 64 characters.';

/** Mirrors snapshots.NAME_RE; '' when fine (an empty name is the caller's message). */
export function snapshotNameProblem(raw: string): string {
  const n = raw.trim();
  if (!n) return '';
  return /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(n)
    ? '' : 'Use letters, numbers, dots, hyphens and underscores, starting with a letter or number (up to 64).';
}

/** "seed-20261004T120000Z.tar.gz" → "seed-20261004T120000Z". */
export function nameFromFile(fileName: string): string {
  return fileName.replace(/\.tar\.gz$|\.tgz$/i, '').replace(/[^A-Za-z0-9._-]/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 64);
}

export default function UploadSnapshotModal({ onUploaded, onClose }: {
  onUploaded: (snapshot: Snapshot) => void; onClose: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  busyRef.current = busy;
  const fileInput = useRef<HTMLInputElement>(null);
  const chooseRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    chooseRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busyRef.current) onCloseRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && opener.isConnected) opener.focus();
    };
  }, []);

  const pick = (f: File | null) => {
    setFile(f);
    setError('');
    if (f && !name.trim()) setName(nameFromFile(f.name));
  };

  const nameError = snapshotNameProblem(name);
  const ready = !!file && !!name.trim() && !nameError && !busy;

  const submit = async () => {
    if (!file || busyRef.current) return;
    if (!name.trim()) { setError('Enter a name.'); return; }
    busyRef.current = true;
    setBusy(true);
    setError('');
    try {
      onUploaded(await uploadSnapshot(file, name.trim(), notes.trim()));
    } catch (e) {
      const max = errorDetail<{ max_bytes?: number }>(e)?.max_bytes;
      setError(typeof max === 'number'
        ? `That file is larger than Sirdar accepts (${formatBytes(max)}, SIRDAR_SNAPSHOT_MAX_BYTES).`
        : deployErrorText(e, "Couldn't upload the snapshot."));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card sirdar-snapmodal-card" role="dialog" aria-modal="true"
           aria-labelledby="sirdar-upload-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Snapshots</div>
            <h3 id="sirdar-upload-title">Upload snapshot</h3>
            <p className="page-hint">
              A bundle from scripts/make-seed-snapshot.sh. Sirdar checks it, encrypts its keys and keeps it for
              new environments and Reset data.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" disabled={busy} onClick={onClose}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body pf-form sirdar-snap-form">
          <div>
            <span className="field-label" id="snap-file-label">Bundle</span>
            <div className="sirdar-file-pick">
              <button type="button" ref={chooseRef} className="btn-ghost" disabled={busy}
                      aria-describedby="snap-file-label snap-file-name" onClick={() => fileInput.current?.click()}>
                {file ? 'Choose another file' : 'Choose file…'}
              </button>
              <span id="snap-file-name" className="mono">
                {file ? `${file.name} · ${formatBytes(file.size)}` : 'No file chosen'}
              </span>
              <input ref={fileInput} type="file" accept=".gz,.tgz,application/gzip" hidden data-testid="snap-file"
                     onChange={(e) => pick(e.target.files?.[0] ?? null)} />
            </div>
          </div>
          <div>
            <label className="field-label" htmlFor="snap-name">Name</label>
            <input id="snap-name" type="text" value={name} maxLength={64} autoComplete="off" spellCheck={false}
                   aria-invalid={!!nameError} aria-describedby="snap-name-help" disabled={busy}
                   onChange={(e) => setName(e.target.value)} />
            <p id="snap-name-help" className="page-hint">{SNAPSHOT_NAME_HELP}</p>
            {nameError && <p className="form-error" role="alert">{nameError}</p>}
          </div>
          <div>
            <label className="field-label" htmlFor="snap-notes">Notes</label>
            <textarea id="snap-notes" rows={3} value={notes} maxLength={2000} disabled={busy}
                      onChange={(e) => setNotes(e.target.value)} />
          </div>
          {busy && <p className="page-hint" role="status">Uploading… Keep this page open until it finishes.</p>}
          {error && <p className="form-error" role="alert">{error}</p>}
        </div>
        <div className="modal-foot">
          <button type="button" className="btn-ghost" disabled={busy} onClick={onClose}>Cancel</button>
          <button type="button" className="btn-solid" disabled={!ready} onClick={() => void submit()}>
            {busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
      </div>
    </div>
  );
}
