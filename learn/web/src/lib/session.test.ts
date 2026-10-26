// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@portal/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@portal/lib/api')>()),
  apiFetch: vi.fn(),
}));

import { apiFetch } from '@portal/lib/api';

import {
  TOKEN_KEY, clearToken, getFirstName, getToken, learnFetch, learnSignOut, setSignedOutHandler, setToken,
} from './session';

const LATER = new Date(Date.now() + 3_600_000).toISOString();

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

let restore: () => void;
let signedOut: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sessionStorage.clear();
  signedOut = vi.fn();
  restore = setSignedOutHandler(signedOut);
});

afterEach(() => {
  restore();
  vi.unstubAllGlobals();
  vi.mocked(apiFetch).mockReset();
});

describe('learn session token', () => {
  it('round-trips through sessionStorage', () => {
    expect(getToken()).toBeNull();
    setToken('tok-1', LATER);
    expect(getToken()).toBe('tok-1');
    expect(sessionStorage.getItem(TOKEN_KEY)).toContain('tok-1');
    expect(TOKEN_KEY).toBe('ss.learn.token');
    clearToken();
    expect(getToken()).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('keeps the first name for the greeting, in sessionStorage only', () => {
    expect(getFirstName()).toBe('');
    setToken('tok-1', LATER, 'Kenji');
    expect(getFirstName()).toBe('Kenji');
    expect(getToken()).toBe('tok-1');
    expect(localStorage.getItem(TOKEN_KEY)).toBeNull();
    clearToken();
    expect(getFirstName()).toBe('');
  });

  it('drops a token once it has expired', () => {
    setToken('tok-old', new Date(Date.now() - 1000).toISOString());
    expect(getToken()).toBeNull();
    expect(sessionStorage.getItem(TOKEN_KEY)).toBeNull();
  });

  it('treats a damaged stored value as signed out', () => {
    sessionStorage.setItem(TOKEN_KEY, '{not json');
    expect(getToken()).toBeNull();
  });
});

describe('learnFetch', () => {
  it('sends the learn token as an Authorization: Learn header', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(200, { ok: true }));
    vi.stubGlobal('fetch', fetchMock);
    setToken('tok-2', LATER);
    const resp = await learnFetch('/learn/auth/me', { headers: { Accept: 'application/json' } });
    expect(resp.status).toBe(200);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/learn/auth/me');
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Learn tok-2');
    expect(headers.get('Accept')).toBe('application/json');
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('falls back to the portal session when signed in with an account', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(200));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    await learnFetch('/learn/me/assignments', { method: 'GET' });
    expect(apiFetch).toHaveBeenCalledWith('/learn/me/assignments', { method: 'GET' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 401 clears the token and goes back to sign-in', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(401, { detail: { code: 'not_authenticated' } })));
    setToken('tok-3', LATER);
    const resp = await learnFetch('/learn/auth/me');
    expect(resp.status).toBe(401);
    expect(getToken()).toBeNull();
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  it('a 401 on the account fallback also goes back to sign-in', async () => {
    vi.mocked(apiFetch).mockResolvedValue(json(401));
    await learnFetch('/learn/auth/me');
    expect(signedOut).toHaveBeenCalledTimes(1);
  });

  it('other errors leave the session alone', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json(403)));
    setToken('tok-4', LATER);
    await learnFetch('/learn/auth/me');
    expect(getToken()).toBe('tok-4');
    expect(signedOut).not.toHaveBeenCalled();
  });
});

describe('learnSignOut', () => {
  it('ends the learn session on the server and forgets the token', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    setToken('tok-5', LATER);
    await learnSignOut();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:8000/learn/auth/logout');
    expect(init.method).toBe('POST');
    expect(new Headers(init.headers).get('Authorization')).toBe('Learn tok-5');
    expect(getToken()).toBeNull();
  });

  it('forgets the token even when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('offline')));
    setToken('tok-6', LATER);
    await learnSignOut();
    expect(getToken()).toBeNull();
  });
});
