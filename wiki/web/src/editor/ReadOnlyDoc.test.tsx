// @vitest-environment jsdom
import '../testing/pmDom';

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getAssetUrls: vi.fn(),
  getNode: vi.fn(),
  getFileUrl: vi.fn(),
}));

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

import { ApiError } from '@portal/lib/api';

import { clearAssetUrls } from '../lib/assetUrls';
import { clearNodeTitles } from '../lib/nodeTitles';
import { CanPrintContext } from '../lib/printPolicy';
import { clearPersonNames, rememberPersonNames } from '../lib/personNames';
import { getAssetUrls, getFileUrl, getNode } from '../lib/wikiApi';
import { makeDetail } from '../testing/fixtures';
import ReadOnlyDoc from './ReadOnlyDoc';

const SHOWN = '0f4d6a2e-3b1c-4c7e-9a55-1d2e3f405162';
const HIDDEN = '1f4d6a2e-3b1c-4c7e-9a55-1d2e3f405162';

const doc = {
  type: 'doc',
  content: [
    { type: 'paragraph', content: [
      { type: 'text', text: 'See ' },
      { type: 'pageLink', attrs: { nodeId: 'n-live', title: 'Old title' } },
      { type: 'text', text: ' and ' },
      { type: 'pageLink', attrs: { nodeId: 'n-gone', title: 'Secret page' } },
    ] },
    { type: 'wikiImage', attrs: { assetId: SHOWN, alt: 'Rack front', caption: 'Rack 12', width: null } },
    { type: 'wikiImage', attrs: { assetId: HIDDEN, alt: 'Hidden', caption: '', width: null } },
    { type: 'details', content: [
      { type: 'detailsSummary', content: [{ type: 'text', text: 'More' }] },
      { type: 'detailsContent', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Tucked away' }] }] },
    ] },
  ],
};

beforeEach(() => {
  clearAssetUrls();
  clearNodeTitles();
  vi.mocked(getAssetUrls).mockResolvedValue({ [SHOWN]: 'https://s3/rack.png' });
  vi.mocked(getNode).mockImplementation(async (id) => {
    if (id === 'n-live') return makeDetail('n-live', { title: 'Cabling standards' });
    throw new ApiError(404, 'not_found');
  });
});
afterEach(cleanup);

describe('ReadOnlyDoc', () => {
  it('renders images by asset URL and a placeholder for one that is not viewable', async () => {
    render(<MemoryRouter><ReadOnlyDoc content={doc} /></MemoryRouter>);
    const img = await screen.findByRole('img', { name: 'Rack front' });
    expect(img.getAttribute('src')).toBe('https://s3/rack.png');
    expect(screen.getByText('Rack 12')).toBeTruthy();
    expect(await screen.findByText('Image unavailable')).toBeTruthy();
    expect(getAssetUrls).toHaveBeenCalledTimes(1);
  });

  it('opens an image full size in the viewer when clicked, and closes it', async () => {
    render(<MemoryRouter><ReadOnlyDoc content={doc} /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'View full size: Rack front' }));
    const dialog = screen.getByRole('dialog', { name: 'Rack 12' });
    expect(within(dialog).getByRole('img', { name: 'Rack front' }).getAttribute('src')).toBe('https://s3/rack.png');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows page links by their current title, or "Missing page"', async () => {
    render(<MemoryRouter><ReadOnlyDoc content={doc} /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Cabling standards' })).toBeTruthy();
    expect(await screen.findByText('Missing page')).toBeTruthy();
    expect(screen.queryByText('Secret page')).toBeNull();
  });

  it('shows mentions by the current name when known, else the stored label', async () => {
    clearPersonNames();
    rememberPersonNames([{ id: 'p-renamed', name: 'Pat Smith' }]);
    const { container } = render(<MemoryRouter><ReadOnlyDoc content={para(
      { type: 'mention', attrs: { personId: 'p-renamed', label: 'Pat Doe' } },
      { type: 'text', text: ' and ' },
      { type: 'mention', attrs: { personId: 'p-other', label: 'Sam Roe' } },
    )} /></MemoryRouter>);
    expect(await screen.findByText('@Pat Smith')).toBeTruthy();
    expect(screen.getByText('@Sam Roe')).toBeTruthy();
    expect(screen.queryByText('@Pat Doe')).toBeNull();
    const chips = container.querySelectorAll('.wiki-mention');
    expect([...chips].map((c) => c.getAttribute('data-mention'))).toEqual(['p-renamed', 'p-other']);
  });

  it('marks text a comment thread is anchored to', async () => {
    const { container } = render(<MemoryRouter><ReadOnlyDoc content={para(
      { type: 'text', text: 'spare PDU', marks: [{ type: 'commentThread', attrs: { threadId: 't-1' } }] },
    )} /></MemoryRouter>);
    await screen.findByText('spare PDU');
    const mark = container.querySelector('.wiki-comment-mark');
    expect(mark?.getAttribute('data-comment-thread')).toBe('t-1');
    expect(mark?.textContent).toBe('spare PDU');
  });

  it('keeps a collapsible section closed until toggled', async () => {
    render(<MemoryRouter><ReadOnlyDoc content={doc} /></MemoryRouter>);
    const toggle = await screen.findByRole('button', { name: 'Expand section' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[contenteditable="true"]')).toBeNull();
  });
});

const para = (...content: object[]) => ({ type: 'doc', content: [{ type: 'paragraph', content }] });

describe('ReadOnlyDoc — unverified targets', () => {
  it('never shows a page link\'s stored title while loading or after a failed lookup', async () => {
    let fail!: (e: unknown) => void;
    vi.mocked(getNode).mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
    render(<MemoryRouter><ReadOnlyDoc content={para(
      { type: 'pageLink', attrs: { nodeId: 'n-slow', title: 'Stored secret title' } },
    )} /></MemoryRouter>);
    expect(await screen.findByText('Loading…')).toBeTruthy();
    expect(screen.queryByText(/Stored secret title/)).toBeNull();
    fail(new Error('network down'));
    expect(await screen.findByText('Couldn\'t load link')).toBeTruthy();
    expect(screen.queryByText(/Stored secret title/)).toBeNull();
    expect(screen.queryByText('Missing page')).toBeNull();
  });

  describe('a failed lookup (not 404/403)', () => {
    beforeEach(() => { vi.mocked(getNode).mockClear(); vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] }); });
    afterEach(() => { vi.useRealTimers(); });
    const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

    it('retries once after 5 s and then shows the title', async () => {
      vi.mocked(getNode)
        .mockRejectedValueOnce(new Error('network down'))
        .mockResolvedValueOnce(makeDetail('n-flaky', { title: 'Cabling standards' }));
      render(<MemoryRouter><ReadOnlyDoc content={para(
        { type: 'pageLink', attrs: { nodeId: 'n-flaky', title: '' } },
      )} /></MemoryRouter>);
      await flush(0);
      expect(screen.getByText('Couldn\'t load link')).toBeTruthy();
      expect(getNode).toHaveBeenCalledTimes(1);
      await flush(4900);
      expect(getNode).toHaveBeenCalledTimes(1);
      await flush(200);
      expect(getNode).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('link', { name: 'Cabling standards' })).toBeTruthy();
    });

    it('retries only once', async () => {
      vi.mocked(getNode).mockReset().mockRejectedValue(new Error('network down'));
      render(<MemoryRouter><ReadOnlyDoc content={para(
        { type: 'pageLink', attrs: { nodeId: 'n-down', title: '' } },
      )} /></MemoryRouter>);
      await flush(0);
      await flush(5100);
      await flush(20_000);
      expect(getNode).toHaveBeenCalledTimes(2);
      expect(screen.getByText('Couldn\'t load link')).toBeTruthy();
    });
  });

  it('encodes node ids in the links it builds', async () => {
    vi.mocked(getNode).mockResolvedValue(makeDetail('a/b?x', { title: 'Odd id' }));
    render(<MemoryRouter><ReadOnlyDoc content={para(
      { type: 'pageLink', attrs: { nodeId: 'a/b?x', title: '' } },
    )} /></MemoryRouter>);
    expect((await screen.findByRole('link', { name: 'Odd id' })).getAttribute('href')).toBe('/n/a%2Fb%3Fx');
  });

  it('shows "File unavailable", not the stored file name, for a file the reader can\'t view', async () => {
    vi.mocked(getFileUrl).mockRejectedValue(new ApiError(404, 'not_found'));
    render(<MemoryRouter><ReadOnlyDoc content={{ type: 'doc', content: [{
      type: 'fileEmbed',
      attrs: { nodeId: 'f-hidden', assetId: null, filename: 'salaries-2026.xlsx', contentType: '' },
    }] }} /></MemoryRouter>);
    expect(await screen.findByText('File unavailable')).toBeTruthy();
    expect(screen.queryByText(/salaries/)).toBeNull();
    expect(screen.queryByRole('link', { name: /Open/ })).toBeNull();
  });

  it('shows a file node embed by the file\'s current title, never the stored name', async () => {
    vi.mocked(getFileUrl).mockResolvedValue({ url: 'https://s3/f', content_type: 'application/zip', preview_status: 'none' });
    vi.mocked(getNode).mockImplementation(async (id) => {
      if (id === 'f-live') return makeDetail('f-live', { title: 'Current name.zip', kind: 'file' });
      throw new ApiError(404, 'not_found');
    });
    render(<MemoryRouter><ReadOnlyDoc content={{ type: 'doc', content: [{
      type: 'fileEmbed',
      attrs: { nodeId: 'f-live', assetId: null, filename: 'Old name.zip', contentType: '' },
    }] }} /></MemoryRouter>);
    expect(await screen.findByText('Current name.zip')).toBeTruthy();
    expect(screen.queryByText('Old name.zip')).toBeNull();
  });
});

