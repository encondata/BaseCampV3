// @vitest-environment jsdom
/** Forgetting one remembered browser treats 404 (already gone) as success;
 *  every other failure, and the forget-all calls, still throw. */
import { afterEach, expect, it, vi } from 'vitest';

import {
  forgetAllMyTrustedBrowsers, forgetAllUserTrustedBrowsers, forgetMyTrustedBrowser,
  forgetUserTrustedBrowser,
} from './api';

const SESSION = {
  status: 'ok', access_token: 'tok', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: { id: 'p1' }, roles: [], must_change_password: false, preferences: {},
  perms: {}, max_rank: 0, scope: { global: true, client_ids: [], partner_ids: [] },
  password_min_length: 8,
  totp: { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 },
};

/** apiFetch refreshes the session first (no token yet), so answer that call
 *  with a valid session and give every other call the status under test. */
function mockFetch(status: number, body: unknown = { detail: { code: 'trusted_browser_not_found' } }) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => (String(url).endsWith('/auth/refresh')
    ? new Response(JSON.stringify(SESSION), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response(status === 204 ? null : JSON.stringify(body),
      { status, headers: { 'Content-Type': 'application/json' } })));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function deleteCall(fn: ReturnType<typeof mockFetch>): [string, RequestInit] {
  const hit = fn.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === 'DELETE');
  expect(hit).toBeTruthy();
  return hit as unknown as [string, RequestInit];
}

afterEach(() => vi.unstubAllGlobals());

it('forgetMyTrustedBrowser: 404 counts as already forgotten', async () => {
  const fetch = mockFetch(404);
  await expect(forgetMyTrustedBrowser('tb1')).resolves.toBeUndefined();
  expect(deleteCall(fetch)[0]).toMatch(/\/auth\/me\/trusted-browsers\/tb1$/);
});

it('forgetUserTrustedBrowser: 404 counts as already forgotten', async () => {
  const fetch = mockFetch(404);
  await expect(forgetUserTrustedBrowser('p1', 'tb1')).resolves.toBeUndefined();
  expect(deleteCall(fetch)[0]).toMatch(/\/users\/p1\/trusted-browsers\/tb1$/);
});

it('a single-row forget still throws on other failures', async () => {
  mockFetch(500, { detail: { code: 'boom' } });
  await expect(forgetMyTrustedBrowser('tb1')).rejects.toMatchObject({ status: 500, code: 'boom' });
  mockFetch(403, { detail: { code: 'forbidden' } });
  await expect(forgetUserTrustedBrowser('p1', 'tb1')).rejects.toMatchObject({ status: 403 });
});

it('forget-all calls throw on failure and succeed on 204', async () => {
  mockFetch(204);
  await expect(forgetAllMyTrustedBrowsers()).resolves.toBeUndefined();
  await expect(forgetAllUserTrustedBrowsers('p1')).resolves.toBeUndefined();
  mockFetch(404);
  await expect(forgetAllMyTrustedBrowsers()).rejects.toMatchObject({ status: 404 });
  await expect(forgetAllUserTrustedBrowsers('p1')).rejects.toMatchObject({ status: 404 });
});
