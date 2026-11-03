// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { resolveInboxLink } from './inboxLinks';

describe('resolveInboxLink', () => {
  it('keeps a relative link in the app', () => {
    expect(resolveInboxLink('/reports?tab=history&run=r1')).toEqual(
      { kind: 'app', to: '/reports?tab=history&run=r1' });
  });

  it('sends an absolute link on another origin out of the app', () => {
    expect(resolveInboxLink('https://wiki.example.com/n/abc#comment-1')).toEqual(
      { kind: 'external', href: 'https://wiki.example.com/n/abc#comment-1' });
    expect(resolveInboxLink('HTTP://wiki.example.com/n/abc')).toEqual(
      { kind: 'external', href: 'http://wiki.example.com/n/abc' });
  });

  it('keeps an absolute link on the portal origin in the app', () => {
    expect(resolveInboxLink(`${window.location.origin}/reports?run=r1#top`)).toEqual(
      { kind: 'app', to: '/reports?run=r1#top' });
  });

  it('keeps a malformed absolute link in the app', () => {
    expect(resolveInboxLink('http://')).toEqual({ kind: 'app', to: '/' });
    expect(resolveInboxLink('https://exa mple.com/n/1')).toEqual({ kind: 'app', to: '/' });
  });

  it('opens no other kind of link: another scheme, a protocol-relative one or none at all goes home, as a malformed one does', () => {
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
    expect(resolveInboxLink('/n/a\\b')).toEqual({ kind: 'app', to: '/n/a\\b' });
  });
});