describe('ReadOnlyDoc — public mode (a public share link)', () => {
  const PDF = '2f4d6a2e-3b1c-4c7e-9a55-1d2e3f405162';
  const publicDoc = {
    type: 'doc',
    content: [
      { type: 'paragraph', content: [
        { type: 'text', text: 'See ' },
        { type: 'pageLink', attrs: { nodeId: 'n-live', title: 'Secret page' } },
        { type: 'text', text: ' and ' },
        { type: 'mention', attrs: { personId: null, label: 'Pat Doe' } },
      ] },
      { type: 'wikiImage', attrs: { assetId: SHOWN, alt: 'Rack front', caption: '', width: null } },
      { type: 'wikiImage', attrs: { assetId: HIDDEN, alt: 'Hidden', caption: '', width: null } },
      { type: 'fileEmbed', attrs: { nodeId: null, assetId: PDF, filename: 'spec.pdf', contentType: 'application/pdf' } },
      { type: 'fileEmbed', attrs: { nodeId: 'f-other', assetId: null, filename: '', contentType: '' } },
    ],
  };

  beforeEach(() => {
    vi.mocked(getAssetUrls).mockClear();
    vi.mocked(getNode).mockClear();
    vi.mocked(getFileUrl).mockClear();
  });

  it('shows images and files from the given URLs and asks the API for nothing', async () => {
    render(<MemoryRouter><ReadOnlyDoc content={publicDoc}
      publicAssets={{ [SHOWN]: 'https://s3/public-rack.png', [PDF]: 'https://s3/spec.pdf' }} /></MemoryRouter>);
    const img = await screen.findByRole('img', { name: 'Rack front' });
    expect(img.getAttribute('src')).toBe('https://s3/public-rack.png');
    expect(await screen.findByText('Image unavailable')).toBeTruthy();
    expect(screen.getByText('spec.pdf')).toBeTruthy();
    expect(screen.getByRole('link', { name: /Download/ }).getAttribute('href')).toBe('https://s3/spec.pdf');
    // an embed of another wiki file: unavailable, no Open link into the wiki
    expect(screen.getByText('File unavailable')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Open/ })).toBeNull();
    expect(screen.getByText('@Pat Doe')).toBeTruthy();
    expect(getAssetUrls).not.toHaveBeenCalled();
    expect(getNode).not.toHaveBeenCalled();
    expect(getFileUrl).not.toHaveBeenCalled();
  });

  it('renders a page link as plain text, never a link or its stored title', async () => {
    const { container } = render(<MemoryRouter><ReadOnlyDoc content={publicDoc} publicAssets={{}} /></MemoryRouter>);
    expect(await screen.findByText('Linked page')).toBeTruthy();
    expect(container.querySelector('.wiki-page-link a')).toBeNull();
    expect(screen.queryByText(/Secret page/)).toBeNull();
    expect(getNode).not.toHaveBeenCalled();
  });
});

