// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  search: vi.fn(),
  listSpaces: vi.fn(),
}));

import { listSpaces, search } from '../lib/wikiApi';
import { makeSearchHit, makeSpace } from '../testing/fixtures';
import SearchPage from './SearchPage';

function Probe() {
  const loc = useLocation();
  return <div data-testid="probe">{loc.pathname}{loc.search}</div>;
}

function renderPage(path = '/search?q=rack') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/search" element={<><SearchPage /><Probe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(search).mockReset().mockResolvedValue([]);
  vi.mocked(listSpaces).mockReset().mockResolvedValue([
    makeSpace({ id: 'space-1', key: 'ops', name: 'Operations' }),
    makeSpace({ id: 'space-2', key: 'guides', name: 'Guides' }),
  ]);
});
afterEach(cleanup);

describe('SearchPage', () => {
  it('searches with the default (no) filters and lists hits with breadcrumbs and snippet', async () => {
    vi.mocked(search).mockResolvedValue([makeSearchHit({
      node: { id: 'n1', kind: 'page', title: 'Rack power', space_key: 'ops', space_name: 'Operations' },
      breadcrumbs: ['Guides'],
      snippet_html: 'How to wire the <mark>rack</mark> power.',
    })]);
    renderPage();
    await waitFor(() => expect(search).toHaveBeenCalledWith({ q: 'rack', space: undefined, kind: undefined, limit: 50 }));
    expect(await screen.findByText('Rack power')).toBeTruthy();
    expect(screen.getByText('Operations / Guides')).toBeTruthy();
    const snippet = document.querySelector('.wiki-search-snippet') as HTMLElement;
    expect(snippet.innerHTML).toBe('How to wire the <mark>rack</mark> power.');
    expect(screen.getByRole('link', { name: /Rack power/ }).getAttribute('href')).toBe('/n/n1');
  });

  it('shows "No results for …" for a query with no hits', async () => {
    renderPage('/search?q=nothing');
    expect(await screen.findByText('No results for “nothing”.')).toBeTruthy();
  });

  it('prompts without searching when there is no query yet', async () => {
    renderPage('/search');
    await waitFor(() => expect(listSpaces).toHaveBeenCalled());
    expect(search).not.toHaveBeenCalled();
    expect(screen.getByText('Type in the search box above to find pages, files and folders.')).toBeTruthy();
  });

  it('filters by kind and updates the URL', async () => {
    renderPage();
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    fireEvent.click(within(screen.getByRole('group', { name: 'Type' })).getByRole('button', { name: 'Pages' }));
    await waitFor(() => expect(search).toHaveBeenCalledWith({ q: 'rack', space: undefined, kind: 'page', limit: 50 }));
    expect(screen.getByTestId('probe').textContent).toBe('/search?q=rack&kind=page');
  });

  it('filters by space and updates the URL', async () => {
    renderPage();
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    const combo = await screen.findByRole('combobox', { name: 'Library' });
    fireEvent.focus(combo);
    fireEvent.mouseDown(await screen.findByRole('button', { name: 'Guides' }));
    await waitFor(() => expect(search).toHaveBeenCalledWith({ q: 'rack', space: 'guides', kind: undefined, limit: 50 }));
    expect(screen.getByTestId('probe').textContent).toBe('/search?q=rack&library=guides');
  });

  it('reads the library from the URL, and turns an old ?space= link into ?library=', async () => {
    renderPage('/search?q=rack&space=guides');
    await waitFor(() => expect(search).toHaveBeenCalledWith({ q: 'rack', space: 'guides', kind: undefined, limit: 50 }));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/search?q=rack&library=guides'));
    expect(search).not.toHaveBeenCalledWith(expect.objectContaining({ space: undefined }));
  });
});
