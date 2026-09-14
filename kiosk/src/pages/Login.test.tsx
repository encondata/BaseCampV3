// @vitest-environment jsdom
/** Kiosk login: email & password is the default, normal form; below it a
 *  divider and an "Other ways to sign in" button expand to Link with
 *  phone / Move password. Password sign-in carries the kiosk-specific
 *  error copy; move password is a placeholder that never calls the API.
 *  The terrain scene and PairPanel are mocked. */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ login: vi.fn(), completePair: vi.fn() }));
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
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

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

it('move password is a placeholder that never calls the API', async () => {
  renderLogin();
  await userEvent.click(screen.getByRole('button', { name: 'Other ways to sign in' }));
  await userEvent.click(screen.getByRole('button', { name: 'Move password' }));
  await userEvent.type(screen.getByLabelText('Move password'), 'secret');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(screen.getByText(/Move passwords aren't available yet/)).toBeTruthy();
  expect(auth.login).not.toHaveBeenCalled();
  expect((screen.getByLabelText('Move password') as HTMLInputElement).value).toBe('');
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
