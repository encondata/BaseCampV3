// @vitest-environment jsdom
import '../testing/pmDom';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.fn();
vi.mock('@portal/lib/notificationsContext', () => ({ useToast: () => toast }));
vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ person: { id: 'p-1' } }) }));
vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getMe: vi.fn(),
  getFileUrl: vi.fn(),
  listFileVersions: vi.fn(),
  updateFile: vi.fn(),
  restoreFileVersion: vi.fn(),
  getAssetUrls: vi.fn().mockResolvedValue({}),
}));
vi.mock('../lib/download', () => ({ openDownload: vi.fn() }));
vi.mock('../lib/treeStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/treeStore')>()),
  noteChanged: vi.fn(),
}));
vi.mock('../uploads/uploadQueue', () => ({ enqueue: vi.fn() }));
vi.mock('../analytics/useRecordView', () => ({ useRecordView: vi.fn() }));
// pdf.js draws in a real browser; here it's a stand-in with one page
vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: {},
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: 1,
      getPage: async () => ({
        getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }),
        render: () => ({ promise: Promise.resolve() }),
      }),
    }),
    destroy: () => Promise.resolve(),
  }),
}));
vi.mock('pdfjs-dist/build/pdf.worker.min.mjs?url', () => ({ default: '/worker.js' }));

import { openDownload } from '../lib/download';
import { noteChanged } from '../lib/treeStore';
import type { FileVersionOut, NodeDetailOut } from '../lib/types';
import { clearWikiMe } from '../lib/useWikiMe';
import { getFileUrl, getMe, listFileVersions, restoreFileVersion, updateFile } from '../lib/wikiApi';
import { makeDetail, makeMe, makeNode } from '../testing/fixtures';
import { enqueue } from '../uploads/uploadQueue';
import { useRecordView } from '../analytics/useRecordView';
import FileView, { MAX_TEXT_PREVIEW } from './FileView';

function version(no: number, over: Partial<FileVersionOut> = {}): FileVersionOut {
  return {
    id: `v${no}`, version_no: no, filename: 'floorplan.pdf', content_type: 'application/pdf',
    size_bytes: 2_500_000, preview_kind: 'native', preview_status: 'ready', extract_status: 'ready',
    note: null, uploaded_by: { id: 'p2', name: 'Ana Ortiz' }, created_at: '2026-09-20T12:00:00Z', ...over,
  };
}

function fileNode(current: FileVersionOut, over: Partial<NodeDetailOut> = {}): NodeDetailOut {
  return makeDetail('file-1', {
    kind: 'file',
    title: current.filename,
    page: null,
    file: { description: 'Second floor', current_version: current },
    breadcrumbs: [{ id: 'f1', title: 'Guides', kind: 'folder' }],
    ...over,
  });
}

