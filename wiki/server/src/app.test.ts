import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';

import { fixtureDoc } from '../../web/src/editor/fixtures';
import type { WikiApi } from './apiClient';
import { createApp } from './app';
import type { ServerConfig } from './config';
import { renderDocHtml } from './render';

const INDEX = '<!doctype html><title>wiki</title><div id="root"></div>';

let tmpRoot: string;
let staticDir: string;

beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'wiki-static-'));
  // a dot directory on the way, like a checkout under .claude/worktrees
  staticDir = join(tmpRoot, '.checkout', 'dist');
  mkdirSync(staticDir, { recursive: true });
  writeFileSync(join(staticDir, 'index.html'), INDEX);
  mkdirSync(join(staticDir, 'assets'));
  writeFileSync(join(staticDir, 'assets', 'app.js'), 'console.log("wiki")');
});

afterAll(() => rmSync(tmpRoot, { recursive: true, force: true }));

const api: WikiApi = {
  authorize: vi.fn(async () => null),
  level: vi.fn(async () => null),
  loadState: vi.fn(async () => ({ ydoc: null, draftJson: null })),
  storeState: vi.fn(async () => undefined),
};

function build(overrides: Partial<ServerConfig> = {}) {
  return createApp({
    port: 0,
    apiUrl: 'http://api.test',
    serviceToken: 'svc-secret',
    staticDir,
    reauthMs: 300_000,
    ...overrides,
  }, api);
}

describe('GET /healthz', () => {
  it('answers ok', async () => {
    const res = await request(build().app).get('/healthz');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });

  it('answers ok even without a service token', async () => {
    const res = await request(build({ serviceToken: '' }).app).get('/healthz');
    expect(res.status).toBe(200);
  });
});

describe('POST /internal/render', () => {
  const render = (app = build().app) => request(app).post('/internal/render');

  it('renders a document with the shared schema', async () => {
    const res = await render()
      .set('X-Wiki-Service-Token', 'svc-secret')
      .send({ doc: fixtureDoc });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ html: renderDocHtml(fixtureDoc) });
  });

  it('is off while no service token is configured', async () => {
    const res = await render(build({ serviceToken: '' }).app)
      .set('X-Wiki-Service-Token', '')
      .send({ doc: fixtureDoc });
    expect(res.status).toBe(503);
    expect(res.body.detail.code).toBe('internal_disabled');
  });

  it('refuses a missing service token', async () => {
    const res = await render().send({ doc: fixtureDoc });
    expect(res.status).toBe(401);
    expect(res.body.detail.code).toBe('bad_service_token');
  });

  it.each(['wrong', 'svc-secre', 'svc-secret-and-more'])('refuses the service token %j', async (token) => {
    const res = await render().set('X-Wiki-Service-Token', token).send({ doc: fixtureDoc });
    expect(res.status).toBe(401);
    expect(res.body.detail.code).toBe('bad_service_token');
  });

  it('refuses something that is not a document', async () => {
    const res = await render()
      .set('X-Wiki-Service-Token', 'svc-secret')
      .send({ doc: { type: 'nope' } });
    expect(res.status).toBe(422);
    expect(res.body.detail.code).toBe('bad_doc');
  });

  it('refuses a body without a document', async () => {
    const res = await render().set('X-Wiki-Service-Token', 'svc-secret').send({});
    expect(res.status).toBe(422);
    expect(res.body.detail.code).toBe('bad_doc');
  });

  it('refuses a body over 5 MB', async () => {
    const big = 'x'.repeat(5 * 1024 * 1024 + 1);
    const res = await render()
      .set('X-Wiki-Service-Token', 'svc-secret')
      .send({ doc: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: big }] }] } });
    expect(res.status).toBe(413);
    expect(res.body.detail.code).toBe('too_large');
  });

  it('refuses a body that is not JSON', async () => {
    const res = await render()
      .set('X-Wiki-Service-Token', 'svc-secret')
      .set('Content-Type', 'application/json')
      .send('{not json');
    expect(res.status).toBe(400);
    expect(res.body.detail.code).toBe('bad_request');
  });
});

describe('the SPA', () => {
  it('serves built files', async () => {
    const res = await request(build().app).get('/assets/app.js');
    expect(res.status).toBe(200);
    expect(res.text).toBe('console.log("wiki")');
  });

  it.each(['/', '/n/abc', '/s/OPS', '/spaces/new', '/p/share-token_1'])('falls back to index.html for %s', async (path) => {
    const res = await request(build().app).get(path);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.text).toBe(INDEX);
  });

  it.each(['/internal/nope', '/internal', '/collab', '/collab/x', '/healthz/x'])(
    'does not fall back for %s', async (path) => {
      const res = await request(build().app).get(path);
      expect(res.status).toBe(404);
      expect(res.text).not.toBe(INDEX);
    },
  );

  it('does not fall back for a POST', async () => {
    const res = await request(build().app).post('/n/abc');
    expect(res.status).toBe(404);
  });

  it('does not fall back for a missing built file', async () => {
    const res = await request(build().app).get('/assets/missing.js');
    expect(res.status).toBe(404);
  });
});

describe('WebSocket upgrades', () => {
  let server: Server;
  let port: number;

  const open = (path: string) => new Promise<'open' | 'refused'>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.on('open', () => { ws.close(); resolve('open'); });
    ws.on('error', () => resolve('refused'));
  });

  beforeAll(async () => {
    const { app, attach } = build();
    server = createServer(app);
    attach(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it.each(['/collab', '/collab?page=x'])('hands %s to Hocuspocus', async (path) => {
    await expect(open(path)).resolves.toBe('open');
  });

  it.each(['/', '/internal/render', '/collabx', '/n/abc'])('refuses an upgrade on %s', async (path) => {
    await expect(open(path)).resolves.toBe('refused');
  });
});
