import { describe, expect, it } from 'vitest';

import { siblingOrigin } from './siblingOrigin';

const at = (hostname: string, protocol = 'https:') => ({ hostname, protocol });

describe('siblingOrigin', () => {
  it('swaps the first label for the one asked for', () => {
    expect(siblingOrigin('api', at('portal.dev.serversherpa.com')))
      .toBe('https://api.dev.serversherpa.com');
    expect(siblingOrigin('api', at('kiosk.dev.serversherpa.com')))
      .toBe('https://api.dev.serversherpa.com');
    expect(siblingOrigin('portal', at('kiosk.dev.serversherpa.com')))
      .toBe('https://portal.dev.serversherpa.com');
  });

  it('follows the page protocol so HTTPS never reaches for HTTP', () => {
    expect(siblingOrigin('api', at('kiosk.dev.serversherpa.com', 'http:')))
      .toBe('http://api.dev.serversherpa.com');
  });

  it('returns the same host when it is already the sibling', () => {
    expect(siblingOrigin('api', at('api.dev.serversherpa.com')))
      .toBe('https://api.dev.serversherpa.com');
  });

  it('leaves localhost alone so the port-based default still applies', () => {
    expect(siblingOrigin('api', at('localhost', 'http:'))).toBeNull();
    expect(siblingOrigin('api', at('kiosk.localhost', 'http:'))).toBeNull();
  });

  it('leaves IP literals alone — a phone on the LAN keeps using the port', () => {
    expect(siblingOrigin('api', at('192.168.8.42', 'http:'))).toBeNull();
    expect(siblingOrigin('api', at('fe80::1', 'http:'))).toBeNull();
  });

  it('needs at least three labels, so example.com never becomes api.com', () => {
    expect(siblingOrigin('api', at('serversherpa.com'))).toBeNull();
    expect(siblingOrigin('api', at('dev-box'))).toBeNull();
  });

  it('is case-insensitive about the host', () => {
    expect(siblingOrigin('api', at('Portal.Dev.ServerSherpa.com')))
      .toBe('https://api.dev.serversherpa.com');
  });
});
