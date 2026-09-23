// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  getSecurityConfig: vi.fn(),
  updateSecurityConfig: vi.fn(),
  revokeAllSessions: vi.fn(),
  ApiError: class ApiError extends Error { code = ''; },
}));
vi.mock('../../lib/api', () => api);
vi.mock('../../lib/systemStatus', () => ({ getSystemStatus: async () => ({ totp_trust_days: 7 }) }));

const { default: SecurityControls } = await import('./SecurityControls');

beforeEach(() => {
  api.getSecurityConfig.mockResolvedValue({ two_factor_enabled: false, two_factor_required: false });
  api.updateSecurityConfig.mockImplementation(async (p: Record<string, boolean>) => ({
    two_factor_enabled: !!(p.two_factor_enabled || p.two_factor_required),
    two_factor_required: !!p.two_factor_required,
  }));
  api.revokeAllSessions.mockResolvedValue({ revoked_sessions: 4, revoked_people: 3 });
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

const switches = () => screen.getAllByRole('checkbox') as HTMLInputElement[];

it('loads the policy and saves a change; requiring 2FA also shows enabled', async () => {
  render(<SecurityControls />);
  await waitFor(() => expect(switches()[0].disabled).toBe(false));
  fireEvent.click(switches()[1]);
  await waitFor(() => expect(api.updateSecurityConfig).toHaveBeenCalledWith({ two_factor_required: true }));
  await waitFor(() => expect(switches()[0].checked).toBe(true));
});

it('End all sessions confirms, calls the API, and reports the count', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<SecurityControls />);
  await waitFor(() => expect(switches()[0].disabled).toBe(false));
  fireEvent.click(screen.getByRole('button', { name: 'End all sessions' }));
  await waitFor(() => expect(api.revokeAllSessions).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.getByText(/Signed out 4 sessions across 3 people/)).toBeTruthy());
});

it('explains the policy and shows the trust window', async () => {
  render(<SecurityControls />);
  expect(await screen.findByText(/skip the code for 7 days/i)).toBeTruthy();
  expect(screen.getByText(/challenges enrolled users at sign-in/i)).toBeTruthy();
});

it('does nothing when the confirm is declined, and disables everything when change is not allowed', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<SecurityControls canChange={false} />);
  await waitFor(() => expect(api.getSecurityConfig).toHaveBeenCalled());
  for (const sw of switches()) expect(sw.disabled).toBe(true);
  const btn = screen.getByRole('button', { name: 'End all sessions' }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(api.revokeAllSessions).not.toHaveBeenCalled();
});
