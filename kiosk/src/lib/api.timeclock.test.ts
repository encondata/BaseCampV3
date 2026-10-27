// @vitest-environment jsdom
/** The three timeclock calls: the paths and methods they use, the body
 *  they send, and the `ApiError` codes they surface to the page. */
import { beforeEach, expect, it, vi } from 'vitest';

import * as api from './api';

const PERSON = {
  id: 'p-1', display_name: 'Jimmy Henderson', first_name: 'James', last_name: 'Henderson',
  preferred_name: 'Jimmy', avatar_url: 'https://s3.test/avatar.png?sig=1', rfid_tag: '100348',
};
const STATUS = {
  person: PERSON,
  clocked_in: true,
  entry: {
    id: 'e-1', started_at: '2026-09-14T12:00:00Z',
    initiative_id: 'i-1', initiative_name: 'NAP11 Hall Migration',
    site_id: 's-1', site_name: 'ACC4',
  },
  last_entry: null,
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
type Call = [string, RequestInit | undefined];

beforeEach(() => {
  api.clearLocalSession();
  window.__KIOSK_CONFIG__ = { apiUrl: 'http://api.test' };
});

it('fetchTimeclockStatus gets the person route and returns the status', async () => {
  const fetchMock = vi.fn(async () => json(STATUS));
  vi.stubGlobal('fetch', fetchMock);
  const status = await api.fetchTimeclockStatus('p-1');
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as Call;
  expect(url).toBe('http://api.test/kiosk/timeclock/p-1');
  expect(init?.method ?? 'GET').toBe('GET');
  expect(status.clocked_in).toBe(true);
  expect(status.entry?.site_name).toBe('ACC4');
  expect(status.person.avatar_url).toBe('https://s3.test/avatar.png?sig=1');
});

it('fetchTimeclockStatus names the kiosk and its zone in the query', async () => {
  const fetchMock = vi.fn(async () => json(STATUS));
  vi.stubGlobal('fetch', fetchMock);
  await api.fetchTimeclockStatus('p-1', 'kiosk-web-1', 'America/Chicago');
  const [url] = fetchMock.mock.calls.at(-1) as unknown as Call;
  expect(url).toBe('http://api.test/kiosk/timeclock/p-1?serial=kiosk-web-1&tz=America%2FChicago');
});

it('fetchTimeclockStatus surfaces person_not_found', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'person_not_found' } }, 404)));
  await expect(api.fetchTimeclockStatus('p-gone'))
    .rejects.toMatchObject({ code: 'person_not_found', status: 404 });
});

it('postClockIn posts serial, person, site and move', async () => {
  const fetchMock = vi.fn(async () => json(STATUS));
  vi.stubGlobal('fetch', fetchMock);
  await api.postClockIn({
    serial: 'kiosk-web-1', person_id: 'p-1', site_id: 's-1', initiative_id: 'i-1',
  });
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as Call;
  expect(url).toBe('http://api.test/kiosk/timeclock/clock-in');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({
    serial: 'kiosk-web-1', person_id: 'p-1', site_id: 's-1', initiative_id: 'i-1',
  });
});

it('postClockIn surfaces already_clocked_in with the open entry id', async () => {
  vi.stubGlobal('fetch', vi.fn(async () =>
    json({ detail: { code: 'already_clocked_in', entry_id: 'e-1' } }, 409)));
  await expect(api.postClockIn({ serial: 'kiosk-web-1', person_id: 'p-1' })).rejects
    .toMatchObject({ code: 'already_clocked_in', status: 409, detail: { entry_id: 'e-1' } });
});

it('postClockOut posts serial and person, and returns the closed entry', async () => {
  const closed = {
    ...STATUS, clocked_in: false, entry: null,
    last_entry: {
      id: 'e-1', started_at: '2026-09-14T12:00:00Z',
      ended_at: '2026-09-14T15:12:00Z', minutes: 192,
    },
  };
  const fetchMock = vi.fn(async () => json(closed));
  vi.stubGlobal('fetch', fetchMock);
  const out = await api.postClockOut({ serial: 'kiosk-web-1', person_id: 'p-1' });
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as Call;
  expect(url).toBe('http://api.test/kiosk/timeclock/clock-out');
  expect(init?.method).toBe('POST');
  expect(JSON.parse(String(init?.body))).toEqual({ serial: 'kiosk-web-1', person_id: 'p-1' });
  expect(out.last_entry?.minutes).toBe(192);
});

it('postClockOut surfaces not_clocked_in, and a read-only portal as 423', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'not_clocked_in' } }, 409)));
  await expect(api.postClockOut({ serial: 'k', person_id: 'p-1' }))
    .rejects.toMatchObject({ code: 'not_clocked_in', status: 409 });

  vi.stubGlobal('fetch', vi.fn(async () => json({ detail: { code: 'read_only_mode' } }, 423)));
  await expect(api.postClockOut({ serial: 'k', person_id: 'p-1' }))
    .rejects.toMatchObject({ code: 'read_only_mode', status: 423 });
});

