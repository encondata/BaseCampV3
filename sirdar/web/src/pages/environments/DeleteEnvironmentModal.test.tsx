// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a === 'add' ? perms.add : a !== 'change' || perms.change) }),
}));
const api = vi.hoisted(() => ({ startDeployment: vi.fn(), trustKnownHost: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import DeleteEnvironmentModal from './DeleteEnvironmentModal';
import { ENV, PUBLISHED_ENV, PX_ENV, PX_NEW_ENV, TEARDOWN } from './testData';

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.startDeployment.mockResolvedValue(TEARDOWN);
});
afterEach(cleanup);

function show(env = PUBLISHED_ENV) {
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<DeleteEnvironmentModal env={env} onStarted={onStarted} onClose={onClose} />);
  return { onStarted, onClose, dialog: screen.getByRole('dialog', { name: 'Delete uat' }) };
}

it('says what goes and what stays, and needs the typed name', async () => {
  const { onStarted, dialog } = show();
  expect(within(dialog).getByText('Settings', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByText(
    /removes the whole \/opt\/serversherpa\/uat folder from the host, backups included\. Snapshots taken from uat are kept/,
  )).toBeTruthy();
  const removes = within(dialog).getByRole('list', { name: 'Sirdar removes' });
  expect(within(removes).getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'Certificate portal.uat.serversherpa.com', 'DNS record portal.uat.serversherpa.com',
    'Proxy host portal.uat.serversherpa.com']);
  const stays = within(dialog).getByRole('list', { name: 'Left in place' });
  expect(within(stays).getByText('DNS record api.uat.serversherpa.com')).toBeTruthy();
  const go = within(dialog).getByRole('button', { name: 'Delete environment' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(go);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(TEARDOWN));
  expect(api.startDeployment).toHaveBeenCalledWith('uat', { mode: 'teardown', confirm_name: 'uat' });
});

it('an environment with nothing published says so', () => {
  const { dialog } = show(ENV);
  expect(within(dialog).getByText('Sirdar manages no DNS records or proxy hosts for it.')).toBeTruthy();
});

it('an API refusal is shown in the modal', async () => {
  api.startDeployment.mockRejectedValue(new ApiError(409, 'integration_not_configured',
    { code: 'integration_not_configured', kinds: ['cloudflare'] }));
  const { dialog } = show();
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  expect(await within(dialog).findByText('Set up Cloudflare in Settings › Integrations first.'))
    .toBeTruthy();
});

it('the typed name is not enough without both deploy:add and deploy:change', async () => {
  for (const [add, change] of [[false, true], [true, false]]) {
    perms.add = add; perms.change = change;
    const { dialog } = show();
    await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
    expect((within(dialog).getByRole('button', { name: 'Delete environment' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
  }
});

it('a Proxmox environment: the VM goes, with everything on it', async () => {
  const onStarted = vi.fn();
  render(<DeleteEnvironmentModal env={PX_ENV} onStarted={onStarted} onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Delete uat3' });
  expect(within(dialog).getByText(
    /Destroys the VM ss-uat3 \(VM 120\) on Proxmox with everything on it: the database, files, backups and VM snapshots/,
  )).toBeTruthy();
  await userEvent.type(within(dialog).getByLabelText('Type uat3 to confirm'), 'uat3');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(TEARDOWN));
  expect(api.startDeployment).toHaveBeenCalledWith('uat3', { mode: 'teardown', confirm_name: 'uat3' });
});

it('a Proxmox environment whose VM was never created: nothing on Proxmox is removed', () => {
  render(<DeleteEnvironmentModal env={PX_NEW_ENV} onStarted={vi.fn()} onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Delete uat3' });
  expect(within(dialog).getByText(/No VM was created yet; nothing on Proxmox is removed\./)).toBeTruthy();
  expect(within(dialog).queryByText(/Destroys the VM/)).toBeNull();
  cleanup();
});

it('a Proxmox environment with a reserved id but no finished build: removes the partly built VM', () => {
  render(<DeleteEnvironmentModal env={{ ...PX_ENV, vm: { ...PX_ENV.vm!, created: false, stage: 'partial' as const } }}
                                 onStarted={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByText(/Removes the partly built VM ss-uat3 \(id 120\) if Proxmox has it\./)).toBeTruthy();
  expect(screen.queryByText(/nothing on Proxmox is removed/)).toBeNull();
  expect(screen.queryByText(/Destroys the VM/)).toBeNull();
});
