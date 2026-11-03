// @vitest-environment jsdom
/** The watch calls: a person's own (/auth/me/watches) and a notification group's
 *  (/notifications/groups/{id}/watches). Each is one request with the method, path
 *  and body the API takes, and a failure becomes an ApiError that carries the API's
 *  code (409 already_watching among them). */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, READ_ONLY_MESSAGE,
  createGroupWatch, createMyWatch, deleteGroupWatch, deleteMyWatch, getWatchState,
  listGroupWatches, listMyWatches, listWikiSpaces, searchWiki, updateGroupWatch, updateMyWatch,
  type Watch, type WatchState, type WikiSearchHit, type WikiSpace,
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
const THING_ID = '22222222-2222-4222-8222-222222222222';
const GROUP_ID = '33333333-3333-4333-8333-333333333333';

const WATCH: Watch = {
  id: WATCH_ID, thing: 'initiative', thing_id: THING_ID, thing_name: 'Initiative A',
  link: `/initiatives/${THING_ID}`, kinds: [], via: { type: 'you', id: null, name: null },
  created_at: '2026-11-02T12:00:00Z',
};

const headersOf = (init: RequestInit) => init.headers as Record<string, string>;

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

// ── a person's own watches ───────────────────────────────────────────

it('listMyWatches: GET /auth/me/watches, the watches as given', async () => {
  const calls = mockFetch(json([WATCH]));
  expect(await listMyWatches()).toEqual([WATCH]);

  expect(calls()).toHaveLength(1);
  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe('/auth/me/watches');
  expect(new URL(url).search).toBe('');
  expect(init.method ?? 'GET').toBe('GET');
  expect(init.body).toBeUndefined();
  expect(headersOf(init).Authorization).toBe('Bearer tok');
});

it('getWatchState: GET /auth/me/watches/state with the thing and its id', async () => {
  const state: WatchState = { watching: true, watch_id: WATCH_ID, kinds: ['truck_status_changed'] };
  const calls = mockFetch(json(state));
  expect(await getWatchState('truck', THING_ID)).toEqual(state);

  const [url, init] = calls()[0];
  const parsed = new URL(url);
  expect(parsed.pathname).toBe('/auth/me/watches/state');
  expect(parsed.searchParams.get('thing')).toBe('truck');
  expect(parsed.searchParams.get('id')).toBe(THING_ID);
  expect([...parsed.searchParams.keys()].sort()).toEqual(['id', 'thing']);
  expect(init.method ?? 'GET').toBe('GET');
});

it('createMyWatch: POST /auth/me/watches with the body as JSON, the new watch back', async () => {
  const calls = mockFetch(json(WATCH, 201));
  const body = { thing: 'initiative' as const, id: THING_ID, kinds: [] };
  expect(await createMyWatch(body)).toEqual(WATCH);

  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe('/auth/me/watches');
  expect(init.method).toBe('POST');
  expect(headersOf(init)['Content-Type']).toBe('application/json');
  expect(JSON.parse(init.body as string)).toEqual(body);
});

it('createMyWatch: an Everything watch goes out with no id and the events it names', async () => {
  const calls = mockFetch(json({ ...WATCH, thing: 'everything', thing_id: null }, 201));
  const body = { thing: 'everything' as const, id: null, kinds: ['truck_status_changed'] };
  await createMyWatch(body);

  expect(JSON.parse(calls()[0][1].body as string)).toEqual(body);
});

it('updateMyWatch: PATCH /auth/me/watches/{id} with the events as {kinds}', async () => {
  const calls = mockFetch(json({ ...WATCH, kinds: ['truck_status_changed'] }));
  const watch = await updateMyWatch(WATCH_ID, ['truck_status_changed']);
  expect(watch.kinds).toEqual(['truck_status_changed']);

  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe(`/auth/me/watches/${WATCH_ID}`);
  expect(init.method).toBe('PATCH');
  expect(headersOf(init)['Content-Type']).toBe('application/json');
  expect(JSON.parse(init.body as string)).toEqual({ kinds: ['truck_status_changed'] });
});

it('updateMyWatch: an empty list goes out as it is (every event that applies)', async () => {
  const calls = mockFetch(json(WATCH));
  await updateMyWatch(WATCH_ID, []);

  expect(JSON.parse(calls()[0][1].body as string)).toEqual({ kinds: [] });
});

it('deleteMyWatch: DELETE /auth/me/watches/{id}, nothing back', async () => {
  const calls = mockFetch(noContent);
  expect(await deleteMyWatch(WATCH_ID)).toBeUndefined();

  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe(`/auth/me/watches/${WATCH_ID}`);
  expect(init.method).toBe('DELETE');
  expect(init.body).toBeUndefined();
});

