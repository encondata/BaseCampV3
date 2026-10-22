// @vitest-environment jsdom
/** The portal says who it is on refresh and logout (?client=portal) so the API
 *  can refuse a kiosk session, and a kiosk session that still reaches a portal
 *  call (403 kiosk_session) signs the portal out instead of looping. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as api from './api';

const SESSION = {
  access_token: 'tok1', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: {}, roles: [], must_change_password: false, preferences: {}, perms: {},
  max_rank: 40, scope: { global: true, client_ids: [], partner_ids: [] }, password_min_length: 8,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

beforeEach(() => {
  vi.stubEnv('VITE_API_URL', 'http://api.test');
  api.clearLocalSession();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

it('refreshSession posts to /auth/refresh?client=portal with credentials', async () => {
  const fetchMock = vi.fn(async () => json(SESSION));
  vi.stubGlobal('fetch', fetchMock);
  await api.refreshSession();
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://api.test/auth/refresh?client=portal');
  expect(init.method).toBe('POST');
  expect(init.credentials).toBe('include');
});

it('a wrong_client 401 on refresh ends up signed out, not looping', async () => {
  const fetchMock = vi.fn(async () => json({ detail: { code: 'wrong_client' } }, 401));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api.refreshSession()).toBeNull();
  expect(api.getSessionExpiresAt()).toBeNull();
});

it('logoutRequest posts to /auth/logout?client=portal', async () => {
  const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchMock);
  await api.logoutRequest();
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe('http://api.test/auth/logout?client=portal');
  expect(init.method).toBe('POST');
  expect(init.credentials).toBe('include');
});

it('apiFetch ends the session on 403 kiosk_session and the body stays readable', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).includes('/auth/refresh')
      ? json(SESSION)
      : json({ detail: { code: 'kiosk_session' } }, 403));
  vi.stubGlobal('fetch', fetchMock);
  await api.refreshSession();
  expect(api.getSessionExpiresAt()).toBe('2030-01-01T00:00:00Z');
  const ended = vi.fn();
  const off = api.onSessionEnded(ended);

  const resp = await api.apiFetch('/people');

  expect(resp.status).toBe(403);
  expect(await resp.json()).toEqual({ detail: { code: 'kiosk_session' } });
  expect(ended).toHaveBeenCalledTimes(1);
  expect(api.getSessionExpiresAt()).toBeNull();
  off();
});

it('apiFetch returns any other 403 untouched and keeps the session', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).includes('/auth/refresh')
      ? json(SESSION)
      : json({ detail: { code: 'forbidden' } }, 403));
  vi.stubGlobal('fetch', fetchMock);
  await api.refreshSession();
  const ended = vi.fn();
  const off = api.onSessionEnded(ended);

  const resp = await api.apiFetch('/people');

  expect(resp.status).toBe(403);
  expect(await resp.json()).toEqual({ detail: { code: 'forbidden' } });
  expect(ended).not.toHaveBeenCalled();
  expect(api.getSessionExpiresAt()).toBe('2030-01-01T00:00:00Z');
  off();
});

it('apiFetch tolerates a 403 with a non-JSON body', async () => {
  const fetchMock = vi.fn(async (url: string) =>
    String(url).includes('/auth/refresh')
      ? json(SESSION)
      : new Response('nope', { status: 403 }));
  vi.stubGlobal('fetch', fetchMock);
  await api.refreshSession();
  const ended = vi.fn();
  const off = api.onSessionEnded(ended);
  const resp = await api.apiFetch('/people');
  expect(resp.status).toBe(403);
  expect(await resp.text()).toBe('nope');
  expect(ended).not.toHaveBeenCalled();
  off();
});
