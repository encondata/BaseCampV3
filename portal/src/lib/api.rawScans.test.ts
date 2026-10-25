// @vitest-environment jsdom
/** The three paged raw-scans calls: query-string encoding (filters as one JSON
 *  param, blanks dropped), signal pass-through, errors, and the CSV export as
 *  an authenticated blob download. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { downloadRawScansCsv, getRawScanFacets, getRawScanPage } from './api';

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

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

it('getRawScanPage sends sort, cursor and filters (JSON, blanks dropped) and returns the page', async () => {
  const calls = mockFetch(json({ rows: [], next_cursor: 'c2', total: 7 }));
  const ctrl = new AbortController();
  const page = await getRawScanPage({
    sort: 'device', dir: 'asc', limit: 100, cursor: 'c1', q: 'ab c',
    since: '2026-10-01T00:00:00Z',
    filters: {
      site: { values: ['DA1', '—'] }, source: { text: '' }, status: { values: [] },
      primary: { text: '00ab', values: ['x'] },
    },
  }, ctrl.signal);
  expect(page).toEqual({ rows: [], next_cursor: 'c2', total: 7 });

  const [url, init] = calls()[0] as [string, RequestInit];
  const u = new URL(url);
  expect(u.pathname).toMatch(/\/scans\/raw\/page$/);
  expect(u.searchParams.get('sort')).toBe('device');
  expect(u.searchParams.get('dir')).toBe('asc');
  expect(u.searchParams.get('limit')).toBe('100');
  expect(u.searchParams.get('cursor')).toBe('c1');
  expect(u.searchParams.get('q')).toBe('ab c');
  expect(u.searchParams.get('since')).toBe('2026-10-01T00:00:00Z');
  expect(u.searchParams.has('until')).toBe(false);
  expect(JSON.parse(u.searchParams.get('filters')!)).toEqual({
    site: { values: ['DA1', '—'] }, primary: { text: '00ab', values: ['x'] },
  });
  expect(init.signal).toBe(ctrl.signal);
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
});

it('getRawScanPage omits cursor/filters when absent or null', async () => {
  const calls = mockFetch(json({ rows: [], next_cursor: null, total: 0 }));
  await getRawScanPage({ cursor: null, filters: {} });
  const u = new URL((calls()[0] as [string])[0]);
  expect([...u.searchParams.keys()]).toEqual([]);
});

it('getRawScanPage throws the API error on failure', async () => {
  mockFetch(json({ detail: { code: 'invalid_cursor' } }, 422));
  await expect(getRawScanPage({ cursor: 'bad' })).rejects.toBeTruthy();
});

it('getRawScanFacets sends the column, search and the other filters', async () => {
  const calls = mockFetch(json([{ value: 'DA1', count: 3 }]));
  const facets = await getRawScanFacets('site', {
    q: 'x', search: 'da', filters: { status: { values: ['Done'] } },
  });
  expect(facets).toEqual([{ value: 'DA1', count: 3 }]);
  const u = new URL((calls()[0] as [string])[0]);
  expect(u.pathname).toMatch(/\/scans\/raw\/facets$/);
  expect(u.searchParams.get('column')).toBe('site');
  expect(u.searchParams.get('search')).toBe('da');
  expect(u.searchParams.get('q')).toBe('x');
  expect(JSON.parse(u.searchParams.get('filters')!)).toEqual({ status: { values: ['Done'] } });
});

it('downloadRawScansCsv fetches the export with the bearer token and saves a dated .csv', async () => {
  const calls = mockFetch(() => new Response('a,b\n1,2\n', { status: 200, headers: { 'Content-Type': 'text/csv' } }));
  const createUrl = vi.fn(() => 'blob:x');
  Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
  const clicked: HTMLAnchorElement[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicked.push(this);
  });

  await downloadRawScansCsv({ sort: 'scanned', dir: 'desc', q: 'z', filters: { site: { values: ['DA1'] } } });

  const [url, init] = calls()[0] as [string, RequestInit];
  const u = new URL(url);
  expect(u.pathname).toMatch(/\/scans\/raw\/export$/);
  expect(u.searchParams.get('sort')).toBe('scanned');
  expect(u.searchParams.get('q')).toBe('z');
  expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok');
  expect(createUrl).toHaveBeenCalledTimes(1);
  expect(clicked).toHaveLength(1);
  expect(clicked[0].download).toMatch(/^raw-scans-\d{4}-\d{2}-\d{2}\.csv$/);
});

it('downloadRawScansCsv throws on a failed export and saves nothing', async () => {
  mockFetch(json({ detail: 'nope' }, 403));
  const createUrl = vi.fn(() => 'blob:x');
  Object.assign(URL, { createObjectURL: createUrl, revokeObjectURL: vi.fn() });
  await expect(downloadRawScansCsv({})).rejects.toBeTruthy();
  expect(createUrl).not.toHaveBeenCalled();
});
