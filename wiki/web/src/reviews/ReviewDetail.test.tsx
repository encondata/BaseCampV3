// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ person: { id: 'p-1', display_name: 'Jimmy Henderson' } }),
}));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getMe: vi.fn(),
  getReview: vi.fn(),
  getNode: vi.fn(),
  approveReview: vi.fn(),
  rejectReview: vi.fn(),
  withdrawReview: vi.fn(),
  listReviews: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import type { Level, ReviewDetail as ReviewDetailOut } from '../lib/types';
import { clearWikiMe } from '../lib/useWikiMe';
import {
  approveReview, getMe, getNode, getReview, rejectReview, withdrawReview,
} from '../lib/wikiApi';
import { makeDetail, makeMe, makeReview, makeReviewDetail } from '../testing/fixtures';
import ReviewDetail from './ReviewDetail';

function Probe() {
  const loc = useLocation();
  return <div data-testid="probe">{loc.pathname}{loc.search}</div>;
}

function renderDetail(review: ReviewDetailOut, level: Level | null = 'manage', from?: string) {
  vi.mocked(getReview).mockResolvedValue(review);
  vi.mocked(getNode).mockResolvedValue(makeDetail('p1', { title: 'Rack power', my_level: level }));
  const entries = from ? [from, `/reviews/${review.id}`] : [`/reviews/${review.id}`];
  return render(
    <MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
      <Routes>
        <Route path="/reviews/:reviewId" element={<ReviewDetail />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  clearWikiMe();
  toast.mockReset();
  vi.mocked(getMe).mockResolvedValue(makeMe());
  vi.mocked(approveReview).mockReset();
  vi.mocked(rejectReview).mockReset();
  vi.mocked(withdrawReview).mockReset();
});
afterEach(cleanup);

describe('ReviewDetail', () => {
  it('shows who asked, their note, and the diff from the published page to the submitted one', async () => {
    renderDetail(makeReviewDetail());
    expect((await screen.findByRole('link', { name: 'Rack power' })).getAttribute('href')).toBe('/n/p1');
    expect(screen.getByText(/Requested by Ada Lovelace/)).toBeTruthy();
    expect(screen.getByText('Updated the breaker list')).toBeTruthy();
    expect(screen.getByText('Pending')).toBeTruthy();
    const diff = screen.getByTestId('diff-view');
    expect(diff.textContent).toContain('the published page');
    expect(diff.textContent).toContain('version 5 (submitted)');
    expect(diff.querySelector('.wiki-diff-block.change')!.textContent).toContain('New');
    expect(diff.querySelector('.wiki-diff-block.change del')!.textContent).toContain('Old');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('diffs against nothing for a page never published', async () => {
    renderDetail(makeReviewDetail({ published_version_id: null, published_content: null }));
    const diff = await screen.findByTestId('diff-view');
    expect(diff.textContent).toContain('nothing published yet');
    expect(diff.querySelector('.wiki-diff-block.add')!.textContent).toContain('New words');
  });

  it('warns when the page was published after the request', async () => {
    renderDetail(makeReviewDetail({ stale: true }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'This page was published after this review was submitted. Approving will replace the newer published version.');
  });

  it('lets a manager approve, with an optional note, then goes back with a toast', async () => {
    vi.mocked(approveReview).mockResolvedValue(makeReview({ status: 'approved' }));
    renderDetail(makeReviewDetail(), 'manage', '/reviews');
    fireEvent.change(await screen.findByLabelText(/Note to the requester/), { target: { value: ' Looks right ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve and publish' }));
    await waitFor(() => expect(approveReview).toHaveBeenCalledWith('r1', 'Looks right'));
    expect(toast).toHaveBeenCalledWith('Approved — “Rack power” is published.');
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/reviews'));
  });

  it('asks for a note before requesting changes', async () => {
    vi.mocked(rejectReview).mockResolvedValue(makeReview({ status: 'rejected' }));
    renderDetail(makeReviewDetail(), 'manage');
    fireEvent.click(await screen.findByRole('button', { name: 'Request changes' }));
    expect(screen.getByText('Say what needs to change.')).toBeTruthy();
    expect(rejectReview).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText(/Note to the requester/), { target: { value: 'Add the PDU list' } });
    fireEvent.click(screen.getByRole('button', { name: 'Request changes' }));
    await waitFor(() => expect(rejectReview).toHaveBeenCalledWith('r1', 'Add the PDU list'));
    expect(toast).toHaveBeenCalledWith('Changes requested on “Rack power”.');
    // opened straight from a link: back to the queue
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/reviews'));
  });

  it('shows why a decision was refused', async () => {
    vi.mocked(approveReview).mockRejectedValue(new ApiError(409, 'not_pending', undefined, 'This review was already withdrawn.'));
    renderDetail(makeReviewDetail(), 'manage');
    fireEvent.click(await screen.findByRole('button', { name: 'Approve and publish' }));
    expect(await screen.findByText('This review was already withdrawn.')).toBeTruthy();
    expect(screen.queryByTestId('probe')).toBeNull();
  });

  it('lets the requester withdraw, but not decide', async () => {
    vi.mocked(withdrawReview).mockResolvedValue(makeReview({ status: 'withdrawn' }));
    renderDetail(makeReviewDetail({ requested_by: { id: 'p-1', name: 'Jimmy Henderson' } }), 'edit');
    fireEvent.click(await screen.findByRole('button', { name: 'Withdraw request' }));
    await waitFor(() => expect(withdrawReview).toHaveBeenCalledWith('r1'));
    expect(toast).toHaveBeenCalledWith('Review request withdrawn.');
    expect(screen.queryByRole('button', { name: 'Approve and publish' })).toBeNull();
  });

  it('offers editors who aren\'t the requester nothing to do', async () => {
    renderDetail(makeReviewDetail(), 'edit');
    await screen.findByTestId('diff-view');
    expect(screen.queryByRole('button', { name: 'Approve and publish' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Withdraw request' })).toBeNull();
  });

  it('shows a decided review\'s decision and no actions', async () => {
    renderDetail(makeReviewDetail({
      status: 'rejected', decided_by: { id: 'p-3', name: 'Grace Hopper' }, decided_at: '2026-09-21T12:00:00Z',
      decision_note: 'Add the PDU list',
    }), 'manage');
    const decision = await screen.findByRole('region', { name: 'Decision' });
    expect(within(decision).getByText(/Grace Hopper/)).toBeTruthy();
    expect(within(decision).getByText('Add the PDU list')).toBeTruthy();
    expect(screen.getByText('Changes requested')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve and publish' })).toBeNull();
  });

  it('is not found when the review isn\'t there', async () => {
    vi.mocked(getReview).mockRejectedValue(new ApiError(404, 'not_found'));
    render(
      <MemoryRouter initialEntries={['/reviews/nope']}>
        <Routes><Route path="/reviews/:reviewId" element={<ReviewDetail />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText(/This review doesn't exist/)).toBeTruthy();
  });
});
