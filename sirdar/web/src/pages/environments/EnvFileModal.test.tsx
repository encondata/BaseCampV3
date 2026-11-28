// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ downloadEnvFile: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import EnvFileModal from './EnvFileModal';
import { ENV } from './testData';

const saved: { name: string; href: string }[] = [];
beforeEach(() => {
  api.downloadEnvFile.mockReset();
  saved.length = 0;
  URL.createObjectURL = vi.fn(() => 'blob:env-file');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    saved.push({ name: this.download, href: this.getAttribute('href') ?? '' });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function open() {
  const onClose = vi.fn();
  render(<EnvFileModal env={ENV} onClose={onClose} />);
  return { onClose };
}
const download = () => userEvent.click(screen.getByRole('button', { name: 'Download' }));

it('asks for the password, with the hint and both buttons', () => {
  open();
  const field = screen.getByLabelText('Your Sirdar password') as HTMLInputElement;
  expect(field.type).toBe('password');
  expect(field.getAttribute('autocomplete')).toBe('current-password');
  expect(document.activeElement).toBe(field);
  expect(screen.getByText('This file holds every password and key for uat. Keep it somewhere private.')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Download' }) as HTMLButtonElement).disabled).toBe(true);
});

it('a wrong password shows under the field and keeps the modal open', async () => {
  api.downloadEnvFile.mockRejectedValue(new ApiError(403, 'invalid_current_password', { code: 'invalid_current_password' }));
  const { onClose } = open();
  await userEvent.type(screen.getByLabelText('Your Sirdar password'), 'wrong');
  await download();
  expect(await screen.findByText("That password isn't right.")).toBeTruthy();
  expect(api.downloadEnvFile).toHaveBeenCalledWith('uat', 'wrong');
  expect(onClose).not.toHaveBeenCalled();
  expect(saved).toEqual([]);
});

it('a locked account gets the lockout message', async () => {
  api.downloadEnvFile.mockRejectedValue(new ApiError(423, 'account_locked', { code: 'account_locked' }));
  open();
  await userEvent.type(screen.getByLabelText('Your Sirdar password'), 'pw{Enter}');
  expect(await screen.findByText('Too many attempts — your account is temporarily locked.')).toBeTruthy();
});

it('the right password saves <env>.env, revokes its URL and closes', async () => {
  api.downloadEnvFile.mockResolvedValue(new Blob(['STACK_ENV=uat\n'], { type: 'text/plain' }));
  const { onClose } = open();
  await userEvent.type(screen.getByLabelText('Your Sirdar password'), 'right');
  await download();
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(saved).toEqual([{ name: 'uat.env', href: 'blob:env-file' }]);
  expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:env-file');
});

it('Cancel and Escape close without a request', async () => {
  const { onClose } = open();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(2);
  expect(api.downloadEnvFile).not.toHaveBeenCalled();
});