// ── a notification group's watches ───────────────────────────────────

const GROUP_WATCH: Watch = {
  ...WATCH, via: { type: 'group', id: GROUP_ID, name: 'Group A' },
};

it('listGroupWatches: GET /notifications/groups/{id}/watches', async () => {
  const calls = mockFetch(json([GROUP_WATCH]));
  expect(await listGroupWatches(GROUP_ID)).toEqual([GROUP_WATCH]);

  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe(`/notifications/groups/${GROUP_ID}/watches`);
  expect(init.method ?? 'GET').toBe('GET');
});

it('createGroupWatch: POST /notifications/groups/{id}/watches with the body as JSON', async () => {
  const calls = mockFetch(json(GROUP_WATCH, 201));
  const body = { thing: 'site' as const, id: THING_ID, kinds: ['initiative_status_changed'] };
  expect(await createGroupWatch(GROUP_ID, body)).toEqual(GROUP_WATCH);

  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe(`/notifications/groups/${GROUP_ID}/watches`);
  expect(init.method).toBe('POST');
  expect(headersOf(init)['Content-Type']).toBe('application/json');
  expect(JSON.parse(init.body as string)).toEqual(body);
});

it('updateGroupWatch: PATCH /notifications/groups/{id}/watches/{watchId} with {kinds}', async () => {
  const calls = mockFetch(json(GROUP_WATCH));
  await updateGroupWatch(GROUP_ID, WATCH_ID, ['truck_status_changed']);

  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe(`/notifications/groups/${GROUP_ID}/watches/${WATCH_ID}`);
  expect(init.method).toBe('PATCH');
  expect(headersOf(init)['Content-Type']).toBe('application/json');
  expect(JSON.parse(init.body as string)).toEqual({ kinds: ['truck_status_changed'] });
});

it('deleteGroupWatch: DELETE /notifications/groups/{id}/watches/{watchId}, nothing back', async () => {
  const calls = mockFetch(noContent);
  expect(await deleteGroupWatch(GROUP_ID, WATCH_ID)).toBeUndefined();

  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe(`/notifications/groups/${GROUP_ID}/watches/${WATCH_ID}`);
  expect(init.method).toBe('DELETE');
});

// ── wiki things ──────────────────────────────────────────────────────

const WIKI_WATCH: Watch = {
  id: WATCH_ID, thing: 'wiki_node', thing_id: THING_ID, thing_name: 'Page A',
  thing_label: 'Wiki page', link: `https://wiki.example.com/n/${THING_ID}`, kinds: [],
  via: { type: 'group', id: GROUP_ID, name: 'Group A' }, created_at: '2026-11-02T12:00:00Z',
};

it('a wiki watch comes back as the API sends it: its label, and an absolute link', async () => {
  mockFetch(json([WIKI_WATCH]));
  const [watch] = await listMyWatches();

  expect(watch.thing).toBe('wiki_node');
  expect(watch.thing_label).toBe('Wiki page');
  expect(watch.link).toBe(`https://wiki.example.com/n/${THING_ID}`);
  expect(watch.kinds).toEqual([]);
});

it('createGroupWatch: a wiki library or node goes out as {thing, id, kinds: []}', async () => {
  const calls = mockFetch(json(WIKI_WATCH, 201));
  await createGroupWatch(GROUP_ID, { thing: 'wiki_space', id: THING_ID, kinds: [] });
  await createGroupWatch(GROUP_ID, { thing: 'wiki_node', id: THING_ID, kinds: [] });

  expect(calls().map(([, init]) => JSON.parse(init.body as string))).toEqual([
    { thing: 'wiki_space', id: THING_ID, kinds: [] },
    { thing: 'wiki_node', id: THING_ID, kinds: [] },
  ]);
});

const SPACE: WikiSpace = { id: THING_ID, key: 'library-a', name: 'Library A' };

it('listWikiSpaces: GET /wiki/spaces with no query, the libraries as given', async () => {
  const calls = mockFetch(json([SPACE]));
  expect(await listWikiSpaces()).toEqual([SPACE]);

  expect(calls()).toHaveLength(1);
  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe('/wiki/spaces');
  expect(new URL(url).search).toBe('');
  expect(init.method ?? 'GET').toBe('GET');
  expect(init.body).toBeUndefined();
  expect(headersOf(init).Authorization).toBe('Bearer tok');
});

