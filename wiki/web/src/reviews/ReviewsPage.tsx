/** /reviews — the reviews queue. "To approve": pending reviews of pages I
 *  manage. "My requests" (`?tab=mine`): my own requests of every status.
 *  Each row opens the review (/reviews/:id). */
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { relativeTime } from '@portal/lib/format';

import { useWikiShell } from '../layout/shellContext';
import type { ReviewOut, ReviewStatus } from '../lib/types';
import { listReviews } from '../lib/wikiApi';
import { ReviewStatusChip } from './ReviewChip';

const GRID = {
  gridTemplateColumns: 'minmax(220px, 2.4fr) minmax(120px, 1fr) minmax(130px, 1fr) minmax(100px, 0.8fr) minmax(160px, 2fr)',
};
const STATUSES: ReviewStatus[] = ['pending', 'approved', 'rejected', 'withdrawn'];

type Tab = 'approve' | 'mine';
type State = { tab: Tab; reviews: ReviewOut[] | 'error' } | null;

async function load(tab: Tab): Promise<ReviewOut[]> {
  if (tab === 'approve') return listReviews({ status: 'pending', mine: 'approver' });
  const lists = await Promise.all(STATUSES.map((status) => listReviews({ status, mine: 'requester' })));
  return lists.flat().sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function Row({ review, tab }: { review: ReviewOut; tab: Tab }) {
  return (
    <div className="dir-row" role="listitem">
      <div className="row-main" style={GRID}>
        <div className="cell cell-primary">
          <div className="pn">
            <Link to={`/reviews/${review.id}`}><b title={review.node.title}>{review.node.title}</b></Link>
          </div>
        </div>
        <div className="cell"><span className="cell-top cell-line">{review.node.space_name}</span></div>
        <div className="cell">
          {tab === 'approve'
            ? <span className="cell-top cell-line">{review.requested_by?.name ?? '—'}</span>
            : <ReviewStatusChip status={review.status} />}
        </div>
        <div className="cell">
          <span className="cell-top cell-line" title={new Date(review.created_at).toLocaleString()}>
            {relativeTime(review.created_at)}
          </span>
        </div>
        <div className="cell">
          <span className="cell-top cell-line" title={review.note || undefined}>{review.note || '—'}</span>
        </div>
      </div>
    </div>
  );
}

export default function ReviewsPage() {
  const { setCurrentNode } = useWikiShell();
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get('tab') === 'mine' ? 'mine' : 'approve';
  const [state, setState] = useState<State>(null);

  useEffect(() => { setCurrentNode(null); }, [setCurrentNode]);

  useEffect(() => {
    let live = true;
    load(tab)
      .then((reviews) => { if (live) setState({ tab, reviews }); })
      .catch(() => { if (live) setState({ tab, reviews: 'error' }); });
    return () => { live = false; };
  }, [tab]);

  const reviews = state?.tab === tab ? state.reviews : null;
  const label = tab === 'approve' ? 'To approve' : 'My requests';
  const pick = (next: Tab) => setParams(next === 'mine' ? { tab: 'mine' } : {}, { replace: true });

  return (
    <div className="portal-page wiki-page" data-testid="reviews-page">
      <div className="dir-head wiki-folder-head">
        <div>
          <div className="eyebrow">Wiki</div>
          <h1 className="page-title">Reviews</h1>
          <p className="page-hint">Changes waiting for a manager's approval before they go live.</p>
        </div>
      </div>

      <div className="dir-toolbar">
        <div className="segmented wiki-reviews-tabs" role="group" aria-label="Reviews">
          <button type="button" className={tab === 'approve' ? 'on' : undefined} aria-pressed={tab === 'approve'}
                  onClick={() => pick('approve')}>To approve</button>
          <button type="button" className={tab === 'mine' ? 'on' : undefined} aria-pressed={tab === 'mine'}
                  onClick={() => pick('mine')}>My requests</button>
        </div>
      </div>

      <div className="dir-list list-scroll wiki-reviews-list">
        <div className="list-head" style={GRID} aria-hidden="true">
          <span>Page</span><span>Space</span><span>{tab === 'approve' ? 'Requested by' : 'Status'}</span>
          <span>Submitted</span><span>Note</span>
        </div>
        <div role="list" aria-label={label}>
          {Array.isArray(reviews) && reviews.map((r) => <Row key={r.id} review={r} tab={tab} />)}
        </div>
        {reviews === null && <div className="dir-empty">Loading…</div>}
        {reviews === 'error' && <div className="dir-empty"><b>Couldn't load reviews</b>Refresh to try again.</div>}
        {Array.isArray(reviews) && reviews.length === 0 && (tab === 'approve' ? (
          <div className="dir-empty"><b>Nothing waiting for your approval</b>Changes submitted on pages you manage show up here.</div>
        ) : (
          <div className="dir-empty"><b>No review requests yet</b>Pages you submit for review show up here.</div>
        ))}
      </div>
    </div>
  );
}
