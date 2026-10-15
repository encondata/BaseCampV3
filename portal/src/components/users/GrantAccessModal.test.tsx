// @vitest-environment jsdom
/** The shared Grant portal access dialog (People › External and the worker page). */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ maxRank: 60, passwordMinLength: 20 }),
}));

const api = vi.hoisted(() => ({ adminCreateAccountRequest: vi.fn(async () => {}) }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()), ...api,
}));

const { ApiError } = await import('../../lib/api');
const { GrantAccessModal } = await import('./GrantAccessModal');

const PERSON = { person_id: 'p9', first_name: 'Ana', last_name: 'Ext', email: 'ana@x.test' };

beforeEach(() => { vi.clearAllMocks(); });
afterEach(cleanup);

it('has the Users header, follows the session minimum, and creates the account', async () => {
  const onDone = vi.fn();
  render(<GrantAccessModal person={PERSON} onClose={() => {}} onDone={onDone} />);
  const dialog = screen.getByRole('dialog', { name: 'Grant portal access' });
  expect(dialog.querySelector('.eyebrow')?.textContent).toBe('Users');
  expect(screen.getByRole('heading', { name: 'Grant portal access — Ana Ext' })).toBeTruthy();
  const email = screen.getByLabelText('Login email *') as HTMLInputElement;
  const temp = screen.getByLabelText('Temporary password *') as HTMLInputElement;
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
