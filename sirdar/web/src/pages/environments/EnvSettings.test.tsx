// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'add' ? perms.add : a !== 'change' || perms.change),
  }),
}));
const api = vi.hoisted(() => ({ updateEnvironment: vi.fn(), getEnvironmentDefaults: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import EnvSettings from './EnvSettings';
import { DEFAULTS, DO_ENV, ENV, ESXI_ENV, ESXI_TARGETS, PX_ENV, PX_NEW_ENV, PX_TARGETS, TARGETS } from './testData';

Element.prototype.scrollIntoView = () => {};
beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getEnvironmentDefaults.mockResolvedValue(DEFAULTS);
  // The saved record: plain fields applied (services / secrets keep the fixture's shape).
  api.updateEnvironment.mockImplementation(async (_name: string, { services: _s, secrets: _x, ...patch }: Record<string, unknown>) => ({ ...ENV, ...patch }));
});
afterEach(cleanup);

function open(env = ENV) {
  const onSaved = vi.fn();
  render(<EnvSettings env={env} targets={TARGETS.targets} onSaved={onSaved} />);
  return { onSaved };
}
const save = () => userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
const secret = (text: string) => screen.getByText(text).closest('.sirdar-secret') as HTMLElement;

it('saves only what changed, a replaced secret included', async () => {
  const { onSaved } = open();
  expect((screen.getByLabelText('Proxy IP') as HTMLInputElement).value).toBe('10.10.48.6');
  await userEvent.clear(screen.getByLabelText('Proxy IP'));
  await userEvent.type(screen.getByLabelText('Proxy IP'), '10.10.48.7');
  await userEvent.clear(screen.getByLabelText('api port'));
  await userEvent.type(screen.getByLabelText('api port'), '8100');
  await userEvent.click(within(secret('Anthropic API key: set')).getByRole('button', { name: 'Replace' }));
  await userEvent.type(screen.getByLabelText('Anthropic API key'), 'sk-new-1');
  await save();
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat', {
    proxy_ip: '10.10.48.7', services: { api: { port: 8100 } }, secrets: { SS_ANTHROPIC_API_KEY: 'sk-new-1' },
  });
  expect(screen.getByText('Saved. The next deploy applies these settings.')).toBeTruthy();
});

it('Clear sends an empty secret; nothing changed saves nothing', async () => {
  open();
  await save();
  expect(screen.getByText('Nothing to save.')).toBeTruthy();
  expect(api.updateEnvironment).not.toHaveBeenCalled();
  await userEvent.click(within(secret('Anthropic API key: set')).getByRole('button', { name: 'Clear' }));
  await save();
  await waitFor(() => expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { secrets: { SS_ANTHROPIC_API_KEY: '' } }));
});

it('checks the fields before saving', async () => {
  open();
  await userEvent.clear(screen.getByLabelText('Bind IP'));
  await userEvent.type(screen.getByLabelText('Bind IP'), '1.2.3');
  await userEvent.clear(screen.getByLabelText('Dumps to keep'));
  await userEvent.type(screen.getByLabelText('Dumps to keep'), '0');
  await userEvent.click(within(secret('Database testing password: not set')).getByRole('button', { name: 'Add' }));
  await userEvent.type(screen.getByLabelText('Database testing password'), 'has space');
  await save();
  expect(screen.getByText('The bind IP must be an IPv4 address.')).toBeTruthy();
  expect(screen.getByText('Keep 1 to 100 dumps.')).toBeTruthy();
  expect(screen.getByText(/no spaces or quotes/)).toBeTruthy();
  expect(api.updateEnvironment).not.toHaveBeenCalled();
});