const HIT: WikiSearchHit = {
  node: { id: THING_ID, kind: 'page', title: 'Page A', space_key: 'library-a', space_name: 'Library A' },
  snippet_html: 'a <mark>Page</mark>', breadcrumbs: ['Folder A'],
};

it('searchWiki: GET /wiki/search with the text, the kind, the limit and log=false, the hits as given', async () => {
  const calls = mockFetch(json([HIT]));
  expect(await searchWiki('Page', 'page', 5)).toEqual([HIT]);

  const [url, init] = calls()[0];
  const parsed = new URL(url);
  expect(parsed.pathname).toBe('/wiki/search');
  expect(parsed.searchParams.get('q')).toBe('Page');
  expect(parsed.searchParams.get('kind')).toBe('page');
  expect(parsed.searchParams.get('limit')).toBe('5');
  expect([...parsed.searchParams.keys()].sort()).toEqual(['kind', 'limit', 'log', 'q']);
  expect(init.method ?? 'GET').toBe('GET');
  expect(init.body).toBeUndefined();
});

it('searchWiki never logs: it searches as the person types, so every call sends log=false', async () => {
  const calls = mockFetch(json([]));
  await searchWiki('a', 'folder', 8);
  await searchWiki('ab', 'page', 20);

  expect(calls().map(([url]) => new URL(url).searchParams.get('log'))).toEqual(['false', 'false']);
});

it('searchWiki sends the text as one encoded value, whatever is in it', async () => {
  const calls = mockFetch(json([]));
  await searchWiki('a&kind=file b/c?#', 'folder', 8);

  const parsed = new URL(calls()[0][0]);
  expect(parsed.searchParams.get('q')).toBe('a&kind=file b/c?#');
  expect(parsed.searchParams.get('kind')).toBe('folder');
  expect([...parsed.searchParams.keys()].sort()).toEqual(['kind', 'limit', 'log', 'q']);
});

it.each([
  ['listWikiSpaces', 403, 'forbidden', () => listWikiSpaces()],
  ['searchWiki', 403, 'forbidden', () => searchWiki('a', 'page', 8)],
  ['searchWiki', 422, 'bad_query', () => searchWiki('a', 'page', 8)],
])('%s: a %i %s is an ApiError that carries the status and code', async (_name, status, code, call) => {
  mockFetch(json({ detail: { code } }, status));
  const err = await call().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status, code });
});

// ── failures ─────────────────────────────────────────────────────────

it('a 409 comes back as an ApiError with the code already_watching, for both creates', async () => {
  mockFetch(json({ detail: { code: 'already_watching' } }, 409));
  const own = await createMyWatch({ thing: 'truck', id: THING_ID, kinds: [] }).catch((e: unknown) => e);
  expect(own).toBeInstanceOf(ApiError);
  expect(own).toMatchObject({ status: 409, code: 'already_watching' });

  const group = await createGroupWatch(GROUP_ID, { thing: 'everything', id: null, kinds: ['truck_status_changed'] })
    .catch((e: unknown) => e);
  expect(group).toBeInstanceOf(ApiError);
  expect(group).toMatchObject({ status: 409, code: 'already_watching' });
});

it.each([
  ['listMyWatches', () => listMyWatches()],
  ['getWatchState', () => getWatchState('site', THING_ID)],
  ['createMyWatch', () => createMyWatch({ thing: 'site', id: THING_ID, kinds: [] })],
  ['updateMyWatch', () => updateMyWatch(WATCH_ID, [])],
  ['deleteMyWatch', () => deleteMyWatch(WATCH_ID)],
  ['listGroupWatches', () => listGroupWatches(GROUP_ID)],
  ['createGroupWatch', () => createGroupWatch(GROUP_ID, { thing: 'site', id: THING_ID, kinds: [] })],
  ['updateGroupWatch', () => updateGroupWatch(GROUP_ID, WATCH_ID, [])],
  ['deleteGroupWatch', () => deleteGroupWatch(GROUP_ID, WATCH_ID)],
])('%s: any failure is an ApiError that carries the status and code', async (_name, call) => {
  mockFetch(json({ detail: { code: 'watch_not_found' } }, 404));
  const err = await call().catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 404, code: 'watch_not_found' });
});

it('read-only mode carries the server message', async () => {
  mockFetch(json({ detail: { code: 'read_only_mode', message: 'Cutover' } }, 423));
  const err = await createMyWatch({ thing: 'truck', id: THING_ID, kinds: [] }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 423, code: 'read_only_mode', message: READ_ONLY_MESSAGE });
});
