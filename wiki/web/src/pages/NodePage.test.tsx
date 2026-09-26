// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => vi.fn() }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ person: { id: 'p-1', display_name: 'Jimmy Henderson' } }),
}));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getNode: vi.fn(),
  getTree: vi.fn(),
  getPageContent: vi.fn(),
  getMe: vi.fn(),
  getFileUrl: vi.fn(),
  listFileVersions: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import { resetTreeStore } from '../lib/treeStore';
import { getFileUrl, getMe, getNode, getPageContent, getTree, listFileVersions } from '../lib/wikiApi';
import { makeDetail, makeMe } from '../testing/fixtures';
import NodePage from './NodePage';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/n/:nodeId" element={<NodePage />} /></Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  resetTreeStore();
  vi.mocked(getTree).mockResolvedValue([]);
  vi.mocked(getMe).mockResolvedValue(makeMe());
  vi.mocked(getPageContent).mockRejectedValue(new ApiError(404, 'not_published'));
  vi.mocked(getFileUrl).mockResolvedValue({ url: null, content_type: 'application/zip', preview_status: 'skipped' });
  vi.mocked(listFileVersions).mockResolvedValue([]);
});
afterEach(cleanup);

describe('NodePage', () => {
  it('shows a folder as a folder view', async () => {
    vi.mocked(getNode).mockResolvedValue(makeDetail('f1', { kind: 'folder', title: 'Guides', page: null }));
    renderAt('/n/f1');
    expect(await screen.findByRole('heading', { name: 'Guides' })).toBeTruthy();
    expect(getNode).toHaveBeenCalledWith('f1');
  });

  it('hands a page to the page view', async () => {
    vi.mocked(getNode).mockResolvedValue(makeDetail('p1', { title: 'Intro', my_level: 'view' }));
    renderAt('/n/p1');
    expect(await screen.findByTestId('page-view')).toBeTruthy();
  });

  it('hands a file to the file view', async () => {
    vi.mocked(getNode).mockResolvedValue(makeDetail('x', { kind: 'file', page: null }));
    renderAt('/n/x');
    expect(await screen.findByTestId('file-view')).toBeTruthy();
    expect(await screen.findByRole('table', { name: 'Versions' })).toBeTruthy();
  });

  it('says so when the node is missing or hidden', async () => {
    vi.mocked(getNode).mockRejectedValue(new ApiError(404, 'not_found'));
    renderAt('/n/gone');
    expect(await screen.findByRole('heading', { name: 'Nothing here' })).toBeTruthy();
  });
});
