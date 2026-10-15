// @vitest-environment jsdom
/** The shared Grant portal access dialog (People › External and the worker page). */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ maxRank: 60, passwordMinLength: 20 }),
}));

const sys = vi.hoisted(() => ({ email_enabled: false }));
vi.mock('../../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({ status: { email_enabled: sys.email_enabled }, refresh: () => {} }),
}));

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const api = vi.hoisted(() => ({ adminCreateAccountRequest: vi.fn(async () => {}) }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { ApiError } = await import('../../lib/api');
const { GrantAccessModal } = await import('./GrantAccessModal');

const PERSON = { person_id: 'p9', first_name: 'Ana', last_name: 'Ext', email: 'ana@x.test' };

beforeEach(() => { vi.clearAllMocks(); sys.email_enabled = false; });
afterEach(cleanup);

it('has the Users header, follows the session minimum, and creates the account', async () => {
  const onDone = vi.fn();
  render(<GrantAccessModal person={PERSON} onClose={() => {}} onDone={onDone} />);
  const dialog = screen.getByRole('dialog', { name: 'Grant portal access' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Users');
  expect(screen.getByRole('heading', { name: 'Grant portal access — Ana Ext' })).toBeTruthy();
  const email = screen.getByLabelText('Login email *') as HTMLInputElement;
  const temp = screen.getByLabelText('Temporary password *') as HTMLInputElement;
  // email off: no Sign-in choice, today's flow
  expect(screen.queryByRole('group', { name: 'Sign-in' })).toBeNull();
  expect(email.value).toBe('ana@x.test');
  expect(temp.minLength).toBe(20);
  expect(temp.value.length).toBeGreaterThanOrEqual(22);
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(api.adminCreateAccountRequest).toHaveBeenCalledWith('p9', {
    login_email: 'ana@x.test', temp_password: temp.value, must_change_password: true,
  }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});

it('maps errors, including the server minimum', async () => {
  api.adminCreateAccountRequest
    .mockRejectedValueOnce(new ApiError(409, 'account_exists'))
    .mockRejectedValueOnce(new ApiError(422, 'password_too_short',
      { code: 'password_too_short', min_length: 20 }));
  render(<GrantAccessModal person={PERSON} onClose={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  expect(await screen.findByText('This person already has a login account.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  expect(await screen.findByText('Temporary passwords need at least 20 characters.')).toBeTruthy();
});

/* ── email on: invite links ── */

const choice = (name: string) => screen.getByRole('button', { name }) as HTMLButtonElement;

it('email on: invite is the default, hides the password fields, and sends invite: true', async () => {
  sys.email_enabled = true;
  const onDone = vi.fn();
  render(<GrantAccessModal person={PERSON} onClose={() => {}} onDone={onDone} />);
  expect(screen.getByRole('group', { name: 'Sign-in' })).toBeTruthy();
  expect(choice('Email an invite link').getAttribute('aria-pressed')).toBe('true');
  expect(choice('Set a temporary password').getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByLabelText('Temporary password *')).toBeNull();
  expect(screen.queryByText('Must change password at first sign-in')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(api.adminCreateAccountRequest).toHaveBeenCalledWith('p9', {
    login_email: 'ana@x.test', temp_password: null, must_change_password: false, invite: true,
  }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
});

it('email on: "Set a temporary password" brings the fields back and sends the password', async () => {
  sys.email_enabled = true;
  render(<GrantAccessModal person={PERSON} onClose={() => {}} onDone={() => {}} />);
  fireEvent.click(choice('Set a temporary password'));
  const temp = screen.getByLabelText('Temporary password *') as HTMLInputElement;
  expect(screen.getByText('Must change password at first sign-in')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(api.adminCreateAccountRequest).toHaveBeenCalledWith('p9', {
    login_email: 'ana@x.test', temp_password: temp.value, must_change_password: true,
  }));
});

it('email on: a blank login email with invite chosen gets the validation error, not a crash', async () => {
  sys.email_enabled = true;
  render(<GrantAccessModal person={{ ...PERSON, email: null }} onClose={() => {}} onDone={() => {}} />);
  const email = screen.getByLabelText('Login email *') as HTMLInputElement;
  expect(email.value).toBe('');
  expect(email.required).toBe(true);
  // bypass the browser's own required check to reach the dialog's guard
  fireEvent.submit(email.closest('form')!);
  expect(await screen.findByText('A login email is required to create an account.')).toBeTruthy();
  expect(api.adminCreateAccountRequest).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog', { name: 'Grant portal access' })).toBeTruthy();
});

it('email on: mail_not_configured from the server is explained', async () => {
  sys.email_enabled = true;
  api.adminCreateAccountRequest.mockRejectedValueOnce(new ApiError(422, 'mail_not_configured'));
  render(<GrantAccessModal person={PERSON} onClose={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  expect(await screen.findByText(
    "Email isn't set up, so an invite can't be sent. Set a temporary password instead.")).toBeTruthy();
});

it('email on: an invite confirms with a toast naming the login email', async () => {
  sys.email_enabled = true;
  const onDone = vi.fn();
  render(<GrantAccessModal person={PERSON} onClose={() => {}} onDone={onDone} />);
  fireEvent.change(screen.getByLabelText('Login email *'), { target: { value: ' login@x.test ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(toast).toHaveBeenCalledWith('Invite sent to login@x.test.');
});

it('the temporary-password path shows no invite toast', async () => {
  sys.email_enabled = true;
  const onDone = vi.fn();
  render(<GrantAccessModal person={PERSON} onClose={() => {}} onDone={onDone} />);
  fireEvent.click(choice('Set a temporary password'));
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await waitFor(() => expect(onDone).toHaveBeenCalled());
  expect(toast).not.toHaveBeenCalled();
});

it('a failed invite shows no toast', async () => {
  sys.email_enabled = true;
  api.adminCreateAccountRequest.mockRejectedValueOnce(new ApiError(409, 'account_exists'));
  render(<GrantAccessModal person={PERSON} onClose={() => {}} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Create account' }));
  await screen.findByText('This person already has a login account.');
  expect(toast).not.toHaveBeenCalled();
});

it('the title uses the preferred display name, falling back to first last', () => {
  const { unmount } = render(
    <GrantAccessModal person={{ ...PERSON, display_name: 'Annie Ext' }} onClose={() => {}} onDone={() => {}} />);
  expect(screen.getByRole('heading', { name: 'Grant portal access — Annie Ext' })).toBeTruthy();
  unmount();
  render(<GrantAccessModal person={{ ...PERSON, display_name: null }} onClose={() => {}} onDone={() => {}} />);
  expect(screen.getByRole('heading', { name: 'Grant portal access — Ana Ext' })).toBeTruthy();
});
