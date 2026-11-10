// @vitest-environment jsdom
/** The matching rules calls (/devtools/matching-rules): each is one request with the method, path
 *  and body the API takes; a failure becomes an ApiError that carries the API's code and detail. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError,
  checkMatchingFlow, createMatchingDraft, createMatchingTestAsset, createMatchingTestRow,
  deleteMatchingTestAsset, deleteMatchingTestRow, deployMatchingVersion, getMatchingVersion,
  listMatchingTestAssets, listMatchingVersions, rollbackMatchingVersion, standbyMatchingVersion,
  testRunMatchingFlow, updateMatchingDraft, updateMatchingTestAsset, updateMatchingTestRow,
} from './api';
import type { Flow } from './matchingRules';

const SESSION = {
  status: 'ok', access_token: 'tok', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: { id: 'p1' }, roles: [], must_change_password: false, preferences: {},
  perms: {}, max_rank: 0, scope: { global: true, client_ids: [], partner_ids: [] },
  password_min_length: 8,
  totp: { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 },
};

function mockFetch(answer: () => Response) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => (String(url).includes('/auth/refresh')
    ? new Response(JSON.stringify(SESSION), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : answer()));
  vi.stubGlobal('fetch', fn);
  return () => fn.mock.calls.filter(([u]) => !String(u).includes('/auth/refresh')) as [string, RequestInit][];
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const noContent = () => new Response(null, { status: 204 });

const ID = '11111111-1111-4111-8111-111111111111';
const FLOW: Flow = {
  format: 1,
  nodes: [{ id: 'n1', kind: 'scan_input', settings: {}, position: { x: 0, y: 0 } }],
  edges: [],
};
const ROOT = '/devtools/matching-rules';

beforeEach(() => vi.unstubAllGlobals());
afterEach(() => vi.unstubAllGlobals());

const bodyOf = (init: RequestInit) => JSON.parse(String(init.body));

it('lists and reads versions', async () => {
  const calls = mockFetch(json([]));
  await listMatchingVersions('scanning');
  await getMatchingVersion(ID);
  const [a, b] = calls();
  expect(a[0]).toContain(`${ROOT}/versions?place=scanning`);
  expect(b[0]).toContain(`${ROOT}/versions/${ID}`);
});

it('creates and updates a draft', async () => {
  const calls = mockFetch(json({}, 200));
  await createMatchingDraft({ place: 'printing', flow: FLOW, based_on_id: ID });
  await updateMatchingDraft(ID, FLOW);
  const [a, b] = calls();
  expect(a[0]).toContain(`${ROOT}/versions`);
  expect(a[1].method).toBe('POST');
  expect(bodyOf(a[1])).toEqual({ place: 'printing', flow: FLOW, based_on_id: ID });
  expect(b[0]).toContain(`${ROOT}/versions/${ID}`);
  expect(b[1].method).toBe('PUT');
  expect(bodyOf(b[1])).toEqual({ flow: FLOW });
});

it('standby, deploy and rollback are POSTs to the version', async () => {
  const calls = mockFetch(json({}));
  await standbyMatchingVersion(ID);
  await deployMatchingVersion(ID);
  await rollbackMatchingVersion(ID);
  expect(calls().map(([u, i]) => [i.method, u.split(ROOT)[1]])).toEqual([
    ['POST', `/versions/${ID}/standby`],
    ['POST', `/versions/${ID}/deploy`],
    ['POST', `/versions/${ID}/rollback`],
  ]);
});

it('check and test-run send the flow', async () => {
  const calls = mockFetch(json({}));
  await checkMatchingFlow('scanning', FLOW);
  await testRunMatchingFlow({ place: 'scanning', flow: FLOW, value: 'ab', against: 'test_set' });
  const [a, b] = calls();
  expect(a[0]).toContain(`${ROOT}/check`);
  expect(a[1].method).toBe('POST');
  expect(bodyOf(a[1])).toEqual({ place: 'scanning', flow: FLOW });
  expect(b[0]).toContain(`${ROOT}/test-run`);
  expect(bodyOf(b[1])).toEqual({ place: 'scanning', flow: FLOW, value: 'ab', against: 'test_set' });
});

it('test assets and rows', async () => {
  const asset = { asset_tag: 1, name: 'Test asset 1' };
  const row = { place: 'printing' as const, value: 'x', expected: 'serial' };
  const list = mockFetch(json([]));
  await listMatchingTestAssets();
  expect(list().map(([u, i]) => [i.method, u.split(ROOT)[1]])).toEqual([['GET', '/test-assets']]);
  const writes = mockFetch(json({}));
  await createMatchingTestAsset(asset);
  await updateMatchingTestAsset(ID, asset);
  await createMatchingTestRow(ID, row);
  await updateMatchingTestRow(ID, row);
  expect(writes().map(([u, i]) => [i.method, u.split(ROOT)[1]])).toEqual([
    ['POST', '/test-assets'],
    ['PATCH', `/test-assets/${ID}`],
    ['POST', `/test-assets/${ID}/rows`],
    ['PATCH', `/test-rows/${ID}`],
  ]);
  const deletes = mockFetch(() => noContent());
  await deleteMatchingTestAsset(ID);
  await deleteMatchingTestRow(ID);
  expect(deletes().map(([u, i]) => [i.method, u.split(ROOT)[1]])).toEqual([
    ['DELETE', `/test-assets/${ID}`],
    ['DELETE', `/test-rows/${ID}`],
  ]);
});

it('a refused deploy is an ApiError with the check', async () => {
  mockFetch(json({ detail: { code: 'check_failed', check: { ok: false } } }, 422));
  const err = await deployMatchingVersion(ID).catch((e) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err.status).toBe(422);
  expect(err.code).toBe('check_failed');
  expect((err.detail as { check: { ok: boolean } }).check.ok).toBe(false);
});
