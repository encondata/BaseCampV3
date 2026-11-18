// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

const session = { access_token: 'tok-1', expires_in: 900, session_expires_at: '2099-01-01T00:00:00Z' };

it('is null while signed out (refresh fails)', async () => {
  const fetchMock = vi.fn(async () => new Response('{}', { status: 401 }));
  vi.stubGlobal('fetch', fetchMock);
  const { accessTokenForService } = await import('./api');
  expect(await accessTokenForService()).toBeNull();
});

it('refreshes once for two concurrent calls on a stale token, then reuses the fresh one', async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(session), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const { accessTokenForService } = await import('./api');
  const [a, b] = await Promise.all([accessTokenForService(), accessTokenForService()]);
  expect(a).toBe('tok-1');
  expect(b).toBe('tok-1');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  expect(await accessTokenForService()).toBe('tok-1');
  expect(fetchMock).toHaveBeenCalledTimes(1);
});
