import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const session = vi.hoisted(() => ({
  token: 'tok-1' as string | null,
  refreshed: true,
}));

vi.mock('@portal/lib/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@portal/lib/api')>();
  return {
    ...real,
    accessTokenForService: vi.fn(async () => session.token),
    refreshSession: vi.fn(async () => {
      if (!session.refreshed) return null;
      session.token = 'tok-2';
      return { access_token: 'tok-2' };
    }),
  };
});

import { ApiError, refreshSession } from '@portal/lib/api';

import { devicesFetch } from './devicesApi';

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

function authOf(init: RequestInit | undefined): string | null {
  return new Headers(init?.headers).get('Authorization');
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  session.token = 'tok-1';
  session.refreshed = true;
  vi.mocked(refreshSession).mockClear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(...responses: Response[]) {
  fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => responses.shift() ?? json(500, {}));
  vi.stubGlobal('fetch', fetchMock);
}

describe('devicesFetch', () => {
  it('sends the bearer to the same-origin path and keeps the caller\'s headers', async () => {
    stubFetch(json(200, { apps: [] }));
    const resp = await devicesFetch('/api/apps', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(await resp.json()).toEqual({ apps: [] });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/apps');
    expect(init.method).toBe('POST');
    expect(authOf(init)).toBe('Bearer tok-1');
    expect(new Headers(init.headers).get('Content-Type')).toBe('application/json');
    expect(refreshSession).not.toHaveBeenCalled();
  });

  it('refreshes once after a 401 and retries with the new token', async () => {
    stubFetch(json(401, { detail: { code: 'not_authenticated', message: 'Sign in again.' } }), json(200, { ok: true }));
    const resp = await devicesFetch('/api/apps');
    expect(resp.status).toBe(200);
    expect(refreshSession).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(authOf(fetchMock.mock.calls[0][1])).toBe('Bearer tok-1');
    expect(authOf(fetchMock.mock.calls[1][1])).toBe('Bearer tok-2');
  });

  it('retries only once: a second 401 is an ApiError', async () => {
    stubFetch(
      json(401, { detail: { code: 'not_authenticated', message: 'Sign in again.' } }),
      json(401, { detail: { code: 'not_authenticated', message: 'Sign in again.' } }),
    );
    const err = await devicesFetch('/api/apps').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it('does not retry when the session could not be refreshed', async () => {
    session.refreshed = false;
    stubFetch(json(401, { detail: { code: 'not_authenticated', message: 'Sign in again.' } }));
    const err = await devicesFetch('/api/apps').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('turns the devices API error body into an ApiError with its code and message', async () => {
    stubFetch(json(409, { detail: { code: 'version_exists', message: 'This build is already uploaded.' } }));
    const err = await devicesFetch('/api/uploads/x/commit', { method: 'POST' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(409);
    expect((err as ApiError).code).toBe('version_exists');
    expect((err as ApiError).message).toBe('This build is already uploaded.');
  });

  it('sends no Authorization header when signed out', async () => {
    session.token = null;
    stubFetch(json(200, {}));
    await devicesFetch('/api/apps');
    expect(authOf(fetchMock.mock.calls[0][1])).toBeNull();
  });

  it.each([
    'https://evil.example/api/apps',
    '//evil.example/api/apps',
    'api/apps',
    '/enroll/x.mobileconfig',
    '/apix',
    'javascript:alert(1)',
  ])('refuses %s: the bearer only goes to same-origin /api paths', async (path) => {
    stubFetch(json(200, {}));
    await expect(devicesFetch(path)).rejects.toThrow(/same-origin \/api path/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts /api with a query string', async () => {
    stubFetch(json(200, []));
    await devicesFetch('/api/apps?device_ref=x');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/apps?device_ref=x');
  });
});
