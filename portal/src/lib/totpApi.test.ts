// @vitest-environment jsdom
/** loginRequest returns the session OR a 2FA challenge; the challenge
 *  must not be stored as a session, and the totp calls carry the
 *  challenge token in the X-Totp-Challenge header. */
import { afterEach, expect, it, vi } from 'vitest';

import { isTotpChallenge, loginRequest, totpEnrollStart, totpVerify } from './api';

const SESSION = {
  status: 'ok', access_token: 'tok', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: { id: 'p1' }, roles: [], must_change_password: false, preferences: {},
  perms: {}, max_rank: 0, scope: { global: true, client_ids: [], partner_ids: [] },
  password_min_length: 8,
  totp: { enrolled: false, enrolled_at: null, required: false, backup_codes_remaining: 0 },
};

function mockFetch(body: unknown, status = 200) {
  const fn = vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
  vi.stubGlobal('fetch', fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

it('loginRequest surfaces a verify challenge without storing a session', async () => {
  mockFetch({ status: 'totp_verify', challenge_token: 'ch', backup_codes_remaining: 5 });
  const result = await loginRequest('a@b.c', 'pw');
  expect(isTotpChallenge(result)).toBe(true);
  if (isTotpChallenge(result)) expect(result.challenge_token).toBe('ch');
});

it('loginRequest returns the session when status is ok', async () => {
  mockFetch(SESSION);
  const result = await loginRequest('a@b.c', 'pw');
  expect(isTotpChallenge(result)).toBe(false);
  if (!isTotpChallenge(result)) expect(result.access_token).toBe('tok');
});

it('totpVerify posts the code with the challenge header and remember flag', async () => {
  const fetch = mockFetch(SESSION);
  await totpVerify('ch', '123456', true);
  const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toMatch(/\/auth\/totp\/verify$/);
  expect((init.headers as Record<string, string>)['X-Totp-Challenge']).toBe('ch');
  expect(JSON.parse(init.body as string)).toEqual({ code: '123456', remember: true });
  expect(init.credentials).toBe('include');
});

it('totpEnrollStart without a token uses the signed-in session (no challenge header)', async () => {
  const fetch = mockFetch({ secret: 'S', otpauth_uri: 'otpauth://x' });
  await totpEnrollStart();
  const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
  expect((init.headers as Record<string, string>)['X-Totp-Challenge']).toBeUndefined();
});
