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
}));

import { resetTreeStore } from '../lib/treeStore';
import type { NodeDetailOut } from '../lib/types';
import { createNode, getTree, updateNode } from '../lib/wikiApi';
import { makeDetail, makeNode } from '../testing/fixtures';
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
});
afterEach(cleanup);

describe('FolderView', () => {
  it('shows breadcrumbs and lists the folder\'s children with type, author and size', async () => {
    renderFolder();
    const nav = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(nav).getByRole('link', { name: 'Operations' }).getAttribute('href')).toBe('/s/ops');
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

  it('keeps the edit controls from a viewer and disables Upload and Import', async () => {
    renderFolder({ ...FOLDER, my_level: 'view' });
    await screen.findByText('Cabling');
    expect(screen.queryByRole('button', { name: 'New page' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Rename Guides' })).toBeNull();
    cleanup();
    renderFolder();
    expect((screen.getByRole('button', { name: 'Upload' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
