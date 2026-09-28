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

const CFG = {
  two_factor_enabled: false, two_factor_required: false,
  password_expiry_enabled: false, password_expiry_days: 90, password_history_count: 3,
  password_expiry_since: null as string | null,
};
beforeEach(() => {
  api.getSecurityConfig.mockResolvedValue({ ...CFG });
  api.updateSecurityConfig.mockImplementation(async (p: Record<string, boolean | number>) => ({
    ...CFG,
    two_factor_enabled: !!(p.two_factor_enabled || p.two_factor_required),
    two_factor_required: !!p.two_factor_required,
    ...p,
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

it('shows the password policy rows and saves the switch and the numbers', async () => {
  render(<SecurityControls />);
  await waitFor(() => expect(switches()[2].disabled).toBe(false));
  expect(screen.getByRole('heading', { name: 'Password expiry' })).toBeTruthy();
  fireEvent.click(switches()[2]);
  await waitFor(() => expect(api.updateSecurityConfig).toHaveBeenCalledWith({ password_expiry_enabled: true }));
  const days = screen.getByLabelText('Expires after') as HTMLInputElement;
  expect(days.value).toBe('90');
  fireEvent.change(days, { target: { value: '60' } });
  fireEvent.blur(days);
  await waitFor(() => expect(api.updateSecurityConfig).toHaveBeenCalledWith({ password_expiry_days: 60 }));
  const count = screen.getByLabelText('Prevent reuse of the last') as HTMLInputElement;
  expect(count.value).toBe('3');
  fireEvent.change(count, { target: { value: '5' } });
  fireEvent.keyDown(count, { key: 'Enter' });
  await waitFor(() => expect(api.updateSecurityConfig).toHaveBeenCalledWith({ password_history_count: 5 }));
});

it('shows a range error from the API and keeps the inputs locked without change rights', async () => {
  api.updateSecurityConfig.mockRejectedValueOnce(Object.assign(new api.ApiError('x'), { code: 'password_expiry_days_out_of_range' }));
  render(<SecurityControls />);
  const days = await screen.findByLabelText('Expires after') as HTMLInputElement;
  fireEvent.change(days, { target: { value: '500' } });
  fireEvent.blur(days);
  expect(await screen.findByText(/between 1 and 365/)).toBeTruthy();
  await waitFor(() => expect(days.value).toBe('90'));
  cleanup();
  render(<SecurityControls canChange={false} />);
  const locked = await screen.findByLabelText('Expires after') as HTMLInputElement;
  expect(locked.disabled).toBe(true);
});

it('does not save when the field is cleared and blurred, and reverts to the saved value', async () => {
  render(<SecurityControls />);
  const days = await screen.findByLabelText('Expires after') as HTMLInputElement;
  expect(days.value).toBe('90');
  fireEvent.change(days, { target: { value: '' } });
  fireEvent.blur(days);
  await waitFor(() => expect(days.value).toBe('90'));
  expect(api.updateSecurityConfig).not.toHaveBeenCalled();
});

it('groups the controls into two-factor, password expiry and sessions cards', async () => {
  const { container } = render(<SecurityControls />);
  await waitFor(() => expect(switches()[0].disabled).toBe(false));
  const heads = [...container.querySelectorAll('.set-section .set-head h3')].map((h) => h.textContent);
  expect(heads).toEqual(['Two-factor authentication', 'Password expiry', 'Sessions']);
  const cards = [...container.querySelectorAll('.set-section')];
  expect(cards[0].textContent).toContain('Require two-factor for everyone');
  expect(cards[1].textContent).toContain('Expires after');
  expect(cards[2].querySelector('button')?.textContent).toBe('End all sessions');
});

it('shows a failed save in the card it came from', async () => {
  api.updateSecurityConfig.mockRejectedValueOnce(Object.assign(new api.ApiError('x'), { code: 'password_history_count_out_of_range' }));
  render(<SecurityControls />);
  const count = await screen.findByLabelText('Prevent reuse of the last');
  fireEvent.change(count, { target: { value: '99' } });
  fireEvent.blur(count);
  const err = await screen.findByText(/between 0 and 24/);
  expect(err.closest('.set-section')?.querySelector('h3')?.textContent).toBe('Password expiry');
});
