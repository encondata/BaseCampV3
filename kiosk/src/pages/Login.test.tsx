// @vitest-environment jsdom
/** Kiosk login: email & password is the default, normal form; below it a
 *  divider and an "Other ways to sign in" button expand to Link with
 *  phone / Move password. Password sign-in carries the kiosk-specific
 *  error copy; move password signs in through the move endpoint.
 *  The terrain scene and PairPanel are mocked. */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ login: vi.fn(), loginWithMovePassword: vi.fn(), completePair: vi.fn() }));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));
vi.mock('@portal/lib/brandScene', () => ({ buildBrandScene: () => () => {} }));
// Records the `onApproved` prop identity on every render, so a test can
// confirm Login hands PairPanel the SAME callback across re-renders
// (an unstable one would tear down and restart PairPanel's poll/clock).
const seenOnApproved = vi.hoisted(() => [] as unknown[]);
vi.mock('../components/PairPanel', () => ({
  default: ({ onApproved }: { onApproved: unknown }) => {
    seenOnApproved.push(onApproved);
    return <div>PAIR PANEL</div>;
  },
}));
const api = vi.hoisted(() => ({ getSystemStatus: vi.fn() }));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const edgeMock = vi.hoisted(() => ({ status: null as null | { cloud: { online: boolean } } }));
vi.mock('../lib/edgeStatus', () => ({
  useEdgeStatus: () => ({ status: edgeMock.status, refresh: async () => {} }),
}));

import { ApiError } from '../lib/api';
import Login from './Login';

function renderLogin() {
  return render(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>HOME</div>} />
        <Route path="/settings" element={<div>SETTINGS</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  seenOnApproved.length = 0;
  api.getSystemStatus.mockResolvedValue({ read_only: false, read_only_message: '', workers_paused: false, banner: null });
  auth.login.mockResolvedValue({});
  auth.loginWithMovePassword.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.clearAllMocks(); edgeMock.status = null; });

it('opens on the email & password form by default', async () => {
  renderLogin();
  expect(screen.getByLabelText('Email')).toBeTruthy();
  expect(screen.getByLabelText('Password')).toBeTruthy();
  expect(screen.queryByText('PAIR PANEL')).toBeNull();
  expect(screen.getByRole('button', { name: 'Other ways to sign in' })).toBeTruthy();
  expect(screen.queryAllByRole('tab')).toHaveLength(0);
});

