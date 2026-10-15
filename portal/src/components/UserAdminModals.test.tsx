// @vitest-environment jsdom
/** Reset password follows the server's minimum; Manage roles offers the
 *  summary's grantable roles and never sends client/partner roles. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({ maxRank: 60, passwordMinLength: 20 }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ maxRank: auth.maxRank, passwordMinLength: auth.passwordMinLength }),
}));

const api = vi.hoisted(() => ({
  adminResetPasswordRequest: vi.fn(async () => {}),
  adminSetRolesRequest: vi.fn(async () => []),
  getAccessSummary: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()), ...api,
}));

const { ApiError } = await import('../lib/api');
const { ManageRolesModal, ResetPasswordModal } = await import('./UserAdminModals');

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
  api.getAccessSummary.mockResolvedValue(SUMMARY);
});
afterEach(cleanup);

/* ── reset password ── */

it('Reset password: minLength and the generated value follow the session minimum', () => {
  render(<ResetPasswordModal user={USER} onClose={() => {}} onDone={() => {}} />);
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
