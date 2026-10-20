/**
 * Versions (spec §3.4, §4.9): one line per save, newest first, with what
 * changed (generated from the design diff), the author's note, who saved
 * it and when. Open shows that version on the canvas, read-only; Restore
 * saves it again as the next version (with unsaved changes on the page it
 * asks first, since they go). A note is added or edited in place: ⌘S never
 * asks for one.
 *
 * The report-generate header; the card sizes to its content.
 */

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

import {
  ApiError, getLabelTemplateVersion, listLabelTemplateVersions, noteLabelTemplateVersion,
  restoreLabelTemplateVersion, type LabelTemplateSaved, type LabelTemplateVersion,
  type LabelTemplateVersionDetail,
} from '../../../lib/api';
import '../../../styles/directory.css';
import '../../../styles/profile.css';   /* .btn-solid, .pf-error */
import '../../../styles/reports.css';
import '../../../styles/labelBuilder.css';
import DataTable, { type DataTableColumn } from '../../DataTable';

export interface VersionsModalProps {
  templateId: string;
  templateName: string;
  /** The version the builder holds (v7, v7.2): marked Current, no Restore. */
  current: string;
  /** The page has unsaved changes: Restore asks first. */
  dirty: boolean;
  onOpen: (version: LabelTemplateVersionDetail) => void;
  onRestored: (saved: LabelTemplateSaved) => void;
  onClose: () => void;
}

const COLUMNS: DataTableColumn[] = [
  { key: 'label', label: 'Version', mono: true, width: '120px' },
  { key: 'summary', label: 'What changed' },
  { key: 'note', label: 'Note', width: '24%' },
  { key: 'by', label: 'Saved by', width: '140px' },
  { key: 'at', label: 'Saved', mono: true, width: '200px' },
  { key: 'actions', label: '', align: 'right', width: '150px' },
];

function when(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

const key = (v: LabelTemplateVersion) => `${v.version}.${v.child_edits}`;

/** A note being written: Enter or leaving keeps it, Escape drops it. */
function NoteBox({ label, value, onDone }: { label: string; value: string; onDone: (note: string | null) => void }) {
  const [draft, setDraft] = useState(value);
  const done = useRef(false);
  const finish = (note: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(note !== null && note.trim() !== value ? note : null);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      finish(draft);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      finish(null);
    }
  };
  return (
    <input className="lbp-text" aria-label={label} value={draft} autoFocus maxLength={2000} spellCheck
      onChange={(e) => setDraft(e.target.value)} onKeyDown={onKeyDown} onBlur={() => finish(draft)} />
  );
}

function errorText(err: unknown, fallback: string): string {
  if (err instanceof ApiError && err.code === 'unknown_version') return 'That version is gone.';
  return fallback;
}

export default function VersionsModal({
  templateId, templateName, current, dirty, onOpen, onRestored, onClose,
}: VersionsModalProps) {
  const [versions, setVersions] = useState<LabelTemplateVersion[] | null>(null);
  const [noting, setNoting] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<LabelTemplateVersion | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    listLabelTemplateVersions(templateId)
      .then((rows) => { if (live) setVersions(rows); })
      .catch(() => { if (live) setError("Couldn't load the versions."); });
    return () => { live = false; };
  }, [templateId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const open = async (v: LabelTemplateVersion) => {
    setBusy(true);
    setError(null);
    try {
      onOpen(await getLabelTemplateVersion(templateId, v.version, v.child_edits));
    } catch (err) {
      setError(errorText(err, `Couldn't open ${v.label}.`));
      setBusy(false);
    }
  };

  const restore = async (v: LabelTemplateVersion) => {
    if (dirty && confirm !== v) {
      setConfirm(v);
      return;
    }
    setConfirm(null);
    setBusy(true);
    setError(null);
    try {
      onRestored(await restoreLabelTemplateVersion(templateId, v.version, v.child_edits));
    } catch (err) {
      setError(errorText(err, `Couldn't restore ${v.label}.`));
      setBusy(false);
    }
  };

  const saveNote = async (v: LabelTemplateVersion, note: string | null) => {
    setNoting(null);
    if (note === null) return;
    setError(null);
    try {
      const saved = await noteLabelTemplateVersion(templateId, v.version, v.child_edits, note.trim());
      setVersions((rows) => rows?.map((r) => (key(r) === key(v) ? { ...r, note: saved.note } : r)) ?? rows);
    } catch {
      setError(`Couldn't save the note on ${v.label}.`);
    }
  };

  const rows = (versions ?? []).map((v) => {
    const isCurrent = v.label === current;
    return {
      key: key(v),
      cells: [
        <span className="lbb-ver">{v.label}{isCurrent && <span className="chip c-green">Current</span>}</span>,
        <span className="cell-sub">{v.summary || '—'}</span>,
        noting === key(v) ? (
          <NoteBox label={`Note on ${v.label}`} value={v.note} onDone={(note) => void saveNote(v, note)} />
        ) : (
          <button type="button" className="lbb-note" onClick={() => setNoting(key(v))} disabled={busy}
            aria-label={v.note ? `Edit the note on ${v.label}` : `Add a note to ${v.label}`}>
            {v.note || <span className="lbb-note-empty">Add a note</span>}
          </button>
        ),
        <span className="cell-sub">{v.created_by_name ?? '—'}</span>,
        when(v.created_at),
        <span className="lbb-ver-actions">
          <button type="button" className="mini-btn" disabled={busy} onClick={() => void open(v)}>Open</button>
          {!isCurrent && (
            <button type="button" className="mini-btn" disabled={busy} onClick={() => void restore(v)}>Restore</button>
          )}
        </span>,
      ],
    };
  });

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card lbb-versions-card" role="dialog" aria-modal="true"
        aria-label={`Versions of ${templateName}`}>
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Label builder</div>
            <h3>Versions of {templateName}</h3>
            <p className="page-hint">
              Every save is kept. Open one to look at it, or restore it as the next version.
            </p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
              strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <div className="modal-body">
          {versions === null && !error
            ? <p className="page-hint">Loading…</p>
            : <DataTable columns={COLUMNS} rows={rows} ariaLabel="Versions" emptyText="No versions yet." />}
        </div>
        <div className="modal-foot">
          {confirm ? (
            <>
              <span className="pf-notice lbb-foot-text">
                Restoring {confirm.label} discards your unsaved changes.
              </span>
              <button type="button" className="btn-solid" disabled={busy} onClick={() => void restore(confirm)}>
                Discard and restore
              </button>
              <button type="button" className="mini-btn" disabled={busy} onClick={() => setConfirm(null)}>Cancel</button>
            </>
          ) : (
            <button type="button" className="mini-btn" onClick={onClose} disabled={busy}>Close</button>
          )}
          {error && <span className="pf-error" role="alert">{error}</span>}
        </div>
      </div>
    </div>
  );
}
