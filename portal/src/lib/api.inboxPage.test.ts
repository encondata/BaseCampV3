// @vitest-environment jsdom
/** listInboxPage: one page of the person's inbox for usePagedList — page size,
 *  query-string encoding (blanks dropped), items mapped to rows, signal
 *  pass-through, and errors. The bell's own listInbox() keeps its old shape. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, listInbox, listInboxPage } from './api';

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
  return () => fn.mock.calls.filter(([u]) => !String(u).includes('/auth/refresh'));
}

const json = (body: unknown, status = 200) => () =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const ITEM = {
  id: 'n1', kind: 'wiki_comment', category: 'wiki', title: 'T', body: '', link: null,
  payload: {}, created_at: '2026-10-30T12:00:00Z', read_at: null,
};

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

it('asks for 50 and maps the inbox items to rows, keeping the cursor and the total', async () => {
  const calls = mockFetch(json({ unread_count: 4, items: [ITEM], next_cursor: 'c2', total: 61 }));
  const page = await listInboxPage({ category: null, unreadOnly: false, search: '', cursor: null });
  expect(page).toEqual({ rows: [ITEM], next_cursor: 'c2', total: 61 });

  const [url] = calls()[0] as [string];
  const u = new URL(url);
  expect(u.pathname).toMatch(/\/notifications\/inbox$/);
  expect(u.searchParams.get('limit')).toBe('50');
  expect([...u.searchParams.keys()]).toEqual(['limit']);                 // no blank params
});

it('sends the cursor, the category and unread_only when they are set', async () => {
  const calls = mockFetch(json({ unread_count: 0, items: [], next_cursor: null, total: 0 }));
  await listInboxPage({ category: 'wiki', unreadOnly: true, search: '', cursor: 'c1' });
  const u = new URL((calls()[0] as [string])[0]);
  expect(u.searchParams.get('limit')).toBe('50');
  expect(u.searchParams.get('cursor')).toBe('c1');
  expect(u.searchParams.get('category')).toBe('wiki');
  expect(u.searchParams.get('unread_only')).toBe('true');
});

it('passes the abort signal through and sends the bearer token', async () => {
  const calls = mockFetch(json({ unread_count: 0, items: [], next_cursor: null, total: 0 }));
  const ctrl = new AbortController();
  await listInboxPage({ category: null, unreadOnly: false, search: '', cursor: null }, ctrl.signal);
  const [, init] = calls()[0] as [string, RequestInit];
  expect(init.signal).toBe(ctrl.signal);
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
});

it('throws the API error on a failed page', async () => {
  mockFetch(json({ detail: { code: 'invalid_cursor' } }, 422));
  await expect(listInboxPage({ category: null, unreadOnly: false, search: '', cursor: 'bad' }))
    .rejects.toBeInstanceOf(ApiError);
});

it('listInbox() keeps asking for the bare inbox the bell polls', async () => {
  const calls = mockFetch(json({ unread_count: 1, items: [ITEM], next_cursor: null, total: 1 }));
  const inbox = await listInbox();
  expect(inbox.items).toEqual([ITEM]);
  const u = new URL((calls()[0] as [string])[0]);
  expect(u.search).toBe('');
});
