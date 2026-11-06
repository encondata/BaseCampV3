// @vitest-environment jsdom
/** The asset watch calls (/auth/me/asset-watches): the person's own watches of one asset, on its
 *  own or on an initiative it is on. Each is one request with the method, path and body the API
 *  takes, and a failure becomes an ApiError that carries the API's code (409 already_watching,
 *  404 thing_not_found among them). */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, READ_ONLY_MESSAGE,
  createMyAssetWatch, deleteMyAssetWatch, getAssetWatchState, listMyAssetWatches, updateMyAssetWatch,
  type AssetWatch, type AssetWatchState,
} from './api';

const SESSION = {
  status: 'ok', access_token: 'tok', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: { id: 'p1' }, roles: [], must_change_password: false, preferences: {},
  perms: {}, max_rank: 0, scope: { global: true, client_ids: [], partner_ids: [] },
  password_min_length: 8,
  totp: { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 },
};

/** apiFetch refreshes the session first (no token yet): answer that, and give
 *  every other call `answer`. Returns the non-refresh calls. */
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

const WATCH_ID = '11111111-1111-4111-8111-111111111111';
const ASSET_ID = '22222222-2222-4222-8222-222222222222';
const INITIATIVE_ID = '33333333-3333-4333-8333-333333333333';
const ROW_ID = '44444444-4444-4444-8444-444444444444';

/** A watch on the asset itself, for its next update. */
const WATCH: AssetWatch = {
  id: WATCH_ID, asset_id: ASSET_ID, asset_name: 'SN-1001',
  initiative_id: null, initiative_name: null, initiative_asset_id: null,
  condition: 'next_update', status: null, status_label: null,
  current_status: 'in_storage', current_status_label: 'In storage',
  link: `/assets/${ASSET_ID}`, created_at: '2026-11-05T12:00:00Z',
};

/** A watch for a status, set on an initiative. */
const INITIATIVE_WATCH: AssetWatch = {
  ...WATCH, initiative_id: INITIATIVE_ID, initiative_name: 'Initiative A',
  initiative_asset_id: ROW_ID, condition: 'status', status: 'shipped', status_label: 'Shipped',
  current_status: 'in_transit', current_status_label: 'In transit',
  link: `/initiatives/${INITIATIVE_ID}/assets/${ROW_ID}`,
};

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

it('listMyAssetWatches: GET /auth/me/asset-watches, the watches as given', async () => {
  const calls = mockFetch(json([WATCH, INITIATIVE_WATCH]));
  expect(await listMyAssetWatches()).toEqual([WATCH, INITIATIVE_WATCH]);

  expect(calls()).toHaveLength(1);
  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe('/auth/me/asset-watches');
  expect(new URL(url).search).toBe('');
  expect(init.method ?? 'GET').toBe('GET');
  expect(init.body).toBeUndefined();
  expect(headersOf(init).Authorization).toBe('Bearer tok');
});

it('getAssetWatchState: GET /auth/me/asset-watches/state with the asset, and no initiative for a watch on the asset itself', async () => {
  const state: AssetWatchState = { watching: true, watch: WATCH };
  const calls = mockFetch(json(state));
  expect(await getAssetWatchState(ASSET_ID)).toEqual(state);

  const [url, init] = calls()[0];
  const parsed = new URL(url);
  expect(parsed.pathname).toBe('/auth/me/asset-watches/state');
  expect(parsed.searchParams.get('asset_id')).toBe(ASSET_ID);
  expect([...parsed.searchParams.keys()]).toEqual(['asset_id']);
  expect(init.method ?? 'GET').toBe('GET');
  expect(init.body).toBeUndefined();
});

it('getAssetWatchState: an initiative goes along as initiative_id', async () => {
  const calls = mockFetch(json({ watching: true, watch: INITIATIVE_WATCH }));
  await getAssetWatchState(ASSET_ID, INITIATIVE_ID);

  const parsed = new URL(calls()[0][0]);
  expect(parsed.searchParams.get('asset_id')).toBe(ASSET_ID);
  expect(parsed.searchParams.get('initiative_id')).toBe(INITIATIVE_ID);
  expect([...parsed.searchParams.keys()].sort()).toEqual(['asset_id', 'initiative_id']);
});

it('getAssetWatchState: null and undefined are the asset itself, never the text "null"', async () => {
  const calls = mockFetch(json({ watching: false, watch: null }));
  await getAssetWatchState(ASSET_ID, null);
  await getAssetWatchState(ASSET_ID, undefined);

  for (const [url] of calls()) {
    expect([...new URL(url).searchParams.keys()]).toEqual(['asset_id']);
  }
});

