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
  adoptEnvironment: vi.fn(), trustKnownHost: vi.fn(), listSnapshots: vi.fn(), getIntegrations: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import NewEnvironmentModal from './NewEnvironmentModal';
import {
  DEFAULTS, ENV, INTEGRATIONS, NO_INTEGRATIONS, PX_NEW_ENV, PX_TARGETS, SNAP, SNAP_TAKING, TARGETS,
} from './testData';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getDeployTargets.mockResolvedValue(TARGETS);
  api.getEnvironmentDefaults.mockResolvedValue(DEFAULTS);
  api.createEnvironment.mockResolvedValue(ENV);
  api.listSnapshots.mockResolvedValue({ snapshots: [SNAP, SNAP_TAKING] });
  api.getIntegrations.mockResolvedValue(INTEGRATIONS);
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
    publish: true,
  });
});

it('Services offers Publish (on by default); Off is shown in Review and sent', async () => {
  await open();
  await fillBasics();
  await next();
  const group = await screen.findByRole('radiogroup', { name: 'Publish DNS and proxy' });
  expect(within(group).getByRole('radio', { name: 'On' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText(/Each deploy creates or updates a DNS record and a proxy host/)).toBeTruthy();
  expect(screen.getByText(/Hand-made records or proxy hosts already at those names must be claimed on the Publish tab/))
    .toBeTruthy();
  expect(screen.queryByText(/to publish\.$/)).toBeNull();
  expect(api.getIntegrations).toHaveBeenCalledTimes(1);
  await userEvent.click(within(group).getByRole('radio', { name: 'Off' }));
  expect(screen.getByText(/DNS records and proxy hosts stay as they are/)).toBeTruthy();
  await next();
  await next();
  expect(screen.getByText('Off: DNS and the proxy are set up by hand')).toBeTruthy();
  const table = screen.getByRole('table', { name: 'Services to create' });
  expect(within(table).queryByText('On the first deploy')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  await waitFor(() => expect(api.createEnvironment).toHaveBeenCalled());
  expect(api.createEnvironment.mock.calls[0][0].publish).toBe(false);
});

it('without both integrations set up, Publish starts Off and says where to set them up', async () => {
  for (const current of [NO_INTEGRATIONS, { ...INTEGRATIONS, npm: NO_INTEGRATIONS.npm }]) {
    api.getIntegrations.mockResolvedValue(current);
    api.createEnvironment.mockClear();
    await open();
    await fillBasics();
    await next();
    const group = await screen.findByRole('radiogroup', { name: 'Publish DNS and proxy' });
    await waitFor(() => expect(within(group).getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true'));
    expect(screen.getByText('Set up Cloudflare and Nginx Proxy Manager in Settings › Integrations to publish.'))
      .toBeTruthy();
    await next();
    await next();
    await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
    await waitFor(() => expect(api.createEnvironment).toHaveBeenCalled());
    expect(api.createEnvironment.mock.calls[0][0].publish).toBe(false);
    cleanup();
  }
});

it('a choice made before the integrations load is kept', async () => {
  let release: (v: typeof NO_INTEGRATIONS) => void = () => {};
  api.getIntegrations.mockImplementation(() => new Promise((r) => { release = r; }));
  await open();
  await fillBasics();
  await next();
  const group = await screen.findByRole('radiogroup', { name: 'Publish DNS and proxy' });
  await userEvent.click(within(group).getByRole('radio', { name: 'Off' }));
  await userEvent.click(within(group).getByRole('radio', { name: 'On' }));
  release(NO_INTEGRATIONS);
  expect(await screen.findByText('Set up Cloudflare and Nginx Proxy Manager in Settings › Integrations to publish.'))
    .toBeTruthy();
  expect(within(group).getByRole('radio', { name: 'On' }).getAttribute('aria-checked')).toBe('true');
});

it('with Publish on, Review lists the names it publishes', async () => {
  await open();
  await fillBasics();
  await next();
  await next();
  await next();
  expect(screen.getByText('On: Sirdar publishes the public names')).toBeTruthy();
  const table = screen.getByRole('table', { name: 'Services to create' });
  expect(within(table).getAllByText('On the first deploy')).toHaveLength(6);
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
  // The gone snapshot is cleared and no longer offered.
  await userEvent.click(screen.getByRole('combobox', { name: 'Snapshot' }));
  expect(screen.queryByRole('button', { name: /^dev-2026-10-04/ })).toBeNull();
  await next();
  expect(screen.getByText('Choose a snapshot.')).toBeTruthy();
});

it('Data: picking a snapshot, going Back and choosing Start empty creates an empty environment', async () => {
  const { onCreated } = await open();
  await fillBasics();
  await next();
  await next();
  await userEvent.click(screen.getByRole('radio', { name: 'From a snapshot' }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Snapshot' }));
  await userEvent.click(await screen.findByRole('button', { name: /^dev-2026-10-04/ }));
  await next();
  expect(screen.getByText(/^Snapshot dev-2026-10-04/)).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  await userEvent.click(screen.getByRole('radio', { name: 'Start empty' }));
  await next();
  expect(screen.getByText('Empty')).toBeTruthy();
  expect(screen.queryByText(/^Snapshot dev-2026-10-04/)).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(ENV));
  expect('snapshot_id' in api.createEnvironment.mock.calls[0][0]).toBe(false);
});

it('Adopt has no Data step and never sends a snapshot_id, even after one was picked in Create', async () => {
  api.adoptEnvironment.mockResolvedValue({ ...ENV, imported_secrets: [], ignored_keys: [] });
  await open();
  await fillBasics('uat');
  await next();
  await next();
  await userEvent.click(screen.getByRole('radio', { name: 'From a snapshot' }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Snapshot' }));
  await userEvent.click(await screen.findByRole('button', { name: /^dev-2026-10-04/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  await userEvent.click(screen.getByRole('button', { name: 'Back' }));
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  expect(screen.queryByText('Data')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Adopt' }));
  await waitFor(() => expect(api.adoptEnvironment).toHaveBeenCalledTimes(1));
  expect('snapshot_id' in api.adoptEnvironment.mock.calls[0][0]).toBe(false);
});

async function pickProxmox() {
  await userEvent.click(screen.getByRole('combobox', { name: 'Target' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Proxmox' }));
}

it('Proxmox: a Machine step sizes the VM and sets its address; Review and the request carry it', async () => {
  api.getDeployTargets.mockResolvedValue(PX_TARGETS);
  api.createEnvironment.mockResolvedValue(PX_NEW_ENV);
  const { onCreated } = await open();
  await fillBasics('uat3');
  await pickProxmox();
  await next();
  expect(['Basics', 'Machine', 'Services', 'Data', 'Review'].every((s) => screen.getByText(s))).toBe(true);
  expect(screen.getByText(/into a VM named ss-uat3/)).toBeTruthy();
  expect((screen.getByLabelText('vCPUs') as HTMLInputElement).value).toBe('4');
  expect((screen.getByLabelText('Memory (GB)') as HTMLInputElement).value).toBe('8');
  expect((screen.getByLabelText('Disk (GB)') as HTMLInputElement).value).toBe('64');
  expect(screen.getByRole('radio', { name: 'Static' }).getAttribute('aria-checked')).toBe('true');
  await next();
  expect(screen.getByText('Enter the address with its prefix, like 10.10.48.70/24.')).toBeTruthy();
  await userEvent.type(screen.getByLabelText('Address'), '10.10.48.70/24');
  await userEvent.type(screen.getByLabelText('Gateway'), '10.10.48.1');
  const cores = screen.getByLabelText('vCPUs');
  await userEvent.clear(cores);
  await userEvent.type(cores, '2');
  await next();
  expect(within(screen.getByRole('table', { name: 'Services' })).getAllByText("The VM's address")).toHaveLength(7);
  await next();
  await next();
  expect(screen.getByText('2 vCPU · 8 GB · 64 GB disk · 10.10.48.70/24 via 10.10.48.1')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  await waitFor(() => expect(onCreated).toHaveBeenCalledWith(PX_NEW_ENV));
  expect(api.createEnvironment.mock.calls[0][0]).toMatchObject({
    name: 'uat3', target: 'proxmox',
    vm: { cores: 2, memory_mb: 8192, disk_gb: 64, ip_mode: 'static', ip_cidr: '10.10.48.70/24', gateway: '10.10.48.1' },
  });
});

it('Proxmox: DHCP needs no address; sizes are checked against the limits', async () => {
  api.getDeployTargets.mockResolvedValue(PX_TARGETS);
  await open();
  await fillBasics('uat3');
  await pickProxmox();
  await next();
  await userEvent.click(screen.getByRole('radio', { name: 'DHCP' }));
  expect(screen.queryByLabelText('Address')).toBeNull();
  const memory = screen.getByLabelText('Memory (GB)');
  await userEvent.clear(memory);
  await userEvent.type(memory, '1');
  await next();
  expect(screen.getByText('Use 2 to 256 GB of memory.')).toBeTruthy();
  await userEvent.clear(memory);
  await userEvent.type(memory, '4');
  await next();
  expect(screen.getByRole('table', { name: 'Services' })).toBeTruthy();
});

it('Proxmox: an address in use sends you back to Machine', async () => {
  api.getDeployTargets.mockResolvedValue(PX_TARGETS);
  api.createEnvironment.mockRejectedValue(new ApiError(409, 'ip_in_use', { code: 'ip_in_use' }));
  await open();
  await fillBasics('uat3');
  await pickProxmox();
  await next();
  await userEvent.type(screen.getByLabelText('Address'), '10.10.48.63/24');
  await userEvent.type(screen.getByLabelText('Gateway'), '10.10.48.1');
  await next();
  await next();
  await next();
  await userEvent.click(screen.getByRole('button', { name: 'Create environment' }));
  expect(await screen.findByText(/That address is already used/)).toBeTruthy();
  expect(screen.getByLabelText('Address')).toBeTruthy();
});

it('Adopt offers SSH targets only', async () => {
  api.getDeployTargets.mockResolvedValue(PX_TARGETS);
  await open();
  await userEvent.click(screen.getByRole('radio', { name: 'Adopt existing' }));
  await userEvent.click(screen.getByRole('combobox', { name: 'Target' }));
  expect(screen.queryByRole('button', { name: 'Proxmox' })).toBeNull();
});
