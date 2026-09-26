// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ person: { id: 'p-1' } }) }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getMe: vi.fn(),
  listSpaces: vi.fn(),
  getAnalytics: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import type { AnalyticsOut } from '../lib/types';
import { clearWikiMe } from '../lib/useWikiMe';
import { getAnalytics, getMe, listSpaces } from '../lib/wikiApi';
import { makeMe, makeSpace } from '../testing/fixtures';
import AnalyticsPage from './AnalyticsPage';

const ref = (id: string, title: string, kind: 'page' | 'file' = 'page') => ({ id, title, kind, space_key: 'ops' });

function days(n: number, views: (i: number) => number = () => 0) {
  return Array.from({ length: n }, (_, i) => ({
    day: new Date(Date.UTC(2026, 8, 26 - (n - 1 - i))).toISOString().slice(0, 10),
    views: views(i),
  }));
}

function analytics(over: Partial<AnalyticsOut> = {}): AnalyticsOut {
  return {
    space_key: null,
    days: 30,
    top_pages: [
      { node: ref('n1', 'Rack power'), views: 42, viewers: 7 },
      { node: ref('n2', 'floorplan.pdf', 'file'), views: 5, viewers: 2 },
    ],
    views_by_day: days(30, (i) => (i === 29 ? 12 : 1)),
    helpfulness: [{ node: ref('n1', 'Rack power'), yes: 2, no: 1, pct: 67 }],
    recent_no_comments: [{ node: ref('n1', 'Rack power'), comment: 'The steps skip the login.', at: '2026-09-25T10:00:00Z' }],
    failed_searches: [{ query: 'pallet jack', count: 4, last_at: '2026-09-25T09:00:00Z' }],
    stale_pages: [{ node: ref('n3', 'Old checklist'), updated_at: '2025-01-02T00:00:00Z' }],
    overdue_reviews: [{ node: ref('n4', 'Truck loading'), next_review_at: '2026-09-01T00:00:00Z' }],
    ...over,
  };
}

function Probe() {
  const loc = useLocation();
  return <div data-testid="probe">{loc.pathname}{loc.search}</div>;
}

function renderPage(path = '/analytics') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/analytics" element={<><AnalyticsPage /><Probe /></>} /></Routes>
    </MemoryRouter>,
  );
}

const OPS = makeSpace({ id: 's1', key: 'ops', name: 'Operations', my_level: 'manage' });
const GUIDES = makeSpace({ id: 's2', key: 'guides', name: 'Guides', my_level: 'view' });
const HR = makeSpace({ id: 's3', key: 'hr', name: 'People Ops', my_level: 'manage' });

beforeEach(() => {
  clearWikiMe();
  vi.mocked(getMe).mockReset().mockResolvedValue(makeMe({ is_admin: true }));
  vi.mocked(listSpaces).mockReset().mockResolvedValue([OPS, GUIDES, HR]);
  vi.mocked(getAnalytics).mockReset().mockResolvedValue(analytics());
});
afterEach(cleanup);

describe('AnalyticsPage — who sees it', () => {
  it('is not found for someone who is neither an admin nor a space manager', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: false }));
    vi.mocked(listSpaces).mockResolvedValue([GUIDES]);
    renderPage();
    expect(await screen.findByText('Nothing here')).toBeTruthy();
    expect(getAnalytics).not.toHaveBeenCalled();
  });

  it('opens a space manager on the first space they manage, with only those to pick from', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: false }));
    vi.mocked(getAnalytics).mockResolvedValue(analytics({ space_key: 'ops', failed_searches: [] }));
    renderPage();
    await waitFor(() => expect(getAnalytics).toHaveBeenCalledWith({ space: 'ops', days: 30 }));
    const combo = await screen.findByRole('combobox', { name: 'Library' });
    fireEvent.focus(combo);
    expect(screen.queryByRole('button', { name: 'Guides' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'All libraries' })).toBeNull();
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'People Ops' }));
    await waitFor(() => expect(getAnalytics).toHaveBeenLastCalledWith({ space: 'hr', days: 30 }));
    expect(screen.getByTestId('probe').textContent).toBe('/analytics?library=hr');
    // searches aren't tied to a space: managers don't get that card
    expect(screen.queryByRole('region', { name: 'Searches with no results' })).toBeNull();
  });
});

