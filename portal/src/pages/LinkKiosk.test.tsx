// @vitest-environment jsdom
/** /link — code entry navigates to /link/:code; /link/:code loads the
 *  pair info, approves or denies, and shows the done/expired/not-allowed
 *  copy from the spec. */
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ can: vi.fn(() => true), logout: vi.fn() }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can, logout: auth.logout, person: { display_name: 'Jimmy Henderson' } }),
}));

const api = vi.hoisted(() => ({
  getPairInfo: vi.fn(), approvePair: vi.fn(), denyPair: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

import { ApiError } from '../lib/api';
import LinkKiosk from './LinkKiosk';

const INFO = { code: 'ABCD2345', kiosk_name: 'Dock 3', serial: 'kiosk-web-1',
               status: 'pending', expires_at: '2030-01-01T00:00:00Z' };

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/link" element={<LinkKiosk />} />
        <Route path="/link/:code" element={<LinkKiosk />} />
        <Route path="/login" element={<div>Login page</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  auth.can.mockReturnValue(true);
  api.getPairInfo.mockResolvedValue(INFO);
  api.approvePair.mockResolvedValue(undefined);
  api.denyPair.mockResolvedValue(undefined);
  auth.logout.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.clearAllMocks(); vi.useRealTimers(); });

it('code entry normalizes and navigates to /link/:code', async () => {
  renderAt('/link');
  const input = screen.getByLabelText('Code');
  await userEvent.type(input, 'abcd-2345');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(api.getPairInfo).toHaveBeenCalledWith('ABCD2345'));
  expect(await screen.findByText('Dock 3')).toBeTruthy();
});

it('folds Crockford look-alikes (O/I/L/U) before navigating', async () => {
  renderAt('/link');
  await userEvent.type(screen.getByLabelText('Code'), 'oill-u234');
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(api.getPairInfo).toHaveBeenCalledWith('0111V234'));
});

it('continue is disabled until eight characters are entered', async () => {
  renderAt('/link');
  const button = screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  await userEvent.type(screen.getByLabelText('Code'), 'abc');
  expect(button.disabled).toBe(true);
});

it('shows the kiosk, names the signer, and approves', async () => {
  renderAt('/link/ABCD2345');
  expect(await screen.findByText('Dock 3')).toBeTruthy();
  expect(screen.getByText(/signs the kiosk in as Jimmy Henderson/)).toBeTruthy();
  expect(screen.getByText('kiosk-web-1')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
  expect(api.approvePair).toHaveBeenCalledWith('ABCD2345');
  expect(await screen.findByText(/Dock 3 is signing in/)).toBeTruthy();
});

it('denies', async () => {
  renderAt('/link/ABCD2345');
  await screen.findByText('Dock 3');
  await userEvent.click(screen.getByRole('button', { name: 'Deny' }));
  expect(api.denyPair).toHaveBeenCalledWith('ABCD2345');
  expect(await screen.findByText('Declined.')).toBeTruthy();
});

it('shows the expired copy for an unknown or used code', async () => {
  api.getPairInfo.mockRejectedValue(new ApiError(404, 'pair_not_found'));
  renderAt('/link/ZZZZZZZZ');
  expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Enter a different code' })).toBeTruthy();
});

it('a race with another approver lands on the expired copy', async () => {
  api.approvePair.mockRejectedValue(new ApiError(409, 'pair_not_pending'));
  renderAt('/link/ABCD2345');
  await screen.findByText('Dock 3');
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
});

it('shows a retry-able error for a transient load failure, not the expired copy', async () => {
  api.getPairInfo.mockRejectedValueOnce(new ApiError(500, 'unknown_error'));
  renderAt('/link/ABCD2345');
  expect(await screen.findByText('Something went wrong. Try again.')).toBeTruthy();
  expect(screen.queryByText(/expired or was already used/)).toBeNull();

  api.getPairInfo.mockResolvedValueOnce(INFO);
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Dock 3')).toBeTruthy();
  expect(api.getPairInfo).toHaveBeenCalledTimes(2);
});

it('shows the expired copy when the initial load reports the pair is no longer pending', async () => {
  api.getPairInfo.mockRejectedValue(new ApiError(409, 'pair_not_pending'));
  renderAt('/link/ABCD2345');
  expect(await screen.findByText(/expired or was already used/)).toBeTruthy();
});

it('refuses accounts without kiosk access', async () => {
  auth.can.mockReturnValue(false);
  renderAt('/link/ABCD2345');
  expect(await screen.findByText(/isn't allowed to sign in to kiosks/)).toBeTruthy();
  expect(api.getPairInfo).not.toHaveBeenCalled();
});

/* ── after approving: sign this phone out, or stay signed in ──────── */

async function approveWithFakeClock() {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  renderAt('/link/ABCD2345');
  await user.click(await screen.findByRole('button', { name: 'Approve' }));
  await screen.findByText(/Dock 3 is signing in/);
  return user;
}

it('after approving, offers to sign this phone out with a 15-second countdown', async () => {
  await approveWithFakeClock();
  expect(screen.getByText('Stay signed in on this phone?')).toBeTruthy();
  expect(screen.getByText(/signed out in 15 seconds/)).toBeTruthy();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(screen.getByText(/signed out in 10 seconds/)).toBeTruthy();
  expect(auth.logout).not.toHaveBeenCalled();
});

it('signs this phone out automatically when the 15 seconds run out', async () => {
  await approveWithFakeClock();
  await vi.advanceTimersByTimeAsync(14_000);
  expect(auth.logout).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1_500);
  await waitFor(() => expect(auth.logout).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Login page')).toBeTruthy();
  await vi.advanceTimersByTimeAsync(5_000);
  expect(auth.logout).toHaveBeenCalledTimes(1);
});

it('Stay signed in cancels the countdown', async () => {
  const user = await approveWithFakeClock();
  await user.click(screen.getByRole('button', { name: 'Stay signed in' }));
  expect(screen.getByText(/still signed in on this phone/)).toBeTruthy();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(auth.logout).not.toHaveBeenCalled();
  expect(screen.queryByText('Login page')).toBeNull();
});

it('Sign out now signs this phone out straight away', async () => {
  const user = await approveWithFakeClock();
  await user.click(screen.getByRole('button', { name: 'Sign out now' }));
  await waitFor(() => expect(auth.logout).toHaveBeenCalledTimes(1));
  expect(await screen.findByText('Login page')).toBeTruthy();
});

it('opening a code that was already approved shows no sign-out prompt', async () => {
  api.getPairInfo.mockResolvedValue({ ...INFO, status: 'approved' });
  renderAt('/link/ABCD2345');
  expect(await screen.findByText(/Dock 3 is signing in/)).toBeTruthy();
  expect(screen.queryByText('Stay signed in on this phone?')).toBeNull();
});

it('denying shows no sign-out prompt', async () => {
  renderAt('/link/ABCD2345');
  await userEvent.click(await screen.findByRole('button', { name: 'Deny' }));
  expect(await screen.findByText('Declined.')).toBeTruthy();
  expect(screen.queryByText('Stay signed in on this phone?')).toBeNull();
});
