// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a !== 'change' || perms.change) }),
}));
const api = vi.hoisted(() => ({
  getDeployTargets: vi.fn(), getEnvironmentDefaults: vi.fn(), createEnvironment: vi.fn(),
  adoptEnvironment: vi.fn(), trustKnownHost: vi.fn(), listSnapshots: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import NewEnvironmentModal from './NewEnvironmentModal';
import { DEFAULTS, ENV, SNAP, SNAP_TAKING, TARGETS } from './testData';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getDeployTargets.mockResolvedValue(TARGETS);
  api.getEnvironmentDefaults.mockResolvedValue(DEFAULTS);
  api.createEnvironment.mockResolvedValue(ENV);
  api.listSnapshots.mockResolvedValue({ snapshots: [SNAP, SNAP_TAKING] });
});
afterEach(cleanup);

async function open(onCreated = vi.fn(), onClose = vi.fn()) {
  render(<NewEnvironmentModal onCreated={onCreated} onClose={onClose} />);
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
  return { onCreated, onClose };
}
const next = () => userEvent.click(screen.getByRole('button', { name: 'Next' }));

async function fillBasics(name = 'qa') {
  await userEvent.type(screen.getByLabelText('Name'), name);
  await userEvent.click(screen.getByRole('radio', { name: 'Custom' }));
  await userEvent.type(screen.getByLabelText('Proxy IP'), '10.10.48.6');
}

it('has the report-generate header and the Create steps', async () => {
  await open();
  expect(screen.getByRole('heading', { name: 'New environment' })).toBeTruthy();
  expect(screen.getByText('Deploy', { selector: '.eyebrow' })).toBeTruthy();
  expect(screen.getByText(/Sirdar generates its secrets/)).toBeTruthy();
  expect(['Basics', 'Services', 'Data', 'Review'].every((s) => screen.getByText(s))).toBe(true);
});

it('creates an environment through Basics, Services and Review', async () => {
  const { onCreated } = await open();
  await fillBasics();
  await next();
  const table = await screen.findByRole('table', { name: 'Services' });
  expect(within(table).getByText('api.qa.serversherpa.com')).toBeTruthy();
  const apiPort = screen.getByLabelText('api port') as HTMLInputElement;
  expect(apiPort.value).toBe('8000');
  await userEvent.clear(apiPort);
  await userEvent.type(apiPort, '8100');
  await next();
  expect(screen.getByRole('radio', { name: 'Start empty' }).getAttribute('aria-checked')).toBe('true');
  await next();
  expect(screen.getByText('/opt/serversherpa/qa')).toBeTruthy();
  expect(screen.getByText('Empty')).toBeTruthy();
  expect(within(screen.getByRole('table', { name: 'Services to create' })).getByText('8100')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(ENV));
  expect(api.createEnvironment).toHaveBeenCalledWith({
    name: 'qa', type: 'custom', target: 'ssh:lab', git_ref: 'main', proxy_ip: '10.10.48.6', bind_ip: '0.0.0.0',
    ports: { api: 8100, portal: 8091, kiosk: 8090, wiki: 8096, spaces: 9000, status: 8095, mailpit: 8025 },
  });
});

it('checks the basics and the ports before moving on', async () => {
  await open();
  await next();
  expect(screen.getByText('Enter a name.')).toBeTruthy();
  expect(screen.getByText('Enter the proxy IP.')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Name'), 'dev');
  await userEvent.type(screen.getByLabelText('Proxy IP'), '10.10.48.6');
  await next();
  expect(screen.getByText('That name is reserved. Choose a different one.')).toBeTruthy();
  await userEvent.clear(screen.getByLabelText('Name'));
  await userEvent.type(screen.getByLabelText('Name'), 'qa');
  await next();
  const portal = await screen.findByLabelText('portal port');
  await userEvent.clear(portal);
  await userEvent.type(portal, '8000');
  await next();
  expect(screen.getByText("Two services can't use the same port.")).toBeTruthy();
  expect(api.createEnvironment).not.toHaveBeenCalled();
});

it('an API error goes back to the step that owns the field', async () => {
  api.createEnvironment.mockRejectedValue(new ApiError(409, 'environment_exists', { code: 'environment_exists' }));
  await open();
  await fillBasics();
  await next();
  await next();
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  expect(await screen.findByText('An environment with that name already exists.')).toBeTruthy();
  expect(screen.getByLabelText('Name')).toBeTruthy();
});

it('adopts an existing environment and lists what it imported and ignored', async () => {
  api.adoptEnvironment.mockResolvedValue({
    ...ENV, imported_secrets: ['POSTGRES_PASSWORD', 'SS_JWT_SECRET'], ignored_keys: ['MINIO_ROOT_PASSWORD'],
  });
  const { onCreated } = await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  expect(screen.queryByLabelText('Proxy IP')).toBeNull();
  expect(screen.getByText('Result')).toBeTruthy();
  expect(screen.getByText(/changes nothing/)).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
  expect(await screen.findByText('MINIO_ROOT_PASSWORD')).toBeTruthy();
  expect(screen.getByText('POSTGRES_PASSWORD')).toBeTruthy();
  expect(screen.getByText('SS_JWT_SECRET')).toBeTruthy();
  expect(api.adoptEnvironment).toHaveBeenCalledWith({ name: 'uat', type: 'dev', target: 'ssh:lab', git_ref: 'main' });
  await userEvent.click(screen.getByRole('button', { name: 'Open environment' }));
  expect(onCreated).toHaveBeenCalledWith(expect.objectContaining({ name: 'uat' }));
});

it('adopt: an unknown host key asks to trust it with the target, then adopts', async () => {
  api.adoptEnvironment
    .mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', {
      code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' }))
    .mockResolvedValueOnce({ ...ENV, imported_secrets: [], ignored_keys: [] });
  api.trustKnownHost.mockResolvedValue({});
  await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and adopt' }));
  expect(await screen.findByText('None. Sirdar knows every key in that .env.')).toBeTruthy();
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc', 'ssh:lab');
  expect(api.adoptEnvironment).toHaveBeenCalledTimes(2);
});

it('adopt: a mismatched host key explains what to do', async () => {
  api.adoptEnvironment.mockRejectedValue(new ApiError(409, 'host_key_mismatch', {
    code: 'host_key_mismatch', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', expected: 'SHA256:old', actual: 'SHA256:new' }));
  await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
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

it('adopt: trusting replays the exact failed attempt even if the form changed behind the host-key modal', async () => {
  api.getDeployTargets.mockResolvedValue(TWO_TARGETS);
  api.adoptEnvironment
    .mockRejectedValueOnce(UNKNOWN_KEY)
    .mockResolvedValueOnce({ ...ENV, imported_secrets: [], ignored_keys: [] });
  api.trustKnownHost.mockResolvedValue({});
  await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
  const trust = await screen.findByRole('button', { name: 'Trust and adopt' });
  // The form behind the host-key modal is inert while it is open.
  expect(screen.getByRole('dialog', { name: 'New environment', hidden: true }).closest('[inert]')).toBeTruthy();
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
  expect(screen.getByRole('dialog', { name: 'New environment' }).closest('[inert]')).toBeNull();
});

it('create: an unknown host key is trusted with "Trust and create" and retries the same payload', async () => {
  api.createEnvironment.mockReset();
  api.createEnvironment.mockRejectedValueOnce(UNKNOWN_KEY).mockResolvedValueOnce(ENV);
  api.trustKnownHost.mockResolvedValue({});
  const { onCreated } = await open();
  await fillBasics();
  await next();
  await next();
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and create' }));
  expect(screen.queryByRole('button', { name: 'Trust and adopt' })).toBeNull();
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(ENV));
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc', 'ssh:lab');
  expect(api.createEnvironment).toHaveBeenCalledTimes(2);
  expect(api.createEnvironment.mock.calls[1][0]).toEqual(api.createEnvironment.mock.calls[0][0]);
});

it('canceling the host-key prompt returns focus to the Name', async () => {
  api.adoptEnvironment.mockRejectedValueOnce(UNKNOWN_KEY);
  await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
  await userEvent.click(within(await screen.findByRole('dialog', { name: 'Trust this server?' })).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Trust this server?' })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
});

it('a failed adopt returns focus to the Name', async () => {
  api.adoptEnvironment.mockRejectedValueOnce(new ApiError(502, 'ssh_failed', { code: 'ssh_failed' }));
  await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  await userEvent.type(screen.getByLabelText('Name'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
  expect(await screen.findByRole('alert')).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
});

it('a create error that sends you back to Basics focuses the Name', async () => {
  api.createEnvironment.mockRejectedValue(new ApiError(409, 'environment_exists', { code: 'environment_exists' }));
  await open();
  await fillBasics();
  await next();
  await next();
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  expect(await screen.findByText('An environment with that name already exists.')).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Name')));
});

it('Data: a new environment can start from a ready snapshot', async () => {
  const { onCreated } = await open();
  await fillBasics();
  await next();
  await next();
  expect(screen.getByText(/starts an empty database/)).toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: 'From a snapshot' }));
  expect(screen.getByText(/restores the snapshot's database and files/)).toBeTruthy();
  await next();
  expect(screen.getByText('Choose a snapshot.')).toBeTruthy();
  await userEvent.click(screen.getByRole('combobox', { name: 'Snapshot' }));
  expect(screen.queryByRole('button', { name: /uat-2026-10-04/ })).toBeNull();      // still being taken
  await userEvent.click(await screen.findByRole('button', { name: 'dev-2026-10-04 · mac-dev · migration 0089 · 526.4 MB' }));
  await next();
  expect(screen.getByText('Snapshot dev-2026-10-04 (migration 0089), restored by the first deploy')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(ENV));
  expect(api.createEnvironment.mock.calls[0][0].snapshot_id).toBe('s1');
});

it('Data: with no snapshot only Start empty is offered, and a gone snapshot sends you back to Data', async () => {
  api.listSnapshots.mockResolvedValue({ snapshots: [] });
  await open();
  await fillBasics();
  await next();
  await next();
  const fromSnap = screen.getByRole('radio', { name: 'From a snapshot' });
  expect(fromSnap.getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByText(/No snapshot yet/)).toBeTruthy();
  cleanup();
  api.listSnapshots.mockResolvedValue({ snapshots: [SNAP] });
  api.createEnvironment.mockRejectedValue(new ApiError(404, 'snapshot_not_found', { code: 'snapshot_not_found' }));
  await open();
  await fillBasics();
  await next();
  await next();
  await userEvent.click(screen.getByRole('radio', { name: 'From a snapshot' }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Snapshot' }));
  await userEvent.click(await screen.findByRole('button', { name: /^dev-2026-10-04/ }));
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  expect(await screen.findByText('That snapshot no longer exists.')).toBeTruthy();
  expect(screen.getByRole('combobox', { name: 'Snapshot' })).toBeTruthy();
});
