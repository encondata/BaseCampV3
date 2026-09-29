/** Submit for review: where the space requires approval, an editor's
 *  Publish sends the draft to the page's managers instead, with an
 *  optional note. Like Publish, it first stores the live document
 *  (`flush`) — the review snapshots the STORED draft — and submits nothing
 *  when that fails. In the portal's modal header pattern, sized to its
 *  content. */
import { useEffect, useState, type FormEvent } from 'react';

import { ApiError } from '@portal/lib/api';
import { useToast } from '@portal/lib/notificationsContext';

import { FlushError } from '../editor/liveFlush';
import { flushFailure } from '../editor/PublishDialog';
import type { ReviewOut } from '../lib/types';
import { errorMessage, submitReview } from '../lib/wikiApi';
import { noteReviewsChanged } from './ReviewsLink';

const NOTE_MAX = 1000;

interface Props {
  pageId: string;
  pageTitle: string;
  /** Store the live document now; resolves once the stored draft is current. */
  flush: () => Promise<void>;
  /** A request is already waiting on this page (this one replaces it). */
  replacesPending?: boolean;
  onClose: () => void;
  onSubmitted: (review: ReviewOut) => void;
}

export default function SubmitReviewDialog({
  pageId, pageTitle, flush, replacesPending = false, onClose, onSubmitted,
}: Props) {
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
      await flush();
      const review = await submitReview(pageId, note.trim() || undefined);
      toast('Submitted for review. A manager of the page will approve it.');
      noteReviewsChanged();
      onSubmitted(review);
      onClose();
    } catch (err) {
      setBusy(false);
      if (err instanceof FlushError) {
        setError(flushFailure(err, { done: 'submitted', doing: 'submitting it' }));
      } else if (err instanceof ApiError && err.status === 409 && err.code === 'nothing_to_review') {
        setError('Nothing new to review — the draft matches the published page.');
      } else {
        setError(errorMessage(err, 'Couldn\'t submit the page for review. Try again.'));
      }
    }
  };

  return (
    <div className="modal-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
      <div className="modal-card reports-modal-card rgm-card wiki-dialog-card" role="dialog"
           aria-modal="true" aria-labelledby="wiki-submit-review-title">
        <div className="modal-head">
          <div className="rgm-head-text">
            <div className="eyebrow">Review</div>
            <h3 id="wiki-submit-review-title">Submit “{pageTitle}” for review</h3>
            <p className="page-hint">
              This library needs a manager's approval before changes go live. Readers keep seeing the
              published version until then.
            </p>
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
                <label htmlFor="wiki-review-note">Note for the reviewer (optional)</label>
                <textarea id="wiki-review-note" className="wiki-publish-note" rows={3} value={note}
                          maxLength={NOTE_MAX} disabled={busy} autoFocus
                          placeholder="What changed, and anything the reviewer should check."
                          onChange={(e) => setNote(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void submit(e);
                          }} />
              </div>
            </div>
            {replacesPending && (
              <p className="page-hint">This replaces the request already waiting on this page.</p>
            )}
            {error && <p className="pf-error" role="alert">{error}</p>}
          </div>
          <div className="modal-foot">
            <button className="btn-solid" type="submit" disabled={busy}>{busy ? 'Submitting…' : 'Submit for review'}</button>
            <button className="mini-btn" type="button" onClick={onClose} disabled={busy}>Cancel</button>
          </div>
        </form>
      </div>
    </div>
  );
}