it('a network failure on a punch is ApiError network', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('offline'); }));
  await expect(api.postClockIn({ serial: 'k', person_id: 'p-1' }))
    .rejects.toMatchObject({ code: 'network', status: 0 });
});

it('fetchTimeclockStatus passes the kiosk serial as a query parameter', async () => {
  const fetchMock = vi.fn(async () => json(STATUS));
  vi.stubGlobal('fetch', fetchMock);
  await api.fetchTimeclockStatus('p', 'SER');
  const [url] = fetchMock.mock.calls.at(-1) as unknown as Call;
  expect(url).toBe('http://api.test/kiosk/timeclock/p?serial=SER');
});

it('fetchTimeclockStatus url-encodes the serial', async () => {
  const fetchMock = vi.fn(async () => json(STATUS));
  vi.stubGlobal('fetch', fetchMock);
  await api.fetchTimeclockStatus('p', 'a b&c');
  const [url] = fetchMock.mock.calls.at(-1) as unknown as Call;
  expect(url).toBe('http://api.test/kiosk/timeclock/p?serial=a%20b%26c');
});


it('postClockIn carries learning_override_id when given', async () => {
  const fetchMock = vi.fn(async () => json(STATUS));
  vi.stubGlobal('fetch', fetchMock);
  await api.postClockIn({ serial: 'k', person_id: 'p-1', learning_override_id: 'ovr-1' });
  const [, init] = fetchMock.mock.calls.at(-1) as unknown as Call;
  expect(JSON.parse(String(init?.body))).toEqual({ serial: 'k', person_id: 'p-1', learning_override_id: 'ovr-1' });
});

it('postLearningLink posts to the session twin and returns sent', async () => {
  const fetchMock = vi.fn(async () => json({ sent: true }));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api.postLearningLink({ serial: 'k', person_id: 'p-1', tz: 'America/Chicago' })).toEqual({ sent: true });
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as Call;
  expect(url).toBe('http://api.test/kiosk/timeclock/learning-link');
  expect(init?.method).toBe('POST');
});

const FORM = {
  serial: 'k', person_id: 'p-1', admin_email: 'a@x.com', admin_password: 'pw',
  reason: 'no_phone' as const, scope: 'punch' as const,
};

it('postLearningOverride posts the admin form with the operator bearer', async () => {
  const fetchMock = vi.fn(async (url: string) => (url.includes('/auth/refresh')
    ? json({ access_token: 'tok-1', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z' })
    : json({ override_id: 'ovr-1' })));
  vi.stubGlobal('fetch', fetchMock);
  expect(await api.postLearningOverride(FORM)).toEqual({ override_id: 'ovr-1' });
  const [url, init] = fetchMock.mock.calls.at(-1) as unknown as Call;
  expect(url).toBe('http://api.test/kiosk/timeclock/learning-override');
  expect(init?.method).toBe('POST');
  expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer tok-1');
  expect(JSON.parse(String(init?.body))).toEqual(FORM);
});

it.each([
  [403, 'override_credentials_invalid'], [403, 'totp_required'], [409, 'totp_seed_unreadable'],
  [422, 'reason_text_required'], [429, 'rate_limited'],
])('postLearningOverride surfaces %i %s without a retry or a sign-out', async (status, code) => {
  const ended = vi.fn();
  const off = api.onSessionEnded(ended);
  const fetchMock = vi.fn(async (url: string) => (url.includes('/auth/refresh')
    ? json({ access_token: 'tok-1', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z' })
    : json({ detail: { code } }, status)));
  vi.stubGlobal('fetch', fetchMock);
  await expect(api.postLearningOverride(FORM)).rejects.toMatchObject({ status, code });
  const overrides = fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/learning-override'));
  expect(overrides).toHaveLength(1);
  expect(ended).not.toHaveBeenCalled();
  off();
});

it('postLearningOverride never refreshes and retries on a 401, nor ends the session', async () => {
  const ended = vi.fn();
  const off = api.onSessionEnded(ended);
  const fetchMock = vi.fn(async (url: string) => (url.includes('/auth/refresh')
    ? json({ access_token: 'tok-1', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z' })
    : json({ detail: { code: 'not_authenticated' } }, 401)));
  vi.stubGlobal('fetch', fetchMock);
  await expect(api.postLearningOverride(FORM)).rejects.toMatchObject({ status: 401 });
  // one refresh up front (no token yet), one override, nothing after the 401
  expect(fetchMock.mock.calls.map(([u]) => String(u).replace('http://api.test', ''))).toEqual([
    '/auth/refresh?client=kiosk', '/kiosk/timeclock/learning-override',
  ]);
  expect(ended).not.toHaveBeenCalled();
  off();
});
