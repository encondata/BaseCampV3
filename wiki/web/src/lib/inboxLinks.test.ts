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

  it('leaves any other absolute URL as it is', () => {
    expect(resolveInboxLink('https://status.serversherpa.com/')).toEqual({
      kind: 'external', href: 'https://status.serversherpa.com/',
    });
  });
});