it('expands to the alternate methods and back again', async () => {
  renderLogin();
  await userEvent.click(screen.getByRole('button', { name: 'Other ways to sign in' }));
  expect(screen.getByRole('button', { name: 'Link with phone' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Move password' })).toBeTruthy();

  await userEvent.click(screen.getByRole('button', { name: 'Link with phone' }));
  expect(screen.getByText('PAIR PANEL')).toBeTruthy();
  const back = screen.getByRole('button', { name: 'Back to email & password' });
  expect(back).toBeTruthy();

  await userEvent.click(back);
  expect(screen.getByLabelText('Email')).toBeTruthy();
});

it('signs in with email and password and lands on home', async () => {
  renderLogin();
  await userEvent.type(screen.getByLabelText('Email'), 'w@x.test');
  await userEvent.type(screen.getByLabelText('Password'), 'pw');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(auth.login).toHaveBeenCalledWith('w@x.test', 'pw');
  expect(await screen.findByText('HOME')).toBeTruthy();
});

it('shows the kiosk-specific error copy', async () => {
  auth.login.mockRejectedValue(new ApiError(403, 'kiosk_not_allowed'));
  renderLogin();
  await userEvent.type(screen.getByLabelText('Email'), 'w@x.test');
  await userEvent.type(screen.getByLabelText('Password'), 'pw');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText(/isn't allowed to use kiosks/)).toBeTruthy();
  auth.login.mockRejectedValue(new ApiError(0, 'network'));
  await userEvent.type(screen.getByLabelText('Password'), 'pw');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText(/Can't reach the server/)).toBeTruthy();
});

async function openMoveForm() {
  await userEvent.click(screen.getByRole('button', { name: 'Other ways to sign in' }));
  await userEvent.click(screen.getByRole('button', { name: 'Move password' }));
}

it('move password signs in through the move endpoint and navigates', async () => {
  renderLogin();
  await openMoveForm();
  await userEvent.type(screen.getByLabelText('Move password'), 'Crew-2026!');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(auth.loginWithMovePassword).toHaveBeenCalledWith('Crew-2026!');
  expect(auth.login).not.toHaveBeenCalled();
  expect(await screen.findByText('HOME')).toBeTruthy();
});

it('a wrong or inactive move password shows the matching message', async () => {
  auth.loginWithMovePassword.mockRejectedValue(new ApiError(401, 'invalid_move_password'));
  renderLogin();
  await openMoveForm();
  await userEvent.type(screen.getByLabelText('Move password'), 'nope');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText("That move password isn't right.")).toBeTruthy();
  expect((screen.getByLabelText('Move password') as HTMLInputElement).value).toBe('');

  auth.loginWithMovePassword.mockRejectedValue(new ApiError(401, 'move_not_active'));
  await userEvent.type(screen.getByLabelText('Move password'), 'old');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText("That move password isn't active.")).toBeTruthy();

  auth.loginWithMovePassword.mockRejectedValue(new ApiError(429, 'move_login_rate_limited'));
  await userEvent.type(screen.getByLabelText('Move password'), 'again');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('Too many tries. Wait a few minutes.')).toBeTruthy();
});

it('a move whose kiosk identity may not use kiosks gets the move wording', async () => {
  auth.loginWithMovePassword.mockRejectedValue(new ApiError(403, 'kiosk_not_allowed'));
  renderLogin();
  await openMoveForm();
  await userEvent.type(screen.getByLabelText('Move password'), 'Crew-2026!');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText(
    "That move can't sign in to kiosks right now. Ask a coordinator.")).toBeTruthy();
  expect(screen.queryByText(/This account isn't allowed/)).toBeNull();
});

it('an empty move password asks for one and never calls the API', async () => {
  renderLogin();
  await openMoveForm();
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText('Enter the move password.')).toBeTruthy();
  expect(auth.loginWithMovePassword).not.toHaveBeenCalled();
});

it('shows system banners and the settings gear', async () => {
  api.getSystemStatus.mockResolvedValue({ read_only: true, read_only_message: 'Cutover', workers_paused: false, banner: 'Hello all' });
  renderLogin();
  expect(await screen.findByText('Read-only maintenance mode — Cutover')).toBeTruthy();
  expect(screen.getByText('Hello all')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Kiosk settings' }));
  expect(await screen.findByText('SETTINGS')).toBeTruthy();
});

it('hands PairPanel a stable onApproved across Login re-renders', async () => {
  const { rerender } = renderLogin();
  await userEvent.click(screen.getByRole('button', { name: 'Other ways to sign in' }));
  await userEvent.click(screen.getByRole('button', { name: 'Link with phone' }));
  expect(seenOnApproved).toHaveLength(1);
  // A re-render of the same route tree (e.g. Login re-rendering because
  // its auth context settled) must not mint a new onApproved — PairPanel
  // lists it as a poll/clock effect dependency, so a fresh identity would
  // tear down and restart the 2s poll and 1s countdown on every Login
  // re-render.
  rerender(
    <MemoryRouter initialEntries={['/login']}>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/" element={<div>HOME</div>} />
        <Route path="/settings" element={<div>SETTINGS</div>} />
      </Routes>
    </MemoryRouter>,
  );
  expect(seenOnApproved).toHaveLength(2);
  expect(seenOnApproved[1]).toBe(seenOnApproved[0]);
});

it('laptop mode offline: Link with phone is hidden, Move password stays', async () => {
  edgeMock.status = { cloud: { online: false } };
  renderLogin();
  await userEvent.click(screen.getByRole('button', { name: 'Other ways to sign in' }));
  expect(screen.queryByRole('button', { name: 'Link with phone' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Move password' })).toBeTruthy();
});

it('laptop mode online: both alternate methods show', async () => {
  edgeMock.status = { cloud: { online: true } };
  renderLogin();
  await userEvent.click(screen.getByRole('button', { name: 'Other ways to sign in' }));
  expect(screen.getByRole('button', { name: 'Link with phone' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Move password' })).toBeTruthy();
});
