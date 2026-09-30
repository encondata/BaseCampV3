// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => vi.fn() }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getTree: vi.fn(),
  createNode: vi.fn(),
  updateNode: vi.fn(),
  getWatchState: vi.fn(),
  watch: vi.fn(),
}));
vi.mock('../uploads/uploadQueue', () => ({ enqueue: vi.fn(), enqueueWalked: vi.fn() }));

import { ShellContext, type ShellValue } from '../layout/shellContext';
import { resetTreeStore } from '../lib/treeStore';
import type { NodeDetailOut } from '../lib/types';
import {
  createNode, getTree, getWatchState, updateNode, watch,
} from '../lib/wikiApi';
import { makeDetail, makeNode } from '../testing/fixtures';
import { enqueue, enqueueWalked } from '../uploads/uploadQueue';
import FolderView from './FolderView';

function Probe() {
  const loc = useLocation();
  return <div>at {loc.pathname}{loc.search}</div>;
}

const FOLDER = makeDetail('f1', {
  kind: 'folder',
  title: 'Guides',
  page: null,
  breadcrumbs: [{ id: 'top', title: 'Library', kind: 'folder' }],
});

function renderFolder(node: NodeDetailOut = FOLDER) {
  return render(
    <MemoryRouter initialEntries={['/n/f1']}>
      <Routes>
        <Route path="/n/f1" element={<FolderView node={node} />} />
        <Route path="*" element={<Probe />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetTreeStore();
  vi.mocked(getTree).mockResolvedValue([
    makeNode('sub', { kind: 'folder', title: 'Racks', parent_id: 'f1', page: null }),
    makeNode('pg', { title: 'Cabling', parent_id: 'f1', updated_by: { id: 'p2', name: 'Ana Ortiz' } }),
    makeNode('fl', {
      kind: 'file',
      title: 'floorplan.pdf',
      parent_id: 'f1',
      page: null,
      file: {
        description: '',
        current_version: {
          id: 'v1', version_no: 1, filename: 'floorplan.pdf', content_type: 'application/pdf',
          size_bytes: 2_500_000, preview_kind: 'pdf', preview_status: 'ready', extract_status: 'ready',
          note: null, uploaded_by: null, created_at: '2026-09-20T12:00:00Z',
        },
      },
    }),
  ]);
  vi.mocked(createNode).mockReset();
  vi.mocked(updateNode).mockReset();
  vi.mocked(getWatchState).mockReset().mockResolvedValue({ watching: false, via: null, watch_id: null });
  vi.mocked(watch).mockReset().mockResolvedValue({
    id: 'w1', node: { id: 'f1', title: 'Guides', kind: 'folder' }, space: null, created_at: '2026-09-20T12:00:00Z',
  });
});
afterEach(cleanup);

describe('FolderView', () => {
  it('marks pages whose review is due or overdue', async () => {
    const review = {
      interval_months: 6, own_interval_months: null, next_review_at: '2026-10-03T12:00:00Z',
      last_reviewed_at: null, pending_review_id: null,
    };
    vi.mocked(getTree).mockResolvedValue([
      makeNode('a', { title: 'Cabling', parent_id: 'f1', review: { ...review, state: 'overdue' } }),
      makeNode('b', { title: 'Badges', parent_id: 'f1', review: { ...review, state: 'due_soon' } }),
      makeNode('c', { title: 'Lifts', parent_id: 'f1', review: { ...review, state: 'ok' } }),
    ]);
    renderFolder();
    const rows = await within(await screen.findByRole('list', { name: 'Contents of Guides' })).findAllByRole('listitem');
    expect(within(rows[0]).getByText('Review overdue')).toBeTruthy();
    expect(within(rows[1]).getByText(/^Review due /)).toBeTruthy();
    expect(rows[2].querySelector('.wiki-review-chip')).toBeNull();
  });

  it('locks the private rows of the list, and only those', async () => {
    vi.mocked(getTree).mockResolvedValue([
      makeNode('a', { title: 'Payroll', parent_id: 'f1', is_private: true }),
      makeNode('b', { title: 'Cabling', parent_id: 'f1' }),
    ]);
    renderFolder();
    const rows = await within(await screen.findByRole('list', { name: 'Contents of Guides' })).findAllByRole('listitem');
    expect(within(rows[0]).getByRole('img', { name: 'Private' })).toBeTruthy();
    expect(within(rows[1]).queryByRole('img', { name: 'Private' })).toBeNull();
  });

  it('shows Private and Printing off chips in the header, not the lock', async () => {
    renderFolder({ ...FOLDER, is_private: true, can_print: false });
    const head = screen.getByRole('heading', { name: 'Guides' }).closest('.wiki-folder-head') as HTMLElement;
    expect(within(head).getByText('Private')).toBeTruthy();
    expect(within(head).getByText('Printing off')).toBeTruthy();
    expect(within(head).queryByRole('img', { name: 'Private' })).toBeNull();
    await screen.findByRole('list', { name: 'Contents of Guides' });
  });

  it('shows no chips for an ordinary folder', async () => {
    renderFolder();
    const head = screen.getByRole('heading', { name: 'Guides' }).closest('.wiki-folder-head') as HTMLElement;
    expect(within(head).queryByText('Private')).toBeNull();
    expect(within(head).queryByText('Printing off')).toBeNull();
    await screen.findByRole('list', { name: 'Contents of Guides' });
  });

  it('shows breadcrumbs and lists the folder\'s children with type, author and size', async () => {
    renderFolder();
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Operations' }).getAttribute('href')).toBe('/library/ops');
    expect(within(nav).getByRole('link', { name: 'Library' }).getAttribute('href')).toBe('/n/top');

    const list = await screen.findByRole('list', { name: 'Contents of Guides' });
    const rows = within(list).getAllByRole('listitem');
    expect(rows.map((r) => r.querySelector('b')?.textContent)).toEqual(['Racks', 'Cabling', 'floorplan.pdf']);
    expect(within(rows[1]).getByText('Page')).toBeTruthy();
    expect(within(rows[1]).getByText('Ana Ortiz')).toBeTruthy();
    expect(within(rows[2]).getByText('PDF')).toBeTruthy();
    expect(within(rows[2]).getByText('2.4 MB')).toBeTruthy();
    expect(getTree).toHaveBeenCalledWith('ops', 'f1');
  });

  it('masks an ancestor the viewer can\'t see as “…”, without a link', async () => {
    renderFolder({
      ...FOLDER,
      breadcrumbs: [
        { id: null, title: 'Secret plans', kind: 'folder' },
        { id: 'top', title: 'Library', kind: 'folder' },
      ],
    });
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(nav.textContent).toBe('Operations/…/Library');
    expect(within(nav).getAllByRole('link').map((a) => a.textContent)).toEqual(['Operations', 'Library']);
    await screen.findByText('Cabling');
  });

  it('opens a child from its row', async () => {
    renderFolder();
    fireEvent.click(await screen.findByText('Cabling'));
    expect(await screen.findByText('at /n/pg')).toBeTruthy();
  });

  it('creates a page in this folder and opens it for editing', async () => {
    vi.mocked(createNode).mockResolvedValue(makeNode('new-1', { title: 'Power budget', parent_id: 'f1' }));
    renderFolder();
    fireEvent.click(screen.getByRole('button', { name: 'New page' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Title'), { target: { value: 'Power budget' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create page' }));

    expect(await screen.findByText('at /n/new-1?edit=1')).toBeTruthy();
    expect(createNode).toHaveBeenCalledWith({
      space_id: 'space-1', parent_id: 'f1', kind: 'page', title: 'Power budget',
    });
  });

  it('renames the folder inline for an editor', async () => {
    vi.mocked(updateNode).mockResolvedValue(makeNode('f1', { kind: 'folder', title: 'How-to guides' }));
    renderFolder();
    fireEvent.click(screen.getByRole('button', { name: 'Rename Guides' }));
    const field = screen.getByLabelText('Folder title');
    fireEvent.change(field, { target: { value: 'How-to guides' } });
    fireEvent.keyDown(field, { key: 'Enter' });
    await vi.waitFor(() => expect(updateNode).toHaveBeenCalledWith('f1', { title: 'How-to guides' }));
  });

  it('offers a Watch button for the folder', async () => {
    renderFolder();
    fireEvent.click(await screen.findByRole('button', { name: 'Watch' }));
    await vi.waitFor(() => expect(watch).toHaveBeenCalledWith({ node_id: 'f1' }));
  });

  it('exports the folder through the shell, for anyone who can view it', async () => {
    const requestExport = vi.fn();
    const node = { ...FOLDER, my_level: 'view' as const };
    render(
      <ShellContext.Provider value={{ requestExport } as unknown as ShellValue}>
        <MemoryRouter initialEntries={['/n/f1']}>
          <Routes><Route path="/n/f1" element={<FolderView node={node} />} /></Routes>
        </MemoryRouter>
      </ShellContext.Provider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Export…' }));
    expect(requestExport).toHaveBeenCalledWith({ kind: 'node', node });
  });

  it('keeps the edit controls, uploads and drops from a viewer', async () => {
    renderFolder({ ...FOLDER, my_level: 'view' });
    await screen.findByText('Cabling');
    expect(screen.queryByRole('button', { name: 'New page' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename Guides' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Upload' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Import' })).toBeNull();
    fireEvent.dragEnter(screen.getByRole('list', { name: 'Contents of Guides' }), {
      dataTransfer: { types: ['Files'], items: [], files: [] },
    });
    expect(screen.queryByText('Drop to upload to Guides')).toBeNull();
  });

  it('uploads picked files into the folder through the tray', async () => {
    vi.mocked(enqueue).mockReset();
    renderFolder();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeTruthy();
    const files = [new File(['a'], 'a.pdf'), new File(['b'], 'b.png')];
    fireEvent.change(screen.getByLabelText('Upload files to Guides'), { target: { files } });
    expect(enqueue).toHaveBeenCalledWith(files,
      { kind: 'node', spaceId: 'space-1', spaceKey: 'ops', parentId: 'f1', label: 'Guides' });
  });

  it('opens the import dialog for the folder', async () => {
    renderFolder();
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    const dialog = screen.getByRole('dialog', { name: 'Import pages' });
    expect(within(dialog).getByText(/into Guides/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('takes files and folders dropped from the computer', async () => {
    vi.mocked(enqueueWalked).mockReset().mockResolvedValue(undefined);
    renderFolder();
    const list = await screen.findByRole('list', { name: 'Contents of Guides' });
    const file = new File(['x'], 'x.txt');
    const dataTransfer = { types: ['Files'], items: [], files: [file], dropEffect: 'none' };
    fireEvent.dragEnter(list, { dataTransfer });
    expect(screen.getByText('Drop to upload to Guides')).toBeTruthy();
    fireEvent.drop(list, { dataTransfer });
    expect(screen.queryByText('Drop to upload to Guides')).toBeNull();
    await vi.waitFor(() => expect(enqueueWalked).toHaveBeenCalledWith(
      [{ path: [], file }], { spaceId: 'space-1', spaceKey: 'ops', parentId: 'f1', label: 'Guides' }, expect.any(Function)));
  });

  it('ignores drags that aren\'t files', async () => {
    renderFolder();
    const list = await screen.findByRole('list', { name: 'Contents of Guides' });
    fireEvent.dragEnter(list, { dataTransfer: { types: ['text/plain'], items: [], files: [] } });
    expect(screen.queryByText('Drop to upload to Guides')).toBeNull();
  });
});
