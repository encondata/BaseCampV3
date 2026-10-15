// @vitest-environment jsdom
/** Reset password follows the server's minimum; Manage roles offers the
 *  summary's grantable roles and never sends client/partner roles. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ maxRank: 60, passwordMinLength: 20 }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ maxRank: auth.maxRank, passwordMinLength: auth.passwordMinLength }),
}));

const sys = vi.hoisted(() => ({
  status: { email_enabled: false } as { email_enabled: boolean; password_reset_ttl_minutes?: number },
}));
vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: sys.status, refresh: () => {} }),
}));

const api = vi.hoisted(() => ({
  adminResendInviteRequest: vi.fn(async () => {}),
  adminSendResetLinkRequest: vi.fn(async () => {}),
  adminResetPasswordRequest: vi.fn(async () => {}),
  adminSetRolesRequest: vi.fn(async () => []),
  getAccessSummary: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

const { ApiError } = await import('../lib/api');
const { ManageRolesModal, ResetPasswordModal, resendInvite } = await import('./UserAdminModals');

const role = (name: string, label: string, rank: number, scope_anchor: string) => ({
  name, label, rank, scope_anchor, color: null, description: '', is_system: true,
  member_count: 0, matrix: {}, totp_required: false,
});
const SUMMARY = {
  two_factor_enabled: true,
  stats: { members: 0, roles: 6, groups: 0, gated_resources: 0, overrides: 0 },
  resources: [],
  roles: [
    role('super_admin', 'Super admin', 80, 'global'),
    role('admin', 'Admin', 60, 'global'),
    role('staff', 'Staff', 40, 'global'),
    role('client_admin', 'Client admin', 20, 'client'),
    role('vendor_admin', 'Vendor admin', 20, 'partner'),
    role('worker', 'Worker', 10, 'self'),
    role('external', 'External', 5, 'self'),
  ],
  groups: [],
};

const USER = {
  person_id: 'p1', display_name: 'Wan Worker', first_name: 'Wan', last_name: 'Worker',
  preferred_name: null, job_title: null, contact_email: null, phone: null,
  roles: ['staff'], status: 'active', max_rank: 40, avatar_url: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.maxRank = 60;
  auth.passwordMinLength = 20;
  sys.status = { email_enabled: false };
  api.getAccessSummary.mockResolvedValue(SUMMARY);
});
afterEach(cleanup);

/* ── reset password ── */

