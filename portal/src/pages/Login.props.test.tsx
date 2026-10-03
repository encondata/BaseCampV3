// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const login = vi.fn();
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ login, completeLogin: vi.fn() }),
}));
vi.mock('../components/SystemBanners', () => ({ default: () => null }));
vi.mock('../lib/systemStatus', () => ({
  getSystemStatus: vi.fn().mockResolvedValue({ totp_trust_days: 0 }),
}));

import { ApiError } from '../lib/api';
import Login from './Login';

beforeEach(() => {
  login.mockReset();
  // jsdom has no matchMedia; Login's error shake reads it.
  window.matchMedia = ((q: string) => ({ matches: true, media: q })) as unknown as typeof window.matchMedia;
});
afterEach(cleanup);

it('keeps the portal defaults without props', () => {
  render(<MemoryRouter><Login /></MemoryRouter>);
  expect(screen.getByText('ServerSherpa Portal')).toBeTruthy();
  expect(screen.getByText('Datacenter Relocation Tools')).toBeTruthy();
});

it('takes eyebrow, scene tag, notice and extra error text', async () => {
  login.mockRejectedValue(new ApiError(403, 'password_change_required'));
  render(
    <MemoryRouter>
      <Login eyebrow="Sirdar" sceneTag="Environment Builder" notice={<span>First run</span>}
             extraErrors={{ password_change_required: 'Change it in the portal first.' }} />
    </MemoryRouter>,
  );
  expect(screen.getByText('Sirdar')).toBeTruthy();
  expect(screen.getByText('Environment Builder')).toBeTruthy();
  expect(screen.getByText('First run')).toBeTruthy();
  await userEvent.type(screen.getByLabelText(/email/i), 'a@b.co');
  await userEvent.type(document.getElementById('login-password') as HTMLElement, 'x');
  await userEvent.click(screen.getByRole('button', { name: /^sign in/i }));
  await waitFor(() => expect(screen.getByText('Change it in the portal first.')).toBeTruthy());
});

it('recovery prop shows a static card and makes no reset request', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><Login recovery="Reset it in the portal." /></MemoryRouter>);
  await user.click(screen.getByRole('button', { name: 'Forgot password?' }));
  expect(screen.getByText('Account recovery')).toBeTruthy();
  expect(screen.getByText('Reset it in the portal.')).toBeTruthy();
  expect(screen.queryByLabelText('Email', { selector: '#forgot-email' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Got it' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Reset your password' }));
  expect(screen.getByText('Reset it in the portal.')).toBeTruthy();
});

it('/login?forgot=1 opens the card on load and closing drops the query', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter initialEntries={['/login?forgot=1']}><Login /></MemoryRouter>);
  expect(screen.getByRole('dialog')).toBeTruthy();
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
});
