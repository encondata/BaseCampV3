// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { resolveInboxLink } from './inboxLinks';

// jsdom serves the page from http://localhost, so the portal falls
// back to its dev port on the same host
describe('resolveInboxLink', () => {
  it('sends a portal path to the portal', () => {
    expect(resolveInboxLink('/reports?tab=history')).toEqual({
      kind: 'external', href: 'http://localhost:5173/reports?tab=history',
    });
  });

  it('opens a link to the wiki itself in-app', () => {
    expect(resolveInboxLink(`${location.origin}/n/abc?edit=1#intro`)).toEqual({ kind: 'app', to: '/n/abc?edit=1#intro' });
  });

  it('leaves any other absolute http(s) URL as it is', () => {
    expect(resolveInboxLink('https://status.serversherpa.com/')).toEqual({
      kind: 'external', href: 'https://status.serversherpa.com/',
    });
  });

  it('never follows another scheme: like the portal, it is read as a portal path', () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,hi', 'JavaScript:void(0)']) {
      const target = resolveInboxLink(link);
      expect(target.kind).toBe('external');
      expect(target.kind === 'external' && target.href.startsWith('http://localhost:5173/')).toBe(true);
    }
  });

  it('reads a protocol-relative link as a path, as the portal does', () => {
    expect(resolveInboxLink('//evil.example/x')).toEqual({
      kind: 'external', href: 'http://localhost:5173//evil.example/x',
    });
  });

  it('stays on the wiki home for an http link it cannot parse', () => {
    expect(resolveInboxLink('http://')).toEqual({ kind: 'app', to: '/' });
  });
});
