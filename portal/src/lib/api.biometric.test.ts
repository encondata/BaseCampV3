// @vitest-environment jsdom
/** Biometric sign-in requests: the personal-device PUT body, the device
 *  forget, and the key lists and forgets (one key gone = 404 = forgotten). */
import { afterEach, expect, it, vi } from 'vitest';

import {
  forgetAllUserBiometricKeys, forgetDeviceBiometric, forgetMyBiometricKey, forgetUserBiometricKey,
  listMyBiometricKeys, listPersonalCandidates, listUserBiometricKeys, setDevicePersonal,
} from './api';

const SESSION = {
  status: 'ok', access_token: 'tok', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: { id: 'p1' }, roles: [], must_change_password: false, preferences: {},
  perms: {}, max_rank: 0, scope: { global: true, client_ids: [], partner_ids: [] },
  password_min_length: 8,
  totp: { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 },
};

function mockFetch(status: number, body: unknown = { detail: { code: 'biometric_key_not_found' } }) {
  const fn = vi.fn(async (url: string, _init?: RequestInit) => (String(url).includes('/auth/refresh')
    ? new Response(JSON.stringify(SESSION), { status: 200, headers: { 'Content-Type': 'application/json' } })
    : new Response(status === 204 ? null : JSON.stringify(body),
      { status, headers: { 'Content-Type': 'application/json' } })));
  vi.stubGlobal('fetch', fn);
  return fn;
}

function call(fn: ReturnType<typeof mockFetch>, method?: string): [string, RequestInit] {
  const hit = fn.mock.calls.find(([url, init]) => !String(url).includes('/auth/refresh')
    && ((init as RequestInit | undefined)?.method ?? 'GET') === (method ?? 'GET'));
  expect(hit).toBeTruthy();
  return hit as unknown as [string, RequestInit];
}

afterEach(() => vi.unstubAllGlobals());

it("listPersonalCandidates GETs the device's eligible people, with the search when there is one", async () => {
  const rows = [{ person_id: 'p2', display_name: 'Sam Lead', login_email: 'sam@x.test' }];
  let fetch = mockFetch(200, rows);
  expect(await listPersonalCandidates('k1', ' sam & co ')).toEqual(rows);
  let [url] = call(fetch);
  expect(url).toMatch(/\/devices\/k1\/personal-candidates\?q=sam\+%26\+co$/);
  fetch = mockFetch(200, []);
  await listPersonalCandidates('k1', '   ');
  [url] = call(fetch);
  expect(url).toMatch(/\/devices\/k1\/personal-candidates$/);
});

it('setDevicePersonal PUTs the person id, or null to clear', async () => {
  let fetch = mockFetch(200, { id: 'k1' });
  await setDevicePersonal('k1', 'p2');
  let [url, init] = call(fetch, 'PUT');
  expect(url).toMatch(/\/devices\/k1\/personal$/);
  expect(JSON.parse(String(init.body))).toEqual({ person_id: 'p2' });
  fetch = mockFetch(200, { id: 'k1' });
  await setDevicePersonal('k1', null);
  [url, init] = call(fetch, 'PUT');
  expect(JSON.parse(String(init.body))).toEqual({ person_id: null });
});

it('setDevicePersonal surfaces not_eligible with its reason', async () => {
  mockFetch(422, { detail: { code: 'not_eligible', reason: 'no_kiosk_view' } });
  await expect(setDevicePersonal('k1', 'p2')).rejects.toMatchObject({
    status: 422, code: 'not_eligible', detail: { reason: 'no_kiosk_view' },
  });
});

it('forgetDeviceBiometric DELETEs /devices/{id}/biometric', async () => {
  const fetch = mockFetch(204);
  await expect(forgetDeviceBiometric('k1')).resolves.toBeUndefined();
  expect(call(fetch, 'DELETE')[0]).toMatch(/\/devices\/k1\/biometric$/);
});

it('the key lists read the user and /me routes', async () => {
  let fetch = mockFetch(200, []);
  await expect(listUserBiometricKeys('p1')).resolves.toEqual([]);
  expect(call(fetch)[0]).toMatch(/\/users\/p1\/biometric-keys$/);
  fetch = mockFetch(200, []);
  await expect(listMyBiometricKeys()).resolves.toEqual([]);
  expect(call(fetch)[0]).toMatch(/\/auth\/me\/biometric-keys$/);
});

it('forgetting one key: 404 counts as forgotten, other failures throw', async () => {
  let fetch = mockFetch(404);
  await expect(forgetUserBiometricKey('p1', 'bk1')).resolves.toBeUndefined();
  expect(call(fetch, 'DELETE')[0]).toMatch(/\/users\/p1\/biometric-keys\/bk1$/);
  fetch = mockFetch(404);
  await expect(forgetMyBiometricKey('bk1')).resolves.toBeUndefined();
  expect(call(fetch, 'DELETE')[0]).toMatch(/\/auth\/me\/biometric-keys\/bk1$/);
  mockFetch(403, { detail: { code: 'cannot_target_self' } });
  await expect(forgetUserBiometricKey('p1', 'bk1')).rejects.toMatchObject({ status: 403, code: 'cannot_target_self' });
});

it('forget all DELETEs the collection and throws on failure', async () => {
  const fetch = mockFetch(204);
  await expect(forgetAllUserBiometricKeys('p1')).resolves.toBeUndefined();
  expect(call(fetch, 'DELETE')[0]).toMatch(/\/users\/p1\/biometric-keys$/);
  mockFetch(500, { detail: { code: 'boom' } });
  await expect(forgetAllUserBiometricKeys('p1')).rejects.toMatchObject({ status: 500 });
});
