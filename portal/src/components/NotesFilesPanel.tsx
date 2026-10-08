/**
 * NotesFilesPanel — the old portal's "document, image, or note" panel,
 * rebuilt: one merged, newest-first stream of notes and file attachments
 * for any entity the notes/attachments APIs host. Read-only unless
 * canWrite (client-scoped actors read; staff write).
 *
 * Every note and file has a visibility level: Everyone (the default —
 * clients and partners who can see the record included), Internal (staff
 * only) or Admin (Admin rank and up). Writers pick the level when adding
 * a note or file and can change it afterward; non-Everyone items carry a
 * chip. The API already filters lists to what the viewer may see.
 */
import { useEffect, useRef, useState } from 'react';

import {
  ApiError, createNote, deleteAttachment, deleteNote, listAttachments,
  listNotes, updateAttachment, updateNote, uploadAttachmentRequest,
  type AttachmentOut, type NoteOut,
} from '../lib/api';
import { useAuth } from '../auth/AuthContext';
import { VISIBILITY_LABEL, visibilityOptions, type Visibility } from '../lib/visibility';
import CollapsePanel from './CollapsePanel';

type Entry =
  | { kind: 'note'; at: string; note: NoteOut }
  | { kind: 'file'; at: string; file: AttachmentOut };

const isImage = (file: AttachmentOut) =>
  !!file.content_type?.startsWith('image/') && !!file.url;

/** Display label for a file's attachment `kind` — the raw value ("survey_template")
 *  reads fine as data but not as UI copy, so known kinds get a proper label
 *  and anything else falls back to the raw string. */
const KIND_LABEL: Record<string, string> = {
  avatar: 'Avatar', photo: 'Photo', document: 'Document',
  survey_template: 'Survey template', report_asset: 'Document',
};
const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind;

/** Chip for a non-default level; Everyone is the norm and shows nothing. */
const visibilityChip = (v: Visibility) => v === 'everyone' ? null
  : <span className="chip tag">{VISIBILITY_LABEL[v]}</span>;

/** The house segmented control over the levels this user may choose. */
function VisibilityPicker({ value, options, onChange, label, disabled }: {
  value: Visibility; options: Visibility[]; onChange: (v: Visibility) => void;
  label: string; disabled?: boolean;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o} type="button" aria-pressed={value === o}
                className={value === o ? 'on' : ''} disabled={disabled}
                onClick={() => onChange(o)}>
          {VISIBILITY_LABEL[o]}
        </button>
      ))}
    </div>
  );
}

/** Failed-write message: the API's refusal to set a level the user can't
 *  see reads the same everywhere; anything else keeps the caller's wording. */
const writeError = (err: unknown, fallback: string) =>
  err instanceof ApiError && err.code === 'visibility_not_allowed'
    ? "You can't choose that visibility." : fallback;

/** Full-size overlay for one image attachment. Closes on scrim click or
 *  Escape. Reuses the house modal-scrim so it sits above everything,
 *  including the map's now-isolated stacking context. */
function Lightbox({ file, onClose }: { file: AttachmentOut; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="modal-scrim nf-lightbox" onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <div className="nf-lightbox-frame">
        <button type="button" className="mini-btn nf-lightbox-close" aria-label="Close"
                onClick={onClose}>✕</button>
        <img src={file.url ?? ''} alt={file.filename} className="nf-lightbox-img" />
        <p className="nf-lightbox-caption">{file.filename}</p>
      </div>
    </div>
  );
}

