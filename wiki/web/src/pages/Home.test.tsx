// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ person: { id: 'p-1' } }) }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getMe: vi.fn(),
  listSpaces: vi.fn(),
  listFavorites: vi.fn(),
  listRecent: vi.fn(),
  listDrafts: vi.fn(),
  listWatches: vi.fn(),
}));

import { resetTreeStore } from '../lib/treeStore';
import { clearWikiMe } from '../lib/useWikiMe';
import {
  getMe, listDrafts, listFavorites, listRecent, listSpaces, listWatches,
} from '../lib/wikiApi';
import { makeMe, makeNode, makeSpace } from '../testing/fixtures';
import Home from './Home';

beforeEach(() => {
  clearWikiMe();
  resetTreeStore();
  vi.mocked(listSpaces).mockResolvedValue([
    makeSpace(),
    makeSpace({ id: 'space-2', key: 'sales', name: 'Sales', description: 'Pitch decks', icon: null }),
  ]);
  vi.mocked(listFavorites).mockResolvedValue([makeNode('fav', { title: 'Rack standards' })]);
  vi.mocked(listRecent).mockResolvedValue([makeNode('rec', { title: 'Cutover plan' })]);
  vi.mocked(listDrafts).mockResolvedValue([makeNode('dr', { title: 'Half-done guide' })]);
  vi.mocked(listWatches).mockResolvedValue([
    { id: 'w1', node: { id: 'wpg', title: 'Runbook', kind: 'page' }, space: { key: 'ops', name: 'Operations' }, created_at: '2026-09-20T00:00:00Z' },
    { id: 'w2', node: null, space: { key: 'facilities', name: 'Facilities' }, created_at: '2026-09-21T00:00:00Z' },
  ]);
});
afterEach(cleanup);

function renderHome() {
  return render(<MemoryRouter><Home /></MemoryRouter>);
}

describe('Home', () => {
  it('lists the spaces as cards linking to each space', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe());
    renderHome();
    const grid = await screen.findByRole('list', { name: 'Spaces' });
    const ops = await within(grid).findByRole('link', { name: /Operations/ });
    expect(ops.getAttribute('href')).toBe('/s/ops');
    expect(within(grid).getByText('How we run moves')).toBeTruthy();
    expect(within(grid).getByRole('link', { name: /Sales/ }).getAttribute('href')).toBe('/s/sales');
  });

  it('hides the New space card from someone who can\'t create spaces', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ can_create_spaces: false }));
    renderHome();
    await screen.findByRole('link', { name: /Operations/ });
    await vi.waitFor(() => expect(getMe).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /New space/ })).toBeNull();
  });

  it('offers the New space card to a creator', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ can_create_spaces: true }));
    renderHome();
    const card = await screen.findByRole('link', { name: /New space/ });
    expect(card.getAttribute('href')).toBe('/spaces/new');
  });

  it('shows favorites, the ten most recently updated, and my drafts', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe());
    renderHome();
    expect(await screen.findByRole('link', { name: /Rack standards/ })).toBeTruthy();
    expect(await screen.findByRole('link', { name: /Cutover plan/ })).toBeTruthy();
    expect(await screen.findByRole('link', { name: /Half-done guide/ })).toBeTruthy();
    expect(listRecent).toHaveBeenCalledWith({ limit: 10 });
    expect(screen.getByRole('link', { name: /Cutover plan/ }).getAttribute('href')).toBe('/n/rec');
  });

  it('shows a Watching section with a link and a see-all link', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe());
    renderHome();
    const section = await screen.findByRole('region', { name: 'Watching' });
    expect(within(section).getByRole('link', { name: /Runbook/ }).getAttribute('href')).toBe('/n/wpg');
    expect(within(section).getByRole('link', { name: /Facilities/ }).getAttribute('href')).toBe('/s/facilities');
    expect(within(section).getByRole('link', { name: 'See all watching' }).getAttribute('href')).toBe('/watching');
  });
});
