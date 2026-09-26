// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => vi.fn() }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getSpace: vi.fn(),
  getTree: vi.fn(),
  listWatches: vi.fn(),
  watch: vi.fn(),
}));
vi.mock('./NodePage', () => ({ default: ({ nodeId }: { nodeId: string }) => <div>home page {nodeId}</div> }));

import { resetTreeStore } from '../lib/treeStore';
import type { SpaceOut } from '../lib/types';
import { getSpace, getTree, listWatches, watch } from '../lib/wikiApi';
import { makeSpace } from '../testing/fixtures';
import SpaceHome from './SpaceHome';

function renderSpace(space: SpaceOut) {
  vi.mocked(getSpace).mockResolvedValue(space);
  return render(
    <MemoryRouter initialEntries={[`/s/${space.key}`]}>
      <Routes><Route path="/s/:spaceKey" element={<SpaceHome />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetTreeStore();
  vi.mocked(getTree).mockReset().mockResolvedValue([]);
  vi.mocked(listWatches).mockReset().mockResolvedValue([]);
  vi.mocked(watch).mockReset().mockResolvedValue({
    id: 'w1', node: null, space: { key: 'ops', name: 'Operations' }, created_at: '2026-09-26T00:00:00Z',
  });
});
afterEach(cleanup);

describe('SpaceHome', () => {
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
});
