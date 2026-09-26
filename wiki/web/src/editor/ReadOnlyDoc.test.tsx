// @vitest-environment jsdom
import '../testing/pmDom';

import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/wikiApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/wikiApi')>()),
  getAssetUrls: vi.fn(),
  getNode: vi.fn(),
  getFileUrl: vi.fn(),
}));

import { ApiError } from '@portal/lib/api';

import { clearAssetUrls } from '../lib/assetUrls';
import { clearNodeTitles } from '../lib/nodeTitles';
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

  it('shows page links by their current title, or "Missing page"', async () => {
    render(<MemoryRouter><ReadOnlyDoc content={doc} /></MemoryRouter>);
    expect(await screen.findByRole('link', { name: 'Cabling standards' })).toBeTruthy();
    expect(await screen.findByText('Missing page')).toBeTruthy();
    expect(screen.queryByText('Secret page')).toBeNull();
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
