// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a !== 'change' || perms.change) }),
}));
const api = vi.hoisted(() => ({ setFirstAdmin: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import type { Environment } from '../../lib/sirdarApi';

import FirstAdminCard from './FirstAdminCard';
import { ENV } from './testData';

const PENDING: Environment = {
  ...ENV, status: 'failed',
  first_admin: { first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', password_mode: 'typed', done: false },
};

beforeEach(() => {
  perms.change = true;
  api.setFirstAdmin.mockReset();
  api.setFirstAdmin.mockImplementation(async (_n: string, body: Record<string, unknown>) => ({
    ...PENDING, first_admin: { ...PENDING.first_admin!, ...body, done: false },
  }));
});
afterEach(cleanup);

function show(env = PENDING, disabled = false) {
  const onSaved = vi.fn();
  render(<FirstAdminCard env={env} disabled={disabled} minLength={8} onSaved={onSaved} />);
  return { onSaved };
}
const card = () => screen.getByRole('group', { name: 'First admin' });
const dialog = () => screen.getByRole('dialog', { name: 'Change the first admin' });
const openChange = () => userEvent.click(within(card()).getByRole('button', { name: 'Change…' }));
const save = () => userEvent.click(within(dialog()).getByRole('button', { name: 'Save' }));

it('shows the name, email and mode; Change needs deploy:change', () => {
  show();
  expect(within(card()).getByText('Ada Lovelace')).toBeTruthy();
  expect(within(card()).getByText('ada@example.com')).toBeTruthy();
  expect(within(card()).getByText('Typed')).toBeTruthy();
  expect(within(card()).getByText(/step 11/)).toBeTruthy();
  cleanup();
  show({ ...PENDING, first_admin: { ...PENDING.first_admin!, password_mode: 'invite' } });
  expect(within(card()).getByText('Invite')).toBeTruthy();
  cleanup();
  perms.change = false;
  show();
  expect(within(card()).queryByRole('button', { name: 'Change…' })).toBeNull();
});

it('Change is disabled while a deployment runs', () => {
  show(PENDING, true);
  expect((within(card()).getByRole('button', { name: 'Change…' }) as HTMLButtonElement).disabled).toBe(true);
});

it('has the report-generate header, starts from the current values, and Escape closes it', async () => {
  show();
  await openChange();
  expect(within(dialog()).getByText('Settings', { selector: '.eyebrow' })).toBeTruthy();
  expect(dialog().classList.contains('sirdar-firstadmin-card')).toBe(true);
  expect((screen.getByLabelText('First name') as HTMLInputElement).value).toBe('Ada');
  expect((screen.getByLabelText('Last name') as HTMLInputElement).value).toBe('Lovelace');
  expect((screen.getByLabelText('Email') as HTMLInputElement).value).toBe('ada@example.com');
  expect(screen.getByRole('radio', { name: 'Typed' }).getAttribute('aria-checked')).toBe('true');
  expect(document.activeElement).toBe(screen.getByLabelText('First name'));
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('a typed password is saved with the names and email', async () => {
  const { onSaved } = show();
  await openChange();
  await userEvent.clear(screen.getByLabelText('Email'));
  await userEvent.type(screen.getByLabelText('Email'), 'ada@cumulus.example');
  await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-9');
  await userEvent.type(screen.getByLabelText('Confirm password'), 'correct-horse-9');
  await save();
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.setFirstAdmin).toHaveBeenCalledWith('uat', {
    first_name: 'Ada', last_name: 'Lovelace', email: 'ada@cumulus.example', password_mode: 'typed',
    password: 'correct-horse-9',
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('status').textContent).toMatch(/Saved/);
});

it('an invite sends no password and hides the password fields', async () => {
  show();
  await openChange();
  await userEvent.click(screen.getByRole('radio', { name: 'Invite' }));
  expect(screen.queryByLabelText('Password')).toBeNull();
  expect(screen.queryByLabelText('Confirm password')).toBeNull();
  await save();
  await waitFor(() => expect(api.setFirstAdmin).toHaveBeenCalled());
  expect(api.setFirstAdmin.mock.calls[0][1]).toEqual({
    first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', password_mode: 'invite',
  });
});

it("a typed password that doesn't match its confirmation is not sent", async () => {
  show();
  await openChange();
  await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-9');
  await userEvent.type(screen.getByLabelText('Confirm password'), 'correct-horse-8');
  await save();
  expect(screen.getByText("The passwords don't match.")).toBeTruthy();
  expect(screen.getByLabelText('Confirm password').getAttribute('aria-invalid')).toBe('true');
  expect(api.setFirstAdmin).not.toHaveBeenCalled();
});

it('checks the names, the email and the password length before sending', async () => {
  show();
  await openChange();
  await userEvent.clear(screen.getByLabelText('First name'));
  await userEvent.clear(screen.getByLabelText('Email'));
  await userEvent.type(screen.getByLabelText('Email'), 'not-an-email');
  await userEvent.type(screen.getByLabelText('Password'), 'short');
  await userEvent.type(screen.getByLabelText('Confirm password'), 'short');
  await save();
  expect(screen.getByLabelText('First name').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByText('Use at least 8 characters.')).toBeTruthy();
  expect(api.setFirstAdmin).not.toHaveBeenCalled();
});

it('API errors go to their field; first_admin_done and deploy_in_progress are alerts', async () => {
  show();
  await openChange();
  await userEvent.type(screen.getByLabelText('Password'), 'correct-horse-9');
  await userEvent.type(screen.getByLabelText('Confirm password'), 'correct-horse-9');

  api.setFirstAdmin.mockRejectedValueOnce(new ApiError(422, 'first_admin_email_invalid', { code: 'first_admin_email_invalid' }));
  await save();
  expect(await screen.findByText('Enter a valid email address for the first admin.')).toBeTruthy();
  expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');

  api.setFirstAdmin.mockRejectedValueOnce(new ApiError(422, 'first_admin_password_too_short', {
    code: 'first_admin_password_too_short', min_length: 12 }));
  await save();
  expect(await screen.findByText(/at least 12 characters/)).toBeTruthy();
  expect(screen.getByLabelText('Password').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('false');

  api.setFirstAdmin.mockRejectedValueOnce(new ApiError(422, 'first_admin_name_invalid', { code: 'first_admin_name_invalid' }));
  await save();
  expect(await screen.findByText(/Enter a first and last name/)).toBeTruthy();
  expect(screen.getByLabelText('First name').getAttribute('aria-invalid')).toBe('true');

  api.setFirstAdmin.mockRejectedValueOnce(new ApiError(409, 'first_admin_done', { code: 'first_admin_done' }));
  await save();
  expect((await within(dialog()).findByRole('alert')).textContent)
    .toBe('The first admin was already created; change their password in the portal.');

  api.setFirstAdmin.mockRejectedValueOnce(new ApiError(409, 'deploy_in_progress', { code: 'deploy_in_progress' }));
  await save();
  await waitFor(() => expect(within(dialog()).getByRole('alert').textContent)
    .toBe('A deployment of this environment is already running.'));
});
