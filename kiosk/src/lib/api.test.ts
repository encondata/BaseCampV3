// @vitest-environment jsdom
/** The kiosk transport keeps the portal's session rules: token in memory
 *  only, single-flight refresh, one refresh-and-retry on 401 then the
 *  session-ended signal, login tagged client=kiosk. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import * as api from './api';

const SESSION = {
  access_token: 'tok1', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: { id: 'p', first_name: 'A', last_name: 'B', preferred_name: null, display_name: 'A B',
            email: 'a@x', job_title: null, avatar_key: null, avatar_url: null },
  roles: ['worker'], must_change_password: false, preferences: {}, perms: { kiosk: { view: true } },
  max_rank: 10, scope: { global: false, client_ids: [], partner_ids: [] }, password_min_length: 8,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Call = [string, RequestInit | undefined];

beforeEach(() => {
  api.clearLocalSession();
  window.__KIOSK_CONFIG__ = { apiUrl: 'http://api.test' };
});
afterEach(() => vi.unstubAllGlobals());

it('loginRequest posts client=kiosk with credentials and stores the token for apiFetch', async () => {
  const fetchMock = vi.fn(async () => json(SESSION));
  vi.stubGlobal('fetch', fetchMock);
  const data = await api.loginRequest('a@x', 'pw');
  expect(data.access_token).toBe('tok1');
  const [url, init] = fetchMock.mock.calls[0] as unknown as Call;
  expect(url).toBe('http://api.test/auth/login');
  expect(init?.credentials).toBe('include');
  expect(JSON.parse(String(init?.body))).toEqual({ email: 'a@x', password: 'pw', client: 'kiosk' });

  await api.apiFetch('/kiosk/heartbeat', { method: 'POST' });
  const [, second] = fetchMock.mock.calls[1] as unknown as Call;
  expect((second?.headers as Record<string, string>).Authorization).toBe('Bearer tok1');
  expect(fetchMock).toHaveBeenCalledTimes(2);        // no refresh while the token is fresh
  expect(api.getSessionExpiresAt()).toBe('2030-01-01T00:00:00Z');
});

it('loginRequest surfaces the API error code and status', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'kiosk_not_allowed' } }, 403)));
  await expect(api.loginRequest('a@x', 'pw')).rejects.toMatchObject({ code: 'kiosk_not_allowed', status: 403 });
});

it('network failures become ApiError network', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  await expect(api.loginRequest('a@x', 'pw')).rejects.toMatchObject({ code: 'network', status: 0 });
});

it('apiFetch refreshes once on 401, retries, and ends the session when refresh fails', async () => {
  const ended = vi.fn();
  const off = api.onSessionEnded(ended);
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith('/auth/login')) return json(SESSION);
    return json({ detail: { code: 'invalid_session' } }, 401);
  });
  vi.stubGlobal('fetch', fetchMock);
  await api.loginRequest('a@x', 'pw');
  const resp = await api.apiFetch('/x');
  expect(resp.status).toBe(401);
  const urls = fetchMock.mock.calls.map(([u]) => String(u));
  expect(urls).toEqual(['http://api.test/auth/login', 'http://api.test/x', 'http://api.test/auth/refresh']);
  expect(ended).toHaveBeenCalledTimes(1);
  expect(api.getSessionExpiresAt()).toBeNull();
  off();
});

it('refreshSession is single-flight', async () => {
  let calls = 0;
  vi.stubGlobal('fetch', vi.fn(async () => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 5));
    return json(SESSION);
  }));
  const [a, b] = await Promise.all([api.refreshSession(), api.refreshSession()]);
  expect(calls).toBe(1);
  expect(a?.access_token).toBe('tok1');
  expect(b?.access_token).toBe('tok1');
});

it('createPairRequest posts serial+name without credentials; pollPair sends the token, stores an approved session, and maps 404 to expired', async () => {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/kiosk/pair')) return json({ code: 'ABCD2345', poll_token: 'pt', link_url: 'http://p/link/ABCD2345', expires_at: '2030-01-01T00:00:00Z' }, 201);
    if (u.endsWith('/kiosk/pair/ABCD2345/poll')) {
      expect(JSON.parse(String(init?.body))).toEqual({ poll_token: 'pt' });
      expect(init?.credentials).toBe('include');
      return json({ status: 'approved', session: SESSION });
    }
    return json({ detail: { code: 'pair_not_found' } }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  const created = await api.createPairRequest({ serial: 's', name: 'Dock 3' });
  expect(created.code).toBe('ABCD2345');
  expect(JSON.parse(String((fetchMock.mock.calls[0] as Call)[1]?.body))).toEqual({ serial: 's', name: 'Dock 3' });
  const polled = await api.pollPair('ABCD2345', 'pt');
  expect(polled.status).toBe('approved');
  expect(api.getSessionExpiresAt()).toBe('2030-01-01T00:00:00Z');
  const gone = await api.pollPair('ZZZZZZZZ', 'pt');
  expect(gone).toEqual({ status: 'expired', session: null });
});

it('pollPair throws on a forbidden token', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'pair_forbidden' } }, 403)));
  await expect(api.pollPair('ABCD2345', 'bad')).rejects.toMatchObject({ code: 'pair_forbidden' });
});

it('heartbeatRequest posts the body with the bearer and returns the registration state', async () => {
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).endsWith('/auth/login')) return json(SESSION);
    return json({ device_id: 'd', name: 'Dock 3', registration: 'none', token_expires_at: null });
  });
  vi.stubGlobal('fetch', fetchMock);
  await api.loginRequest('a@x', 'pw');
  const r = await api.heartbeatRequest({ serial: 's', name: 'Dock 3', mode: 'web', version: '0.1.0' });
  expect(r.registration).toBe('none');
  const [url, init] = fetchMock.mock.calls[1] as unknown as Call;
  expect(url).toBe('http://api.test/kiosk/heartbeat');
  expect(init?.method).toBe('POST');
  expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok1');
});

it('getSystemStatus fetches without auth', async () => {
  const fetchMock = vi.fn(async () => json({ read_only: true, read_only_message: 'Cutover', workers_paused: false, banner: null }));
  vi.stubGlobal('fetch', fetchMock);
  const s = await api.getSystemStatus();
  expect(s.read_only).toBe(true);
  expect((fetchMock.mock.calls[0] as unknown as Call)[0]).toBe('http://api.test/system/status');
});
