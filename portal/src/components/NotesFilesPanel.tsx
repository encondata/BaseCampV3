/**
 * NotesFilesPanel — the old portal's "document, image, or note" panel,
 * rebuilt: one merged, newest-first stream of notes and file attachments
 * for any entity the notes/attachments APIs host. Read-only unless
 * canWrite (client-scoped actors read; staff write).
 */
import { useEffect, useRef, useState } from 'react';

import {
  ApiError, createNote, deleteAttachment, deleteNote, listAttachments,
  listNotes, updateNote, uploadAttachmentRequest,
  type AttachmentOut, type NoteOut,
} from '../lib/api';

type Entry =
  | { kind: 'note'; at: string; note: NoteOut }
  | { kind: 'file'; at: string; file: AttachmentOut };

export default function NotesFilesPanel({ entityType, entityId, canWrite }: {
  entityType: 'asset'; entityId: string; canWrite: boolean;
}) {
  const [notes, setNotes] = useState<NoteOut[]>([]);
  const [files, setFiles] = useState<AttachmentOut[]>([]);
  const [status, setStatus] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [draft, setDraft] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editBody, setEditBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  const load = async () => {
    try {
      const [n, f] = await Promise.all([
        listNotes(entityType, entityId),
        listAttachments(entityType, entityId),
      ]);
      setNotes(n);
      setFiles(f);
      setStatus('loaded');
    } catch {
      setStatus('error');
    }
  };

  useEffect(() => {
    let cancelled = false;
    setStatus('loading');
    void load().then(() => { if (cancelled) return; });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityType, entityId]);

  const entries: Entry[] = [
    ...notes.map((n) => ({ kind: 'note' as const, at: n.created_at, note: n })),
    ...files.map((f) => ({ kind: 'file' as const, at: f.created_at, file: f })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  const addNote = async () => {
    const body = draft.trim();
    if (!body) return;
    setBusy(true);
    setError('');
    try {
      await createNote(entityType, entityId, body);
      setDraft('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? 'Could not save the note.' : 'Network error.');
    } finally {
      setBusy(false);
    }
  };

  const saveEdit = async () => {
    if (editingId === null) return;
    setBusy(true);
    try {
      await updateNote(editingId, editBody.trim());
      setEditingId(null);
      await load();
    } catch {
      setError('Could not update the note.');
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File) => {
    setBusy(true);
    setError('');
    try {
      await uploadAttachmentRequest({
        entityType, entityId,
        kind: file.type.startsWith('image/') ? 'photo' : 'document',
        file,
      });
      await load();
    } catch {
      setError('Upload failed.');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="detail-block" style={{ gridColumn: '1 / -1' }}>
      <p className="eyebrow-sm">Notes &amp; files</p>

      {status === 'loading' && <p className="page-hint">Loading…</p>}
      {status === 'error' && <p className="page-hint">Could not load notes and files.</p>}

      {status === 'loaded' && (
        <>
          {canWrite && (
            <div className="nf-composer">
              <textarea rows={2} placeholder="Add a note…" value={draft}
                        onChange={(e) => setDraft(e.target.value)} disabled={busy} />
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

          {entries.length === 0 && <p className="page-hint">Nothing here yet.</p>}

          <ul className="nf-list">
            {entries.map((entry) => entry.kind === 'note' ? (
              <li key={`n-${entry.note.id}`} className="nf-item">
                {editingId === entry.note.id ? (
                  <>
                    <textarea rows={2} value={editBody}
                              onChange={(e) => setEditBody(e.target.value)} />
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
                      <span>{entry.note.author_name ?? 'Unknown'}</span>
                      <span>{new Date(entry.note.created_at).toLocaleString()}</span>
                      {canWrite && (
                        <span className="nf-actions">
                          <button className="mini-btn" onClick={() => {
                            setEditingId(entry.note.id);
                            setEditBody(entry.note.body);
                          }}>Edit</button>
                          <button className="mini-btn danger" onClick={() => {
                            void deleteNote(entry.note.id).then(load);
                          }}>Delete</button>
                        </span>
                      )}
                    </div>
                  </>
                )}
              </li>
            ) : (
              <li key={`f-${entry.file.id}`} className="nf-item">
                <p className="nf-body">
                  {entry.file.url
                    ? <a href={entry.file.url} target="_blank" rel="noreferrer">
                        📎 {entry.file.filename}</a>
                    : <>📎 {entry.file.filename}</>}
                  <span className="chip tag" style={{ marginLeft: 8 }}>
                    {entry.file.kind}</span>
                </p>
                <div className="nf-meta">
                  <span>{(entry.file.size_bytes / 1024).toFixed(0)} KB</span>
                  <span>{new Date(entry.file.created_at).toLocaleString()}</span>
                  {canWrite && (
                    <span className="nf-actions">
                      <button className="mini-btn danger" onClick={() => {
                        void deleteAttachment(entry.file.id).then(load);
                      }}>Delete</button>
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
          {error && <span className="pf-error">{error}</span>}
        </>
      )}
    </div>
  );
}
