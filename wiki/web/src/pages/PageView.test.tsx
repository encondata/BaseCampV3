// @vitest-environment jsdom
import '../testing/pmDom';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => vi.fn() }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ person: { id: 'p-1', display_name: 'Jimmy Henderson' } }),
}));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getPageContent: vi.fn(),
  getMe: vi.fn(),
  getAssetUrls: vi.fn(),
  setFavorite: vi.fn(),
  publishPage: vi.fn(),
}));
// live editing is verified in the browser; here the editor is a stand-in
vi.mock('../editor/WikiEditor', () => ({
  default: ({ pageId }: { pageId: string }) => <div data-testid="wiki-editor">editing {pageId}</div>,
}));

import { ApiError } from '@portal/lib/api';

import { ShellContext, type ShellValue } from '../layout/shellContext';
import type { NodeDetailOut, PageContentOut } from '../lib/types';
import { getMe, getPageContent, setFavorite } from '../lib/wikiApi';
import { makeDetail, makeMe } from '../testing/fixtures';
import PageView from './PageView';

const PUBLISHED: PageContentOut = {
  version_id: 'v3',
  version_no: 3,
  kind: 'published',
  title: 'Rack power',
  content_json: {
    type: 'doc',
    content: [
      { type: 'heading', attrs: { level: 2, textAlign: null }, content: [{ type: 'text', text: 'Before you start' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Hello from the published page.' }] },
    ],
  },
  created_at: new Date(Date.now() - 2 * 3600_000).toISOString(),
  created_by: { id: 'p-2', name: 'Ada Lovelace' },
};

const published = { is_home: false, published_version_id: 'v3', published_at: PUBLISHED.created_at,
  has_unpublished_changes: false };
const never = { is_home: false, published_version_id: null, published_at: null, has_unpublished_changes: true };

function Probe() {
  const loc = useLocation();
  return <div data-testid="probe">{loc.pathname}{loc.search}</div>;
}

function renderPage(node: NodeDetailOut, path = `/n/${node.id}`) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/n/:nodeId" element={<><PageView node={node} /><Probe /></>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(getMe).mockResolvedValue(makeMe());
  vi.mocked(getPageContent).mockReset().mockResolvedValue(PUBLISHED);
  vi.mocked(setFavorite).mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);

describe('PageView — view mode', () => {
  it('renders the published version read-only with its meta line and contents', async () => {
    renderPage(makeDetail('p1', { title: 'Rack power', my_level: 'view', page: published }));
    expect(await screen.findByText('Hello from the published page.')).toBeTruthy();
    expect(getPageContent).toHaveBeenCalledWith('p1', 'published');
    expect(screen.getByText(/Published by Ada Lovelace · 2h ago/)).toBeTruthy();
    // read-only: nothing on the page is editable
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
    // the table of contents links to the rendered heading's id
    const toc = screen.getByRole('navigation', { name: 'On this page' });
    expect(toc.textContent).toContain('Before you start');
    await waitFor(() => expect(document.getElementById('h-before-you-start')).not.toBeNull());
  });

  it('shows viewers a friendly empty state for a page that was never published', async () => {
    vi.mocked(getPageContent).mockRejectedValue(new ApiError(404, 'not_published'));
    renderPage(makeDetail('p1', { my_level: 'view', page: never }));
    expect(await screen.findByText('This page hasn\'t been published yet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
  });

  it('gives viewers no edit controls, even with ?edit=1', async () => {
    renderPage(makeDetail('p1', { my_level: 'view', page: published }), '/n/p1?edit=1');
    await screen.findByText('Hello from the published page.');
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    expect(screen.queryByTestId('wiki-editor')).toBeNull();
  });
});

describe('PageView — editors', () => {
  it('shows the View/Edit toggle, Publish and the unpublished-changes chip', async () => {
    renderPage(makeDetail('p1', {
      my_level: 'edit', page: { ...published, has_unpublished_changes: true },
    }));
    await screen.findByText('Hello from the published page.');
    expect(screen.getByRole('button', { name: 'View' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(screen.getByText('Unpublished changes')).toBeTruthy();
    expect(screen.getByRole('link', { name: /History/ }).getAttribute('href')).toBe('/n/p1/history');
  });

  it('switches to the live editor with ?edit=1', async () => {
    renderPage(makeDetail('p1', { my_level: 'edit', page: published }));
    await screen.findByText('Hello from the published page.');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(await screen.findByTestId('wiki-editor')).toBeTruthy();
    expect(screen.getByTestId('probe').textContent).toBe('/n/p1?edit=1');
  });

  it('opens a never-published page straight in the editor', async () => {
    vi.mocked(getPageContent).mockRejectedValue(new ApiError(404, 'not_published'));
    renderPage(makeDetail('p1', { my_level: 'edit', page: never }));
    expect(await screen.findByTestId('wiki-editor')).toBeTruthy();
    expect(screen.getByText('Not published yet')).toBeTruthy();
  });

  it('stars the page', async () => {
    renderPage(makeDetail('p1', { my_level: 'edit', page: published }));
    await screen.findByText('Hello from the published page.');
    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));
    await waitFor(() => expect(setFavorite).toHaveBeenCalledWith('p1', true));
    expect(screen.getByRole('button', { name: 'Remove from favorites' })).toBeTruthy();
  });
});

describe('PageView — the ⋯ menu', () => {
  it('routes Move, Permissions and Delete through the shell, like the tree', async () => {
    const shell: ShellValue = {
      setCurrentNode: vi.fn(), setCurrentSpace: vi.fn(), openNewNode: vi.fn(),
      requestDelete: vi.fn(), requestMove: vi.fn(), requestPermissions: vi.fn(),
    };
    const node = makeDetail('p1', { title: 'Rack power', my_level: 'manage', page: published });
    render(
      <ShellContext.Provider value={shell}>
        <MemoryRouter initialEntries={['/n/p1']}>
          <Routes><Route path="/n/:nodeId" element={<PageView node={node} />} /></Routes>
        </MemoryRouter>
      </ShellContext.Provider>,
    );
    await screen.findByText('Hello from the published page.');
    const open = () => fireEvent.click(screen.getByRole('button', { name: 'Actions for Rack power' }));

    open();
    expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(
      ['Move…', 'Copy link', 'Permissions…', 'Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move…' }));
    expect(shell.requestMove).toHaveBeenCalledWith(node);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions…' }));
    expect(shell.requestPermissions).toHaveBeenCalledWith(node);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(shell.requestDelete).toHaveBeenCalledWith(node);
  });
});