it('API errors show next to their field or under the form', async () => {
  api.updateEnvironment.mockRejectedValueOnce(new ApiError(422, 'secret_invalid', { code: 'secret_invalid', key: 'SS_ANTHROPIC_API_KEY' }));
  open();
  await userEvent.click(within(secret('Anthropic API key: set')).getByRole('button', { name: 'Replace' }));
  await userEvent.type(screen.getByLabelText('Anthropic API key'), 'abc');
  await save();
  expect(await within(secret('Anthropic API key')).findByText(/can't be saved/)).toBeTruthy();
  api.updateEnvironment.mockRejectedValueOnce(new ApiError(409, 'deploy_in_progress', { code: 'deploy_in_progress' }));
  await save();
  expect(await screen.findByText('A deployment of this environment is already running.')).toBeTruthy();
});

it('a view-only reader sees disabled fields and no Save', () => {
  perms.change = false;
  open();
  expect(screen.getByText('You can view these settings but not change them.')).toBeTruthy();
  expect((screen.getByLabelText('Proxy IP') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('api port') as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
});

it("settings can't be saved while a deployment runs", () => {
  open({ ...ENV, status: 'deploying' });
  expect(screen.getByText("Settings can't change while a deployment is running.")).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Save settings' }) as HTMLButtonElement).disabled).toBe(true);
});

it('a reloaded environment (new updated_at) keeps unsaved edits and typed secrets', async () => {
  const { rerender } = render(<EnvSettings env={ENV} targets={TARGETS.targets} onSaved={vi.fn()} />);
  await userEvent.clear(screen.getByLabelText('Proxy IP'));
  await userEvent.type(screen.getByLabelText('Proxy IP'), '10.10.48.7');
  await userEvent.click(within(secret('Anthropic API key: set')).getByRole('button', { name: 'Replace' }));
  await userEvent.type(screen.getByLabelText('Anthropic API key'), 'sk-typed');
  rerender(<EnvSettings env={{ ...ENV, updated_at: '2026-10-03T14:00:00Z' }} targets={TARGETS.targets} onSaved={vi.fn()} />);
  expect((screen.getByLabelText('Proxy IP') as HTMLInputElement).value).toBe('10.10.48.7');
  expect((screen.getByLabelText('Anthropic API key') as HTMLInputElement).value).toBe('sk-typed');
});

it('after a successful save the form shows the saved values', async () => {
  // The server normalizes the address; the form shows what it stored.
  api.updateEnvironment.mockResolvedValue({ ...ENV, proxy_ip: '10.10.48.8', updated_at: '2026-10-03T14:00:00Z' });
  function Host() {
    const [env, setEnv] = useState(ENV);
    return <EnvSettings env={env} targets={TARGETS.targets} onSaved={setEnv} />;
  }
  render(<Host />);
  await userEvent.clear(screen.getByLabelText('Proxy IP'));
  await userEvent.type(screen.getByLabelText('Proxy IP'), '10.10.48.7');
  await save();
  await screen.findByText('Saved. The next deploy applies these settings.');
  expect((screen.getByLabelText('Proxy IP') as HTMLInputElement).value).toBe('10.10.48.8');
});

it('the fields are disabled while a deployment runs, not just Save', () => {
  open({ ...ENV, status: 'deploying' });
  expect((screen.getByLabelText('Proxy IP') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('Default git ref') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('api port') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('api address') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByRole('combobox', { name: 'Target' }) as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByRole('button', { name: 'Replace' })).toBeNull();
});

it('Delete environment needs deploy:add and deploy:change, and says backups go too', () => {
  render(<EnvSettings env={ENV} targets={TARGETS.targets} onSaved={vi.fn()} onDeleteStarted={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Delete environment…' })).toBeTruthy();
  expect(screen.getByText(/deletes its data, backups and folder on the host/)).toBeTruthy();
  cleanup();
  perms.add = false;
  render(<EnvSettings env={ENV} targets={TARGETS.targets} onSaved={vi.fn()} onDeleteStarted={vi.fn()} />);
  expect(screen.getByRole('button', { name: 'Save settings' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Delete environment…' })).toBeNull();
});

it('Proxmox: the target and the addresses are the VM\'s; Machine saves only what changed', async () => {
  const onSaved = vi.fn();
  render(<EnvSettings env={PX_ENV} targets={PX_TARGETS.targets} onSaved={onSaved} onDeleteStarted={vi.fn()} />);
  expect((screen.getByLabelText('Target') as HTMLInputElement).value).toBe('Proxmox · ss-uat3');
  expect((screen.getByLabelText('Target') as HTMLInputElement).disabled).toBe(true);
  expect(screen.queryByLabelText('api address')).toBeNull();
  expect(within(screen.getByRole('table', { name: 'Service addresses' })).getAllByText('10.10.48.70')).toHaveLength(7);
  expect((screen.getByLabelText('vCPUs') as HTMLInputElement).value).toBe('4');
  const disk = screen.getByLabelText('Disk (GB)');
  await userEvent.clear(disk);
  await userEvent.type(disk, '32');
  await save();
  expect(screen.getByText('A disk can grow but never shrink.')).toBeTruthy();
  await userEvent.clear(disk);
  await userEvent.type(disk, '64');
  await userEvent.clear(screen.getByLabelText('vCPUs'));
  await userEvent.type(screen.getByLabelText('vCPUs'), '8');
  await userEvent.clear(screen.getByLabelText('Memory (GB)'));
  await userEvent.type(screen.getByLabelText('Memory (GB)'), '16');
  await save();
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat3', { vm: { cores: 8, memory_mb: 16384 } });
  expect(screen.getByText(/Destroys its VM on Proxmox/)).toBeTruthy();
});

it('Proxmox: the Machine limits and their messages come from the environment defaults', async () => {
  api.getEnvironmentDefaults.mockResolvedValue({
    ...DEFAULTS,
    vm: { ...DEFAULTS.vm, limits: { cores: [2, 16], memory_mb: [4096, 65536], disk_gb: [32, 512], keep_snapshots: [1, 5] } },
  });
  render(<EnvSettings env={PX_ENV} targets={PX_TARGETS.targets} onSaved={vi.fn()} />);
  await waitFor(() => expect(api.getEnvironmentDefaults).toHaveBeenCalled());
  const field = async (label: string, value: string) => {
    await userEvent.clear(screen.getByLabelText(label));
    await userEvent.type(screen.getByLabelText(label), value);
  };
  await field('vCPUs', '32');
  await save();
  expect(screen.getByText('Use 2 to 16 vCPUs.')).toBeTruthy();
  await field('vCPUs', '4');
  await field('Memory (GB)', '128');
  await save();
  expect(screen.getByText('Use 4 to 64 GB of memory.')).toBeTruthy();
  await field('Memory (GB)', '8');
  await field('Disk (GB)', '1024');
  await save();
  expect(screen.getByText('Use a disk of 32 to 512 GB.')).toBeTruthy();
  await field('Disk (GB)', '64');
  await field('VM snapshots to keep', '8');
  await save();
  expect(screen.getByText('Keep 1 to 5 VM snapshots.')).toBeTruthy();
  expect(api.updateEnvironment).not.toHaveBeenCalled();
});

it('Proxmox before its first deploy: the danger zone says nothing on Proxmox is removed', () => {
  render(<EnvSettings env={PX_NEW_ENV} targets={PX_TARGETS.targets} onSaved={vi.fn()} onDeleteStarted={vi.fn()} />);
  expect(screen.getByText(/No VM was created yet; nothing on Proxmox is removed\./)).toBeTruthy();
  expect(screen.queryByText(/Destroys its VM/)).toBeNull();
});

it('Proxmox with a partly built VM: the danger zone says the partly built VM is removed', () => {
  const env = { ...PX_NEW_ENV, vm: { ...PX_NEW_ENV.vm!, vmid: 120, created: false, stage: 'partial' as const } };
  render(<EnvSettings env={env} targets={PX_TARGETS.targets} onSaved={vi.fn()} onDeleteStarted={vi.fn()} />);
  expect(screen.getByText(/Removes the partly built VM ss-uat3 \(VM 120\) if Proxmox has it\./)).toBeTruthy();
  expect(screen.queryByText(/nothing on Proxmox is removed/)).toBeNull();
});

it('ESXi: the target, the Machine hint, the disk-grow warning and the danger zone name ESXi', async () => {
  render(<EnvSettings env={ESXI_ENV} targets={ESXI_TARGETS.targets} onSaved={vi.fn()} onDeleteStarted={vi.fn()} />);
  expect((screen.getByLabelText('Target') as HTMLInputElement).value).toBe('ESXi · ss-uat3');
  expect(screen.getByText(
    "The next deploy's step 0 resizes the VM: ESXi shuts it down and starts it again to change its vCPUs, memory or "
    + 'disk. A disk can grow but never shrink.',
  )).toBeTruthy();
  const warning = /ESXi can't grow a disk that has snapshots: the next deploy deletes this environment's VM snapshots first, then takes a new one\./;
  expect(screen.queryByText(warning)).toBeNull();
  const disk = screen.getByLabelText('Disk (GB)');
  await userEvent.clear(disk);
  await userEvent.type(disk, '80');
  expect(screen.getByText(warning)).toBeTruthy();
  await userEvent.clear(disk);
  await userEvent.type(disk, '64');
  expect(screen.queryByText(warning)).toBeNull();
  expect(screen.getByText(/Destroys its VM on ESXi with everything on it, VM snapshots included, /)).toBeTruthy();
});

it('Proxmox: the Machine hint is unchanged and a bigger disk shows no ESXi warning', async () => {
  render(<EnvSettings env={PX_ENV} targets={PX_TARGETS.targets} onSaved={vi.fn()} onDeleteStarted={vi.fn()} />);
  expect(screen.getByText(
    "The next deploy's step 0 resizes the VM (Proxmox restarts it when it must). A disk can grow but never shrink.",
  )).toBeTruthy();
  const disk = screen.getByLabelText('Disk (GB)');
  await userEvent.clear(disk);
  await userEvent.type(disk, '80');
  expect(screen.queryByText(/can't grow a disk that has snapshots/)).toBeNull();
  expect(screen.getByText(/Destroys its VM on Proxmox with everything on it, VM snapshots included, /)).toBeTruthy();
});

it("DigitalOcean: what Sirdar built can't change here; the DigitalOcean section can", () => {
  open(DO_ENV);
  for (const label of ['Target', 'Proxy IP', 'Bind IP', 'Base domain', 'Spaces bucket']) {
    expect(screen.queryByLabelText(label)).toBeNull();
  }
  expect(screen.getByRole('region', { name: 'DigitalOcean' })).toBeTruthy();
});

const FIRST_ADMIN = {
  first_name: 'Ada', last_name: 'Lovelace', email: 'ada@example.com', password_mode: 'typed' as const, done: false,
};

it('the First admin card shows only while a first admin is still to be created', () => {
  open({ ...ENV, first_admin: FIRST_ADMIN });
  const card = screen.getByRole('group', { name: 'First admin' });
  expect(within(card).getByText('Ada Lovelace')).toBeTruthy();
  expect(within(card).getByRole('button', { name: 'Change…' })).toBeTruthy();
  cleanup();
  open({ ...ENV, first_admin: { ...FIRST_ADMIN, done: true } });
  expect(screen.queryByRole('group', { name: 'First admin' })).toBeNull();
  cleanup();
  open({ ...ENV, first_admin: null });
  expect(screen.queryByRole('group', { name: 'First admin' })).toBeNull();
});
