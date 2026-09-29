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
});
