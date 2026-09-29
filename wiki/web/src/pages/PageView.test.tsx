// @vitest-environment jsdom
import '../testing/pmDom';

import { Editor } from '@tiptap/core';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
const systemStatus = { read_only: false };
vi.mock('@portal/lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: systemStatus, refresh: () => {} }),
}));
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
  getVersion: vi.fn(),
  recordRestore: vi.fn(),
  listComments: vi.fn(),
  deleteComment: vi.fn(),
  postComment: vi.fn(),
  getWatchState: vi.fn(),
  createTemplate: vi.fn(),
  submitReview: vi.fn(),
  getReview: vi.fn(),
  withdrawReview: vi.fn(),
  markReviewed: vi.fn(),
  updateNode: vi.fn(),
  listReviews: vi.fn(),
}));
vi.mock('../analytics/useRecordView', () => ({ useRecordView: vi.fn() }));
/** What the stand-in editor hands PageView once it has first synced: a
 *  real (unconnected) editor, so comment marks can attach to it, whose
 *  commands are stand-ins. */
const fakeEditor = Object.defineProperty(
  Object.create(new Editor({ extensions: wikiExtensions() })), 'commands',
  { value: { setContent: vi.fn(), unsetCommentThread: vi.fn() } },
);
/** The stand-in editor's own flush (its live connection's). */
const editorFlush = vi.fn<() => Promise<void>>();
// live editing is verified in the browser; here the editor is a stand-in
vi.mock('../editor/WikiEditor', () => ({
  default: ({ pageId, onAccessLost, onFirstSync, onLiveFlush }: {
    pageId: string; onAccessLost: (l: 'view' | 'none') => void; onFirstSync?: (editor: unknown) => void;
    onLiveFlush?: (flush: (() => Promise<void>) | null) => void;
  }) => (
    <div data-testid="wiki-editor">
      editing {pageId}
      <button type="button" onClick={() => onAccessLost('view')}>server says read-only</button>
      <button type="button" onClick={() => onAccessLost('none')}>server refuses</button>
      <button type="button" onClick={() => { onLiveFlush?.(editorFlush); onFirstSync?.(fakeEditor); }}>
        first sync
      </button>
    </div>
  ),
}));
// a page not open in this tab is flushed over a short-lived connection
vi.mock('../editor/flushPage', () => ({ flushPage: vi.fn() }));

import { ApiError } from '@portal/lib/api';

import { ShellContext, type ShellValue } from '../layout/shellContext';
import type { NodeDetailOut, PageContentOut } from '../lib/types';
import { flushPage } from '../editor/flushPage';
import { wikiExtensions } from '../editor/schema';
import type { CommentThread } from '../lib/types';
import { longDate } from '@portal/lib/format';

import { resetTreeStore, useTreeRevision } from '../lib/treeStore';
import { clearWikiMe } from '../lib/useWikiMe';
import type { NodeReviewOut } from '../lib/types';
import {
  createTemplate, deleteComment, getMe, getPageContent, getReview, getVersion, getWatchState, listComments,
  listReviews, markReviewed, postComment, publishPage, recordRestore, setFavorite, submitReview, withdrawReview,
} from '../lib/wikiApi';
import { makeDetail, makeMe, makeNode, makeReview, makeReviewDetail, makeSpace } from '../testing/fixtures';
import { useRecordView } from '../analytics/useRecordView';
import PageView, { TARGET_HIGHLIGHT_MS } from './PageView';

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
  toast.mockReset();
  systemStatus.read_only = false;
  vi.mocked(getMe).mockResolvedValue(makeMe());
  vi.mocked(getPageContent).mockReset().mockResolvedValue(PUBLISHED);
  vi.mocked(setFavorite).mockReset().mockResolvedValue(undefined);
  vi.mocked(listComments).mockReset().mockResolvedValue([]);
  vi.mocked(getWatchState).mockReset().mockResolvedValue({ watching: false, via: null, watch_id: null });
  vi.mocked(createTemplate).mockReset();
  vi.mocked(listReviews).mockReset().mockResolvedValue([]);
  vi.mocked(flushPage).mockReset().mockResolvedValue(undefined);
  editorFlush.mockReset().mockResolvedValue(undefined);
  vi.mocked(useRecordView).mockReset();
});
afterEach(cleanup);

