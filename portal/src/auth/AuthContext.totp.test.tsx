// @vitest-environment jsdom
/** login() hands a 2FA challenge back to the caller without touching auth
 *  state; completeLogin() applies the session once the code passes. */
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  loginRequest: vi.fn(),
  refreshSession: vi.fn(async () => null),
  logoutRequest: vi.fn(),
  onSessionEnded: vi.fn(() => () => {}),
  installVisibilityRefresh: vi.fn(() => () => {}),
  savePreferencesRequest: vi.fn(),
  isTotpChallenge: (r: { status: string }) => r.status !== 'ok',
}));
vi.mock('../lib/api', () => api);

const { AuthProvider, useAuth } = await import('./AuthContext');

const SESSION = {
  status: 'ok', access_token: 'tok', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: { id: 'p1', display_name: 'Ada' }, roles: ['staff'], must_change_password: false,
  preferences: {}, perms: {}, max_rank: 40, scope: { global: true, client_ids: [], partner_ids: [] },
  password_min_length: 8,
  totp: { enrolled: true, enrolled_at: '2026-09-23T00:00:00Z', required: false, backup_codes_remaining: 8 },
};

let ctx: ReturnType<typeof useAuth>;
function Probe() { ctx = useAuth(); return null; }

afterEach(cleanup);

it('a challenge leaves the context anonymous; completeLogin signs in', async () => {
  api.loginRequest.mockResolvedValue({ status: 'totp_verify', challenge_token: 'ch', backup_codes_remaining: 8 });
  render(<AuthProvider><Probe /></AuthProvider>);
  await act(async () => {});
  const result = await act(() => ctx.login('a@b.c', 'pw'));
  expect(result.status).toBe('totp_verify');
  expect(ctx.status).toBe('anon');
  act(() => ctx.completeLogin(SESSION as never));
  expect(ctx.status).toBe('authed');
  expect(ctx.totp?.enrolled).toBe(true);
  act(() => ctx.applyTotp({ ...SESSION.totp, backup_codes_remaining: 3 }));
  expect(ctx.totp?.backup_codes_remaining).toBe(3);
});
