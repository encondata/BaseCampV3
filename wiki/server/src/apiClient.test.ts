import { describe, expect, it, vi } from 'vitest';

import { ApiError, isRetryable, makeApi } from './apiClient';
import { loadConfig, type ServerConfig } from './config';

const NODE = '3f2a1b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';

const cfg: ServerConfig = {
  port: 5177,
  apiUrl: 'http://api.test',
  serviceToken: 'svc-secret',
  staticDir: 'dist',
  reauthMs: 300_000,
};

function reply(status: number, body?: unknown): Response {
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
  });
}

describe('loadConfig', () => {
  it('uses the defaults', () => {
    expect(loadConfig({})).toEqual({
      port: 5177,
      apiUrl: 'http://localhost:8000',
      serviceToken: '',
      staticDir: 'dist',
      reauthMs: 300_000,
    });
  });

  it('reads the environment and drops a trailing slash from the API URL', () => {
    expect(loadConfig({
      PORT: '8080',
      WIKI_API_URL: 'https://api.example.com/',
      WIKI_SERVICE_TOKEN: 'tok',
      WIKI_STATIC_DIR: '/srv/wiki',
      WIKI_REAUTH_MS: '60000',
    })).toEqual({
      port: 8080,
      apiUrl: 'https://api.example.com',
      serviceToken: 'tok',
      staticDir: '/srv/wiki',
      reauthMs: 60_000,
    });
  });

  it('refuses a number that is not one', () => {
    expect(() => loadConfig({ PORT: 'eighty' })).toThrow(/PORT/);
    expect(() => loadConfig({ WIKI_REAUTH_MS: '0' })).toThrow(/WIKI_REAUTH_MS/);
  });
});

describe('makeApi.authorize', () => {
  it('passes the user token and the service token through', async () => {
    const fetchImpl = vi.fn(async () => reply(200, {
      level: 'edit', person: { id: 'p1', name: 'Ada' }, color: '#123456',
    }));
    const api = makeApi(cfg, fetchImpl as typeof fetch);
    await expect(api.authorize('user-tok', NODE)).resolves.toEqual({
      level: 'edit', person: { id: 'p1', name: 'Ada' }, color: '#123456',
    });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://api.test/wiki/internal/collab/authorize?node=${NODE}`);
    const headers = new Headers(init.headers);
    expect(headers.get('authorization')).toBe('Bearer user-tok');
    expect(headers.get('x-wiki-service-token')).toBe('svc-secret');
  });

  it.each([401, 403, 404])('answers null for %s', async (status) => {
    const api = makeApi(cfg, (async () => reply(status, { detail: { code: 'x' } })) as typeof fetch);
    await expect(api.authorize('tok', NODE)).resolves.toBeNull();
  });

  it('answers null for a level it does not know', async () => {
    const api = makeApi(cfg, (async () => reply(200, {
      level: 'owner', person: { id: 'p1', name: 'Ada' }, color: '#123456',
    })) as typeof fetch);
    await expect(api.authorize('tok', NODE)).resolves.toBeNull();
  });

  it('throws for a server error', async () => {
    const api = makeApi(cfg, (async () => reply(503, {
      detail: { code: 'internal_disabled', message: 'off' },
    })) as typeof fetch);
    await expect(api.authorize('tok', NODE)).rejects.toMatchObject({
      status: 503, code: 'internal_disabled',
    });
  });
});

