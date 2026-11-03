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

  it('takes no link on the wiki origin whose path starts with another slash: "<origin>//host" stays on the wiki home, as "//host" does', () => {
    for (const path of ['//evil.example/x', '//evil.example/x?a=1#top', '/\\evil.example/x']) {
      expect(resolveInboxLink(`${location.origin}${path}`)).toEqual({ kind: 'app', to: '/' });
    }
  });

  it('leaves any other absolute http(s) URL as it is', () => {
    expect(resolveInboxLink('https://status.serversherpa.com/')).toEqual({
      kind: 'external', href: 'https://status.serversherpa.com/',
    });
  });

  it('opens no other kind of link: another scheme, a protocol-relative one or none at all stays on the wiki home, as the portal does', () => {
    for (const link of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/x', '']) {
      expect(resolveInboxLink(link)).toEqual({ kind: 'app', to: '/' });
    }
    for (const link of ['JavaScript:void(0)', 'vbscript:msgbox(1)', 'reports']) {
      expect(resolveInboxLink(link)).toEqual({ kind: 'app', to: '/' });
    }
  });

  it('takes no path a browser reads as another host\'s: a backslash, tab or newline after the slash', () => {
    for (const link of ['/\\evil.example/x', '/\t/evil.example/x', '/\n/evil.example/x', '/\r/evil.example/x']) {
      expect(resolveInboxLink(link)).toEqual({ kind: 'app', to: '/' });
    }
  });

  it('stays on the wiki home for an http link it cannot parse', () => {
    expect(resolveInboxLink('http://')).toEqual({ kind: 'app', to: '/' });
  });
});
