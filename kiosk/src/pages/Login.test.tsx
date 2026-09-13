// @vitest-environment jsdom
/** Kiosk login: three method pills (link is the default and the choice
 *  persists), password sign-in with the kiosk-specific error copy, the
 *  move-password placeholder that never calls the API, and the settings
 *  gear. The terrain scene and PairPanel are mocked. */
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ login: vi.fn(), completePair: vi.fn() }));
vi.mock('../auth/KioskAuthContext', () => ({ useKioskAuth: () => auth }));
vi.mock('@portal/lib/brandScene', () => ({ buildBrandScene: () => () => {} }));
vi.mock('../components/PairPanel', () => ({ default: () => <div>PAIR PANEL</div> }));
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
  api.getSystemStatus.mockResolvedValue({ read_only: false, read_only_message: '', workers_paused: false, banner: null });
  auth.login.mockResolvedValue({});
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

it('opens on Link with phone by default and remembers the chosen method', async () => {
  renderLogin();
  expect(screen.getByRole('tab', { name: 'Link with phone', selected: true })).toBeTruthy();
  expect(screen.getByText('PAIR PANEL')).toBeTruthy();
  await userEvent.click(screen.getByRole('tab', { name: 'Email & password' }));
  expect(screen.getByLabelText('Email')).toBeTruthy();
  expect(localStorage.getItem('ss.kiosk.method')).toBe('password');
  cleanup();
  renderLogin();
  expect(screen.getByRole('tab', { name: 'Email & password', selected: true })).toBeTruthy();
});

it('signs in with email and password and lands on home', async () => {
  localStorage.setItem('ss.kiosk.method', 'password');
  renderLogin();
  await userEvent.type(screen.getByLabelText('Email'), 'w@x.test');
  await userEvent.type(screen.getByLabelText('Password'), 'pw');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(auth.login).toHaveBeenCalledWith('w@x.test', 'pw');
  expect(await screen.findByText('HOME')).toBeTruthy();
});

it('shows the kiosk-specific error copy', async () => {
  localStorage.setItem('ss.kiosk.method', 'password');
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
  await userEvent.click(screen.getByRole('tab', { name: 'Move password' }));
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
