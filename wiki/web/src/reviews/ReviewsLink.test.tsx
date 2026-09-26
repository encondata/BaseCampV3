// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  listReviews: vi.fn(),
}));

import { listReviews } from '../lib/wikiApi';
import { makeReview } from '../testing/fixtures';
import ReviewsLink, { noteReviewsChanged, POLL_MS } from './ReviewsLink';

let visibility: DocumentVisibilityState = 'visible';

beforeEach(() => {
  visibility = 'visible';
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => visibility });
  vi.mocked(listReviews).mockReset().mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderLink() {
  return render(<MemoryRouter><ReviewsLink /></MemoryRouter>);
}

describe('ReviewsLink', () => {
  it('always links to the reviews queue, with no badge while nothing waits', async () => {
    renderLink();
    const link = screen.getByRole('link', { name: 'Reviews' });
    expect(link.getAttribute('href')).toBe('/reviews');
    await waitFor(() => expect(listReviews).toHaveBeenCalledWith({ status: 'pending', mine: 'approver' }));
    expect(document.querySelector('.wiki-count-badge')).toBeNull();
  });

  it('counts the reviews waiting on me', async () => {
    vi.mocked(listReviews).mockResolvedValue([makeReview(), makeReview({ id: 'r2' })]);
    renderLink();
    expect(await screen.findByRole('link', { name: 'Reviews (2 waiting for you)' })).toBeTruthy();
    expect(document.querySelector('.wiki-count-badge')!.textContent).toBe('2');
  });

  it('polls every minute while the tab is visible, and catches up when it shows again', async () => {
    vi.useFakeTimers();
    renderLink();
    await act(async () => { await Promise.resolve(); });
    expect(listReviews).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS); });
    expect(listReviews).toHaveBeenCalledTimes(2);

    visibility = 'hidden';
    await act(async () => { await vi.advanceTimersByTimeAsync(POLL_MS * 3); });
    expect(listReviews).toHaveBeenCalledTimes(2);

    visibility = 'visible';
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(listReviews).toHaveBeenCalledTimes(3);
  });

  it('recounts when a review is decided or submitted here', async () => {
    renderLink();
    await waitFor(() => expect(listReviews).toHaveBeenCalledTimes(1));
    vi.mocked(listReviews).mockResolvedValue([makeReview()]);
    act(() => { noteReviewsChanged(); });
    expect(await screen.findByRole('link', { name: 'Reviews (1 waiting for you)' })).toBeTruthy();
  });
});
