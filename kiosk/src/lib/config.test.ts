// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { apiUrl, kioskVersion, portalUrl } from './config';

afterEach(() => {
  delete window.__KIOSK_CONFIG__;
  vi.unstubAllEnvs();
});

it('window config wins, then VITE_* env, then the hostname default', () => {
  window.__KIOSK_CONFIG__ = { apiUrl: 'https://api.example.com/', portalUrl: 'https://portal.example.com' };
  vi.stubEnv('VITE_API_URL', 'http://env-api:1');
  expect(apiUrl()).toBe('https://api.example.com');        // trailing slash trimmed
  expect(portalUrl()).toBe('https://portal.example.com');

  window.__KIOSK_CONFIG__ = {};
  expect(apiUrl()).toBe('http://env-api:1');

  vi.unstubAllEnvs();
  expect(apiUrl()).toBe(`http://${window.location.hostname}:8000`);
  expect(portalUrl()).toBe(`http://${window.location.hostname}:5173`);
});

it('kioskVersion prefers VITE_KIOSK_VERSION over the package version', () => {
  vi.stubEnv('VITE_KIOSK_VERSION', '9.9.9');
  expect(kioskVersion()).toBe('9.9.9');
  vi.unstubAllEnvs();
  expect(kioskVersion()).toBe(__KIOSK_VERSION__);
});
