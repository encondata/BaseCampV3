// @vitest-environment jsdom
/** The company notification settings' two calls: getNotificationSettings
 *  (GET /notifications/settings) and updateNotificationSettings (PUT, a
 *  partial body, the whole settings back). Both turn a failure into an
 *  ApiError that carries the API's code. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  ApiError, READ_ONLY_MESSAGE, getNotificationSettings, updateNotificationSettings,
  type NotificationSettings,
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

const SETTINGS: NotificationSettings = {
  defaults: {
    approvals: { inbox: true, email: true },
    reports: { inbox: true, email: false },
    wiki: { inbox: true, email: true },
    learning: { inbox: true, email: true },
    initiatives: { inbox: true, email: true },
    trucks: { inbox: true, email: true },
    devices: { inbox: true, email: true },
    status_rules: { inbox: true, email: true },
    bulk_actions: { inbox: true, email: true },
  },
  critical_kinds: ['report_failed'],
  kinds: [
    { kind: 'report_failed', label: 'Report failed', category: 'reports', email: true,
      owner_always: false, critical: true, locked: false, watchable: false, everywhere: false, reaches: [] },
    { kind: 'password_expiring', label: 'Password expiring', category: 'security', email: true,
      owner_always: true, critical: true, locked: true, watchable: false, everywhere: false, reaches: [] },
  ],
};

beforeEach(() => { vi.restoreAllMocks(); });
afterEach(() => vi.unstubAllGlobals());

it('getNotificationSettings: GET /notifications/settings, the settings as given', async () => {
  const calls = mockFetch(json(SETTINGS));
  expect(await getNotificationSettings()).toEqual(SETTINGS);

  expect(calls()).toHaveLength(1);
  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe('/notifications/settings');
  expect(init.method ?? 'GET').toBe('GET');
  expect(init.body).toBeUndefined();
});

it('getNotificationSettings: sends the access token like every other call', async () => {
  const calls = mockFetch(json(SETTINGS));
  await getNotificationSettings();
  expect((calls()[0][1].headers as Record<string, string>).Authorization).toBe('Bearer tok');
});

it('updateNotificationSettings: PUT /notifications/settings with the body as JSON', async () => {
  const calls = mockFetch(json(SETTINGS));
  const body = {
    defaults: { reports: { inbox: true, email: false } },
    critical_kinds: ['report_failed'],
  };
  expect(await updateNotificationSettings(body)).toEqual(SETTINGS);

  const [url, init] = calls()[0];
  expect(new URL(url).pathname).toBe('/notifications/settings');
  expect(init.method).toBe('PUT');
  expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
  expect(JSON.parse(init.body as string)).toEqual(body);
});

it('updateNotificationSettings: sends only the part it is given', async () => {
  const calls = mockFetch(json(SETTINGS));
  await updateNotificationSettings({ defaults: { wiki: { inbox: false, email: false } } });
  await updateNotificationSettings({ critical_kinds: [] });

  expect(JSON.parse(calls()[0][1].body as string)).toEqual({ defaults: { wiki: { inbox: false, email: false } } });
  expect(JSON.parse(calls()[1][1].body as string)).toEqual({ critical_kinds: [] });
});

it('a 422 comes back as an ApiError with the code, for both calls', async () => {
  mockFetch(json({ detail: { code: 'invalid_category' } }, 422));
  const put = await updateNotificationSettings({ defaults: { nope: { inbox: true, email: true } } })
    .catch((e: unknown) => e);
  expect(put).toBeInstanceOf(ApiError);
  expect(put).toMatchObject({ status: 422, code: 'invalid_category' });

  mockFetch(json({ detail: { code: 'invalid_kind' } }, 422));
  await expect(updateNotificationSettings({ critical_kinds: ['nope'] }))
    .rejects.toMatchObject({ status: 422, code: 'invalid_kind' });

  mockFetch(json({ detail: { code: 'forbidden' } }, 403));
  await expect(getNotificationSettings()).rejects.toMatchObject({ status: 403, code: 'forbidden' });
});

it('read-only mode carries the server message', async () => {
  mockFetch(json({ detail: { code: 'read_only_mode', message: 'Cutover' } }, 423));
  const err = await updateNotificationSettings({ critical_kinds: [] }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ApiError);
  expect(err).toMatchObject({ status: 423, code: 'read_only_mode', message: READ_ONLY_MESSAGE });
});
