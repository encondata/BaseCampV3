/** Review chips — a page's place in its periodic review cycle ("Review
 *  due <date>", "Review overdue") and a review request's status — and the
 *  few rules the UI reads from a space's settings. */
import { longDate } from '@portal/lib/format';

import { atLeast } from '../components/RowMenu';
import type { Level, NodeReviewOut, ReviewStatus, SpaceOut } from '../lib/types';

/** Whether a publish by someone at `level` goes through review instead:
 *  the space requires approval and they don't manage the page (managers
 *  are its approvers, and publish directly). */
export function submitsForReview(level: Level | null | undefined, space: SpaceOut): boolean {
  return space.settings.require_approval === true && !atLeast(level, 'manage');
}

/** The space's default review interval in months; null when it has none. */
export function spaceReviewInterval(space: SpaceOut): number | null {
  const v = space.settings.review_interval_months;
  return typeof v === 'number' ? v : null;
}

/** Whether the page's review is due soon or overdue. */
export function isReviewDue(review: NodeReviewOut | null | undefined): boolean {
  return review?.state === 'due_soon' || review?.state === 'overdue';
}

/** "Review due <date>" / "Review overdue"; nothing while the page is on schedule. */
export default function ReviewChip({ review }: { review: NodeReviewOut | null | undefined }) {
  if (review?.state === 'overdue') {
    return <span className="chip c-red wiki-review-chip"><span className="dot" />Review overdue</span>;
  }
  if (review?.state === 'due_soon') {
    return (
      <span className="chip c-amber wiki-review-chip" title={review.next_review_at
        ? new Date(review.next_review_at).toLocaleString() : undefined}>
        <span className="dot" />Review due {longDate(review.next_review_at)}
      </span>
    );
  }
  return null;
}

const STATUS: Record<ReviewStatus, { label: string; color: string }> = {
  pending: { label: 'Pending', color: 'c-amber' },
  approved: { label: 'Approved', color: 'c-green' },
  rejected: { label: 'Changes requested', color: 'c-red' },
  withdrawn: { label: 'Withdrawn', color: 'c-slate' },
};

export function ReviewStatusChip({ status }: { status: ReviewStatus }) {
  const { label, color } = STATUS[status];
  return <span className={`chip ${color}`}><span className="dot" />{label}</span>;
}