function renderFile(node: NodeDetailOut) {
  return render(<MemoryRouter><FileView node={node} /></MemoryRouter>);
}

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  toast.mockReset();
  clearWikiMe();
  vi.mocked(getMe).mockReset().mockResolvedValue(makeMe());
  vi.mocked(getFileUrl).mockReset().mockResolvedValue({
    url: 'https://s3/inline', content_type: 'application/pdf', preview_status: 'ready',
  });
  vi.mocked(listFileVersions).mockReset().mockResolvedValue([version(2), version(1, { filename: 'old-plan.pdf' })]);
  vi.mocked(updateFile).mockReset();
  vi.mocked(restoreFileVersion).mockReset();
  vi.mocked(openDownload).mockReset();
  vi.mocked(noteChanged).mockReset();
  vi.mocked(enqueue).mockReset();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('FileView previews', () => {
  it('shows an image inline', async () => {
    const node = fileNode(version(1, { filename: 'rack.png', content_type: 'image/png' }));
    vi.mocked(getFileUrl).mockResolvedValue({ url: 'https://s3/rack', content_type: 'image/png', preview_status: 'ready' });
    renderFile(node);
    const img = await screen.findByRole('img', { name: 'rack.png' });
    expect(img.getAttribute('src')).toBe('https://s3/rack');
    expect(getFileUrl).toHaveBeenCalledWith('file-1', { disposition: 'inline' });
    // breadcrumbs, title
    const crumbs = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumbs).getByRole('link', { name: 'Guides' }).getAttribute('href')).toBe('/n/f1');
    expect(screen.getByRole('heading', { name: 'rack.png' })).toBeTruthy();
  });

  it('marks a private or no-print file with chips in the header', async () => {
    renderFile(fileNode(version(2), { is_private: true, can_print: false }));
    await screen.findByLabelText('Preview of floorplan.pdf');
    const head = document.querySelector('.wiki-page-head') as HTMLElement;
    expect(within(head).getByText('Private')).toBeTruthy();
    expect(within(head).getByText('Printing off')).toBeTruthy();
  });

  it('shows a PDF in the browser\'s own viewer', async () => {
    renderFile(fileNode(version(2)));
    const frame = await screen.findByTitle('Preview of floorplan.pdf');
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('src')).toBe('https://s3/inline');
  });

  it('plays video and audio', async () => {
    vi.mocked(getFileUrl).mockResolvedValue({ url: 'https://s3/clip', content_type: 'video/mp4', preview_status: 'ready' });
    renderFile(fileNode(version(1, { filename: 'walkthrough.mp4', content_type: 'video/mp4' })));
    await vi.waitFor(() => expect(document.querySelector('video')?.getAttribute('src')).toBe('https://s3/clip'));
    cleanup();
    renderFile(fileNode(version(1, { filename: 'note.mp3', content_type: 'audio/mpeg' })));
    await vi.waitFor(() => expect(document.querySelector('audio')?.getAttribute('src')).toBe('https://s3/clip'));
  });

  it('waits for an office document\'s preview, polling every 3 seconds', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.mocked(getFileUrl)
      .mockResolvedValueOnce({ url: null, content_type: 'application/pdf', preview_status: 'pending' })
      .mockResolvedValueOnce({ url: null, content_type: 'application/pdf', preview_status: 'pending' })
      .mockResolvedValue({ url: 'https://s3/preview.pdf', content_type: 'application/pdf', preview_status: 'ready' });
    const docx = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    renderFile(fileNode(version(1, {
      filename: 'plan.docx', content_type: docx, preview_kind: 'pdf', preview_status: 'pending',
    })));
    expect(await screen.findByText('Preparing preview…')).toBeTruthy();
    expect(getFileUrl).toHaveBeenCalledWith('file-1', { preview: true });
    await act(() => vi.advanceTimersByTimeAsync(3000));
    expect(getFileUrl).toHaveBeenCalledTimes(2);
    expect(screen.getByText('Preparing preview…')).toBeTruthy();
    await act(() => vi.advanceTimersByTimeAsync(3000));
    const frame = await screen.findByTitle('Preview of plan.docx');
    expect(frame.getAttribute('src')).toBe('https://s3/preview.pdf');
    await act(() => vi.advanceTimersByTimeAsync(9000));
    expect(getFileUrl).toHaveBeenCalledTimes(3);
  });

  it('offers a download when the preview failed, or there is none', async () => {
    vi.mocked(getFileUrl).mockResolvedValue({ url: null, content_type: 'application/pdf', preview_status: 'failed' });
    renderFile(fileNode(version(1, { filename: 'plan.xlsx', content_type: 'application/vnd.ms-excel', preview_kind: 'pdf', preview_status: 'failed' })));
    expect(await screen.findByText('No preview — download to open')).toBeTruthy();
    cleanup();
    vi.mocked(getFileUrl).mockClear();
    renderFile(fileNode(version(1, { filename: 'bundle.zip', content_type: 'application/zip', preview_kind: 'none', preview_status: 'skipped' })));
    expect(await screen.findByText('No preview — download to open')).toBeTruthy();
    expect(getFileUrl).not.toHaveBeenCalled();
  });

  it('shows a text file as text', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('line one\n<b>not bold</b>'));
    vi.stubGlobal('fetch', fetchMock);
    renderFile(fileNode(version(1, { filename: 'notes.txt', content_type: 'text/plain', size_bytes: 30 })));
    const pre = await screen.findByText(/line one/);
    expect(pre.tagName).toBe('PRE');
    expect(pre.textContent).toBe('line one\n<b>not bold</b>');
    expect(fetchMock).toHaveBeenCalledWith('https://s3/inline', expect.objectContaining({ credentials: 'omit' }));
  });

  it('renders Markdown through the wiki schema, never as raw HTML', async () => {
    const md = '# Cutover\n\nSome **bold** text <img src=x onerror="globalThis.__pwned=1">\n\n<script>globalThis.__pwned=2</script>';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(md)));
    renderFile(fileNode(version(1, { filename: 'README.md', content_type: 'text/markdown', size_bytes: md.length })));
    const article = await screen.findByRole('article', { name: 'Page content' });
    await vi.waitFor(() => expect(within(article).getByRole('heading', { name: 'Cutover' })).toBeTruthy());
    expect(within(article).getByText('bold').tagName).toBe('STRONG');
    expect(article.querySelector('img, script')).toBeNull();
    await new Promise((r) => setTimeout(r, 10));
    expect((globalThis as Record<string, unknown>).__pwned).toBeUndefined();
  });

  it('won\'t fetch a text file over 2 MB', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderFile(fileNode(version(1, { filename: 'big.log', content_type: 'text/plain', size_bytes: MAX_TEXT_PREVIEW + 1 })));
    expect(await screen.findByText('This file is too large to preview — download to open.')).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(MAX_TEXT_PREVIEW).toBe(2 * 1024 * 1024);
  });
});

