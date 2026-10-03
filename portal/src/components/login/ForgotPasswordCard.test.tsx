// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';

const api = vi.hoisted(() => ({ requestPasswordReset: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const { default: ForgotPasswordCard } = await import('./ForgotPasswordCard');

beforeEach(() => { vi.clearAllMocks(); api.requestPasswordReset.mockResolvedValue(undefined); });
afterEach(cleanup);

it('sends a reset link when email is on and shows the fixed message', async () => {
  const user = userEvent.setup();
  render(<ForgotPasswordCard initialEmail="pat@x.test" emailEnabled ttlMinutes={15} onClose={() => {}} />);
  expect(screen.getByLabelText('Email')).toHaveProperty('value', 'pat@x.test');
  await user.click(screen.getByRole('button', { name: 'Send reset link' }));
  expect(api.requestPasswordReset).toHaveBeenCalledWith('pat@x.test');
  expect(await screen.findByText(/a reset link is on its way\. It expires in 15 minutes\./)).toBeTruthy();
});

it('asks administrators when email is off', async () => {
  const user = userEvent.setup();
  render(<ForgotPasswordCard initialEmail="" emailEnabled={false} ttlMinutes={15} onClose={() => {}} />);
  await user.type(screen.getByLabelText('Email'), 'pat@x.test');
  await user.click(screen.getByRole('button', { name: 'Ask for a reset' }));
  expect(await screen.findByText(/your administrators have been asked to reset it/)).toBeTruthy();
});

it('requires an email', async () => {
  const user = userEvent.setup();
  render(<ForgotPasswordCard initialEmail="" emailEnabled ttlMinutes={15} onClose={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Send reset link' }));
  expect(api.requestPasswordReset).not.toHaveBeenCalled();
  expect(screen.getByText('Enter your email.')).toBeTruthy();
});

it('shows the rate-limit message on 429', async () => {
  api.requestPasswordReset.mockRejectedValue(new ApiError(429, 'rate_limited'));
  const user = userEvent.setup();
  render(<ForgotPasswordCard initialEmail="pat@x.test" emailEnabled ttlMinutes={15} onClose={() => {}} />);
  await user.click(screen.getByRole('button', { name: 'Send reset link' }));
  expect(await screen.findByText('Too many requests. Try again later.')).toBeTruthy();
});