/** Whether PageView ever asked for this page's view to be counted. */
const countedView = (id: string) => vi.mocked(useRecordView).mock.calls.some(([n, on]) => n === id && on);

describe('PageView — analytics', () => {
  it('counts a reader\'s view', async () => {
    renderPage(makeDetail('p1', { my_level: 'view', page: published }));
    await screen.findByText('Hello from the published page.');
    expect(countedView('p1')).toBe(true);
  });

  it('counts no view while an editor has the page open in the editor', async () => {
    renderPage(makeDetail('p1', { my_level: 'edit', page: published }), '/n/p1?edit=1');
    expect(await screen.findByTestId('wiki-editor')).toBeTruthy();
    expect(useRecordView).toHaveBeenCalled();
    expect(countedView('p1')).toBe(false);
  });

  it('counts no view for a page that was never published', async () => {
    vi.mocked(getPageContent).mockRejectedValue(new ApiError(404, 'not_published'));
    renderPage(makeDetail('p1', { my_level: 'view', page: never }));
    expect(await screen.findByText('This page hasn\'t been published yet')).toBeTruthy();
    expect(countedView('p1')).toBe(false);
  });
});

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
    // no rail, so no comments are fetched
    expect(listComments).not.toHaveBeenCalled();
    // no live connection is even attempted: live editing is for editors
    expect(screen.queryByTestId('wiki-editor')).toBeNull();
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

  it('offers a Watch button in the header', async () => {
    renderPage(makeDetail('p1', { my_level: 'edit', page: published }));
    await screen.findByText('Hello from the published page.');
    expect(await screen.findByRole('button', { name: 'Watch' })).toBeTruthy();
    expect(getWatchState).toHaveBeenCalledWith('p1');
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
  it('routes Move, Copy, Permissions, Share and Delete through the shell, like the tree', async () => {
    const shell: ShellValue = {
      setCurrentNode: vi.fn(), setCurrentSpace: vi.fn(), openNewNode: vi.fn(),
      requestDelete: vi.fn(), requestMove: vi.fn(), requestCopy: vi.fn(), requestPermissions: vi.fn(), requestShare: vi.fn(),
      requestExport: vi.fn(),
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
      ['Move…', 'Copy…', 'Copy link', 'Export…', 'Save as template…', 'Review schedule…', 'Permissions…', 'Share…', 'Delete']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Move…' }));
    expect(shell.requestMove).toHaveBeenCalledWith(node);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy…' }));
    expect(shell.requestCopy).toHaveBeenCalledWith(node);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Permissions…' }));
    expect(shell.requestPermissions).toHaveBeenCalledWith(node);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Share…' }));
    expect(shell.requestShare).toHaveBeenCalledWith(node);
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export…' }));
    expect(shell.requestExport).toHaveBeenCalledWith({ kind: 'node', node });
    open();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    expect(shell.requestDelete).toHaveBeenCalledWith(node);
  });

  it('offers wiki admins Use as help for…, which opens the help-link form with the page', async () => {
    clearWikiMe();
    vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: true }));
    try {
      const node = makeDetail('p1', { title: 'Rack power', my_level: 'manage', page: published });
      render(
        <MemoryRouter initialEntries={['/n/p1']}>
          <Routes>
            <Route path="/n/:nodeId" element={<PageView node={node} />} />
            <Route path="/admin/help-links" element={<Probe />} />
          </Routes>
        </MemoryRouter>,
      );
      await screen.findByText('Hello from the published page.');
      await waitFor(() => expect(getMe).toHaveBeenCalled());
      await act(async () => {});
      fireEvent.click(screen.getByRole('button', { name: 'Actions for Rack power' }));
      fireEvent.click(screen.getByRole('menuitem', { name: 'Use as help for…' }));
      expect(screen.getByTestId('probe').textContent).toBe('/admin/help-links?node=p1');
    } finally {
      clearWikiMe();
    }
  });

  it('opens Save as template… and creates one from the page', async () => {
    vi.mocked(createTemplate).mockResolvedValue({
      id: 't-1', space_id: 'space-1', space_key: 'ops', name: 'Rack power', description: '', icon: '',
      is_builtin: false, created_by: null, created_at: '2026-09-26T00:00:00Z', updated_at: '2026-09-26T00:00:00Z',
    });
    const node = makeDetail('p1', {
      title: 'Rack power', my_level: 'manage', page: published, space: makeSpace({ my_level: 'manage' }),
    });
    renderPage(node);
    await screen.findByText('Hello from the published page.');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Rack power' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save as template…' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save as template' }));
    await waitFor(() => expect(createTemplate).toHaveBeenCalledWith(expect.objectContaining({
      space_id: 'space-1', name: 'Rack power', from_node_id: 'p1',
    })));
  });
});

