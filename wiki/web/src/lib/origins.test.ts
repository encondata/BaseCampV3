import { afterEach, describe, expect, it, vi } from 'vitest';

import { collabUrl, portalOrigin } from './origins';

function at(url: string) {
  const u = new URL(url);
  vi.stubGlobal('location', { protocol: u.protocol, hostname: u.hostname, host: u.host });
}

afterEach(() => vi.unstubAllGlobals());

describe('portalOrigin', () => {
  it('swaps to the portal sibling on a real hostname', () => {
    at('https://wiki.dev.serversherpa.com/n/abc');
    expect(portalOrigin()).toBe('https://portal.dev.serversherpa.com');
  });

  it('falls back to port 5173 on localhost and LAN addresses', () => {
    at('http://localhost:5176/');
    expect(portalOrigin()).toBe('http://localhost:5173');
    at('http://192.168.1.20:5176/');
    expect(portalOrigin()).toBe('http://192.168.1.20:5173');
  });
});

describe('collabUrl', () => {
  it('uses wss on an https page, on the page\'s own host', () => {
    at('https://wiki.serversherpa.com/n/abc');
    expect(collabUrl()).toBe('wss://wiki.serversherpa.com/collab');
  });

  it('uses ws on an http page and keeps the port', () => {
    at('http://localhost:5176/');
    expect(collabUrl()).toBe('ws://localhost:5176/collab');
  });
});