it('createMyAssetWatch: POST /auth/me/asset-watches with the body as JSON, the new watch back', async () => {
  const calls = mockFetch(json(WATCH, 201));
  const body = { asset_id: ASSET_ID, initiative_id: null, condition: 'next_update' as const, status: null };
  expect(await createMyAssetWatch(body)).toEqual(WATCH);

  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe('/auth/me/asset-watches');
  expect(new URL(url).search).toBe('');
  expect(init.method).toBe('POST');
  expect(headersOf(init)['Content-Type']).toBe('application/json');
  expect(JSON.parse(init.body as string)).toEqual(body);
});

it('createMyAssetWatch: a watch for a status on an initiative goes out as it is given', async () => {
  const calls = mockFetch(json(INITIATIVE_WATCH, 201));
  const body = {
    asset_id: ASSET_ID, initiative_id: INITIATIVE_ID, condition: 'status' as const, status: 'shipped',
  };
  expect(await createMyAssetWatch(body)).toEqual(INITIATIVE_WATCH);

  expect(JSON.parse(calls()[0][1].body as string)).toEqual(body);
});

it('updateMyAssetWatch: PATCH /auth/me/asset-watches/{id} with the condition and status as JSON', async () => {
  const calls = mockFetch(json(INITIATIVE_WATCH));
  const body = { condition: 'status' as const, status: 'shipped' };
  expect(await updateMyAssetWatch(WATCH_ID, body)).toEqual(INITIATIVE_WATCH);

  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe(`/auth/me/asset-watches/${WATCH_ID}`);
  expect(init.method).toBe('PATCH');
  expect(headersOf(init)['Content-Type']).toBe('application/json');
  expect(JSON.parse(init.body as string)).toEqual(body);
});

it('updateMyAssetWatch: a Next update goes out with the status it is given (null), as the API takes it', async () => {
  const calls = mockFetch(json(WATCH));
  await updateMyAssetWatch(WATCH_ID, { condition: 'next_update', status: null });

  expect(JSON.parse(calls()[0][1].body as string)).toEqual({ condition: 'next_update', status: null });
});

it('deleteMyAssetWatch: DELETE /auth/me/asset-watches/{id}, nothing back', async () => {
  const calls = mockFetch(noContent);
  expect(await deleteMyAssetWatch(WATCH_ID)).toBeUndefined();

  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe(`/auth/me/asset-watches/${WATCH_ID}`);
  expect(init.method).toBe('DELETE');
  expect(init.body).toBeUndefined();
});

// ── failures ─────────────────────────────────────────────────────────

it.each([
  [409, 'already_watching'],
  [404, 'thing_not_found'],
  [404, 'watch_not_found'],
  [422, 'not_on_initiative'],
  [422, 'invalid_condition'],
  [422, 'status_required'],
  [422, 'invalid_status'],
  [422, 'already_at_status'],
])('a %i %s comes back as an ApiError that carries the status and code, from a create', async (status, code) => {
  mockFetch(json({ detail: { code } }, status));
  const err = await createMyAssetWatch({
    asset_id: ASSET_ID, condition: 'next_update',
  }).catch((e: unknown) => e);

  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status, code });
});

it.each([
  ['listMyAssetWatches', () => listMyAssetWatches()],
  ['getAssetWatchState', () => getAssetWatchState(ASSET_ID, INITIATIVE_ID)],
  ['createMyAssetWatch', () => createMyAssetWatch({ asset_id: ASSET_ID, condition: 'next_update' })],
  ['updateMyAssetWatch', () => updateMyAssetWatch(WATCH_ID, { condition: 'next_update' })],
  ['deleteMyAssetWatch', () => deleteMyAssetWatch(WATCH_ID)],
])('%s: any failure is an ApiError that carries the status and code', async (_name, call) => {
  mockFetch(json({ detail: { code: 'watch_not_found' } }, 404));
  const err = await call().catch((e: unknown) => e);

  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 404, code: 'watch_not_found' });
});

it('read-only mode carries the server message', async () => {
  mockFetch(json({ detail: { code: 'read_only_mode', message: 'Cutover' } }, 423));
  const err = await createMyAssetWatch({ asset_id: ASSET_ID, condition: 'next_update' })
    .catch((e: unknown) => e);

  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 423, code: 'read_only_mode', message: READ_ONLY_MESSAGE });
});