describe('FileView — printing off', () => {
  const off = (current: FileVersionOut, over: Partial<NodeDetailOut> = {}) =>
    fileNode(current, { can_print: false, ...over });

  afterEach(() => { delete document.body.dataset.noPrint; });

  it('has no Download, no version Download column and no Share…, and guards printing', async () => {
    renderFile(off(version(2), { my_level: 'manage' }));
    const table = await screen.findByRole('table', { name: 'Versions' });
    await within(table).findByText('old-plan.pdf');
    expect(screen.queryByRole('button', { name: 'Download' })).toBeNull();
    expect(within(table).queryByRole('button', { name: /Download version/ })).toBeNull();
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent))
      .toEqual(['No.', 'File name', 'Size', 'Uploaded by', 'When', 'Restore']);
    // Upload new version and Restore are not downloads
    expect(screen.getByRole('button', { name: 'Upload new version' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for floorplan.pdf' }));
    expect(screen.getByRole('menuitem', { name: 'Permissions…' })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: 'Share…' })).toBeNull();
    expect(document.body.dataset.noPrint).toBe('1');
    expect(document.querySelector('.wiki-print-blocked')?.textContent).toBe('Printing is turned off for this page.');
    fireEvent.keyDown(window, { key: 'p', ctrlKey: true });
    expect(toast).toHaveBeenCalledWith('Printing is turned off for this page.');
  });

  it('draws a PDF on canvases instead of the browser\'s viewer', async () => {
    renderFile(off(version(2)));
    const viewer = await screen.findByLabelText('Preview of floorplan.pdf');
    expect(viewer.classList.contains('wiki-pdf-viewer')).toBe(true);
    await vi.waitFor(() => expect(viewer.querySelector('canvas')).not.toBeNull());
    expect(document.querySelector('iframe, object, embed')).toBeNull();
  });

  it('draws an office document\'s PDF on canvases too', async () => {
    vi.mocked(getFileUrl).mockResolvedValue({ url: 'https://s3/preview.pdf', content_type: 'application/pdf', preview_status: 'ready' });
    renderFile(off(version(1, {
      filename: 'plan.docx', content_type: 'application/msword', preview_kind: 'pdf', preview_status: 'ready',
    })));
    await screen.findByLabelText('Preview of plan.docx');
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('takes the download, rate and picture-in-picture controls off video and audio', async () => {
    vi.mocked(getFileUrl).mockResolvedValue({ url: 'https://s3/clip', content_type: 'video/mp4', preview_status: 'ready' });
    renderFile(off(version(1, { filename: 'walkthrough.mp4', content_type: 'video/mp4' })));
    const video = await vi.waitFor(() => {
      const el = document.querySelector('video');
      if (!el) throw new Error('no video yet');
      return el;
    });
    expect(video.getAttribute('controlslist')).toBe('nodownload noplaybackrate');
    expect(video.hasAttribute('disablepictureinpicture')).toBe(true);
    expect(fireEvent.contextMenu(video)).toBe(false);
    cleanup();
    renderFile(off(version(1, { filename: 'note.mp3', content_type: 'audio/mpeg' })));
    const audio = await vi.waitFor(() => {
      const el = document.querySelector('audio');
      if (!el) throw new Error('no audio yet');
      return el;
    });
    expect(audio.getAttribute('controlslist')).toBe('nodownload noplaybackrate');
    expect(fireEvent.contextMenu(audio)).toBe(false);
  });

  it('turns the context menu off on an image', async () => {
    vi.mocked(getFileUrl).mockResolvedValue({ url: 'https://s3/rack', content_type: 'image/png', preview_status: 'ready' });
    renderFile(off(version(1, { filename: 'rack.png', content_type: 'image/png' })));
    const img = await screen.findByRole('img', { name: 'rack.png' });
    expect(fireEvent.contextMenu(img)).toBe(false);
  });

  it('doesn\'t send a reader to a download when there is no preview', async () => {
    renderFile(off(version(1, { filename: 'bundle.zip', content_type: 'application/zip', preview_kind: 'none', preview_status: 'skipped' })));
    expect(await screen.findByText('No preview available.')).toBeTruthy();
    expect(screen.queryByText(/download to open/)).toBeNull();
  });

  it('leaves everything as it was when printing is on', async () => {
    renderFile(fileNode(version(2)));
    const frame = await screen.findByTitle('Preview of floorplan.pdf');
    expect(frame.tagName).toBe('IFRAME');
    expect(screen.getByRole('button', { name: 'Download' })).toBeTruthy();
    expect(document.body.dataset.noPrint).toBeUndefined();
    expect(document.querySelector('.wiki-pdf-viewer')).toBeNull();
  });
});

describe('FileView details', () => {
  it('lists the versions with download and restore', async () => {
    const restored = version(3, { note: 'Restored from version 1' });
    vi.mocked(restoreFileVersion).mockResolvedValue(restored);
    vi.mocked(getFileUrl).mockImplementation(async (_id, params) => ({
      url: params?.disposition === 'attachment' ? `https://s3/dl/${params.version_id ?? 'current'}` : 'https://s3/inline',
      content_type: 'application/pdf',
      preview_status: 'ready',
    }));
    const node = fileNode(version(2));
    renderFile(node);
    const table = await screen.findByRole('table', { name: 'Versions' });
    const headers = within(table).getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers).toEqual(['No.', 'File name', 'Size', 'Uploaded by', 'When', 'Download', 'Restore']);
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(2);
    expect(within(rows[0]).getByText('2')).toBeTruthy();
    expect(within(rows[0]).getByText('Current')).toBeTruthy();
    expect(within(rows[1]).getByText('old-plan.pdf')).toBeTruthy();
    expect(within(rows[1]).getByText('2.4 MB')).toBeTruthy();
    expect(within(rows[1]).getByText('Ana Ortiz')).toBeTruthy();
    // the current version can't be restored
    expect(within(rows[0]).queryByRole('button', { name: /Restore/ })).toBeNull();

    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Download version 1' }));
    await vi.waitFor(() => expect(openDownload).toHaveBeenCalledWith('https://s3/dl/v1'));
    expect(getFileUrl).toHaveBeenCalledWith('file-1', { version_id: 'v1', disposition: 'attachment' });

    fireEvent.click(within(rows[1]).getByRole('button', { name: 'Restore version 1' }));
    await vi.waitFor(() => expect(restoreFileVersion).toHaveBeenCalledWith('file-1', 'v1'));
    await vi.waitFor(() => expect(noteChanged).toHaveBeenCalled());
    expect(toast).toHaveBeenCalledWith('Restored version 1 as version 3.');

    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    await vi.waitFor(() => expect(openDownload).toHaveBeenCalledWith('https://s3/dl/current'));
  });

  it('saves the description on blur, only when it changed', async () => {
    vi.mocked(updateFile).mockResolvedValue(makeNode('file-1', { kind: 'file', page: null }));
    renderFile(fileNode(version(2)));
    const box = screen.getByLabelText('Description') as HTMLTextAreaElement;
    expect(box.value).toBe('Second floor');
    fireEvent.blur(box);
    expect(updateFile).not.toHaveBeenCalled();
    fireEvent.change(box, { target: { value: 'Second floor, east wing' } });
    fireEvent.blur(box);
    await vi.waitFor(() => expect(updateFile).toHaveBeenCalledWith('file-1', 'Second floor, east wing'));
    await vi.waitFor(() => expect(noteChanged).toHaveBeenCalled());
  });

  it('uploads a new version through the upload tray', async () => {
    renderFile(fileNode(version(2)));
    const input = screen.getByLabelText('Upload new version') as HTMLInputElement;
    const next = new File(['v3'], 'floorplan-v3.pdf', { type: 'application/pdf' });
    fireEvent.change(input, { target: { files: [next] } });
    expect(enqueue).toHaveBeenCalledWith([next], { kind: 'version', nodeId: 'file-1', label: 'floorplan.pdf' });
  });

  it('gives a viewer the file read-only', async () => {
    renderFile(fileNode(version(2), { my_level: 'view' }));
    const table = await screen.findByRole('table', { name: 'Versions' });
    expect(within(table).queryByRole('button', { name: /Restore/ })).toBeNull();
    expect(within(table).getAllByRole('button', { name: /Download version/ })).toHaveLength(2);
    expect(screen.queryByLabelText('Upload new version')).toBeNull();
    expect(screen.queryByLabelText('Description')).toBeNull();
    expect(screen.getByText('Second floor')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Rename/ })).toBeNull();
  });

  it('offers wiki admins Use as help for…, which opens the help-link form with the file', async () => {
    vi.mocked(getMe).mockResolvedValue(makeMe({ is_admin: true }));
    function Probe() {
      const loc = useLocation();
      return <div data-testid="probe">{loc.pathname}{loc.search}</div>;
    }
    const node = fileNode(version(2), { my_level: 'view' });
    render(
      <MemoryRouter initialEntries={['/n/file-1']}>
        <Routes>
          <Route path="/n/:nodeId" element={<FileView node={node} />} />
          <Route path="/admin/help-links" element={<Probe />} />
        </Routes>
      </MemoryRouter>,
    );
    await screen.findByRole('table', { name: 'Versions' });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Actions for floorplan.pdf' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Use as help for…' }));
    expect(screen.getByTestId('probe').textContent).toBe('/admin/help-links?node=file-1');
  });

  it('leaves Use as help for… out for everyone else', async () => {
    renderFile(fileNode(version(2), { my_level: 'manage' }));
    await screen.findByRole('table', { name: 'Versions' });
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Actions for floorplan.pdf' }));
    expect(screen.queryByRole('menuitem', { name: 'Use as help for…' })).toBeNull();
  });
});

describe('FileView — analytics', () => {
  it('counts a view of the file', async () => {
    renderFile(fileNode(version(1)));
    expect(useRecordView).toHaveBeenCalledWith('file-1', true);
    await act(async () => {});
  });
});
