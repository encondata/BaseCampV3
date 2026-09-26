// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getSpace: vi.fn(),
  getSpaceTrash: vi.fn(),
  restoreTrash: vi.fn(),
  purgeTrash: vi.fn(),
  getTree: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import { resetTreeStore } from '../lib/treeStore';
import type { TrashBatch } from '../lib/types';
import { getSpace, getSpaceTrash, getTree, purgeTrash, restoreTrash } from '../lib/wikiApi';
import { makeNode, makeSpace } from '../testing/fixtures';
import TrashPage from './TrashPage';

const DAY = 86_400_000;
const BATCHES: TrashBatch[] = [
  {
    batch_id: 'b1', root: { id: 'f9', title: 'Old runbooks', kind: 'folder' }, count: 7,
    deleted_by: { id: 'p-2', name: 'Ada Lovelace' },
    deleted_at: new Date(Date.now() - 2 * DAY).toISOString(),
    purge_at: new Date(Date.now() + 28 * DAY).toISOString(),
  },
  {
    batch_id: 'b2', root: { id: 'p9', title: 'Draft notes', kind: 'page' }, count: 1,
    deleted_by: null, deleted_at: new Date(Date.now() - 3600_000).toISOString(), purge_at: null,
  },
];

function renderTrash() {
  return render(
    <MemoryRouter initialEntries={['/library/ops/trash']}>
      <Routes><Route path="/library/:spaceKey/trash" element={<TrashPage />} /></Routes>
    </MemoryRouter>,
  );
}

const rowOf = (title: string) => screen.getByText(title).closest('[role="listitem"]') as HTMLElement;

beforeEach(() => {
  resetTreeStore();
  toast.mockReset();
  vi.mocked(getTree).mockResolvedValue([]);
  vi.mocked(getSpace).mockResolvedValue(makeSpace({ my_level: 'manage' }));
  vi.mocked(getSpaceTrash).mockReset().mockResolvedValue(BATCHES);
  vi.mocked(restoreTrash).mockReset();
  vi.mocked(purgeTrash).mockReset();
});
afterEach(cleanup);

describe('TrashPage', () => {
  it('lists the deleted batches with what, items, who and when', async () => {
    renderTrash();
    await screen.findByText('Old runbooks');
    const row = rowOf('Old runbooks');
    expect(within(row).getByText('7')).toBeTruthy();
    expect(within(row).getByText('Ada Lovelace')).toBeTruthy();
    expect(within(row).getByText('2d ago')).toBeTruthy();
    expect(getSpaceTrash).toHaveBeenCalledWith('ops');
  });

  it('restores a batch and drops it from the list', async () => {
    vi.mocked(restoreTrash).mockResolvedValue(makeNode('f9', { kind: 'folder', title: 'Old runbooks' }));
    renderTrash();
    await screen.findByText('Old runbooks');
    fireEvent.click(within(rowOf('Old runbooks')).getByRole('button', { name: 'Restore Old runbooks' }));
    await waitFor(() => expect(restoreTrash).toHaveBeenCalledWith('b1'));
    await waitFor(() => expect(screen.queryByText('Old runbooks')).toBeNull());
    expect(toast).toHaveBeenCalledWith('Restored “Old runbooks”.');
  });

  it('deletes a batch forever after a confirmation', async () => {
    vi.mocked(purgeTrash).mockResolvedValue(undefined);
    renderTrash();
    await screen.findByText('Draft notes');
    fireEvent.click(within(rowOf('Draft notes')).getByRole('button', { name: 'Delete Draft notes forever' }));
    expect(purgeTrash).not.toHaveBeenCalled();
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete forever' }));
    await waitFor(() => expect(purgeTrash).toHaveBeenCalledWith('b2'));
    await waitFor(() => expect(screen.queryByText('Draft notes')).toBeNull());
  });

  it('says so to someone who can\'t manage the space', async () => {
    vi.mocked(getSpace).mockResolvedValue(makeSpace({ my_level: 'edit' }));
    vi.mocked(getSpaceTrash).mockRejectedValue(new ApiError(403, 'forbidden'));
    renderTrash();
    expect(await screen.findByText(/only library managers/i)).toBeTruthy();
  });
});