export default function NotesFilesPanel({ entityType, entityId, canWrite }: {
  entityType: string; entityId: string; canWrite: boolean;
}) {
  const [notes, setNotes] = useState<NoteOut[]>([]);
  const [files, setFiles] = useState<AttachmentOut[]>([]);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [draftVisibility, setDraftVisibility] = useState<Visibility>('everyone');
  const [editVisibility, setEditVisibility] = useState<Visibility>('everyone');
  const [visibilityFileId, setVisibilityFileId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lightbox, setLightbox] = useState<AttachmentOut | null>(null);
  const { maxRank, scope } = useAuth();
  const options = visibilityOptions(scope?.global ?? true, maxRank ?? 0);
  const fileRef = useRef<HTMLInputElement>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  // grow with content while typing, capped so long notes scroll
  const autoGrow = (el: HTMLTextAreaElement | null) => {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight + 2, 220)}px`;
  };

  const load = async (isLive: () => boolean = () => true) => {
    try {
      const [n, f] = await Promise.all([
        listNotes(entityType, entityId),
        listAttachments(entityType, entityId),
      ]);
      if (!isLive()) return;
      setNotes(n);
      setFiles(f);
      setStatus('loaded');
    } catch {
      if (isLive()) setStatus('error');
    }
  };

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void load(() => !cancelled);
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, entityId]);

  // image attachments move into the thumbnail grid; everything else
  // (notes + non-image files) stays in the plain newest-first list.
  const imageFiles = files.filter(isImage);
  const entries: Entry[] = [
    ...notes.map((n) => ({ kind: 'note' as const, at: n.created_at, note: n })),
    ...files.filter((f) => !isImage(f)).map((f) => ({ kind: 'file' as const, at: f.created_at, file: f })),
  ].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));

  const addNote = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError('');
    try {
      await createNote(entityType, entityId, body, draftVisibility);
      setDraft('');
      if (composerRef.current) composerRef.current.style.height = '';
      await load();
    } catch (err) {
      setError(err instanceof ApiError
        ? writeError(err, 'Could not save the note.') : 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (editingId === null) return;
    setBusy(true);
    setError('');
    try {
      await updateNote(editingId, { body: editBody.trim(), visibility: editVisibility });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(writeError(err, 'Could not update the note.'));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      await uploadAttachmentRequest({
        // uploadAttachmentRequest predates this panel and still narrows
        // entityType to its historical avatar/photo/document callers;
        // this component is contractually generic, so assert here.
        entityType: entityType as 'person' | 'client' | 'partner' | 'asset',
        entityId,
        kind: file.type.startsWith('image/') ? 'photo' : 'document',
        file,
        visibility: draftVisibility,
      });
      await load();
    } catch (err) {
      setError(writeError(err, 'Upload failed.'));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const removeNote = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      await deleteNote(id);
      await load();
    } catch {
      setError('Could not delete the note.');
    } finally {
      setBusy(false);
    }
  };

  const removeAttachment = async (id: string) => {
    setBusy(true);
    setError('');
    try {
      await deleteAttachment(id);
      await load();
    } catch {
      setError('Could not delete the file.');
    } finally {
      setBusy(false);
    }
  };

  const changeFileVisibility = async (file: AttachmentOut, level: Visibility) => {
    if (level === file.visibility) return;
    setBusy(true);
    setError('');
    try {
      await updateAttachment(file.id, { visibility: level });
      setVisibilityFileId(null);
      await load();
    } catch (err) {
      setError(writeError(err, 'Could not change the visibility.'));
    } finally {
      setBusy(false);
    }
  };

  /** Visibility button for a file (avatars are always Everyone, so none). */
  const visibilityButton = (file: AttachmentOut) => canWrite && file.kind !== 'avatar' && (
    <button className="mini-btn" disabled={busy} onClick={() => {
      setVisibilityFileId(visibilityFileId === file.id ? null : file.id);
    }}>Visibility</button>
  );

  const filePicker = (file: AttachmentOut) => visibilityFileId === file.id && (
    <VisibilityPicker value={file.visibility} options={options} disabled={busy}
                      label="File visibility"
                      onChange={(v) => void changeFileVisibility(file, v)} />
  );

  const badge = (
    <span className="badge-count">
      {status === 'loading' ? '…' : status === 'error' ? '—'
        : `${notes.length} notes · ${files.length} files`}
    </span>
  );

  return (
    <div className="detail-block" style={{ gridColumn: '1 / -1' }}>
      <CollapsePanel title="Notes & files" badge={badge}>
      {status === 'loading' && <p className="page-hint">Loading…</p>}
      {status === 'error' && <p className="page-hint">Could not load notes and files.</p>}

      {status === 'loaded' && (
        <>
          {imageFiles.length > 0 && (
            <div className="nf-thumbs">
              {imageFiles.map((file) => (
                <div key={`t-${file.id}`}
                     className={`nf-thumb-wrap${visibilityFileId === file.id ? ' nf-vis-open' : ''}`}>
                  <button type="button" className="nf-thumb"
                          onClick={() => setLightbox(file)}
                          aria-label={`Open ${file.filename}`}>
                    <img src={file.url ?? ''} alt={file.filename} loading="lazy" />
                  </button>
                  <div className="mini-row compact nf-thumb-cap">
                    <span className="cell-top">{file.filename}</span>
                    {canWrite && (
                      <span className="nf-actions">
                        <button className="mini-btn danger" disabled={busy} onClick={() => {
                          void removeAttachment(file.id);
                        }}>Delete</button>
                      </span>
                    )}
                  </div>
                  {(file.visibility !== 'everyone' || (canWrite && file.kind !== 'avatar')) && (
                    <div className="nf-thumb-vis">
                      {visibilityChip(file.visibility)}
                      {visibilityButton(file)}
                    </div>
                  )}
                  {filePicker(file)}
                </div>
              ))}
            </div>
          )}

          {canWrite && (
            <div className="nf-composer">
              <textarea ref={composerRef} rows={2} placeholder="Add a note…"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onInput={(e) => autoGrow(e.currentTarget)}
                        disabled={busy} />
              {options.length > 1 && (
                <>
                  <div className="nf-visibility">
                    <span className="page-hint nf-visibility-label">Visible to</span>
                    <VisibilityPicker value={draftVisibility} options={options}
                                      label="Visible to" disabled={busy}
                                      onChange={setDraftVisibility} />
                  </div>
                  <p className="page-hint nf-visibility-hint">
                    Everyone includes client and partner users who can see this record.</p>
                </>
              )}
              <div className="nf-composer-actions">
                <button className="mini-btn" onClick={() => void addNote()}
                        disabled={busy || !draft.trim()}>Add note</button>
                <button className="mini-btn" onClick={() => fileRef.current?.click()}
                        disabled={busy}>Attach file</button>
                <input ref={fileRef} type="file" hidden
                       onChange={(e) => {
                         const f = e.target.files?.[0];
                         if (f) void upload(f);
                       }} />
              </div>
            </div>
          )}

          {entries.length === 0 && imageFiles.length === 0 && (
            <p className="page-hint">Nothing here yet.</p>
          )}

          <ul className="mini-list nf-list">
            {entries.map((entry) => entry.kind === 'note' ? (
              <li key={`n-${entry.note.id}`} className="mini-row nf-item">
                {editingId === entry.note.id ? (
                  <>
                    <textarea rows={2} value={editBody} ref={autoGrow}
                              onChange={(e) => setEditBody(e.target.value)}
                              onInput={(e) => autoGrow(e.currentTarget)} />
                    {options.length > 1 && (
                      <VisibilityPicker value={editVisibility} options={options}
                                        label="Note visibility" disabled={busy}
                                        onChange={setEditVisibility} />
                    )}
                    <div className="nf-actions">
                      <button className="mini-btn" onClick={() => void saveEdit()}
                              disabled={busy || !editBody.trim()}>Save</button>
                      <button className="mini-btn" onClick={() => setEditingId(null)}>
                        Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <p className="nf-body">{entry.note.body}</p>
                    <div className="nf-meta">
                      <span className="cell-top">{entry.note.author_name ?? 'Unknown'}</span>
                      <span className="mono">{new Date(entry.note.created_at).toLocaleString()}</span>
                      {visibilityChip(entry.note.visibility)}
                      {canWrite && (
                        <span className="nf-actions">
                          <button className="mini-btn" disabled={busy} onClick={() => {
                            setEditingId(entry.note.id);
                            setEditBody(entry.note.body);
                            setEditVisibility(entry.note.visibility);
                          }}>Edit</button>
                          <button className="mini-btn danger" disabled={busy} onClick={() => {
                            void removeNote(entry.note.id);
                          }}>Delete</button>
                        </span>
                      )}
                    </div>
                  </>
                )}
              </li>
            ) : (
              <li key={`f-${entry.file.id}`} className="mini-row nf-item">
                <p className="nf-body">
                  {entry.file.url
                    ? <a href={entry.file.url} target="_blank" rel="noreferrer">
                        📎 {entry.file.filename}</a>
                    : <>📎 {entry.file.filename}</>}
                  <span className="chip tag" style={{ marginLeft: 8 }}>
                    {kindLabel(entry.file.kind)}</span>
                  {entry.file.visibility !== 'everyone' && (
                    <span style={{ marginLeft: 6 }}>{visibilityChip(entry.file.visibility)}</span>
                  )}
                </p>
                <div className="nf-meta">
                  <span className="mono">{(entry.file.size_bytes / 1024).toFixed(0)} KB</span>
                  <span className="mono">{new Date(entry.file.created_at).toLocaleString()}</span>
                  {canWrite && (
                    <span className="nf-actions">
                      {visibilityButton(entry.file)}
                      <button className="mini-btn danger" disabled={busy} onClick={() => {
                        void removeAttachment(entry.file.id);
                      }}>Delete</button>
                    </span>
                  )}
                </div>
                {filePicker(entry.file)}
              </li>
            ))}
          </ul>
          {error && <span className="pf-error">{error}</span>}
        </>
      )}
      </CollapsePanel>
      {lightbox && <Lightbox file={lightbox} onClose={() => setLightbox(null)} />}
    </div>
  );
}
