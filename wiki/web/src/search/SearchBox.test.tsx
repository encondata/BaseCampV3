// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  search: vi.fn(),
}));

import { search } from '../lib/wikiApi';
import { makeSearchHit } from '../testing/fixtures';
import SearchBox from './SearchBox';

function Probe() {
  const loc = useLocation();
  return <div data-testid="probe">{loc.pathname}{loc.search}</div>;
}

function renderBox() {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <SearchBox />
      <Probe />
    </MemoryRouter>,
  );
}

const type = (text: string) => fireEvent.change(screen.getByLabelText('Search the wiki'), { target: { value: text } });

beforeEach(() => {
  vi.mocked(search).mockReset().mockResolvedValue([]);
});
afterEach(cleanup);

describe('SearchBox', () => {
  it('debounces the query, searching the top 8 and showing icon, space, breadcrumbs and snippet', async () => {
    const hit = makeSearchHit({
      node: { id: 'n1', kind: 'page', title: 'Rack power', space_key: 'ops', space_name: 'Operations' },
      breadcrumbs: ['Guides'],
      snippet_html: 'How to wire the <mark>rack</mark> power.',
    });
    vi.mocked(search).mockResolvedValue([hit]);
    renderBox();
    type('rack');
    expect(search).not.toHaveBeenCalled();
    await waitFor(() => expect(search).toHaveBeenCalledWith({ q: 'rack', limit: 8 }));

    expect(await screen.findByText('Rack power')).toBeTruthy();
    expect(screen.getByText('Operations / Guides')).toBeTruthy();
    const snippet = document.querySelector('.wiki-search-hit-snippet') as HTMLElement;
    expect(snippet.innerHTML).toBe('How to wire the <mark>rack</mark> power.');
  });

  it('renders a snippet with escaped markup as plain text, never as a real element', async () => {
    vi.mocked(search).mockResolvedValue([makeSearchHit({
      snippet_html: 'See &lt;img src=x onerror="globalThis.__pwned = 1"&gt; here',
    })]);
    renderBox();
    type('rack');
    await waitFor(() => expect(search).toHaveBeenCalled());
    const snippet = await screen.findByText(/See <img/);
    expect(snippet.querySelector('img')).toBeNull();
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('moves through hits with the arrow keys and opens the highlighted one on Enter', async () => {
    vi.mocked(search).mockResolvedValue([
      makeSearchHit({ node: { id: 'n1', kind: 'page', title: 'First', space_key: 'ops', space_name: 'Operations' } }),
      makeSearchHit({ node: { id: 'n2', kind: 'page', title: 'Second', space_key: 'ops', space_name: 'Operations' } }),
    ]);
    renderBox();
    type('r');
    await screen.findByText('First');
    const input = screen.getByLabelText('Search the wiki');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByTestId('probe').textContent).toBe('/n/n2');
  });

  it('opens the full results page on Enter when nothing is highlighted', async () => {
    renderBox();
    type('rack power');
    await waitFor(() => expect(search).toHaveBeenCalled());
    fireEvent.keyDown(screen.getByLabelText('Search the wiki'), { key: 'Enter' });
    expect(screen.getByTestId('probe').textContent).toBe('/search?q=rack%20power');
  });

  it('closes the dropdown on Escape', async () => {
    vi.mocked(search).mockResolvedValue([makeSearchHit()]);
    renderBox();
    type('rack');
    await screen.findByText('Rack power');
    fireEvent.keyDown(screen.getByLabelText('Search the wiki'), { key: 'Escape' });
    expect(screen.queryByText('Rack power')).toBeNull();
  });

  it('focuses on Ctrl/Cmd+K', () => {
    renderBox();
    const input = screen.getByLabelText('Search the wiki') as HTMLInputElement;
    fireEvent.keyDown(document, { key: 'k', ctrlKey: true });
    expect(document.activeElement).toBe(input);
  });

  it('shows "No results for …" when nothing comes back', async () => {
    renderBox();
    type('nothing');
    await waitFor(() => expect(search).toHaveBeenCalled());
    expect(await screen.findByText('No results for “nothing”.')).toBeTruthy();
  });
});
