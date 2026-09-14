// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  refreshSession: vi.fn(),
  loginRequest: vi.fn(),
  logoutRequest: vi.fn(),
  onSessionEnded: vi.fn(() => () => {}),
  installVisibilityRefresh: vi.fn(() => () => {}),
}));
vi.mock('../lib/api', () => api);
const hb = vi.hoisted(() => ({ startHeartbeat: vi.fn(), HEARTBEAT_MS: 60_000 }));
vi.mock('../lib/heartbeat', () => hb);

import { KioskAuthProvider, useKioskAuth } from './KioskAuthContext';

const SESSION = {
  access_token: 't', expires_in: 900, session_expires_at: '2030-01-01T00:00:00Z',
  person: { id: 'p', first_name: 'A', last_name: 'B', preferred_name: null, display_name: 'A B',
            email: 'a@x', job_title: null, avatar_key: null, avatar_url: null },
  roles: ['worker'], must_change_password: false, preferences: { theme: 'dark' },
  perms: { kiosk: { view: true } }, max_rank: 10,
  scope: { global: false, client_ids: [], partner_ids: [] }, password_min_length: 8,
};

function Probe() {
  const a = useKioskAuth();
  return (
    <div>
      <span data-testid="status">{a.status}</span>
      <span data-testid="reg">{a.registration ?? 'null'}</span>
      <span data-testid="can">{String(a.can('kiosk', 'view'))}</span>
      <button onClick={() => void a.login('a@x', 'pw')}>login</button>
      <button onClick={() => a.completePair(SESSION as unknown as Parameters<typeof a.completePair>[0])}>
        pair
      </button>
      <button onClick={() => void a.logout()}>logout</button>
    </div>
  );
}

beforeEach(() => {
  api.refreshSession.mockResolvedValue(null);
  api.loginRequest.mockResolvedValue(SESSION);
  api.logoutRequest.mockResolvedValue(undefined);
  hb.startHeartbeat.mockImplementation((onState: (s: string) => void) => {
    onState('none');
    return { stop: vi.fn(), now: vi.fn(() => Promise.resolve()) };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('restores a session from the cookie on mount and starts the heartbeat', async () => {
  api.refreshSession.mockResolvedValue(SESSION);
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  expect(screen.getByTestId('status').textContent).toBe('loading');
  await act(async () => {});
  expect(screen.getByTestId('status').textContent).toBe('authed');
  expect(screen.getByTestId('can').textContent).toBe('true');
  expect(hb.startHeartbeat).toHaveBeenCalledTimes(1);
  expect(screen.getByTestId('reg').textContent).toBe('none');
});

it('is anon without a cookie; login then logout toggles state and the heartbeat', async () => {
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  expect(screen.getByTestId('status').textContent).toBe('anon');
  expect(hb.startHeartbeat).not.toHaveBeenCalled();
  await act(async () => { screen.getByText('login').click(); });
  expect(screen.getByTestId('status').textContent).toBe('authed');
  const handle = hb.startHeartbeat.mock.results[0].value;
  await act(async () => { screen.getByText('logout').click(); });
  expect(screen.getByTestId('status').textContent).toBe('anon');
  expect(handle.stop).toHaveBeenCalled();
  expect(screen.getByTestId('reg').textContent).toBe('null');
});

it('does not heartbeat while a password change is required', async () => {
  api.refreshSession.mockResolvedValue({ ...SESSION, must_change_password: true });
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  expect(screen.getByTestId('status').textContent).toBe('authed');
  expect(hb.startHeartbeat).not.toHaveBeenCalled();
});

it('marks the first heartbeat as a sign-in after login()', async () => {
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  await act(async () => { screen.getByText('login').click(); });
  expect(hb.startHeartbeat.mock.calls[0][2]).toBe(true);
});

it('does not mark the heartbeat as a sign-in after a cookie restore', async () => {
  api.refreshSession.mockResolvedValue(SESSION);
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  expect(hb.startHeartbeat.mock.calls[0][2]).toBe(false);
});

it('marks the first heartbeat as a sign-in after completePair()', async () => {
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  await act(async () => { screen.getByText('pair').click(); });
  expect(hb.startHeartbeat.mock.calls[0][2]).toBe(true);
});
