/** Publish: snapshots the live draft as the version readers see, with an
 *  optional change note. In the portal's modal header pattern, sized to
 *  its content. */
import { useEffect, useState, type FormEvent } from 'react';

import { ApiError } from '@portal/lib/api';
import { useToast } from '@portal/lib/notificationsContext';

import type { VersionOut } from '../lib/types';
import { errorMessage, publishPage } from '../lib/wikiApi';

const NOTE_MAX = 1000;

interface Props {
  pageId: string;
  pageTitle: string;
  onClose: () => void;
  onPublished: (version: VersionOut) => void;
}

export default function PublishDialog({ pageId, pageTitle, onClose, onPublished }: Props) {
  const toast = useToast();
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !busy) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const version = await publishPage(pageId, note.trim() || undefined);
      toast('Published');
      onPublished(version);
      onClose();
    } catch (err) {
      setBusy(false);
      if (err instanceof ApiError && err.status === 409 && err.code === 'nothing_to_publish') {
        setError('Nothing new to publish');
      } else {
        setError(errorMessage(err, 'Couldn\'t publish the page. Try again.'));
      }
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-dialog-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-publish-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Publish</div>
            <h3 id="wiki-publish-title">Publish “{pageTitle}”</h3>
            <p className="page-hint">Everyone who can view this page will see the current draft.</p>
          </div>
          <button type="button" className="modal-close" aria-label="Close" onClick={onClose} disabled={busy}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"
                 strokeLinecap="round"><path d="M5 5l14 14M19 5L5 19" /></svg>
          </button>
        </div>
        <form onSubmit={(e) => void submit(e)}>
          <div className="modal-body">
            <div className="pf-form">
              <div className="full">
                <label htmlFor="wiki-publish-note">Change note (optional)</label>
                <textarea id="wiki-publish-note" className="wiki-publish-note" rows={3} value={note}
                          maxLength={NOTE_MAX} disabled={busy} autoFocus
                          placeholder="What changed? Readers see this in the page history."
                          onChange={(e) => setNote(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
                          }} />
              </div>
            </div>
            {error && <p className="pf-error" role="alert">{error}</p>}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={busy}>{busy ? 'Publishing…' : 'Publish'}</button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
