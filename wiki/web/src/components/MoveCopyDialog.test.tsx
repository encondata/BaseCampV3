// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  listSpaces: vi.fn(),
  getTree: vi.fn(),
  moveNode: vi.fn(),
  copyNode: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import { resetTreeStore } from '../lib/treeStore';
import type { NodeOut } from '../lib/types';
import { copyNode, getTree, listSpaces, moveNode } from '../lib/wikiApi';
import { makeNode, makeSpace } from '../testing/fixtures';
import MoveCopyDialog from './MoveCopyDialog';

const OPS = makeSpace({ my_level: 'edit' });
const ENG = makeSpace({ id: 'space-2', key: 'eng', name: 'Engineering', my_level: 'edit', home_node_id: null });

const F1 = makeNode('f1', { kind: 'folder', title: 'Guides', has_children: true });
const ROOT: NodeOut[] = [
  F1,
  makeNode('p1', { title: 'Intro' }),
  makeNode('x1', { kind: 'file', title: 'manual.pdf' }),
  makeNode('ro', { kind: 'folder', title: 'Read only', my_level: 'view' }),
];
const IN_F1: NodeOut[] = [makeNode('c1', { kind: 'folder', title: 'Racks', parent_id: 'f1' })];

function Probe() {
  const loc = useLocation();
  return <div data-testid="probe">{loc.pathname}</div>;
}

function renderDialog(node: NodeOut, mode: 'move' | 'copy', onClose = vi.fn()) {
  render(
    <MemoryRouter initialEntries={['/n/start']}>
      <Routes>
        <Route path="*" element={<><MoveCopyDialog node={node} mode={mode} onClose={onClose} /><Probe /></>} />
      </Routes>
    </MemoryRouter>,
  );
  return onClose;
}

const item = (name: string) => screen.getByRole('treeitem', { name });

beforeEach(() => {
  resetTreeStore();
  toast.mockReset();
  vi.mocked(listSpaces).mockResolvedValue([OPS, ENG]);
  vi.mocked(getTree).mockImplementation(async (key, parentId) => {
    if (key !== 'ops') return [];
    return parentId === 'f1' ? IN_F1 : parentId ? [] : ROOT;
  });
  vi.mocked(moveNode).mockReset();
  vi.mocked(copyNode).mockReset();
});
afterEach(cleanup);

describe('MoveCopyDialog', () => {
  it('disables the node itself, its descendants, files and places without edit', async () => {
    renderDialog(F1, 'move');
    await screen.findByRole('treeitem', { name: 'Intro' });
    fireEvent.click(screen.getByRole('button', { name: 'Expand Guides' }));
    await screen.findByRole('treeitem', { name: 'Racks' });
    expect(item('Guides').getAttribute('aria-disabled')).toBe('true');
    expect(item('Racks').getAttribute('aria-disabled')).toBe('true');
    expect(item('manual.pdf').getAttribute('aria-disabled')).toBe('true');
    expect(item('Read only').getAttribute('aria-disabled')).toBe('true');
    expect(item('Intro').getAttribute('aria-disabled')).toBe('false');
    fireEvent.click(item('Racks'));
    expect(screen.getByRole('button', { name: 'Move here' })).toHaveProperty('disabled', true);
  });

  it('keeps a move inside the space unless the mover manages the node', async () => {
    renderDialog(makeNode('p1', { title: 'Intro' }), 'move');
    await screen.findByRole('treeitem', { name: 'Guides' });
    expect(screen.queryByRole('treeitem', { name: 'Engineering' })).toBeNull();
  });

  it('moves into the picked folder and refreshes the tree', async () => {
    const node = makeNode('p1', { title: 'Intro' });
    vi.mocked(moveNode).mockResolvedValue({ ...node, parent_id: 'f1' });
    const onClose = renderDialog(node, 'move');
    fireEvent.click(await screen.findByRole('treeitem', { name: 'Guides' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move here' }));
    await waitFor(() => expect(moveNode).toHaveBeenCalledWith('p1', { parent_id: 'f1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith('Moved “Intro” to Guides.');
  });

  it('copies to another space\'s top level and opens the copy', async () => {
    const node = makeNode('p1', { title: 'Intro', my_level: 'view' });
    vi.mocked(copyNode).mockResolvedValue(makeNode('copy-1', { title: 'Intro', space_key: 'eng', space_id: 'space-2' }));
    renderDialog(node, 'copy');
    fireEvent.click(await screen.findByRole('treeitem', { name: 'Engineering' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy here' }));
    await waitFor(() => expect(copyNode).toHaveBeenCalledWith('p1', { parent_id: null, space_id: 'space-2' }));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/n/copy-1'));
  });

  it('shows the copy limit inline', async () => {
    vi.mocked(copyNode).mockRejectedValue(new ApiError(422, 'too_many'));
    renderDialog(F1, 'copy');
    fireEvent.click(await screen.findByRole('treeitem', { name: 'Intro' }));
    fireEvent.click(screen.getByRole('button', { name: 'Copy here' }));
    expect(await screen.findByText(/more than 500/)).toBeTruthy();
  });
});