describe('PageView — live editing ends', () => {
  const editing = () => renderPage(makeDetail('p1', { my_level: 'edit', page: published }), '/n/p1?edit=1');

  it('blames read-only mode when the wiki is in it', async () => {
    systemStatus.read_only = true;
    editing();
    fireEvent.click(await screen.findByRole('button', { name: 'server says read-only' }));
    expect(toast).toHaveBeenCalledWith('The wiki is in read-only mode right now — showing the published version.');
    expect(screen.queryByTestId('wiki-editor')).toBeNull();
    expect(await screen.findByText('Hello from the published page.')).toBeTruthy();
  });

  it('otherwise says editing is unavailable without guessing why', async () => {
    editing();
    fireEvent.click(await screen.findByRole('button', { name: 'server says read-only' }));
    expect(toast).toHaveBeenCalledWith('You can\'t edit this page right now — showing the published version.');
  });

  it('says live editing stopped when the server refuses the connection', async () => {
    editing();
    fireEvent.click(await screen.findByRole('button', { name: 'server refuses' }));
    expect(toast.mock.calls[0][0]).toMatch(/^Live editing stopped/);
    expect(screen.queryByTestId('wiki-editor')).toBeNull();
    // back in View mode, on the published version
    expect(await screen.findByText('Hello from the published page.')).toBeTruthy();
    expect(screen.getByTestId('page-view').getAttribute('data-mode')).toBe('view');
  });
});

describe('PageView — restoring a version', () => {
  it('applies the version after the first sync, records it and clears the param', async () => {
    const content = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Old words' }] }] };
    vi.mocked(getVersion).mockReset().mockResolvedValue({
      id: 'v2', version_no: 2, kind: 'published', title: 'Rack power', note: null, created_by: null,
      created_at: PUBLISHED.created_at!, content_json: content,
    });
    vi.mocked(recordRestore).mockReset().mockResolvedValue({
      id: 'v9', version_no: 9, kind: 'restored', title: 'Rack power', note: 'Restored from version 2',
      created_by: null, created_at: PUBLISHED.created_at!,
    });
    fakeEditor.commands.setContent.mockReset();
    renderPage(makeDetail('p1', { my_level: 'edit', page: published }), '/n/p1?edit=1&restore=v2');
    await screen.findByTestId('wiki-editor');
    await waitFor(() => expect(getVersion).toHaveBeenCalledWith('p1', 'v2'));
    // nothing is applied before the editor has the live document
    expect(fakeEditor.commands.setContent).not.toHaveBeenCalled();
    expect(recordRestore).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'first sync' }));
    await waitFor(() => expect(recordRestore).toHaveBeenCalledWith('p1', 'v2'));
    expect(fakeEditor.commands.setContent).toHaveBeenCalledWith(content, true);
    // the restored content is stored before it's announced as back
    expect(editorFlush).toHaveBeenCalled();
    expect(editorFlush.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(recordRestore).mock.invocationCallOrder[0]);
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/n/p1?edit=1'));
    expect(toast).toHaveBeenCalledWith('Restored version 2. Publish when it\'s ready for readers.');
  });

  it('ignores the param for someone who can\'t edit, clearing it with a toast', async () => {
    vi.mocked(getVersion).mockReset();
    renderPage(makeDetail('p1', { my_level: 'view', page: published }), '/n/p1?edit=1&restore=v2');
    await screen.findByText('Hello from the published page.');
    expect(getVersion).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith('Couldn\'t restore — you can\'t edit this page right now.');
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/n/p1?edit=1'));
  });

  it('clears the param and tells the user when editing is blocked before the restore can apply', async () => {
    vi.mocked(getVersion).mockReset().mockReturnValue(new Promise(() => {})); // never resolves — access is lost first
    renderPage(makeDetail('p1', { my_level: 'edit', page: published }), '/n/p1?edit=1&restore=v2');
    await screen.findByTestId('wiki-editor');
    fireEvent.click(screen.getByRole('button', { name: 'server says read-only' }));
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Couldn\'t restore — you can\'t edit this page right now.'));
    await waitFor(() => expect(screen.getByTestId('probe').textContent).toBe('/n/p1?edit=1'));
    expect(screen.queryByTestId('wiki-editor')).toBeNull();
  });
});

