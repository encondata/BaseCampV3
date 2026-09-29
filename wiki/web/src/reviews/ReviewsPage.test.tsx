// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  listReviews: vi.fn(),
}));

import type { ReviewListParams, ReviewOut } from '../lib/types';
import { listReviews } from '../lib/wikiApi';
import { makeReview } from '../testing/fixtures';
import ReviewsPage from './ReviewsPage';

function Probe() {
  const loc = useLocation();
  return <div data-testid="probe">{loc.pathname}{loc.search}</div>;
}

function renderPage(path = '/reviews') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/reviews" element={<><ReviewsPage /><Probe /></>} /></Routes>
    </MemoryRouter>,
  );
}

const toApprove = [
  makeReview({ id: 'r1', node: { id: 'p1', title: 'Rack power', space_key: 'ops', space_name: 'Operations' } }),
];
const mine: Record<string, ReviewOut[]> = {
  pending: [makeReview({ id: 'm1', created_at: '2026-09-24T10:00:00Z', node: { id: 'p2', title: 'Cabling', space_key: 'ops', space_name: 'Operations' } })],
  approved: [makeReview({ id: 'm2', status: 'approved', created_at: '2026-09-25T10:00:00Z', node: { id: 'p3', title: 'Badges', space_key: 'ops', space_name: 'Operations' } })],
  rejected: [makeReview({ id: 'm3', status: 'rejected', created_at: '2026-09-23T10:00:00Z', node: { id: 'p4', title: 'Lifts', space_key: 'ops', space_name: 'Operations' } })],
  withdrawn: [],
};

beforeEach(() => {
  vi.mocked(listReviews).mockReset().mockImplementation(async ({ status, mine: who }: ReviewListParams = {}) => (
    who === 'approver' ? toApprove : mine[status ?? 'pending']));
});
afterEach(cleanup);

describe('ReviewsPage', () => {
  it('lists the pending reviews waiting on me, linking to each', async () => {
    renderPage();
    const list = await screen.findByRole('list', { name: 'To approve' });
    const rows = await within(list).findAllByRole('listitem');
    expect(rows).toHaveLength(1);
    expect(listReviews).toHaveBeenCalledWith({ status: 'pending', mine: 'approver' });
    expect(within(rows[0]).getByRole('link', { name: 'Rack power' }).getAttribute('href')).toBe('/reviews/r1');
    expect(within(rows[0]).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(rows[0]).getByText('Operations')).toBeTruthy();
    expect(within(rows[0]).getByText('Updated the breaker list')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'To approve' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('shows my own requests of every status, newest first, with their status', async () => {
    renderPage();
    await screen.findByRole('list', { name: 'To approve' });
    fireEvent.click(screen.getByRole('button', { name: 'My requests' }));
    expect(screen.getByTestId('probe').textContent).toBe('/reviews?tab=mine');
    const list = await screen.findByRole('list', { name: 'My requests' });
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(3));
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('b')?.textContent)).toEqual(['Badges', 'Cabling', 'Lifts']);
    expect(within(rows[0]).getByText('Approved')).toBeTruthy();
    expect(within(rows[1]).getByText('Pending')).toBeTruthy();
    expect(within(rows[2]).getByText('Changes requested')).toBeTruthy();
    for (const status of ['pending', 'approved', 'rejected', 'withdrawn']) {
      expect(listReviews).toHaveBeenCalledWith({ status, mine: 'requester' });
    }
  });

  it('opens on my requests from ?tab=mine', async () => {
    renderPage('/reviews?tab=mine');
    expect(await screen.findByRole('list', { name: 'My requests' })).toBeTruthy();
  });

  it('says when nothing waits on me', async () => {
    vi.mocked(listReviews).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('Nothing waiting for your approval')).toBeTruthy();
  });

  it('says when the list can\'t load', async () => {
    vi.mocked(listReviews).mockRejectedValue(new Error('nope'));
    renderPage();
    expect(await screen.findByText('Couldn\'t load reviews')).toBeTruthy();
  });
});
