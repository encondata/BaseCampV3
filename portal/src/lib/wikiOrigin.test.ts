import { afterEach, describe, expect, it, vi } from 'vitest';

import { wikiOrigin } from './wikiOrigin';

function at(url: string) {
  const u = new URL(url);
  vi.stubGlobal('location', { protocol: u.protocol, hostname: u.hostname, host: u.host });
}

afterEach(() => vi.unstubAllGlobals());

describe('wikiOrigin', () => {
  it('swaps to the wiki sibling on a real hostname', () => {
    at('https://portal.dev.serversherpa.com/people/users');
    expect(wikiOrigin()).toBe('https://wiki.dev.serversherpa.com');
  });

  it('falls back to port 5176 on localhost and LAN addresses', () => {
    at('http://localhost:5173/');
    expect(wikiOrigin()).toBe('http://localhost:5176');
    at('http://192.168.1.20:5173/');
    expect(wikiOrigin()).toBe('http://192.168.1.20:5176');
  });
});