describe('ReadOnlyDoc — printing off', () => {
  const ASSET_PDF = '3f4d6a2e-3b1c-4c7e-9a55-1d2e3f405162';
  const ASSET_ZIP = '4f4d6a2e-3b1c-4c7e-9a55-1d2e3f405162';
  const embed = (attrs: Record<string, unknown>) => ({ type: 'doc', content: [{ type: 'fileEmbed', attrs }] });
  const offDoc = (content: unknown) => render(
    <MemoryRouter>
      <CanPrintContext.Provider value={false}><ReadOnlyDoc content={content as never} /></CanPrintContext.Provider>
    </MemoryRouter>,
  );

  beforeEach(() => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('draws a PDF embed on canvases and offers no download link', async () => {
    vi.mocked(getAssetUrls).mockResolvedValue({ [ASSET_PDF]: 'https://s3/spec.pdf' });
    const { container } = offDoc(embed({ nodeId: null, assetId: ASSET_PDF, filename: 'spec.pdf', contentType: 'application/pdf' }));
    await screen.findByText('spec.pdf');
    await vi.waitFor(() => expect(container.querySelector('.wiki-pdf-viewer canvas')).not.toBeNull());
    expect(container.querySelector('iframe')).toBeNull();
    expect(screen.queryByRole('link', { name: /Download/ })).toBeNull();
  });

  it('shows just the name and icon for a file the API left out, with no link', async () => {
    vi.mocked(getAssetUrls).mockResolvedValue({});
    const { container } = offDoc(embed({
      nodeId: null, assetId: ASSET_ZIP, filename: 'drawings.zip', contentType: 'application/zip',
    }));
    expect(await screen.findByText('drawings.zip')).toBeTruthy();
    expect(screen.getByText('Not available while printing is off')).toBeTruthy();
    expect(container.querySelector('.wiki-file-icon')).not.toBeNull();
    expect(container.querySelector('a')).toBeNull();
    expect(screen.queryByText('File unavailable')).toBeNull();
  });

  it('locks an embedded video and image, and the viewer\'s Open original link', async () => {
    vi.mocked(getAssetUrls).mockResolvedValue({ [SHOWN]: 'https://s3/rack.png', [ASSET_PDF]: 'https://s3/clip.mp4' });
    const { container } = offDoc({ type: 'doc', content: [
      { type: 'wikiImage', attrs: { assetId: SHOWN, alt: 'Rack front', caption: 'Rack 12', width: null } },
      { type: 'fileEmbed', attrs: { nodeId: null, assetId: ASSET_PDF, filename: 'clip.mp4', contentType: 'video/mp4' } },
    ] });
    const img = await screen.findByRole('img', { name: 'Rack front' });
    expect(fireEvent.contextMenu(img)).toBe(false);
    const video = await vi.waitFor(() => {
      const el = container.querySelector('video');
      if (!el) throw new Error('no video yet');
      return el;
    });
    expect(video.getAttribute('controlslist')).toBe('nodownload noplaybackrate');
    expect(video.hasAttribute('disablepictureinpicture')).toBe(true);
    expect(fireEvent.contextMenu(video)).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'View full size: Rack front' }));
    const dialog = screen.getByRole('dialog', { name: 'Rack 12' });
    expect(within(dialog).queryByRole('link', { name: 'Open original' })).toBeNull();
    expect(fireEvent.contextMenu(within(dialog).getByRole('img', { name: 'Rack front' }))).toBe(false);
  });

  it('draws another file\'s PDF on canvases when that file can\'t be printed, though the page can', async () => {
    vi.mocked(getFileUrl).mockResolvedValue({ url: 'https://s3/f.pdf', content_type: 'application/pdf', preview_status: 'ready' });
    vi.mocked(getNode).mockResolvedValue(makeDetail('f-live', { title: 'Plan.pdf', kind: 'file', can_print: false }));
    const { container } = render(<MemoryRouter><ReadOnlyDoc content={embed({
      nodeId: 'f-live', assetId: null, filename: '', contentType: '',
    }) as never} /></MemoryRouter>);
    await screen.findByText('Plan.pdf');
    await vi.waitFor(() => expect(container.querySelector('.wiki-pdf-viewer canvas')).not.toBeNull());
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('keeps the browser\'s viewer and the Download link when printing is on', async () => {
    vi.mocked(getAssetUrls).mockResolvedValue({ [ASSET_PDF]: 'https://s3/spec.pdf' });
    const { container } = render(<MemoryRouter><ReadOnlyDoc content={embed({
      nodeId: null, assetId: ASSET_PDF, filename: 'spec.pdf', contentType: 'application/pdf',
    }) as never} /></MemoryRouter>);
    await screen.findByText('spec.pdf');
    expect(container.querySelector('iframe')?.getAttribute('src')).toBe('https://s3/spec.pdf');
    expect(screen.getByRole('link', { name: /Download/ }).getAttribute('href')).toBe('https://s3/spec.pdf');
  });
});
