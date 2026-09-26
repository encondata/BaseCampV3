// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  listWatches: vi.fn(),
  unwatch: vi.fn(),
}));

import { listWatches, unwatch } from '../lib/wikiApi';
import WatchingPage from './WatchingPage';

function renderPage() {
  return render(
    <MemoryRouter initialEntries={['/watching']}>
      <Routes><Route path="/watching" element={<WatchingPage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  toast.mockReset();
  vi.mocked(listWatches).mockReset();
  vi.mocked(unwatch).mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('WatchingPage', () => {
  it('lists my node and space watches, and unwatches one', async () => {
    vi.mocked(listWatches).mockResolvedValue([
      { id: 'w1', node: { id: 'n1', title: 'Rack power', kind: 'page' }, space: { key: 'ops', name: 'Operations' }, created_at: '2026-09-20T00:00:00Z' },
      { id: 'w2', node: null, space: { key: 'facilities', name: 'Facilities' }, created_at: '2026-09-22T00:00:00Z' },
    ]);
    renderPage();
    const list = await screen.findByRole('list', { name: 'Watching' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByRole('link', { name: 'Rack power' }).getAttribute('href')).toBe('/n/n1');
    expect(within(rows[0]).getByText('Page')).toBeTruthy();
    expect(within(rows[1]).getByRole('link', { name: 'Facilities' }).getAttribute('href')).toBe('/s/facilities');
    expect(within(rows[1]).getByText('Space')).toBeTruthy();

    fireEvent.click(within(rows[0]).getByRole('button', { name: 'Stop watching Rack power' }));
    await waitFor(() => expect(unwatch).toHaveBeenCalledWith('w1'));
    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(1));
  });

  it('shows an empty state with nothing watched', async () => {
    vi.mocked(listWatches).mockResolvedValue([]);
    renderPage();
    expect(await screen.findByText('Nothing watched yet')).toBeTruthy();
  });

  it('reports a failed unwatch and keeps the row', async () => {
    vi.mocked(listWatches).mockResolvedValue([
      { id: 'w1', node: { id: 'n1', title: 'Rack power', kind: 'page' }, space: null, created_at: '2026-09-20T00:00:00Z' },
    ]);
    vi.mocked(unwatch).mockRejectedValue(new Error('nope'));
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: 'Stop watching Rack power' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Stop watching Rack power' })).toBeTruthy();
  });

  it('shows an error when the list fails to load', async () => {
    vi.mocked(listWatches).mockRejectedValue(new Error('nope'));
    renderPage();
    expect(await screen.findByText(/Couldn't load your watches/)).toBeTruthy();
  });
});