it('Reset password: minLength and the generated value follow the session minimum', () => {
  render(<ResetPasswordModal user={USER} onClose={() => {}} onDone={() => {}} />);
  // email off: no choice, today's flow
  expect(screen.queryByRole('group', { name: 'Reset method' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send link' })).toBeNull();
  const input = screen.getByLabelText('Temporary password') as HTMLInputElement;
  expect(input.minLength).toBe(20);
  expect(input.value.length).toBeGreaterThanOrEqual(22);
  const reset = screen.getByRole('button', { name: 'Reset password' }) as HTMLButtonElement;
  expect(reset.disabled).toBe(false);
  fireEvent.change(input, { target: { value: 'x'.repeat(19) } });
  expect(reset.disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Generate a new password' }));
  expect(input.value.length).toBeGreaterThanOrEqual(22);
  expect(reset.disabled).toBe(false);
});

it('Reset password: a server password_too_short names its min_length', async () => {
  api.adminResetPasswordRequest.mockRejectedValueOnce(
    new ApiError(422, 'password_too_short', { code: 'password_too_short', min_length: 20 }));
  render(<ResetPasswordModal user={USER} onClose={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
  expect(await screen.findByText('Temporary passwords need at least 20 characters.')).toBeTruthy();
});

it('Reset password, email on: the emailed link is the default and "Send link" sends it', async () => {
  sys.status = { email_enabled: true, password_reset_ttl_minutes: 15 };
  const onDone = vi.fn();
  render(<ResetPasswordModal user={{ ...USER, login_email: 'wan@x.test' }}
                             onClose={() => {}} onDone={onDone} />);
  expect(screen.getByRole('group', { name: 'Reset method' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Email a reset link' }).getAttribute('aria-pressed'))
    .toBe('true');
  expect(screen.queryByLabelText('Temporary password')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Send link' }));
  await waitFor(() => expect(api.adminSendResetLinkRequest).toHaveBeenCalledWith('p1'));
  expect(api.adminResetPasswordRequest).not.toHaveBeenCalled();
  expect(await screen.findByText(
    'Reset link sent to wan@x.test. It works once and expires in 15 minutes.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  expect(onDone).toHaveBeenCalled();
});

it('Reset password, email on: without known minutes the link "expires soon."', async () => {
  sys.status = { email_enabled: true };
  render(<ResetPasswordModal user={{ ...USER, login_email: 'wan@x.test' }}
                             onClose={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send link' }));
  expect(await screen.findByText(
    'Reset link sent to wan@x.test. It works once and expires soon.')).toBeTruthy();
});

it('Reset password, email on: "Set a temporary password" is today\'s flow', async () => {
  sys.status = { email_enabled: true, password_reset_ttl_minutes: 15 };
  render(<ResetPasswordModal user={USER} onClose={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Set a temporary password' }));
  const input = screen.getByLabelText('Temporary password') as HTMLInputElement;
  expect(screen.queryByRole('button', { name: 'Send link' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Reset password' }));
  await waitFor(() => expect(api.adminResetPasswordRequest).toHaveBeenCalledWith('p1', input.value, true));
  expect(api.adminSendResetLinkRequest).not.toHaveBeenCalled();
});

it('Reset password, email on: an invited account is told to resend the invite', async () => {
  sys.status = { email_enabled: true, password_reset_ttl_minutes: 15 };
  api.adminSendResetLinkRequest.mockRejectedValueOnce(new ApiError(409, 'invited'));
  render(<ResetPasswordModal user={USER} onClose={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Send link' }));
  expect(await screen.findByText(
    "They haven't set a password yet. Resend their invite instead.")).toBeTruthy();
});

/* ── resend invite ── */

it('resendInvite: "Invite sent to {email}." or a friendly error', async () => {
  expect(await resendInvite('p1', 'wan@x.test')).toBe('Invite sent to wan@x.test.');
  expect(api.adminResendInviteRequest).toHaveBeenCalledWith('p1');
  api.adminResendInviteRequest.mockRejectedValueOnce(new ApiError(409, 'not_invited'));
  expect(await resendInvite('p1', 'wan@x.test')).toBe("They've already set a password.");
  api.adminResendInviteRequest.mockRejectedValueOnce(new ApiError(422, 'mail_not_configured'));
  expect(await resendInvite('p1', 'wan@x.test')).toBe("Email isn't set up, so nothing can be sent.");
});

/* ── manage roles ── */

const chip = (label: string) => screen.queryByRole('button', { name: label }) as HTMLButtonElement | null;

it('Manage roles: chips are the summary\'s grantable roles by label, no client/vendor', async () => {
  render(<ManageRolesModal user={USER} onClose={() => {}} onSaved={() => {}} />);
  expect(await screen.findByRole('button', { name: 'Staff' })).toBeTruthy();
  expect(chip('Worker')).toBeTruthy();
  expect(chip('External')).toBeTruthy();
  // at or above the actor's rank (60): not offered
  expect(chip('Admin')).toBeNull();
  expect(chip('Super admin')).toBeNull();
  // retired names and org roles are never chips
  expect(chip('client')).toBeNull();
  expect(chip('vendor')).toBeNull();
  expect(chip('Client admin')).toBeNull();
  expect(chip('Staff')?.getAttribute('aria-pressed')).toBe('true');
});

it('Manage roles: an org-role holder unticking staff sends [] and sees the org chip read-only', async () => {
  render(<ManageRolesModal user={{ ...USER, roles: ['client_admin', 'staff'] }}
                           onClose={() => {}} onSaved={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Staff' }));
  expect(screen.getByText('Client admin').tagName).toBe('SPAN');
  expect(screen.getByText("Managed from the client's or partner's contacts page.")).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Save roles' }));
  await waitFor(() => expect(api.adminSetRolesRequest).toHaveBeenCalledWith('p1', []));
});

it('Manage roles: ticking admin sends [admin, staff], keeping the org role out', async () => {
  auth.maxRank = 80;
  const onSaved = vi.fn();
  render(<ManageRolesModal user={{ ...USER, roles: ['client_admin', 'staff'] }}
                           onClose={() => {}} onSaved={onSaved} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Admin' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save roles' }));
  await waitFor(() => expect(api.adminSetRolesRequest).toHaveBeenCalledWith('p1', ['admin', 'staff']));
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
});

it('Manage roles: self roles ride along after the globals', async () => {
  render(<ManageRolesModal user={{ ...USER, roles: ['staff', 'worker'] }}
                           onClose={() => {}} onSaved={() => {}} />);
  fireEvent.click(await screen.findByRole('button', { name: 'External' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save roles' }));
  await waitFor(() => expect(api.adminSetRolesRequest)
    .toHaveBeenCalledWith('p1', ['staff', 'worker', 'external']));
});

it('Manage roles: Save waits for the role list', async () => {
  api.getAccessSummary.mockReturnValue(new Promise(() => {}));
  render(<ManageRolesModal user={USER} onClose={() => {}} onSaved={() => {}} />);
  expect(screen.getByText('Loading roles…')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save roles' }) as HTMLButtonElement).disabled).toBe(true);
});
