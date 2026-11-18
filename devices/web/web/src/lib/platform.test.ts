import { describe, expect, it } from 'vitest';

import { viewerPlatform } from './platform';

const UA = {
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1',
  ipad: 'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  // iPadOS asks for the desktop site by default: a Mac user agent, told apart by touch
  mac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15',
  windows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
};

const nav = (userAgent: string, maxTouchPoints = 0) => ({ userAgent, maxTouchPoints });

describe('viewerPlatform', () => {
  it('an Android user agent is android', () => {
    expect(viewerPlatform(nav(UA.android, 5))).toBe('android');
  });

  it('an iPhone is ios', () => {
    expect(viewerPlatform(nav(UA.iphone, 5))).toBe('ios');
  });

  it('an iPad is ios, in mobile mode and in desktop mode', () => {
    expect(viewerPlatform(nav(UA.ipad, 5))).toBe('ios');
    expect(viewerPlatform(nav(UA.mac, 5))).toBe('ios');
  });

  it('a Mac and a Windows PC are desktop', () => {
    expect(viewerPlatform(nav(UA.mac, 0))).toBe('desktop');
    // a touch-screen Mac doesn't exist, but a single touch point (some trackpads report one) stays desktop
    expect(viewerPlatform(nav(UA.mac, 1))).toBe('desktop');
    expect(viewerPlatform(nav(UA.windows, 10))).toBe('desktop');
  });
});
