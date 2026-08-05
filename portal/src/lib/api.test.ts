/**
 * Guards the module-scope invariant: importing lib/api must not touch browser
 * globals. It once computed the API base URL at import, which crashed every
 * test that transitively imported it (i.e. the whole component tree) under
 * vitest's default node environment.
 *
 * These tests must run WITHOUT a DOM environment — that is the point.
 */

import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

it('imports without touching browser globals', async () => {
  expect(typeof globalThis.window).toBe('undefined');
  await expect(import('./api')).resolves.toBeDefined();
});

it('prefers VITE_API_URL when configured', async () => {
  vi.stubEnv('VITE_API_URL', 'https://api.example.com');
  const { apiUrl } = await import('./api');

  expect(apiUrl()).toBe('https://api.example.com');
});

it('falls back to the serving host on port 8000 so LAN devices reach the API', async () => {
  vi.stubEnv('VITE_API_URL', undefined);
  vi.stubGlobal('window', { location: { hostname: '192.168.1.42' } });
  const { apiUrl } = await import('./api');

  expect(apiUrl()).toBe('http://192.168.1.42:8000');
});
