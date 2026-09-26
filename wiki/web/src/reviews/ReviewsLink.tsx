/** The top bar's "Reviews" entry: a link to the reviews queue with a badge
 *  counting the pending reviews waiting on me (pages I manage). The count
 *  is polled every minute while the tab is visible, caught up when it
 *  shows again, and recounted at once when a review is submitted or
 *  decided in this tab (`noteReviewsChanged`). */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

import { listReviews } from '../lib/wikiApi';

export const POLL_MS = 60_000;

const listeners = new Set<() => void>();

/** A review was submitted, decided or withdrawn here: recount. */
export function noteReviewsChanged(): void {
  listeners.forEach((fn) => fn());
}

/** How many pending reviews wait on me; null until first counted. */
function usePendingApprovals(): number | null {
  const [count, setCount] = useState<number | null>(null);

  const load = useCallback(() => {
    listReviews({ status: 'pending', mine: 'approver' })
      .then((reviews) => setCount(reviews.length))
      .catch(() => { /* keep the last count; the next poll tries again */ });
  }, []);

  useEffect(() => {
    let live = true;
    const refresh = () => { if (live) load(); };
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refresh();
    }, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    listeners.add(refresh);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      listeners.delete(refresh);
    };
  }, [load]);

  return count;
}

export default function ReviewsLink() {
  const count = usePendingApprovals();
  const waiting = count !== null && count > 0;
  return (
    <Link to="/reviews" className="btn-ghost wiki-reviews-link"
          aria-label={waiting ? `Reviews (${count} waiting for you)` : 'Reviews'}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"
           strokeLinejoin="round" aria-hidden="true"><path d="M9 11l2 2 4-4" /><path d="M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0z" /></svg>
      Reviews
      {waiting && <span className="wiki-count-badge" aria-hidden="true">{count > 99 ? '99+' : count}</span>}
    </Link>
  );
}
