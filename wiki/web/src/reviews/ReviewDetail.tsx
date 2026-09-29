/** /reviews/:reviewId — one review request: the page, who asked and when,
 *  their note, a warning when the page was published after it was
 *  submitted, and the diff from the page's published content to the
 *  submitted snapshot. A manager of the page approves it (publishing that
 *  snapshot; the note is optional) or requests changes (the note is
 *  required); the requester can withdraw it. After a decision it goes back
 *  where it came from (the queue when opened from a link) with a toast. */
import { useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { useAuth } from '@portal/auth/AuthContext';
import { ApiError } from '@portal/lib/api';
import { relativeTime } from '@portal/lib/format';
import { useToast } from '@portal/lib/notificationsContext';

import { atLeast } from '../components/RowMenu';
import { diffDocs } from '../history/diff';
import DiffView from '../history/DiffView';
import { useWikiShell } from '../layout/shellContext';
import type { Level, ReviewDetail as ReviewDetailOut } from '../lib/types';
import { useWikiMe } from '../lib/useWikiMe';
import { approveReview, errorMessage, getNode, getReview, rejectReview, withdrawReview } from '../lib/wikiApi';
import NotFound from '../pages/NotFound';
import { ReviewStatusChip } from './ReviewChip';
import { noteReviewsChanged } from './ReviewsLink';

const NOTE_MAX = 1000;

type State =
  | { id: string; status: 'ready'; review: ReviewDetailOut; level: Level | null }
  | { id: string; status: 'missing' }
  | { id: string; status: 'error'; message: string };

const DECIDED: Record<string, string> = {
  approved: 'Approved', rejected: 'Changes requested', withdrawn: 'Withdrawn',
};

export default function ReviewDetail() {
  const { reviewId = '' } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const location = useLocation();
  const { setCurrentNode } = useWikiShell();
  const me = useWikiMe();
  const { person } = useAuth();
  const meId = me?.person.id ?? person?.id ?? null;
  const [state, setState] = useState<State | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'approve' | 'reject' | 'withdraw' | null>(null);
  const [error, setError] = useState('');

  useEffect(() => { setCurrentNode(null); }, [setCurrentNode]);

  useEffect(() => {
    let live = true;
    setNote('');
    setError('');
    getReview(reviewId)
      .then(async (review) => {
        // the review doesn't say what I may do on its page; the node does
        const level = await getNode(review.node.id).then((n) => n.my_level, () => null);
        if (live) setState({ id: reviewId, status: 'ready', review, level });
      })
      .catch((err) => {
        if (!live) return;
        if (err instanceof ApiError && err.status === 404) setState({ id: reviewId, status: 'missing' });
        else setState({ id: reviewId, status: 'error', message: errorMessage(err, 'Couldn\'t load this review.') });
      });
    return () => { live = false; };
  }, [reviewId]);

  const shown = state?.id === reviewId ? state : null;
  const review = shown?.status === 'ready' ? shown.review : null;
  const blocks = useMemo(
    () => (review ? diffDocs(review.published_content, review.submitted_content) : []),
    [review],
  );

  if (!shown) return <div className="portal-page wiki-page"><p className="page-hint">Loading…</p></div>;
  if (shown.status === 'missing') return <NotFound what="review" />;
  if (shown.status === 'error') {
    return <div className="portal-page wiki-page"><p className="pf-error">{shown.message}</p></div>;
  }

  const r = shown.review;
  const pending = r.status === 'pending';
  const isManager = atLeast(shown.level, 'manage');
  const isRequester = !!meId && r.requested_by?.id === meId;

  const back = () => {
    // opened straight from a link (an inbox item): there's nothing to go back to here
    if (location.key === 'default') navigate('/reviews');
    else navigate(-1);
  };

  const act = async (kind: 'approve' | 'reject' | 'withdraw') => {
    const trimmed = note.trim();
    if (kind === 'reject' && !trimmed) {
      setError('Say what needs to change.');
      return;
    }
    setBusy(kind);
    setError('');
    try {
      if (kind === 'approve') {
        await approveReview(r.id, trimmed || undefined);
        toast(`Approved — “${r.node.title}” is published.`);
      } else if (kind === 'reject') {
        await rejectReview(r.id, trimmed);
        toast(`Changes requested on “${r.node.title}”.`);
      } else {
        await withdrawReview(r.id);
        toast('Review request withdrawn.');
      }
      noteReviewsChanged();
      back();
    } catch (err) {
      setBusy(null);
      setError(errorMessage(err, 'Couldn\'t save the decision. Try again.'));
    }
  };

  return (
    <div className="portal-page wiki-page wiki-review-detail" data-testid="review-detail">
      <nav className="wiki-crumbs" aria-label="Breadcrumb">
        <Link to="/reviews">Reviews</Link>
        <span className="wiki-crumb"><span className="wiki-crumb-sep" aria-hidden="true">/</span>{r.node.space_name}</span>
      </nav>
      <header className="wiki-page-head">
        <div className="wiki-page-head-main">
          <div className="eyebrow">Review</div>
          <h1 className="page-title wiki-title"><Link to={`/n/${r.node.id}`}>{r.node.title}</Link></h1>
          <div className="wiki-page-meta">
            <span title={new Date(r.created_at).toLocaleString()}>
              Requested by {r.requested_by?.name ?? 'someone'} · {relativeTime(r.created_at)}
            </span>
            <ReviewStatusChip status={r.status} />
          </div>
          {r.note && <blockquote className="wiki-review-note">{r.note}</blockquote>}
        </div>
      </header>

      {pending && r.stale && (
        <p className="wiki-review-banner is-warn" role="alert">
          This page was published after this review was submitted. Approving will replace the newer published version.
        </p>
      )}

      {!pending && (
        <section className="wiki-review-decision" aria-label="Decision">
          <div className="wiki-section-label">Decision</div>
          <p className="page-hint">
            {DECIDED[r.status]}
            {r.decided_by ? ` by ${r.decided_by.name}` : ''}
            {r.decided_at ? ` · ${relativeTime(r.decided_at)}` : ''}
          </p>
          {r.decision_note && <blockquote className="wiki-review-note">{r.decision_note}</blockquote>}
        </section>
      )}

      {pending && (isManager || isRequester) && (
        <section className="wiki-review-actions" aria-label="Your decision">
          {isManager && (
            <div className="pf-form">
              <div className="full">
                <label htmlFor="wiki-review-decision-note">
                  Note to the requester (optional to approve, required to request changes)
                </label>
                <textarea id="wiki-review-decision-note" className="wiki-publish-note" rows={3} value={note}
                          maxLength={NOTE_MAX} disabled={!!busy} placeholder="What's good, or what needs to change."
                          onChange={(e) => setNote(e.target.value)} />
              </div>
            </div>
          )}
          {error && <p className="pf-error">{error}</p>}
          <div className="wiki-review-buttons">
            {isManager && (
              <>
                <button type="button" className="btn-solid" disabled={!!busy} onClick={() => void act('approve')}>
                  {busy === 'approve' ? 'Approving…' : 'Approve and publish'}
                </button>
                <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => void act('reject')}>
                  {busy === 'reject' ? 'Sending…' : 'Request changes'}
                </button>
              </>
            )}
            {isRequester && (
              <button type="button" className="btn-ghost" disabled={!!busy} onClick={() => void act('withdraw')}>
                {busy === 'withdraw' ? 'Withdrawing…' : 'Withdraw request'}
              </button>
            )}
          </div>
        </section>
      )}

      <DiffView blocks={blocks}
                from={r.published_content ? 'the published page' : 'nothing published yet'}
                to={`version ${r.submitted_version_no} (submitted)`} />
    </div>
  );
}
