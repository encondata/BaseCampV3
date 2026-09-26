// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { helpContext, helpLinkAdminUrl, lookupHelp, openInNewTab } from './wikiHelp';

afterEach(() => { vi.restoreAllMocks(); });

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

describe('wikiHelp', () => {
  it('names a screen by app and path; the server normalizes the rest', () => {
    expect(helpContext('portal', '/bulk/time')).toBe('portal:/bulk/time');
    expect(helpContext('kiosk', '/enroll')).toBe('kiosk:/enroll');
  });

  it('asks the wiki for the screen’s guide through the app’s own fetch', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(200, {
      node_id: 'n1', title: 'Time Guide', url: 'https://wiki.test/n/n1', context: 'portal:/bulk',
    }));
    const found = await lookupHelp(fetcher, 'portal:/bulk/time');
    expect(fetcher).toHaveBeenCalledWith('/wiki/help?context=portal%3A%2Fbulk%2Ftime');
    expect(found).toEqual({ found: true, url: 'https://wiki.test/n/n1', title: 'Time Guide' });
  });

  it('reads a 404 as "no guide yet"', async () => {
    const fetcher = vi.fn().mockResolvedValue(json(404, { detail: { code: 'not_found' } }));
    expect(await lookupHelp(fetcher, 'portal:/assets')).toEqual({ found: false });
  });

  it('throws on anything else, so the button can say the lookup failed', async () => {
    await expect(lookupHelp(vi.fn().mockResolvedValue(json(500, {})), 'portal:/x')).rejects.toThrow();
    await expect(lookupHelp(vi.fn().mockRejectedValue(new Error('offline')), 'portal:/x')).rejects.toThrow();
  });

  it('points "Link a guide" at the wiki’s Help links page with the context prefilled', () => {
    // jsdom serves the page from localhost: the wiki is its :5176 sibling
    expect(helpLinkAdminUrl('portal:/bulk/time'))
      .toBe(`${location.protocol}//${location.hostname}:5176/admin/help-links?context=portal%3A%2Fbulk%2Ftime`);
  });

  it('opens a URL in a new tab without handing it this window', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    openInNewTab('https://wiki.test/n/n1');
    expect(open).toHaveBeenCalledWith('https://wiki.test/n/n1', '_blank', 'noopener');
  });
});
