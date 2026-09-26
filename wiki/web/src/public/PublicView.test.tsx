// @vitest-environment jsdom
import '../testing/pmDom';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  apiFetch: vi.fn(),
  apiUrl: () => 'http://api.test',
}));

vi.mock('../lib/download', () => ({ openDownload: vi.fn() }));

import { apiFetch } from '@portal/lib/api';

import { openDownload } from '../lib/download';

import type { PublicFileOut, PublicPageOut } from '../lib/types';
import PublicApp, { isPublicPath } from './PublicApp';
import Root from '../Root';

const ASSET = '0f4d6a2e-3b1c-4c7e-9a55-1d2e3f405162';
const fetchSpy = vi.fn();

const PAGE: PublicPageOut = {
  kind: 'page',
  title: 'Rack Guide',
  published_at: '2026-09-20T12:00:00Z',
  asset_urls: { [ASSET]: 'https://s3/rack.png' },
  url_ttl_seconds: 600,
  content_json: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'Torque the rails to spec.' }] },
    { type: 'wikiImage', attrs: { assetId: ASSET, alt: 'Rack front', caption: '', width: null } },
  ] },
};

const FILE: PublicFileOut = {
  kind: 'file', title: 'manual.pdf', filename: 'manual.pdf', content_type: 'application/pdf',
  size_bytes: 2048, inline: true, url: 'https://s3/manual-inline', download_url: 'https://s3/manual-dl',
  url_ttl_seconds: 600,
};

const PDF_ASSET = '1f4d6a2e-3b1c-4c7e-9a55-1d2e3f405162';
const PAGE_WITH_PDF: PublicPageOut = {
  ...PAGE,
  asset_urls: { [PDF_ASSET]: 'https://s3/spec.pdf' },
  content_json: { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'The spec:' }] },
    { type: 'fileEmbed', attrs: { nodeId: null, assetId: PDF_ASSET, filename: 'spec.pdf', contentType: 'application/pdf' } },
  ] },
};

function answer(status: number, body?: unknown) {
  fetchSpy.mockResolvedValueOnce(new Response(body === undefined ? '{}' : JSON.stringify(body), { status }));
}

function renderAt(token: string) {
  return render(<MemoryRouter initialEntries={[`/p/${token}`]}><PublicApp /></MemoryRouter>);
}

/** Every URL anything fetched — the public view may only ever read its share. */
const fetched = () => fetchSpy.mock.calls.map((c) => String(c[0]));

