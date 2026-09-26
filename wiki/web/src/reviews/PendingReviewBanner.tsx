/** On a page with a review request waiting (editors see its id): "Waiting
 *  for review since <time>", who asked, Withdraw (the requester or a
 *  manager) and, for managers, Review now (/reviews/:id). */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { useToast } from '@portal/lib/notificationsContext';

import type { ReviewDetail } from '../lib/types';
import { errorMessage, getReview, withdrawReview } from '../lib/wikiApi';
import { noteReviewsChanged } from './ReviewsLink';

const since = (iso: string) => new Date(iso).toLocaleString(undefined, {
  month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

interface Props {
  reviewId: string;
  canManage: boolean;
  meId: string | null;
  /** The request was withdrawn: the page should reload. */
  onWithdrawn: () => void;
}

export default function PendingReviewBanner({ reviewId, canManage, meId, onWithdrawn }: Props) {
  const toast = useToast();
  const [review, setReview] = useState<ReviewDetail | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    setReview(null);
    getReview(reviewId).then((r) => { if (live) setReview(r); }).catch(() => { /* the banner still stands */ });
    return () => { live = false; };
  }, [reviewId]);

  const mine = !!meId && review?.requested_by?.id === meId;
  const canWithdraw = canManage || mine;

  const withdraw = async () => {
    setBusy(true);
    try {
      await withdrawReview(reviewId);
      toast('Review request withdrawn.');
      noteReviewsChanged();
      onWithdrawn();
    } catch (err) {
      toast(errorMessage(err, 'Couldn\'t withdraw the review request.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wiki-review-banner" role="status" aria-label="Pending review">
      <div className="wiki-review-banner-text">
        <b>{review ? `Waiting for review since ${since(review.created_at)}` : 'Waiting for review'}</b>
        {review && !mine && review.requested_by && <span>Requested by {review.requested_by.name}</span>}
        {review && mine && <span>A manager of the page will approve it or ask for changes.</span>}
      </div>
      <div className="wiki-review-banner-actions">
        {canManage && <Link className="btn-solid" to={`/reviews/${reviewId}`}>Review now</Link>}
        {canWithdraw && (
          <button type="button" className="btn-ghost" disabled={busy} onClick={() => void withdraw()}>
            {busy ? 'Withdrawing…' : 'Withdraw'}
          </button>
        )}
      </div>
    </div>
  );
}
