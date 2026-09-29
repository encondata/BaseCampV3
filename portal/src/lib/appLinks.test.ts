import { describe, expect, it } from 'vitest';

import { appOrigin, KIOSK_DEV_PORT, WIKI_DEV_PORT } from './appLinks';

describe('appOrigin', () => {
  it('swaps the first hostname label on a real host', () => {
    const loc = { hostname: 'portal.dev.serversherpa.com', protocol: 'https:' };
    expect(appOrigin('kiosk', KIOSK_DEV_PORT, loc)).toBe('https://kiosk.dev.serversherpa.com');
    expect(appOrigin('wiki', WIKI_DEV_PORT, loc)).toBe('https://wiki.dev.serversherpa.com');
  });

  it('falls back to the dev port on localhost and IP addresses', () => {
    expect(appOrigin('kiosk', KIOSK_DEV_PORT, { hostname: 'localhost', protocol: 'http:' }))
      .toBe('http://localhost:5174');
    expect(appOrigin('wiki', WIKI_DEV_PORT, { hostname: '10.10.48.103', protocol: 'http:' }))
      .toBe('http://10.10.48.103:5176');
  });

  it('an override wins and loses its trailing slash', () => {
    const loc = { hostname: 'portal.dev.serversherpa.com', protocol: 'https:' };
    expect(appOrigin('wiki', WIKI_DEV_PORT, loc, 'https://docs.example.com/')).toBe('https://docs.example.com');
    expect(appOrigin('wiki', WIKI_DEV_PORT, loc, '   ')).toBe('https://wiki.dev.serversherpa.com');
  });
});
