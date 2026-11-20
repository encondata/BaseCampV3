// @vitest-environment jsdom
/** The laptop's environment: the edge calls behind the chooser (anonymous
 *  reads, the unlock, the switch with its bearer and error codes), the
 *  hook the shell and Login read, and the badge and server wording. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as api from './api';
import { environmentBadge, serverLabel, useEdgeEnvironment } from './environment';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Call = [string, RequestInit | undefined];

const UAT: api.EdgeEnvironment = {
  kind: 'named', id: 'uat', name: 'UAT', domain: 'uat.serversherpa.com',
  api_url: 'https://api.uat.serversherpa.com', portal_url: 'https://portal.uat.serversherpa.com',
  is_prod: false, ever_registered: true,
};
const PROD: api.EdgeEnvironment = {
  ...UAT, id: 'prod', name: 'Prod', domain: 'serversherpa.com',
  api_url: 'https://api.serversherpa.com', portal_url: 'https://portal.serversherpa.com', is_prod: true,
};
const CUSTOM: api.EdgeEnvironment = {
  kind: 'custom', id: null, name: 'Custom', domain: null,
  api_url: 'http://10.10.48.103:8000', portal_url: 'http://10.10.48.103:5173',
  is_prod: false, ever_registered: false,
};

function call(fetchMock: ReturnType<typeof vi.fn>, i = -1) {
  const [url, init] = fetchMock.mock.calls.at(i) as unknown as Call;
  return {
    url,
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: init?.body ? JSON.parse(String(init.body)) : undefined,
  };
}

beforeEach(() => {
  api.clearLocalSession();
  window.__KIOSK_CONFIG__ = { apiUrl: 'http://edge.test' };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.__KIOSK_CONFIG__;
});

describe('edge calls', () => {
  it('getEdgeEnvironment reads GET /edge/environment with no sign-in', async () => {
    const fetchMock = vi.fn(async () => json(UAT));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.getEdgeEnvironment()).toEqual(UAT);
    expect(call(fetchMock)).toMatchObject({ url: 'http://edge.test/edge/environment', method: 'GET' });
  });

  it('getEdgeEnvironments reads the list and where it came from', async () => {
    const list = { source: 'built_in', environments: [{ ...PROD, kind: undefined }] };
    const fetchMock = vi.fn(async () => json(list));
    vi.stubGlobal('fetch', fetchMock);
    expect(await api.getEdgeEnvironments()).toEqual(list);
    expect(call(fetchMock)).toMatchObject({ url: 'http://edge.test/edge/environments', method: 'GET' });
  });

  it('unlockEnvironment posts the password as JSON; a 403 is wrong_password', async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.unlockEnvironment('cumulus')).resolves.toBeUndefined();
    expect(call(fetchMock)).toMatchObject({
      url: 'http://edge.test/edge/environment/unlock', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: { password: 'cumulus' },
    });

    fetchMock.mockResolvedValueOnce(json({ detail: { code: 'wrong_password' } }, 403));
    await expect(api.unlockEnvironment('nope')).rejects.toMatchObject({ status: 403, code: 'wrong_password' });
  });

  it('switchEnvironment posts the body as JSON and answers the new environment', async () => {
    const fetchMock = vi.fn(async () => json(PROD));
    vi.stubGlobal('fetch', fetchMock);
    const body = { password: 'cumulus', target: { id: 'prod' } };
    expect(await api.switchEnvironment(body)).toEqual(PROD);
    const sent = call(fetchMock);
    expect(sent).toMatchObject({
      url: 'http://edge.test/edge/environment', method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body,
    });
    // signed out: no bearer
    expect(sent.headers.Authorization).toBeUndefined();
  });

  it('switchEnvironment sends the bearer when signed in, so the edge can check who it is', async () => {
    const fetchMock = vi.fn(async (url: string) => (String(url).endsWith('/auth/login')
      ? json({ access_token: 'tok-1', expires_in: 900, session_expires_at: '2026-11-21T00:00:00Z' })
      : json(PROD)));
    vi.stubGlobal('fetch', fetchMock);
    await api.loginRequest('a@b.c', 'pw');
    await api.switchEnvironment({ password: 'cumulus', target: { custom: { api_url: 'http://x', portal_url: 'http://y' } } });
    expect(call(fetchMock).headers.Authorization).toBe('Bearer tok-1');
  });

  it('switchEnvironment throws the code, and the unsent count of outbox_not_empty', async () => {
    const fetchMock = vi.fn(async () => json({ detail: { code: 'outbox_not_empty', pending: 3 } }, 409));
    vi.stubGlobal('fetch', fetchMock);
    const err = await api.switchEnvironment({ password: 'cumulus', target: { id: 'uat' } }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(api.ApiError);
    expect(err).toMatchObject({ status: 409, code: 'outbox_not_empty', detail: { pending: 3 } });

    fetchMock.mockResolvedValueOnce(json({ detail: { code: 'access_check_offline' } }, 503));
    await expect(api.switchEnvironment({ password: 'cumulus', target: { id: 'uat' }, discard: true }))
      .rejects.toMatchObject({ status: 503, code: 'access_check_offline' });
  });
});

describe('environmentBadge', () => {
  it('names a non-Prod environment, says Custom for typed URLs, and nothing on Prod', () => {
    expect(environmentBadge(UAT)).toBe('UAT');
    expect(environmentBadge({ ...CUSTOM, name: 'whatever' })).toBe('Custom');
    expect(environmentBadge(PROD)).toBeNull();
    expect(environmentBadge(null)).toBeNull();
  });
});

describe('serverLabel', () => {
  it('a named environment shows its API host; a custom one its whole API URL', () => {
    expect(serverLabel(UAT)).toBe('api.uat.serversherpa.com');
    expect(serverLabel(CUSTOM)).toBe('http://10.10.48.103:8000');
  });
});

// a .ts file: no JSX
function Probe() {
  const env = useEdgeEnvironment();
  return createElement('div', null, env ? env.name : 'none');
}
const probe = () => createElement(Probe);

describe('useEdgeEnvironment', () => {
  it('on a laptop, fetches the environment once per mount', async () => {
    window.__KIOSK_CONFIG__ = { apiUrl: 'http://edge.test', mode: 'laptop' };
    const fetchMock = vi.fn(async () => json(UAT));
    vi.stubGlobal('fetch', fetchMock);
    const { rerender } = render(probe());
    expect(await screen.findByText('UAT')).toBeTruthy();
    rerender(probe());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('on the plain web kiosk, asks nothing and is null', async () => {
    const fetchMock = vi.fn(async () => json(UAT));
    vi.stubGlobal('fetch', fetchMock);
    render(probe());
    await waitFor(() => expect(screen.getByText('none')).toBeTruthy());
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays null when the edge cannot be asked', async () => {
    window.__KIOSK_CONFIG__ = { apiUrl: 'http://edge.test', mode: 'laptop' };
    const fetchMock = vi.fn(async () => { throw new TypeError('down'); });
    vi.stubGlobal('fetch', fetchMock);
    render(probe());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(screen.getByText('none')).toBeTruthy();
  });
});