describe('makeApi.level', () => {
  const PERSON = '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c6b';

  it('asks by person with the service token alone', async () => {
    const fetchImpl = vi.fn(async () => reply(200, { level: 'view' }));
    const api = makeApi(cfg, fetchImpl as typeof fetch);
    await expect(api.level(NODE, PERSON)).resolves.toBe('view');
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://api.test/wiki/internal/collab/level?node=${NODE}&person=${PERSON}`);
    const headers = new Headers(init.headers);
    expect(headers.get('x-wiki-service-token')).toBe('svc-secret');
    expect(headers.get('authorization')).toBeNull();
  });

  it.each([
    [404, 'not_found'],
    // dropped to view: live editing is for editors, so the connection goes
    [403, 'forbidden'],
  ])('answers null when the person may no longer open the page live (%s)', async (status, code) => {
    const api = makeApi(cfg, (async () => reply(status, { detail: { code } })) as typeof fetch);
    await expect(api.level(NODE, PERSON)).resolves.toBeNull();
  });

  it('answers null for a level it does not know', async () => {
    const api = makeApi(cfg, (async () => reply(200, { level: 'owner' })) as typeof fetch);
    await expect(api.level(NODE, PERSON)).resolves.toBeNull();
  });

  it.each([401, 503])('throws for %s (a server problem, not a verdict on the person)', async (status) => {
    const api = makeApi(cfg, (async () => reply(status, { detail: { code: 'x' } })) as typeof fetch);
    await expect(api.level(NODE, PERSON)).rejects.toMatchObject({ status });
  });
});

describe('makeApi.loadState', () => {
  it('decodes the stored update', async () => {
    const fetchImpl = vi.fn(async () => reply(200, {
      ydoc_b64: Buffer.from([1, 2, 3]).toString('base64'), draft_json: null, title: 'T',
    }));
    const api = makeApi(cfg, fetchImpl as typeof fetch);
    const state = await api.loadState(NODE);
    expect(state.ydoc).toEqual(new Uint8Array([1, 2, 3]));
    expect(state.draftJson).toBeNull();
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://api.test/wiki/internal/pages/${NODE}/state`);
    expect(new Headers(init.headers).get('x-wiki-service-token')).toBe('svc-secret');
  });

  it('hands back the draft of a page never opened live', async () => {
    const draft = { type: 'doc', content: [] };
    const api = makeApi(cfg, (async () => reply(200, {
      ydoc_b64: null, draft_json: draft, title: 'T',
    })) as typeof fetch);
    await expect(api.loadState(NODE)).resolves.toEqual({ ydoc: null, draftJson: draft });
  });

  it('throws when the page is gone', async () => {
    const api = makeApi(cfg, (async () => reply(404, {
      detail: { code: 'not_found', message: 'gone' },
    })) as typeof fetch);
    await expect(api.loadState(NODE)).rejects.toBeInstanceOf(ApiError);
  });
});

describe('makeApi.storeState', () => {
  it('PUTs the encoded document, its JSON and the editors', async () => {
    const fetchImpl = vi.fn(async () => reply(204));
    const api = makeApi(cfg, fetchImpl as typeof fetch);
    const doc = { type: 'doc', content: [] };
    await api.storeState(NODE, new Uint8Array([9, 8, 7]), doc, ['p1', 'p2']);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://api.test/wiki/internal/pages/${NODE}/state`);
    expect(init.method).toBe('PUT');
    const headers = new Headers(init.headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('x-wiki-service-token')).toBe('svc-secret');
    expect(JSON.parse(init.body as string)).toEqual({
      ydoc_b64: Buffer.from([9, 8, 7]).toString('base64'),
      content_json: doc,
      editor_ids: ['p1', 'p2'],
    });
  });

  it('throws an ApiError carrying the status and code', async () => {
    const api = makeApi(cfg, (async () => reply(409, {
      detail: { code: 'deleted', message: 'trash' },
    })) as typeof fetch);
    await expect(api.storeState(NODE, new Uint8Array(), {}, [])).rejects.toMatchObject({
      status: 409, code: 'deleted',
    });
  });
});

describe('isRetryable', () => {
  it('retries read-only mode, server errors and network failures only', () => {
    expect(isRetryable(new ApiError(423, 'read_only_mode'))).toBe(true);
    expect(isRetryable(new ApiError(500, null))).toBe(true);
    expect(isRetryable(new ApiError(503, 'internal_disabled'))).toBe(true);
    expect(isRetryable(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryable(new ApiError(409, 'deleted'))).toBe(false);
    expect(isRetryable(new ApiError(413, 'too_large'))).toBe(false);
    expect(isRetryable(new ApiError(422, 'bad_doc'))).toBe(false);
    expect(isRetryable(new ApiError(401, 'bad_service_token'))).toBe(false);
  });
});
