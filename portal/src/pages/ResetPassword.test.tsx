// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../lib/api';

const api = vi.hoisted(() => ({
  checkPasswordResetToken: vi.fn(),
  confirmPasswordReset: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));
vi.mock('../lib/systemStatus', async (importActual) => ({
  ...(await importActual<typeof import('../lib/systemStatus')>()),
  getSystemStatus: vi.fn().mockResolvedValue({ password_min_length: 10 }),
}));
vi.mock('../auth/AuthContext', () => ({ useAuth: () => ({ passwordMinLength: 8 }) }));

const { default: ResetPassword } = await import('./ResetPassword');

function renderAt(hash: string) {
  window.history.replaceState(null, '', `/reset-password${hash}`);
  return render(<MemoryRouter><ResetPassword /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.checkPasswordResetToken.mockResolvedValue(true);
  api.confirmPasswordReset.mockResolvedValue(undefined);
});
afterEach(cleanup);

it('strips the token from the address bar and checks it', async () => {
  renderAt('#token=abc123');
  expect(await screen.findByLabelText(/New password/)).toBeTruthy();
  expect(window.location.hash).toBe('');
  expect(api.checkPasswordResetToken).toHaveBeenCalledWith('abc123');
  expect(screen.queryByLabelText('Current password')).toBeNull();
});

it('shows the expired state for a dead link', async () => {
  api.checkPasswordResetToken.mockResolvedValue(false);
  renderAt('#token=old');
  expect(await screen.findByText('This link has expired or was already used')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Request a new link' }).getAttribute('href')).toBe('/login?forgot=1');
});

it('treats a missing token as expired without calling the API', async () => {
  renderAt('');
  expect(await screen.findByText('This link has expired or was already used')).toBeTruthy();
  expect(api.checkPasswordResetToken).not.toHaveBeenCalled();
});

it('sets the password and offers sign-in', async () => {
  const user = userEvent.setup();
  renderAt('#token=abc123');
  await user.type(await screen.findByLabelText(/New password/), 'BrandNewPass9!');
  await user.type(screen.getByLabelText('Confirm new password'), 'BrandNewPass9!');
  await user.click(screen.getByRole('button', { name: 'Set password' }));
  expect(api.confirmPasswordReset).toHaveBeenCalledWith('abc123', 'BrandNewPass9!');
  expect(await screen.findByText('Password changed')).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Sign in' }).getAttribute('href')).toBe('/login');
});

it('uses the server minimum length', async () => {
  const user = userEvent.setup();
  renderAt('#token=abc123');
  await user.type(await screen.findByLabelText(/New password \(10\+ characters\)/), 'short9!x');
  await user.type(screen.getByLabelText('Confirm new password'), 'short9!x');
  await user.click(screen.getByRole('button', { name: 'Set password' }));
  expect(screen.getByText('New password must be at least 10 characters.')).toBeTruthy();
  expect(api.confirmPasswordReset).not.toHaveBeenCalled();
});

it('maps server errors', async () => {
  api.confirmPasswordReset.mockRejectedValue(new ApiError(422, 'password_recently_used'));
  const user = userEvent.setup();
  renderAt('#token=abc123');
  await user.type(await screen.findByLabelText(/New password/), 'BrandNewPass9!');
  await user.type(screen.getByLabelText('Confirm new password'), 'BrandNewPass9!');
  await user.click(screen.getByRole('button', { name: 'Set password' }));
  expect(await screen.findByText(/That password was used recently/)).toBeTruthy();
});
