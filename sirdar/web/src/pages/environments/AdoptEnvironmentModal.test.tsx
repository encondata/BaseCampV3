// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a !== 'change' || perms.change) }),
}));
const api = vi.hoisted(() => ({ getDeployTargets: vi.fn(), adoptEnvironment: vi.fn(), trustKnownHost: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import AdoptEnvironmentModal from './AdoptEnvironmentModal';
import { DO_TARGETS, ENV, ESXI_TARGETS, PX_TARGETS, TARGETS } from './testData';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getDeployTargets.mockResolvedValue(TARGETS);
});
afterEach(cleanup);

async function open(onAdopted = vi.fn(), onClose = vi.fn()) {
  render(<AdoptEnvironmentModal onAdopted={onAdopted} onClose={onClose} />);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
  return { onAdopted, onClose };
}
const adopt = () => userEvent.click(screen.getByRole('button', { name: 'Adopt' }));

it('has the report-generate header', async () => {
  await open();
  const dialog = screen.getByRole('dialog', { name: 'Adopt an environment' });
  expect(dialog.classList.contains('sirdar-adopt-card')).toBe(true);
  expect(within(dialog).getByText('Deploy', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByText(
    'Adopt an environment set up by hand. Sirdar reads its .env and git checkout over SSH and changes nothing.',
  )).toBeTruthy();
  const steps = dialog.querySelector('.rgm-steps') as HTMLElement;
  expect(within(steps).getByText('Basics')).toBeTruthy();
  expect(within(steps).getByText('Result')).toBeTruthy();
  expect(screen.queryByRole('radiogroup', { name: 'How to add it' })).toBeNull();
  expect(screen.queryByLabelText('Proxy IP')).toBeNull();
  expect(['Dev', 'Beta', 'Custom'].every((t) => screen.getByRole('radio', { name: t }))).toBe(true);
  expect(screen.queryByRole('radio', { name: 'Production' })).toBeNull();
});

it('adopts an existing environment and lists what it imported and ignored', async () => {
  api.adoptEnvironment.mockResolvedValue({
    ...ENV, imported_secrets: ['POSTGRES_PASSWORD', 'SS_JWT_SECRET'], ignored_keys: ['MINIO_ROOT_PASSWORD'],
  });
  const { onAdopted } = await open();
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await adopt();
  expect(await screen.findByText('MINIO_ROOT_PASSWORD')).toBeTruthy();
  expect(screen.getByText('POSTGRES_PASSWORD')).toBeTruthy();
  expect(screen.getByText('SS_JWT_SECRET')).toBeTruthy();
  expect(screen.getByText('/opt/serversherpa/uat')).toBeTruthy();
  expect(screen.getByText('e73b99ca')).toBeTruthy();
  expect(api.adoptEnvironment).toHaveBeenCalledWith({ name: 'uat', type: 'dev', target: 'ssh:lab', git_ref: 'main' });
  await userEvent.click(screen.getByRole('button', { name: 'Open environment' }));
  expect(onAdopted).toHaveBeenCalledWith(expect.objectContaining({ name: 'uat' }));
});

it('an unknown host key asks to trust it with the target, then adopts', async () => {
  api.adoptEnvironment
    .mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', {
      code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' }))
    .mockResolvedValueOnce({ ...ENV, imported_secrets: [], ignored_keys: [] });
  api.trustKnownHost.mockResolvedValue({});
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await adopt();
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and adopt' }));
  expect(await screen.findByText('None. Sirdar knows every key in that .env.')).toBeTruthy();
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc', 'ssh:lab');
  expect(api.adoptEnvironment).toHaveBeenCalledTimes(2);
});

it('a mismatched host key explains what to do', async () => {
  api.adoptEnvironment.mockRejectedValue(new ApiError(409, 'host_key_mismatch', {
    code: 'host_key_mismatch', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', expected: 'SHA256:old', actual: 'SHA256:new' }));
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await adopt();
  expect(await screen.findByText(/doesn't match the one Sirdar trusted/)).toBeTruthy();
  expect(screen.getByText(/Trusted SSH hosts/)).toBeTruthy();
});

it('Escape and Cancel close it', async () => {
  const { onClose } = await open();
  await userEvent.keyboard('{Escape}');
  expect(onClose).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalledTimes(2);
});

const TWO_TARGETS = {
  ...TARGETS,
  targets: [...TARGETS.targets,
    { id: 'ssh:other', label: 'Other box', kind: 'ssh' as const, source: 'saved' as const, available: true, configured: true }],
};
const UNKNOWN_KEY = new ApiError(409, 'host_key_unknown', {
  code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' });

it('trusting replays the exact failed attempt even if the form changed behind the host-key modal', async () => {
  api.getDeployTargets.mockResolvedValue(TWO_TARGETS);
  api.adoptEnvironment
    .mockRejectedValueOnce(UNKNOWN_KEY)
    .mockResolvedValueOnce({ ...ENV, imported_secrets: [], ignored_keys: [] });
  api.trustKnownHost.mockResolvedValue({});
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await adopt();
  const trust = await screen.findByRole('button', { name: 'Trust and adopt' });
  // The form behind the host-key modal is inert while it is open.
  expect(screen.getByRole('dialog', { name: 'Adopt an environment', hidden: true }).closest('[inert]')).toBeTruthy();
  // jsdom doesn't enforce inert, so change the target and name anyway.
  await userEvent.click(screen.getByRole('combobox', { name: 'Target', hidden: true }));
  await userEvent.click(await screen.findByRole('button', { name: 'Other box', hidden: true }));
  await userEvent.type(screen.getByLabelText('Name'), 'x');
  await userEvent.click(trust);
  expect(await screen.findByText('None. Sirdar knows every key in that .env.')).toBeTruthy();
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc', 'ssh:lab');
  expect(api.adoptEnvironment).toHaveBeenCalledTimes(2);
  expect(api.adoptEnvironment.mock.calls[1][0]).toEqual(api.adoptEnvironment.mock.calls[0][0]);
  expect(api.adoptEnvironment.mock.calls[1][0]).toEqual({ name: 'uat', type: 'dev', target: 'ssh:lab', git_ref: 'main' });
  expect(screen.getByRole('dialog', { name: 'Adopt an environment' }).closest('[inert]')).toBeNull();
});

it('canceling the host-key prompt returns focus to the Name', async () => {
  api.adoptEnvironment.mockRejectedValueOnce(UNKNOWN_KEY);
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await adopt();
  await userEvent.click(within(await screen.findByRole('dialog', { name: 'Trust this server?' })).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Trust this server?' })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
});

it('a failed adopt returns focus to the Name', async () => {
  api.adoptEnvironment.mockRejectedValueOnce(new ApiError(502, 'ssh_failed', { code: 'ssh_failed' }));
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await adopt();
  expect(await screen.findByRole('alert')).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
});

it('offers SSH targets only (no ESXi, Proxmox or DigitalOcean)', async () => {
  // ESXi or Proxmox (first in a list) is never the default either.
  api.getDeployTargets.mockResolvedValue({
    ...TARGETS,
    targets: [...ESXI_TARGETS.targets, ...PX_TARGETS.targets, ...DO_TARGETS.targets]
      .filter((t) => !TARGETS.targets.some((u) => u.id === t.id))
      .concat(TARGETS.targets),
  });
  api.adoptEnvironment.mockRejectedValue(new ApiError(422, 'stop', { code: 'stop' }));
  await open();
  expect((screen.getByRole('combobox', { name: 'Target' }) as HTMLInputElement).value).toBe('Lab box');
  await userEvent.click(screen.getByRole('combobox', { name: 'Target' }));
  for (const name of ['VMware ESXi', 'Proxmox', 'DigitalOcean']) {
    expect(screen.queryByRole('button', { name })).toBeNull();
  }
  expect(screen.getByRole('button', { name: 'Lab box' })).toBeTruthy();
  await userEvent.keyboard('{Escape}');
  await userEvent.type(screen.getByLabelText('Name'), 'uat3');
  await adopt();
  await waitFor(() => expect(api.adoptEnvironment).toHaveBeenCalled());
  expect(api.adoptEnvironment.mock.calls[0][0].target).toBe('ssh:lab');
});

it('sends only name, type, target and ref (never a snapshot_id)', async () => {
  api.adoptEnvironment.mockResolvedValue({ ...ENV, imported_secrets: [], ignored_keys: [] });
  await open();
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  await userEvent.clear(screen.getByLabelText('Git ref'));
  await userEvent.type(screen.getByLabelText('Git ref'), 'release/1.2');
  await adopt();
  await waitFor(() => expect(api.adoptEnvironment).toHaveBeenCalledTimes(1));
  expect(api.adoptEnvironment.mock.calls[0][0]).toEqual({
    name: 'uat', type: 'custom', target: 'ssh:lab', git_ref: 'release/1.2' });
});

it('checks the name, target and ref before adopting', async () => {
  api.getDeployTargets.mockResolvedValue({ ...TARGETS, targets: [] });
  await open();
  await adopt();
  expect(screen.getByText('Enter a name.')).toBeTruthy();
  expect(screen.getByText('Choose a target.')).toBeTruthy();
  expect(screen.getByText(/Add an SSH target under Target/)).toBeTruthy();
  expect(api.adoptEnvironment).not.toHaveBeenCalled();
});
