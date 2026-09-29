// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getWatchState: vi.fn(),
  listWatches: vi.fn(),
  watch: vi.fn(),
  unwatch: vi.fn(),
}));

import { getWatchState, listWatches, unwatch, watch } from '../lib/wikiApi';
import WatchButton from './WatchButton';

beforeEach(() => {
  toast.mockReset();
  vi.mocked(getWatchState).mockReset();
  vi.mocked(listWatches).mockReset();
  vi.mocked(watch).mockReset();
  vi.mocked(unwatch).mockReset();
});
afterEach(cleanup);

describe('WatchButton', () => {
  it('watches a node that is not watched yet', async () => {
    vi.mocked(getWatchState).mockResolvedValue({ watching: false, via: null, watch_id: null });
    vi.mocked(watch).mockResolvedValue({
      id: 'w1', node: { id: 'n1', title: 'Page', kind: 'page' }, space: null, created_at: '2026-09-26T00:00:00Z',
    });
    render(<WatchButton target={{ kind: 'node', nodeId: 'n1' }} />);
    const btn = await screen.findByRole('button', { name: 'Watch' });
    fireEvent.click(btn);
    await waitFor(() => expect(watch).toHaveBeenCalledWith({ node_id: 'n1' }));
    expect(await screen.findByRole('button', { name: 'Watching' })).toBeTruthy();
  });

  it('unwatches a node the caller watches directly', async () => {
    vi.mocked(getWatchState).mockResolvedValue({ watching: true, via: 'node', watch_id: 'w1' });
    vi.mocked(unwatch).mockResolvedValue(undefined);
    render(<WatchButton target={{ kind: 'node', nodeId: 'n1' }} />);
    const btn = await screen.findByRole('button', { name: 'Watching' });
    fireEvent.click(btn);
    await waitFor(() => expect(unwatch).toHaveBeenCalledWith('w1'));
    expect(await screen.findByRole('button', { name: 'Watch' })).toBeTruthy();
  });

  it('shows an inherited watch as a disabled chip naming the folder', async () => {
    vi.mocked(getWatchState).mockResolvedValue({ watching: true, via: 'ancestor', watch_id: 'w2' });
    render(<WatchButton target={{ kind: 'node', nodeId: 'n1' }} />);
    expect(await screen.findByText('Watching via folder')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('shows an inherited watch as a disabled chip naming the space', async () => {
    vi.mocked(getWatchState).mockResolvedValue({ watching: true, via: 'space', watch_id: 'w3' });
    render(<WatchButton target={{ kind: 'node', nodeId: 'n1' }} />);
    expect(await screen.findByText('Watching via library')).toBeTruthy();
  });

  it('reports a failed toggle without changing the shown state', async () => {
    vi.mocked(getWatchState).mockResolvedValue({ watching: false, via: null, watch_id: null });
    vi.mocked(watch).mockRejectedValue(new Error('nope'));
    render(<WatchButton target={{ kind: 'node', nodeId: 'n1' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Watch' }));
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(screen.getByRole('button', { name: 'Watch' })).toBeTruthy();
  });

  it('watches and unwatches a space directly', async () => {
    vi.mocked(listWatches).mockResolvedValue([]);
    vi.mocked(watch).mockResolvedValue({ id: 'w4', node: null, space: { key: 'ops', name: 'Operations' }, created_at: '2026-09-26T00:00:00Z' });
    render(<WatchButton target={{ kind: 'space', spaceId: 'space-1', spaceKey: 'ops' }} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Watch' }));
    await waitFor(() => expect(watch).toHaveBeenCalledWith({ space_id: 'space-1' }));
    expect(await screen.findByRole('button', { name: 'Watching' })).toBeTruthy();
  });

  it('finds an existing direct space watch on load', async () => {
    vi.mocked(listWatches).mockResolvedValue([
      { id: 'w5', node: null, space: { key: 'ops', name: 'Operations' }, created_at: '2026-09-26T00:00:00Z' },
    ]);
    render(<WatchButton target={{ kind: 'space', spaceId: 'space-1', spaceKey: 'ops' }} />);
    const btn = await screen.findByRole('button', { name: 'Watching' });
    fireEvent.click(btn);
    await waitFor(() => expect(unwatch).toHaveBeenCalledWith('w5'));
  });
});
