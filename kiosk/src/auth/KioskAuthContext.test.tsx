// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  refreshSession: vi.fn(),
  loginRequest: vi.fn(),
  moveLoginRequest: vi.fn(),
  logoutRequest: vi.fn(),
  signOutRequest: vi.fn(),
  onSessionEnded: vi.fn(() => () => {}),
  installVisibilityRefresh: vi.fn(() => () => {}),
}));
vi.mock('../lib/api', () => api);
const hb = vi.hoisted(() => ({ startHeartbeat: vi.fn(), HEARTBEAT_MS: 60_000 }));
vi.mock('../lib/heartbeat', () => hb);
const identity = vi.hoisted(() => ({ getIdentity: vi.fn(() => ({ serial: 'kiosk-web-test', name: 'Kiosk Test' })) }));
vi.mock('../lib/identity', () => identity);

import { readKioskSetup, writeKioskSetup } from '../lib/kioskSetup';
import { readSetupState, writeSetupState } from '../lib/setupState';
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
      <span data-testid="kiosk-move">{a.kioskMove?.name ?? 'none'}</span>
      <span data-testid="is-admin">{String(a.isAdmin)}</span>
      <span data-testid="is-developer">{String(a.isDeveloper)}</span>
      <button onClick={() => void a.login('a@x', 'pw')}>login</button>
      <button onClick={() => void a.loginWithMovePassword('Crew-2026!')}>move login</button>
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
  api.signOutRequest.mockResolvedValue(undefined);
  hb.startHeartbeat.mockImplementation((onState: (s: string) => void) => {
    onState('none');
    return { stop: vi.fn(), now: vi.fn(() => Promise.resolve()) };
  });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); localStorage.clear(); });

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

it('marks the first heartbeat as a password sign-in after login()', async () => {
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  await act(async () => { screen.getByText('login').click(); });
  expect(hb.startHeartbeat.mock.calls[0][2]).toEqual({ method: 'password' });
});

it('does not mark the heartbeat as a sign-in after a cookie restore', async () => {
  api.refreshSession.mockResolvedValue(SESSION);
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  expect(hb.startHeartbeat.mock.calls[0][2]).toBeUndefined();
});

it('marks the first heartbeat as a link sign-in after completePair()', async () => {
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  await act(async () => { screen.getByText('pair').click(); });
  expect(hb.startHeartbeat.mock.calls[0][2]).toEqual({ method: 'link' });
});

it('logout signs out on the server before dropping the session', async () => {
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  await act(async () => { screen.getByText('login').click(); });
  const order: string[] = [];
  api.signOutRequest.mockImplementationOnce(async () => { order.push('signOut'); });
  api.logoutRequest.mockImplementationOnce(async () => { order.push('logout'); });
  await act(async () => { screen.getByText('logout').click(); });
  expect(api.signOutRequest).toHaveBeenCalledWith('kiosk-web-test');
  expect(order).toEqual(['signOut', 'logout']);
});

it('derives isAdmin/isDeveloper as both true for a developer at admin rank', async () => {
  api.loginRequest.mockResolvedValue({ ...SESSION, roles: ['developer'], max_rank: 100 });
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  await act(async () => { screen.getByText('login').click(); });
  expect(screen.getByTestId('is-admin').textContent).toBe('true');
  expect(screen.getByTestId('is-developer').textContent).toBe('true');
});

it('derives isAdmin true / isDeveloper false for an admin who is not a developer', async () => {
  api.loginRequest.mockResolvedValue({ ...SESSION, roles: ['admin'], max_rank: 60 });
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  await act(async () => { screen.getByText('login').click(); });
  expect(screen.getByTestId('is-admin').textContent).toBe('true');
  expect(screen.getByTestId('is-developer').textContent).toBe('false');
});

it('derives isAdmin/isDeveloper as both false for a plain worker', async () => {
  api.loginRequest.mockResolvedValue({ ...SESSION, roles: ['worker'], max_rank: 10 });
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  await act(async () => { screen.getByText('login').click(); });
  expect(screen.getByTestId('is-admin').textContent).toBe('false');
  expect(screen.getByTestId('is-developer').textContent).toBe('false');
});

it('loginWithMovePassword calls the move endpoint and keeps the move from the session', async () => {
  api.moveLoginRequest.mockResolvedValue({ ...SESSION, kiosk_move: { initiative_id: 'i1', name: 'Las Vegas 3' } });
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  expect(screen.getByTestId('kiosk-move').textContent).toBe('none');
  await act(async () => { screen.getByText('move login').click(); });
  expect(api.moveLoginRequest).toHaveBeenCalledWith('Crew-2026!');
  expect(screen.getByTestId('status').textContent).toBe('authed');
  expect(screen.getByTestId('kiosk-move').textContent).toBe('Las Vegas 3');
  expect(hb.startHeartbeat.mock.calls[0][2]).toEqual({ method: 'password' });
});

it('a normal sign-in has no kiosk move', async () => {
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  await act(async () => { screen.getByText('login').click(); });
  expect(screen.getByTestId('kiosk-move').textContent).toBe('none');
});

const SAVED_SETUP = {
  initiativeId: 'x-move', initiativeName: 'Other move', siteId: 's1', siteName: 'Dock',
  siteRole: 'source' as const, scanStatus: 'loaded', scanLabel: 'Loaded',
};

it('a move sign-in drops a setup saved for another move and marks setup incomplete', async () => {
  writeKioskSetup(SAVED_SETUP);
  writeSetupState('complete');
  api.moveLoginRequest.mockResolvedValue({ ...SESSION, kiosk_move: { initiative_id: 'y-move', name: 'Y' } });
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  await act(async () => { screen.getByText('move login').click(); });
  expect(readKioskSetup()).toBeNull();
  expect(readSetupState()).toBe('incomplete');
});

it('a move sign-in keeps a setup saved for the same move', async () => {
  writeKioskSetup({ ...SAVED_SETUP, initiativeId: 'y-move' });
  writeSetupState('complete');
  api.moveLoginRequest.mockResolvedValue({ ...SESSION, kiosk_move: { initiative_id: 'y-move', name: 'Y' } });
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  await act(async () => { screen.getByText('move login').click(); });
  expect(readKioskSetup()?.initiativeId).toBe('y-move');
  expect(readSetupState()).toBe('complete');
});

it('a person sign-in leaves any saved setup alone', async () => {
  writeKioskSetup(SAVED_SETUP);
  writeSetupState('complete');
  render(<KioskAuthProvider><Probe /></KioskAuthProvider>);
  await act(async () => {});
  await act(async () => { screen.getByText('login').click(); });
  expect(readKioskSetup()?.initiativeId).toBe('x-move');
  expect(readSetupState()).toBe('complete');
});
