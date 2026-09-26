// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => vi.fn() }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getTree: vi.fn(),
  listFavorites: vi.fn(),
  listRecent: vi.fn(),
}));

import { resetTreeStore } from '../lib/treeStore';
import { getTree, listFavorites, listRecent } from '../lib/wikiApi';
import { makeNode, makeSpace } from '../testing/fixtures';
import Sidebar from './Sidebar';

const SPACES = [makeSpace(), makeSpace({ id: 'space-2', key: 'sales', name: 'Sales', icon: null })];

beforeEach(() => {
  resetTreeStore();
  localStorage.clear();
  vi.mocked(getTree).mockResolvedValue([makeNode('p1', { title: 'Intro' })]);
  vi.mocked(listFavorites).mockResolvedValue([makeNode('fav', { title: 'Rack standards' })]);
  vi.mocked(listRecent).mockResolvedValue([makeNode('rec', { title: 'Cutover plan' })]);
});
afterEach(cleanup);

function renderSidebar(props: { space: typeof SPACES[number] | null; home?: boolean }) {
  return render(
    <MemoryRouter>
      <Sidebar spaces={SPACES} activeId={null} revealIds={[]} onCollapse={vi.fn()}
               onNewAtRoot={vi.fn()} onNewChild={vi.fn()} {...props} />
    </MemoryRouter>,
  );
}

describe('Sidebar', () => {
  it('on the home page lists the libraries only — Home already shows favorites and recent', async () => {
    renderSidebar({ space: SPACES[0], home: true });
    const nav = screen.getByRole('complementary', { name: 'Wiki navigation' });
    expect(within(nav).getByText('Libraries')).toBeTruthy();
    expect(within(nav).getByRole('link', { name: /Operations/ }).getAttribute('href')).toBe('/library/ops');
    expect(within(nav).getByRole('link', { name: /Sales/ }).getAttribute('href')).toBe('/library/sales');
    expect(within(nav).queryByRole('region', { name: 'Favorites' })).toBeNull();
    expect(within(nav).queryByRole('region', { name: 'Recently updated' })).toBeNull();
    expect(within(nav).queryByRole('tree')).toBeNull();
    expect(listFavorites).not.toHaveBeenCalled();
    expect(listRecent).not.toHaveBeenCalled();
  });

  it('inside a library keeps its tree, favorites and what changed there', async () => {
    renderSidebar({ space: SPACES[0] });
    expect(await screen.findByRole('tree', { name: 'Operations pages' })).toBeTruthy();
    const favorites = screen.getByRole('region', { name: 'Favorites' });
    expect(await within(favorites).findByRole('link', { name: /Rack standards/ })).toBeTruthy();
    const recent = screen.getByRole('region', { name: 'Recently updated' });
    expect(await within(recent).findByRole('link', { name: /Cutover plan/ })).toBeTruthy();
    expect(listRecent).toHaveBeenCalledWith({ space: 'ops', limit: 5 });
  });
});
