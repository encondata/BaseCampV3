// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getSpace: vi.fn(),
  listDueReviews: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';
import { longDate } from '@portal/lib/format';

import type { NodeReviewOut } from '../lib/types';
import { getSpace, listDueReviews } from '../lib/wikiApi';
import { makeNode, makeSpace } from '../testing/fixtures';
import DueReviewsPage from './DueReviewsPage';

const due = (over: Partial<NodeReviewOut>): NodeReviewOut => ({
  interval_months: 6, own_interval_months: null, next_review_at: '2026-10-01T12:00:00Z',
  last_reviewed_at: null, state: 'due_soon', pending_review_id: null, ...over,
});

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/s/ops/due']}>
      <Routes><Route path="/s/:spaceKey/due" element={<DueReviewsPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getSpace).mockReset().mockResolvedValue(makeSpace());
  vi.mocked(listDueReviews).mockReset();
});
afterEach(cleanup);

describe('DueReviewsPage', () => {
  it('lists the space\'s pages due for review with their state', async () => {
    vi.mocked(listDueReviews).mockResolvedValue([
      makeNode('p1', { title: 'Rack power', owner: { id: 'p-2', name: 'Ada Lovelace' },
        review: due({ state: 'overdue', next_review_at: '2026-09-01T12:00:00Z', last_reviewed_at: '2026-03-01T12:00:00Z' }) }),
      makeNode('p2', { title: 'Cabling', review: due({}) }),
    ]);
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Due for review' })).toBeTruthy();
    expect(listDueReviews).toHaveBeenCalledWith('ops');
    expect(screen.getByRole('link', { name: 'Operations' }).getAttribute('href')).toBe('/s/ops');
    const rows = within(await screen.findByRole('list', { name: 'Due for review' })).getAllByRole('listitem');
    expect(within(rows[0]).getByRole('link', { name: 'Rack power' }).getAttribute('href')).toBe('/n/p1');
    expect(within(rows[0]).getByText('Review overdue')).toBeTruthy();
    expect(within(rows[0]).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(rows[0]).getByText(longDate('2026-03-01T12:00:00Z'))).toBeTruthy();
    expect(within(rows[1]).getByText(`Review due ${longDate('2026-10-01T12:00:00Z')}`)).toBeTruthy();
    expect(within(rows[1]).getByText('Never')).toBeTruthy();
  });

  it('says when nothing is due', async () => {
    vi.mocked(listDueReviews).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('Nothing due for review')).toBeTruthy();
  });

  it('is not found for a space that isn\'t there', async () => {
    vi.mocked(getSpace).mockRejectedValue(new ApiError(404, 'not_found'));
    vi.mocked(listDueReviews).mockRejectedValue(new ApiError(404, 'not_found'));
    renderPage();
    expect(await screen.findByText(/This space doesn't exist/)).toBeTruthy();
  });
});