describe('PageView — publishing the live document', () => {
  const VERSION = {
    id: 'v4', version_no: 4, kind: 'published' as const, title: 'Rack power', note: null,
    created_by: null, created_at: PUBLISHED.created_at!,
  };

  it('from View, stores whatever is being edited live before publishing', async () => {
    let stored!: () => void;
    vi.mocked(flushPage).mockReturnValue(new Promise<void>((resolve) => { stored = resolve; }));
    vi.mocked(publishPage).mockReset().mockResolvedValue(VERSION);
    renderPage(makeDetail('p1', { my_level: 'edit', page: { ...published, has_unpublished_changes: true } }));
    await screen.findByText('Hello from the published page.');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(flushPage).toHaveBeenCalledWith('p1'));
    expect(publishPage).not.toHaveBeenCalled();
    stored();
    await waitFor(() => expect(publishPage).toHaveBeenCalledWith('p1', undefined));
  });

  it('from Edit, stores this editor\'s own live document first', async () => {
    vi.mocked(publishPage).mockReset().mockResolvedValue(VERSION);
    renderPage(makeDetail('p1', { my_level: 'edit', page: published }), '/n/p1?edit=1');
    fireEvent.click(await screen.findByRole('button', { name: 'first sync' }));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Publish' }));
    await waitFor(() => expect(publishPage).toHaveBeenCalledWith('p1', undefined));
    expect(editorFlush).toHaveBeenCalledTimes(1);
    expect(flushPage).not.toHaveBeenCalled();
  });
});