describe('AnalyticsPage — the numbers', () => {
  it('shows every card for an admin over all spaces', async () => {
    renderPage();
    await waitFor(() => expect(getAnalytics).toHaveBeenCalledWith({ space: undefined, days: 30 }));
    expect(listSpaces).toHaveBeenCalledWith(true);

    const views = await screen.findByRole('region', { name: 'Views over time' });
    expect(within(views).getByText('41')).toBeTruthy();                   // total views
    const chart = within(views).getByRole('img');
    expect(chart.getAttribute('aria-label')).toMatch(/41 views over the last 30 days/);
    expect(chart.querySelectorAll('rect[data-day]')).toHaveLength(30);

    const top = screen.getByRole('region', { name: 'Top pages' });
    const rows = within(top).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('link', { name: 'Rack power' }).getAttribute('href')).toBe('/n/n1');
    expect(within(rows[0]).getByText('42')).toBeTruthy();
    expect(within(rows[0]).getByText('7')).toBeTruthy();

    const helpful = screen.getByRole('region', { name: 'Helpfulness' });
    expect(within(helpful).getByText('67%')).toBeTruthy();
    expect(within(helpful).getByRole('meter', { name: 'Rack power: 67% found it helpful' })).toBeTruthy();

    const comments = screen.getByRole('region', { name: 'Recent “No” comments' });
    expect(within(comments).getByText('The steps skip the login.')).toBeTruthy();

    const failed = screen.getByRole('region', { name: 'Searches with no results' });
    expect(within(failed).getByText('pallet jack')).toBeTruthy();
    expect(within(failed).getByText('4')).toBeTruthy();

    const stale = screen.getByRole('region', { name: 'Stale pages' });
    expect(within(stale).getByRole('link', { name: 'Old checklist' }).getAttribute('href')).toBe('/n/n3');

    const overdue = screen.getByRole('region', { name: 'Overdue reviews' });
    expect(within(overdue).getByRole('link', { name: 'Truck loading' })).toBeTruthy();
  });

  it('switches the window and the space, and keeps both in the URL', async () => {
    renderPage();
    await waitFor(() => expect(getAnalytics).toHaveBeenCalledTimes(1));
    vi.mocked(getAnalytics).mockResolvedValue(analytics({ days: 90, views_by_day: days(90) }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Period' })).getByRole('button', { name: '90 days' }));
    await waitFor(() => expect(getAnalytics).toHaveBeenLastCalledWith({ space: undefined, days: 90 }));
    expect(screen.getByTestId('probe').textContent).toBe('/analytics?days=90');

    const combo = await screen.findByRole('combobox', { name: 'Library' });
    fireEvent.focus(combo);
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'Guides' }));
    await waitFor(() => expect(getAnalytics).toHaveBeenLastCalledWith({ space: 'guides', days: 90 }));
    expect(screen.getByTestId('probe').textContent).toBe('/analytics?days=90&library=guides');
  });

  it('reads the window and library from the URL', async () => {
    renderPage('/analytics?library=ops&days=7');
    await waitFor(() => expect(getAnalytics).toHaveBeenCalledWith({ space: 'ops', days: 7 }));
  });

  it('turns an old ?space= link into ?library=', async () => {
    renderPage('/analytics?space=ops&days=7');
    await waitFor(() => expect(getAnalytics).toHaveBeenCalledWith({ space: 'ops', days: 7 }));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/analytics?days=7&library=ops'));
    expect(getAnalytics).not.toHaveBeenCalledWith(expect.objectContaining({ space: undefined }));
  });

  it('shows friendly empty states', async () => {
    vi.mocked(getAnalytics).mockResolvedValue(analytics({
      top_pages: [], views_by_day: days(30), helpfulness: [], recent_no_comments: [],
      failed_searches: [], stale_pages: [], overdue_reviews: [],
    }));
    renderPage();
    expect(await screen.findByText('No views in this period.')).toBeTruthy();
    expect(screen.getByText('Nobody has rated a page in this period.')).toBeTruthy();
    expect(screen.getByText('No comments in this period.')).toBeTruthy();
    expect(screen.getByText('Every search found something.')).toBeTruthy();
    expect(screen.getByText('Every published page was updated in the last year.')).toBeTruthy();
    expect(screen.getByText('No reviews are overdue.')).toBeTruthy();
  });

  it('shows an error when the numbers can\'t be loaded', async () => {
    vi.mocked(getAnalytics).mockRejectedValue(new ApiError(500, 'boom'));
    renderPage();
    expect(await screen.findByText('Couldn\'t load the analytics.')).toBeTruthy();
  });
});
