// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ createSshTarget: vi.fn(), updateSshTarget: vi.fn(), getSshTarget: vi.fn(), listKeyFiles: vi.fn() }));
vi.mock('../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import SshTargetModal from './SshTargetModal';

Element.prototype.scrollIntoView = () => {};
const SAVED = { slug: 'edge-box', name: 'Edge Box', host: '10.0.0.5', port: 2222, user: 'deployer',
                key_path: null, password_set: true, passphrase_set: false };

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.listKeyFiles.mockResolvedValue({ files: ['id_ed25519', 'b_key'] });
  api.getSshTarget.mockResolvedValue(SAVED);
  api.createSshTarget.mockResolvedValue({ ...SAVED, slug: 'new-one', name: 'New One' });
  api.updateSshTarget.mockResolvedValue(SAVED);
});
afterEach(cleanup);

const field = (n: RegExp | string) => screen.getByLabelText(n) as HTMLInputElement;
async function openAdd(onSaved = vi.fn(), onClose = vi.fn()) {
  render(<SshTargetModal mode="add" onSaved={onSaved} onClose={onClose} />);
  await waitFor(() => expect(api.listKeyFiles).toHaveBeenCalled());
  return { onSaved, onClose };
}
async function openEdit(onSaved = vi.fn(), onClose = vi.fn()) {
  render(<SshTargetModal mode="edit" slug="edge-box" onSaved={onSaved} onClose={onClose} />);
  await screen.findByText('Password: set');
  return { onSaved, onClose };
}

it('shows the header, defaults the port to 22 and focuses the name', async () => {
  await openAdd();
  expect(screen.getByText('Deploy')).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Add SSH target' })).toBeTruthy();
  expect(screen.getByText(/Saved to deploy-targets\.env on the Sirdar host\. Passwords and passphrases are write-only\./)).toBeTruthy();
  expect(field('Port').value).toBe('22');
  expect(document.activeElement).toBe(field('Name'));
  expect(screen.getByText(/sirdar\/deploy-keys\/ on the Sirdar host \(chmod 600\)/)).toBeTruthy();
});

it('validates required fields, port range and auth before calling the API', async () => {
  await openAdd();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByText('Enter a name.')).toBeTruthy();
  expect(screen.getByText('Enter a host.')).toBeTruthy();
  expect(screen.getByText('Enter a user.')).toBeTruthy();
  expect(screen.getByText('Add a password or choose a key file.')).toBeTruthy();
  await userEvent.type(field('Name'), 'x');
  await userEvent.type(field('Host'), 'h');
  await userEvent.type(field('User'), 'u');
  await userEvent.type(field('Password'), 'pw');
  await userEvent.clear(field('Port'));
  await userEvent.type(field('Port'), '70000');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByText('Port must be a number from 1 to 65535.')).toBeTruthy();
  expect(api.createSshTarget).not.toHaveBeenCalled();
});

it('POSTs the new target and reports the saved slug', async () => {
  const { onSaved } = await openAdd();
  await userEvent.type(field('Name'), 'New One');
  await userEvent.type(field('Host'), '10.1.1.1');
  await userEvent.type(field('User'), 'deploy');
  await userEvent.type(field('Password'), 'sekret');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('new-one'));
  expect(api.createSshTarget).toHaveBeenCalledWith({ name: 'New One', host: '10.1.1.1', port: 22, user: 'deploy', password: 'sekret' });
});

it('a key file satisfies auth and unlocks the passphrase', async () => {
  await openAdd();
  expect(screen.queryByLabelText('Key passphrase')).toBeNull();
  await userEvent.type(field('Name'), 'K');
  await userEvent.type(field('Host'), 'h');
  await userEvent.type(field('User'), 'u');
  await userEvent.click(screen.getByLabelText('Key file'));
  await userEvent.click(await screen.findByText('id_ed25519'));
  await userEvent.type(field('Key passphrase'), 'pp');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.createSshTarget).toHaveBeenCalled());
  expect(api.createSshTarget).toHaveBeenCalledWith({ name: 'K', host: 'h', port: 22, user: 'u', key_path: 'id_ed25519', key_passphrase: 'pp' });
});

it('maps API error codes to inline messages and stays open', async () => {
  api.createSshTarget.mockRejectedValue(new ApiError(422, 'name_taken', { code: 'name_taken' }));
  const { onSaved } = await openAdd();
  await userEvent.type(field('Name'), 'Dup');
  await userEvent.type(field('Host'), 'h');
  await userEvent.type(field('User'), 'u');
  await userEvent.type(field('Password'), 'pw');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('A target with that name already exists.')).toBeTruthy();
  expect(onSaved).not.toHaveBeenCalled();
});

it('edit loads the fields, never prefills a secret and omits secrets when untouched', async () => {
  const { onSaved } = await openEdit();
  expect(screen.getByRole('heading', { name: 'Edit SSH target' })).toBeTruthy();
  expect(field('Name').value).toBe('Edge Box');
  expect(field('Host').value).toBe('10.0.0.5');
  expect(field('Port').value).toBe('2222');
  expect(field('User').value).toBe('deployer');
  expect(screen.queryByLabelText('Password')).toBeNull();
  expect(document.body.innerHTML).not.toMatch(/sekret|value="[^"]*pw/);
  await userEvent.clear(field('Host'));
  await userEvent.type(field('Host'), '10.0.0.6');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(onSaved).toHaveBeenCalledWith('edge-box'));
  expect(api.updateSshTarget).toHaveBeenCalledWith('edge-box',
    { name: 'Edge Box', host: '10.0.0.6', port: 2222, user: 'deployer', key_path: '' });
});

it('Replace sends the new password; Clear sends an empty string', async () => {
  await openEdit();
  await userEvent.click(screen.getByRole('button', { name: 'Replace' }));
  await userEvent.type(field('Password'), 'newpw');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateSshTarget).toHaveBeenCalled());
  expect(api.updateSshTarget.mock.calls[0][1]).toMatchObject({ password: 'newpw' });
  cleanup(); api.updateSshTarget.mockClear();

  await openEdit();
  await userEvent.click(screen.getByRole('button', { name: 'Clear' }));
  expect(screen.getByText('Password: will be cleared')).toBeTruthy();
  // clearing the only credential is refused client-side
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(screen.getByText('Add a password or choose a key file.')).toBeTruthy();
  expect(api.updateSshTarget).not.toHaveBeenCalled();
  await userEvent.click(screen.getByLabelText('Key file'));
  await userEvent.click(await screen.findByText('b_key'));
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(api.updateSshTarget).toHaveBeenCalled());
  expect(api.updateSshTarget.mock.calls[0][1]).toMatchObject({ password: '', key_path: 'b_key' });
});

it('Escape and Cancel close, but not while saving', async () => {
  let release!: () => void;
  api.updateSshTarget.mockReturnValue(new Promise((r) => { release = () => r(SAVED); }));
  const { onClose, onSaved } = await openEdit();
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await userEvent.keyboard('{Escape}');
  expect((screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled).toBe(true);
  expect(onClose).not.toHaveBeenCalled();
  release();
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  cleanup();
  const again = await openAdd();
  await userEvent.keyboard('{Escape}');
  expect(again.onClose).toHaveBeenCalledTimes(1);
});