describe('PageView — comments', () => {
  const MARKED: PageContentOut = {
    ...PUBLISHED,
    content_json: {
      type: 'doc',
      content: [{ type: 'paragraph', content: [
        { type: 'text', text: 'Check the ' },
        { type: 'text', text: 'spare PDU', marks: [{ type: 'commentThread', attrs: { threadId: 't1' } }] },
        { type: 'text', text: ' stock.' },
      ] }],
    },
  };
  const ada = { id: 'p-2', name: 'Ada Lovelace' };
  const THREADS: CommentThread[] = [
    { thread_id: 't1', anchor: true, resolved_at: null, resolved_by: null, comments: [
      { id: 't1', thread_id: 't1', parent_id: null, body: { text: 'Which PDU?', mentions: [] }, author: ada,
        created_at: PUBLISHED.created_at!, edited_at: null, deleted: false },
      { id: 'c2', thread_id: 't1', parent_id: 't1', body: { text: 'The grey one.', mentions: [] }, author: ada,
        created_at: PUBLISHED.created_at!, edited_at: null, deleted: false },
    ] },
    { thread_id: 't9', anchor: false, resolved_at: PUBLISHED.created_at!, resolved_by: ada, comments: [
      { id: 't9', thread_id: 't9', parent_id: null, body: { text: 'Old question', mentions: [] }, author: ada,
        created_at: PUBLISHED.created_at!, edited_at: null, deleted: false },
    ] },
  ];
  beforeEach(() => {
    vi.mocked(getPageContent).mockResolvedValue(MARKED);
    vi.mocked(listComments).mockResolvedValue(THREADS);
  });

  it('switches the rail between contents and comments, counting open threads', async () => {
    renderPage(makeDetail('p1', { my_level: 'view', page: published }));
    const tab = await screen.findByRole('button', { name: 'Comments (1)' });
    expect(screen.getByText('No headings on this page yet.')).toBeTruthy();
    fireEvent.click(tab);
    const rail = screen.getByRole('region', { name: 'Comments' });
    expect(within(rail).getByText('Which PDU?')).toBeTruthy();
    // the thread quotes the text it's on, from the page shown
    expect(within(rail).getByText('spare PDU').tagName).toBe('BLOCKQUOTE');
    expect(within(rail).getByRole('button', { name: 'Resolved (1)' })).toBeTruthy();
    // readers may comment by default
    expect(within(rail).getByRole('button', { name: 'New comment' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Contents' }));
    expect(screen.queryByRole('region', { name: 'Comments' })).toBeNull();
  });

  it('opens the comments at a linked comment', async () => {
    renderPage(makeDetail('p1', { my_level: 'view', page: published }), '/n/p1#comment-c2');
    const rail = await screen.findByRole('region', { name: 'Comments' });
    await waitFor(() => expect(rail.querySelector('#thread-t1')!.className).toContain('is-focused'));
    expect(rail.querySelector('#comment-c2')!.className).toContain('is-target');
  });

  it('picks a thread when its text is clicked, and lights the text while picked', async () => {
    renderPage(makeDetail('p1', { my_level: 'view', page: published }));
    await screen.findByRole('button', { name: 'Comments (1)' });
    const marked = await waitFor(() => {
      const el = document.querySelector<HTMLElement>('.wiki-page-content [data-comment-thread="t1"]');
      expect(el).not.toBeNull();
      return el!;
    });
    fireEvent.click(marked);
    const rail = await screen.findByRole('region', { name: 'Comments' });
    await waitFor(() => expect(rail.querySelector('#thread-t1')!.className).toContain('is-focused'));
    await waitFor(() => expect(document.querySelector('.wiki-comment-anchor.is-active')?.textContent).toBe('spare PDU'));
  });

  it('takes a deleted thread\'s marks out of the live document', async () => {
    const mine = { ...THREADS[0], comments: [{ ...THREADS[0].comments[0], author: { id: 'p-1', name: 'Jimmy Henderson' } }] };
    // the reload after the delete no longer has the thread
    vi.mocked(listComments).mockResolvedValueOnce([mine]).mockResolvedValue([]);
    vi.mocked(deleteComment).mockReset().mockResolvedValue(undefined);
    fakeEditor.commands.unsetCommentThread.mockReset();
    renderPage(makeDetail('p1', { my_level: 'edit', page: published }), '/n/p1?edit=1');
    fireEvent.click(await screen.findByRole('button', { name: 'first sync' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Comments (1)' }));
    const rail = screen.getByRole('region', { name: 'Comments' });
    // the live document has no such text: its thread is listed as on deleted text
    expect(within(rail).getByText('On deleted text (1)')).toBeTruthy();
    fireEvent.click(await within(rail).findByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(fakeEditor.commands.unsetCommentThread).toHaveBeenCalledWith('t1'));
  });

  describe('a linked comment', () => {
    const PAGE_THREAD: CommentThread = { thread_id: 't5', anchor: false, resolved_at: null, resolved_by: null, comments: [
      { id: 't5', thread_id: 't5', parent_id: null, body: { text: 'Another thing', mentions: [] }, author: ada,
        created_at: PUBLISHED.created_at!, edited_at: null, deleted: false },
    ] };
    const scroll = vi.fn();
    beforeEach(() => {
      scroll.mockReset();
      Element.prototype.scrollIntoView = scroll;
      vi.mocked(listComments).mockResolvedValue([THREADS[0], PAGE_THREAD]);
      vi.mocked(postComment).mockReset().mockResolvedValue(THREADS[0].comments[1]);
    });
    afterEach(() => { vi.useRealTimers(); });
    const target = () => document.querySelector('.wiki-comment.is-target')?.id ?? null;
    const scrolledTo = (id: string) => scroll.mock.contexts.filter((el) => (el as Element).id === id).length;

    it('is scrolled to once — not again when the comments reload', async () => {
      renderPage(makeDetail('p1', { my_level: 'view', page: published }), '/n/p1#comment-c2');
      await waitFor(() => expect(target()).toBe('comment-c2'));
      expect(scrolledTo('comment-c2')).toBe(1);
      // replying reloads the comments (listComments resolves again)
      const t1 = document.querySelector('#thread-t1') as HTMLElement;
      fireEvent.click(within(t1).getByRole('button', { name: 'Reply' }));
      fireEvent.change(within(t1).getByRole('textbox', { name: 'Reply' }), { target: { value: 'Thanks' } });
      await act(async () => { fireEvent.click(within(t1).getByRole('button', { name: 'Reply' })); });
      expect(postComment).toHaveBeenCalled();
      await waitFor(() => expect(listComments).toHaveBeenCalledTimes(2));
      await act(async () => { await Promise.resolve(); });
      expect(scrolledTo('comment-c2')).toBe(1);
    });

    it('stops standing out when another thread is picked, which then scrolls into view', async () => {
      renderPage(makeDetail('p1', { my_level: 'view', page: published }), '/n/p1#comment-c2');
      await waitFor(() => expect(target()).toBe('comment-c2'));
      fireEvent.click(screen.getByText('Another thing'));
      await waitFor(() => expect(target()).toBeNull());
      expect(document.querySelector('#thread-t5')!.className).toContain('is-focused');
      expect(scrolledTo('thread-t5')).toBe(1);
    });

    it('stops standing out after a few seconds', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      renderPage(makeDetail('p1', { my_level: 'view', page: published }), '/n/p1#comment-c2');
      await waitFor(() => expect(target()).toBe('comment-c2'));
      await act(async () => { vi.advanceTimersByTime(TARGET_HIGHLIGHT_MS); });
      expect(target()).toBeNull();
      // still the picked thread
      expect(document.querySelector('#thread-t1')!.className).toContain('is-focused');
    });
  });

  describe('a reader\'s selection', () => {
    /** Selects `[start, end)` of the page's text node reading `text`, and lets go of the mouse. */
    const select = async (text: string, start: number, end: number) => {
      const node = [...document.querySelectorAll('.wiki-page-content .ProseMirror *')]
        .flatMap((el) => [...el.childNodes]).find((n) => n.nodeType === 3 && n.textContent === text)!;
      const range = document.createRange();
      range.setStart(node, start);
      range.setEnd(node, end);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
      fireEvent.mouseUp(document);
      fireEvent.click(within(await screen.findByRole('toolbar', { name: 'Selected text' }))
        .getByRole('button', { name: 'Comment' }));
    };
    const box = () => screen.getByRole('textbox', { name: 'Comment on the selected text' }) as HTMLTextAreaElement;
    const quote = () => document.querySelector('.wiki-thread-new .wiki-thread-quote')?.textContent;

    it('follows a new selection while nothing is written, and asks before moving a draft', async () => {
      renderPage(makeDetail('p1', { my_level: 'view', page: published }));
      // Select only once the page's DOM has settled: registering the
      // highlight plugin, and the threads arriving, redraw the marked text
      // — a selection made before that is left on detached text nodes and
      // the Comment button never shows.
      await screen.findByRole('button', { name: 'Comments (1)' });
      await waitFor(() => expect(document.querySelector('.wiki-page-content .wiki-comment-anchor')).not.toBeNull());
      await select('Check the ', 0, 5);
      expect(quote()).toBe('Check');
      // nothing written yet: the new selection simply takes over
      await select(' stock.', 1, 6);
      expect(quote()).toBe('stock');
      expect(screen.queryByRole('dialog')).toBeNull();

      fireEvent.change(box(), { target: { value: 'Half a thought' } });
      await select('Check the ', 0, 5);
      const dialog = screen.getByRole('dialog');
      expect(within(dialog).getByText('Replace the selection for this comment?')).toBeTruthy();
      fireEvent.click(within(dialog).getByRole('button', { name: 'Keep the current one' }));
      expect(quote()).toBe('stock');
      expect(box().value).toBe('Half a thought');

      await select('Check the ', 0, 5);
      fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Replace' }));
      expect(quote()).toBe('Check');
      expect(box().value).toBe('Half a thought');
    });
  });

  it('offers no commenting when the space keeps readers from it', async () => {
    renderPage(makeDetail('p1', {
      my_level: 'view', page: published, space: makeSpace({ settings: { readers_can_comment: false } }),
    }));
    fireEvent.click(await screen.findByRole('button', { name: 'Comments (1)' }));
    const rail = screen.getByRole('region', { name: 'Comments' });
    expect(within(rail).queryByRole('button', { name: 'New comment' })).toBeNull();
    expect(within(rail).queryByRole('button', { name: 'Reply' })).toBeNull();
  });
});

describe('PageView — reviews', () => {
  const strict = makeSpace({ settings: { require_approval: true } });
  const review = (over: Partial<NodeReviewOut> = {}): NodeReviewOut => ({
    interval_months: 6, own_interval_months: null, next_review_at: '2026-10-03T12:00:00Z',
    last_reviewed_at: null, state: 'ok', pending_review_id: null, ...over,
  });
  /** Counts tree changes, which make NodePage refetch the node. */
  function Revision() {
    return <div data-testid="revision">{useTreeRevision()}</div>;
  }

  beforeEach(() => {
    resetTreeStore();
    vi.mocked(submitReview).mockReset().mockResolvedValue(makeReview());
    vi.mocked(getReview).mockReset().mockResolvedValue(makeReviewDetail({ created_at: '2026-09-26T10:00:00Z' }));
    vi.mocked(withdrawReview).mockReset().mockResolvedValue(makeReview({ status: 'withdrawn' }));
    vi.mocked(markReviewed).mockReset();
    vi.mocked(publishPage).mockReset();
  });

  it('has an editor submit for review where the space requires approval, storing the live document first', async () => {
    let stored!: () => void;
    vi.mocked(flushPage).mockReturnValue(new Promise<void>((resolve) => { stored = resolve; }));
    render(
      <MemoryRouter initialEntries={['/n/p1']}>
        <PageView node={makeDetail('p1', { title: 'Rack power', my_level: 'edit', page: published, space: strict })} />
        <Revision />
      </MemoryRouter>,
    );
    await screen.findByText('Hello from the published page.');
    expect(screen.queryByRole('button', { name: 'Publish' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Submit for review' }));
    const dialog = screen.getByRole('dialog', { name: 'Submit “Rack power” for review' });
    fireEvent.change(within(dialog).getByLabelText(/Note for the reviewer/), { target: { value: 'New breakers' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(flushPage).toHaveBeenCalledWith('p1'));
    expect(submitReview).not.toHaveBeenCalled();
    stored();
    await waitFor(() => expect(submitReview).toHaveBeenCalledWith('p1', 'New breakers'));
    expect(publishPage).not.toHaveBeenCalled();
    // the node is refetched, so the pending banner shows up
    await waitFor(() => expect(screen.getByTestId('revision').textContent).not.toBe('0'));
  });

  it('lets a manager publish directly where the space requires approval', async () => {
    renderPage(makeDetail('p1', { my_level: 'manage', page: published, space: strict }));
    await screen.findByText('Hello from the published page.');
    expect(screen.getByRole('button', { name: 'Publish' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Submit for review' })).toBeNull();
  });

  it('switches to submitting for review when a publish is refused as needing review', async () => {
    vi.mocked(publishPage).mockRejectedValue(new ApiError(409, 'review_required'));
    renderPage(makeDetail('p1', { title: 'Rack power', my_level: 'edit', page: published }));
    await screen.findByText('Hello from the published page.');
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Publish' }));
    expect(await screen.findByRole('dialog', { name: 'Submit “Rack power” for review' })).toBeTruthy();
    // the header's button reads that way from now on
    expect(document.querySelector('.wiki-publish-btn')!.textContent).toBe('Submit for review');
    expect(toast).toHaveBeenCalledWith('This library needs a manager\'s approval — submit your changes for review.');
  });

  it('shows my pending request with Withdraw, and no Review now for an editor', async () => {
    vi.mocked(getReview).mockResolvedValue(makeReviewDetail({
      created_at: '2026-09-26T10:00:00Z', requested_by: { id: 'p-1', name: 'Jimmy Henderson' },
    }));
    renderPage(makeDetail('p1', {
      my_level: 'edit', page: published, space: strict, review: review({ pending_review_id: 'r1' }),
    }));
    const banner = await screen.findByRole('status', { name: 'Pending review' });
    await waitFor(() => expect(banner.textContent).toMatch(/^Waiting for review since /));
    expect(getReview).toHaveBeenCalledWith('r1');
    expect(within(banner).queryByRole('link', { name: 'Review now' })).toBeNull();
    fireEvent.click(within(banner).getByRole('button', { name: 'Withdraw' }));
    await waitFor(() => expect(withdrawReview).toHaveBeenCalledWith('r1'));
    expect(toast).toHaveBeenCalledWith('Review request withdrawn.');
  });

  it('gives a manager Review now and Withdraw on someone else\'s request', async () => {
    renderPage(makeDetail('p1', {
      my_level: 'manage', page: published, space: strict, review: review({ pending_review_id: 'r1' }),
    }));
    const banner = await screen.findByRole('status', { name: 'Pending review' });
    expect(within(banner).getByRole('link', { name: 'Review now' }).getAttribute('href')).toBe('/reviews/r1');
    await waitFor(() => expect(within(banner).getByText(/Requested by Ada Lovelace/)).toBeTruthy());
    expect(within(banner).getByRole('button', { name: 'Withdraw' })).toBeTruthy();
  });

  it('shows another editor\'s request without Withdraw', async () => {
    renderPage(makeDetail('p1', {
      my_level: 'edit', page: published, space: strict, review: review({ pending_review_id: 'r1' }),
    }));
    const banner = await screen.findByRole('status', { name: 'Pending review' });
    await waitFor(() => expect(within(banner).getByText(/Requested by Ada Lovelace/)).toBeTruthy());
    expect(within(banner).queryByRole('button', { name: 'Withdraw' })).toBeNull();
  });

  it('shows the review-due chip, and lets an editor mark the page reviewed', async () => {
    vi.mocked(markReviewed).mockResolvedValue(makeNode('p1', { review: review() }));
    renderPage(makeDetail('p1', { my_level: 'edit', page: published, review: review({ state: 'due_soon' }) }));
    await screen.findByText('Hello from the published page.');
    expect(screen.getByText(`Review due ${longDate('2026-10-03T12:00:00Z')}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Mark as reviewed' }));
    await waitFor(() => expect(markReviewed).toHaveBeenCalledWith('p1'));
    expect(toast).toHaveBeenCalledWith('Marked as reviewed. The next review is in 6 months.');
  });

  it('shows readers an overdue chip but no Mark as reviewed', async () => {
    renderPage(makeDetail('p1', { my_level: 'view', page: published, review: review({ state: 'overdue' }) }));
    await screen.findByText('Hello from the published page.');
    expect(screen.getByText('Review overdue')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Mark as reviewed' })).toBeNull();
  });

  it('opens Review schedule… from the ⋯ menu for managers', async () => {
    renderPage(makeDetail('p1', { title: 'Rack power', my_level: 'manage', page: published, review: review() }));
    await screen.findByText('Hello from the published page.');
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Rack power' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Review schedule…' }));
    expect(screen.getByRole('dialog', { name: 'Review schedule for “Rack power”' })).toBeTruthy();
  });
});