beforeEach(() => {
  fetchSpy.mockReset();
  vi.stubGlobal('fetch', fetchSpy);
  vi.mocked(apiFetch).mockReset();
  vi.mocked(openDownload).mockReset();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('isPublicPath', () => {
  it('matches /p/<token> only', () => {
    expect(isPublicPath('/p/abc-_123')).toBe(true);
    expect(isPublicPath('/p/abc/')).toBe(true);
    expect(isPublicPath('/p/')).toBe(false);
    expect(isPublicPath('/p/a/b')).toBe(false);
    expect(isPublicPath('/n/abc')).toBe(false);
    expect(isPublicPath('/pages/x')).toBe(false);
  });
});

describe('PublicView', () => {
  it('renders a shared page with a slim header and its images, reading only the share', async () => {
    answer(200, PAGE);
    renderAt('tok123');
    expect(await screen.findByRole('heading', { name: 'Rack Guide' })).toBeTruthy();
    expect(screen.getByText('Shared from ServerSherpa Wiki')).toBeTruthy();
    expect(await screen.findByText('Torque the rails to spec.')).toBeTruthy();
    expect((await screen.findByRole('img', { name: 'Rack front' })).getAttribute('src')).toBe('https://s3/rack.png');
    expect(fetched()).toEqual(['http://api.test/wiki/public/tok123']);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('shows a file with a preview and a download', async () => {
    answer(200, FILE);
    renderAt('tok123');
    expect(await screen.findByRole('heading', { name: 'manual.pdf' })).toBeTruthy();
    expect(screen.getByTitle('Preview of manual.pdf').getAttribute('src')).toBe('https://s3/manual-inline');
    expect(screen.getByRole('link', { name: /Download/ }).getAttribute('href')).toBe('https://s3/manual-dl');
    expect(screen.getByText(/2\.0 KB/)).toBeTruthy();
  });

  it('never previews a file the API serves as an attachment', async () => {
    answer(200, { ...FILE, title: 'logo.svg', filename: 'logo.svg', content_type: 'image/svg+xml', inline: false });
    renderAt('tok123');
    expect(await screen.findByText('No preview — download to open')).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('says the link is unavailable on a 404', async () => {
    answer(404);
    renderAt('gone');
    expect(await screen.findByText('This link isn’t available')).toBeTruthy();
  });

  it('asks to wait on a 429', async () => {
    answer(429);
    renderAt('busy');
    expect(await screen.findByRole('heading', { name: 'Too many requests' })).toBeTruthy();
  });

  it('keeps search engines out and sends no referrer', async () => {
    answer(200, PAGE);
    renderAt('tok123');
    await screen.findByRole('heading', { name: 'Rack Guide' });
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex, nofollow');
    expect(document.querySelector('meta[name="referrer"]')?.getAttribute('content')).toBe('no-referrer');
  });
});

describe('PublicView — expired URLs', () => {
  const clock = () => {
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    return (ms: number) => now.mockReturnValue(start + ms);
  };

  it('re-reads the share (as a refresh) when a page image fails; once per set of URLs until they go stale', async () => {
    const at = clock();
    answer(200, PAGE);
    answer(200, { ...PAGE, asset_urls: { [ASSET]: 'https://s3/rack-fresh.png' } });
    answer(200, { ...PAGE, asset_urls: { [ASSET]: 'https://s3/rack-later.png' } });
    renderAt('tok123');
    fireEvent.error(await screen.findByRole('img', { name: 'Rack front' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Rack front' }).getAttribute('src'))
      .toBe('https://s3/rack-fresh.png'));
    expect(fetched()).toEqual(['http://api.test/wiki/public/tok123', 'http://api.test/wiki/public/tok123?refresh=1']);
    // the fresh URLs failing right away: no loop
    fireEvent.error(screen.getByRole('img', { name: 'Rack front' }));
    await new Promise((r) => { setTimeout(r, 20); });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    // a later expiry recovers again
    at(481_000);
    fireEvent.error(screen.getByRole('img', { name: 'Rack front' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'Rack front' }).getAttribute('src'))
      .toBe('https://s3/rack-later.png'));
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('keeps the page on screen with a notice when a refresh is refused or fails', async () => {
    answer(200, PAGE);
    answer(429);
    renderAt('tok123');
    fireEvent.error(await screen.findByRole('img', { name: 'Rack front' }));
    expect(await screen.findByRole('status')).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/Couldn’t refresh/);
    expect(screen.getByText('Torque the rails to spec.')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Rack Guide' })).toBeTruthy();
  });

  it('shows the link is gone when a refresh finds it revoked', async () => {
    answer(200, PAGE);
    answer(404);
    renderAt('tok123');
    fireEvent.error(await screen.findByRole('img', { name: 'Rack front' }));
    expect(await screen.findByText('This link isn’t available')).toBeTruthy();
  });

  it('re-reads the share once when a file preview fails to load', async () => {
    const image = { ...FILE, title: 'rack.png', filename: 'rack.png', content_type: 'image/png', url: 'https://s3/old.png' };
    answer(200, image);
    answer(200, { ...image, url: 'https://s3/new.png' });
    renderAt('tok123');
    fireEvent.error(await screen.findByRole('img', { name: 'rack.png' }));
    await waitFor(() => expect(screen.getByRole('img', { name: 'rack.png' }).getAttribute('src')).toBe('https://s3/new.png'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('downloads straight away while the URL is fresh', async () => {
    answer(200, FILE);
    renderAt('tok123');
    const link = await screen.findByRole('link', { name: /Download/ });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('re-reads the share before downloading once 80% of the URL lifetime has passed', async () => {
    const at = clock();
    answer(200, { ...FILE, url_ttl_seconds: 100 });
    answer(200, { ...FILE, url_ttl_seconds: 100, download_url: 'https://s3/manual-dl-fresh' });
    renderAt('tok123');
    const link = await screen.findByRole('link', { name: /Download/ });
    at(79_000);
    const early = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(early);
    expect(early.defaultPrevented).toBe(false);
    at(81_000);
    const late = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(late);
    expect(late.defaultPrevented).toBe(true);
    await waitFor(() => expect(openDownload).toHaveBeenCalledWith('https://s3/manual-dl-fresh'));
    expect(fetched()[1]).toBe('http://api.test/wiki/public/tok123?refresh=1');
  });

  it('re-reads the share before reopening an embedded PDF preview whose URL may have expired', async () => {
    const at = clock();
    answer(200, PAGE_WITH_PDF);
    answer(200, { ...PAGE_WITH_PDF, asset_urls: { [PDF_ASSET]: 'https://s3/spec-fresh.pdf' } });
    renderAt('tok123');
    fireEvent.click(await screen.findByRole('button', { name: /Hide preview/ }));
    at(500_000);
    fireEvent.click(screen.getByRole('button', { name: /Preview/ }));
    await waitFor(() => expect(screen.getByTitle('Preview of spec.pdf').getAttribute('src'))
      .toBe('https://s3/spec-fresh.pdf'));
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('re-reads the share before downloading an embedded file whose URL may have expired', async () => {
    const at = clock();
    answer(200, PAGE_WITH_PDF);
    answer(200, { ...PAGE_WITH_PDF, asset_urls: { [PDF_ASSET]: 'https://s3/spec-fresh.pdf' } });
    renderAt('tok123');
    const link = await screen.findByRole('link', { name: /Download/ });
    at(500_000);
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await waitFor(() => expect(openDownload).toHaveBeenCalledWith('https://s3/spec-fresh.pdf'));
  });
});

describe('Root', () => {
  it('serves /p/<token> without the session providers — no sign-in or status calls at all', async () => {
    window.history.pushState({}, '', '/p/tok123');
    answer(200, PAGE);
    render(<Root pathname="/p/tok123" />);
    expect(await screen.findByRole('heading', { name: 'Rack Guide' })).toBeTruthy();
    await waitFor(() => expect(fetched()).toEqual(['http://api.test/wiki/public/tok123']));
    const [, init] = fetchSpy.mock.calls[0];
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).has('Authorization')).toBe(false);
    expect(apiFetch).not.toHaveBeenCalled();
    window.history.pushState({}, '', '/');
  });
});
