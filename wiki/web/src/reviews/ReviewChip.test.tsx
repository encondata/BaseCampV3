// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { longDate } from '@portal/lib/format';

import type { NodeReviewOut } from '../lib/types';
import { makeSpace } from '../testing/fixtures';
import ReviewChip, { isReviewDue, ReviewStatusChip, spaceReviewInterval, submitsForReview } from './ReviewChip';

const base: NodeReviewOut = {
  interval_months: 6, own_interval_months: null, next_review_at: '2026-10-03T12:00:00Z',
  last_reviewed_at: null, state: 'ok', pending_review_id: null,
};

afterEach(cleanup);

describe('ReviewChip', () => {
  it('says when a review falls due soon', () => {
    render(<ReviewChip review={{ ...base, state: 'due_soon' }} />);
    const chip = screen.getByText(`Review due ${longDate(base.next_review_at)}`);
    expect(chip.closest('.chip')!.className).toContain('c-amber');
  });

  it('says a review is overdue', () => {
    render(<ReviewChip review={{ ...base, state: 'overdue' }} />);
    expect(screen.getByText('Review overdue').closest('.chip')!.className).toContain('c-red');
  });

  it('shows nothing while a page is on schedule, unscheduled or not a page', () => {
    const { container, rerender } = render(<ReviewChip review={base} />);
    expect(container.textContent).toBe('');
    rerender(<ReviewChip review={{ ...base, state: null }} />);
    expect(container.textContent).toBe('');
    rerender(<ReviewChip review={null} />);
    expect(container.textContent).toBe('');
  });
});

describe('ReviewStatusChip', () => {
  it('names each status', () => {
    const { rerender } = render(<ReviewStatusChip status="pending" />);
    expect(screen.getByText('Pending')).toBeTruthy();
    rerender(<ReviewStatusChip status="approved" />);
    expect(screen.getByText('Approved')).toBeTruthy();
    rerender(<ReviewStatusChip status="rejected" />);
    expect(screen.getByText('Changes requested')).toBeTruthy();
    rerender(<ReviewStatusChip status="withdrawn" />);
    expect(screen.getByText('Withdrawn')).toBeTruthy();
  });
});

describe('review rules', () => {
  it('sends editors, not managers, through review where the space requires approval', () => {
    const strict = makeSpace({ settings: { require_approval: true } });
    expect(submitsForReview('edit', strict)).toBe(true);
    expect(submitsForReview('manage', strict)).toBe(false);
    expect(submitsForReview('edit', makeSpace())).toBe(false);
    expect(submitsForReview('edit', makeSpace({ settings: { require_approval: false } }))).toBe(false);
  });

  it('reads the space\'s review interval, none by default', () => {
    expect(spaceReviewInterval(makeSpace())).toBeNull();
    expect(spaceReviewInterval(makeSpace({ settings: { review_interval_months: 12 } }))).toBe(12);
  });

  it('counts a page as due when its review is due soon or overdue', () => {
    expect(isReviewDue({ ...base, state: 'due_soon' })).toBe(true);
    expect(isReviewDue({ ...base, state: 'overdue' })).toBe(true);
    expect(isReviewDue(base)).toBe(false);
    expect(isReviewDue(null)).toBe(false);
  });
});
