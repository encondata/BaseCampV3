// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => vi.fn() }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getSpace: vi.fn(),
  getTree: vi.fn(),
  listWatches: vi.fn(),
  watch: vi.fn(),
  listDueReviews: vi.fn(),
}));
vi.mock('./NodePage', () => ({ default: ({ nodeId }: { nodeId: string }) => <div>home page {nodeId}</div> }));

import { ShellContext, type ShellValue } from '../layout/shellContext';
import { resetTreeStore } from '../lib/treeStore';
import type { SpaceOut } from '../lib/types';
import { getSpace, getTree, listDueReviews, listWatches, watch } from '../lib/wikiApi';
import { makeNode, makeSpace } from '../testing/fixtures';
import SpaceHome from './SpaceHome';

function renderSpace(space: SpaceOut) {
  vi.mocked(getSpace).mockResolvedValue(space);
  return render(
    <MemoryRouter initialEntries={[`/library/${space.key}`]}>
      <Routes><Route path="/library/:spaceKey" element={<SpaceHome />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetTreeStore();
  vi.mocked(getTree).mockReset().mockResolvedValue([]);
  vi.mocked(listWatches).mockReset().mockResolvedValue([]);
  vi.mocked(listDueReviews).mockReset().mockResolvedValue([]);
  vi.mocked(watch).mockReset().mockResolvedValue({
    id: 'w1', node: null, space: { key: 'ops', name: 'Operations' }, created_at: '2026-09-26T00:00:00Z',
  });
});
afterEach(cleanup);

describe('SpaceHome', () => {
  it('exports the whole space through the shell', async () => {
    const space = makeSpace({ home_node_id: 'home-1' });
    vi.mocked(getSpace).mockResolvedValue(space);
    const requestExport = vi.fn();
    const shell = {
      setCurrentNode: vi.fn(), setCurrentSpace: vi.fn(), requestExport,
    } as unknown as ShellValue;
    render(
      <ShellContext.Provider value={shell}>
        <MemoryRouter initialEntries={['/library/ops']}>
          <Routes><Route path="/library/:spaceKey" element={<SpaceHome />} /></Routes>
        </MemoryRouter>
      </ShellContext.Provider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Export library…' }));
    expect(requestExport).toHaveBeenCalledWith({ kind: 'space', space });
  });

  it('shows a plain header with a space Watch button when there is no home page', async () => {
    renderSpace(makeSpace({ home_node_id: null }));
    await screen.findByText('Operations');
    const btn = await screen.findByRole('button', { name: 'Watch' });
    fireEvent.click(btn);
    await waitFor(() => expect(watch).toHaveBeenCalledWith({ space_id: 'space-1' }));
  });

  it('renders the home page plus a space Watch button on the contents section', async () => {
    renderSpace(makeSpace({ home_node_id: 'home-1' }));
    await screen.findByText('home page home-1');
    expect(await screen.findByRole('button', { name: 'Watch' })).toBeTruthy();
  });

  it('locks the private items in the library\'s list', async () => {
    vi.mocked(getTree).mockResolvedValue([makeNode('a', { title: 'Payroll', is_private: true }), makeNode('b', { title: 'Cabling' })]);
    renderSpace(makeSpace({ home_node_id: null }));
    const rows = await within(await screen.findByRole('list', { name: 'What\'s in this library' })).findAllByRole('listitem');
    expect(within(rows[0]).getByRole('img', { name: 'Private' })).toBeTruthy();
    expect(within(rows[1]).queryByRole('img', { name: 'Private' })).toBeNull();
  });

  it('links to the pages due for review while any are due', async () => {
    vi.mocked(listDueReviews).mockResolvedValue([makeNode('p1'), makeNode('p2')]);
    renderSpace(makeSpace({ home_node_id: 'home-1' }));
    const link = await screen.findByRole('link', { name: '2 pages due for review' });
    expect(link.getAttribute('href')).toBe('/library/ops/due');
    expect(listDueReviews).toHaveBeenCalledWith('ops');
  });

  it('shows no due link when nothing is due', async () => {
    renderSpace(makeSpace({ home_node_id: 'home-1' }));
    await screen.findByText('home page home-1');
    await waitFor(() => expect(listDueReviews).toHaveBeenCalled());
    expect(screen.queryByRole('link', { name: /due for review/ })).toBeNull();
  });
});
