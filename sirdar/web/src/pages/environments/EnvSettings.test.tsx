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
import { DEFAULTS, DO_ENV, ENV, ESXI_ENV, ESXI_TARGETS, LAN_ENV, PX_ENV, PX_NEW_ENV, PX_TARGETS, TARGETS } from './testData';

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
  needs_password: false,
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

it('Blue/Green: the target names its three VMs, sizes are not editable, and Delete names the VMs', () => {
  render(<EnvSettings env={LAN_ENV} targets={ESXI_TARGETS.targets} onSaved={vi.fn()} onDeleteStarted={vi.fn()} />);
  expect((screen.getByLabelText('Target') as HTMLInputElement).value)
    .toBe('ESXi · Blue/Green (ss-lan9-data, ss-lan9-orange, ss-lan9-purple)');
  expect(screen.queryByLabelText('vCPUs')).toBeNull();
  expect(screen.queryByLabelText('VM snapshots to keep')).toBeNull();
  const del = screen.getByText(/destroys its three VMs on ESXi/);
  expect(del.textContent).toContain('ss-lan9-data, ss-lan9-orange and ss-lan9-purple');
  expect(del.textContent).not.toMatch(/VM snapshots/);
});

it('the SMTP password is labeled and shown only when mail goes through SMTP', async () => {
  open();
  expect(screen.queryByText(/SS_SMTP_PASSWORD|SMTP password/)).toBeNull();
  cleanup();
  open({ ...ENV, mail: { ...ENV.mail, mode: 'smtp', host: 'smtp.example.com', port: 587, from_address: 'ops@example.com' },
         secrets_set: { ...ENV.secrets_set, SS_SMTP_PASSWORD: true } });
  expect(secret('SMTP password: set')).toBeTruthy();
  expect(screen.queryByText(/SS_SMTP_PASSWORD/)).toBeNull();
});

it('the bare name follows the portal: no row to edit, and it never trips the port check', async () => {
  const { onSaved } = open();
  expect(screen.queryByLabelText('home port')).toBeNull();
  await userEvent.clear(screen.getByLabelText('api port'));
  await userEvent.type(screen.getByLabelText('api port'), '8100');
  await save();
  await waitFor(() => expect(onSaved).toHaveBeenCalled());
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { services: { api: { port: 8100 } } });
});

it('Apps & mail: turning the wiki off turns learning off, and both are saved', async () => {
  open({ ...ENV, apps: ['wiki', 'kiosk', 'learn', 'status', 'mailpit'] });
  await userEvent.click(screen.getByLabelText('Wiki'));
  expect((screen.getByLabelText('Learning') as HTMLInputElement).checked).toBe(false);
  await save();
  await waitFor(() => expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { apps: ['kiosk', 'status', 'mailpit'] }));
  expect(screen.getByText('Saved. The next deploy applies these settings.')).toBeTruthy();
});

it('Apps & mail: SMTP is checked first and sent without a password', async () => {
  open();
  await userEvent.click(screen.getByRole('radio', { name: 'SMTP' }));
  expect(screen.queryByLabelText('SMTP password')).toBeNull();
  await save();
  expect(screen.getByText("Enter the SMTP server's host name or address.")).toBeTruthy();
  expect(api.updateEnvironment).not.toHaveBeenCalled();
  await userEvent.type(screen.getByLabelText('SMTP host'), 'smtp.example.com');
  await userEvent.type(screen.getByLabelText('From address'), 'ops@example.com');
  await save();
  await waitFor(() => expect(api.updateEnvironment).toHaveBeenCalledWith('uat', {
    mail: { mode: 'smtp', host: 'smtp.example.com', port: 587, from_address: 'ops@example.com', starttls: true } }));
});

it('Apps & mail: the kiosk signing digests are saved normalized', async () => {
  open();
  await userEvent.type(screen.getByLabelText('Kiosk signing digests'), 'AB:'.repeat(31) + 'AB');
  await save();
  await waitFor(() => expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { kiosk_signing_digests: ['ab'.repeat(32)] }));
});

it('Apps & mail: an API refusal lands on its field', async () => {
  api.updateEnvironment.mockRejectedValueOnce(new ApiError(422, 'learn_needs_wiki', { code: 'learn_needs_wiki' }));
  open();
  await userEvent.click(screen.getByLabelText('Status page'));
  await save();
  expect(await screen.findByText('The learning site needs the wiki: turn the wiki on, or turn learning off.')).toBeTruthy();
});

it('Apps & mail is locked while a deployment runs', () => {
  open({ ...ENV, status: 'deploying' });
  expect((screen.getByLabelText('Kiosk') as HTMLInputElement).disabled).toBe(true);
  expect((screen.getByLabelText('Kiosk signing digests') as HTMLTextAreaElement).disabled).toBe(true);
});

it('Apps & mail: a new SMTP host or user without a new password says the saved one is cleared', async () => {
  const HINT = 'Changing the server or user clears the saved password; enter it again.';
  api.getEnvironmentDefaults.mockResolvedValue({ ...DEFAULTS, optional_secrets: [...DEFAULTS.optional_secrets, 'SS_SMTP_PASSWORD'] });
  open({ ...ENV, mail: { ...ENV.mail, mode: 'smtp', host: 'smtp.example.com', port: 587, from_address: 'ops@example.com', password_set: true },
         secrets_set: { ...ENV.secrets_set, SS_SMTP_PASSWORD: true } });
  expect(screen.queryByText(HINT)).toBeNull();
  await userEvent.type(screen.getByLabelText('User name'), 'ops');
  expect(screen.getByText(HINT)).toBeTruthy();
  await userEvent.clear(screen.getByLabelText('User name'));
  expect(screen.queryByText(HINT)).toBeNull();
  await userEvent.type(screen.getByLabelText('SMTP host'), 'x');
  expect(screen.getByText(HINT)).toBeTruthy();
  await userEvent.click(await within(secret('SMTP password: set')).findByRole('button', { name: 'Replace' }));
  await userEvent.type(screen.getByLabelText('SMTP password'), 'new-pass');
  expect(screen.queryByText(HINT)).toBeNull();
});

it('Apps & mail: a digest error describes the digests field', async () => {
  open();
  await userEvent.type(screen.getByLabelText('Kiosk signing digests'), 'nope');
  await save();
  const box = screen.getByLabelText('Kiosk signing digests');
  expect(box.getAttribute('aria-invalid')).toBe('true');
  const err = screen.getByText('Each digest is a SHA-256: 64 hex characters, colons allowed.');
  expect(err.id).toBe('env-set-digests-error');
  expect(box.getAttribute('aria-describedby')?.split(' ')).toContain('env-set-digests-error');
  expect(api.updateEnvironment).not.toHaveBeenCalled();
});

const SMTP_ENV = {
  ...ENV, mail: { ...ENV.mail, mode: 'smtp' as const, host: 'smtp.example.com', port: 587, from_address: 'ops@example.com', password_set: true },
  secrets_set: { ...ENV.secrets_set, SS_SMTP_PASSWORD: true },
};

it('Apps & mail: switching a saved SMTP environment to Mailpit hides the SMTP password and never sends it', async () => {
  const NOTE = 'Switching to Mailpit clears the saved SMTP password.';
  api.getEnvironmentDefaults.mockResolvedValue({ ...DEFAULTS, optional_secrets: [...DEFAULTS.optional_secrets, 'SS_SMTP_PASSWORD'] });
  open(SMTP_ENV);
  expect(screen.queryByText(NOTE)).toBeNull();
  await userEvent.click(await within(secret('SMTP password: set')).findByRole('button', { name: 'Replace' }));
  await userEvent.type(screen.getByLabelText('SMTP password'), 'typed-pass');
  await userEvent.click(screen.getByRole('radio', { name: 'Mailpit' }));
  expect(screen.queryByText(/SMTP password: set/)).toBeNull();
  expect(screen.queryByLabelText('SMTP password')).toBeNull();
  expect(screen.getByText(NOTE)).toBeTruthy();
  await save();
  await waitFor(() => expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { mail: { mode: 'mailpit' } }));
});

it('Apps & mail: a refused SMTP password lands on its row', async () => {
  api.getEnvironmentDefaults.mockResolvedValue({ ...DEFAULTS, optional_secrets: [...DEFAULTS.optional_secrets, 'SS_SMTP_PASSWORD'] });
  api.updateEnvironment.mockRejectedValueOnce(new ApiError(422, 'smtp_password_without_smtp', { code: 'smtp_password_without_smtp' }));
  open(SMTP_ENV);
  await userEvent.click(await within(secret('SMTP password: set')).findByRole('button', { name: 'Replace' }));
  await userEvent.type(screen.getByLabelText('SMTP password'), 'typed-pass');
  await save();
  await waitFor(() => expect(api.updateEnvironment).toHaveBeenCalled());
  const row = screen.getByLabelText('SMTP password').closest('.sirdar-secret') as HTMLElement;
  expect(within(row).getByRole('alert')).toBeTruthy();
});

it('Apps & mail: apps stored in another order are not a change', async () => {
  open({ ...ENV, apps: ['mailpit', 'status', 'kiosk', 'wiki'] });
  await save();
  expect(screen.getByText('Nothing to save.')).toBeTruthy();
  expect(api.updateEnvironment).not.toHaveBeenCalled();
});

it('Apps & mail: a host that differs only in case keeps the saved password (the API compares lowercased)', async () => {
  const HINT = 'Changing the server or user clears the saved password; enter it again.';
  api.getEnvironmentDefaults.mockResolvedValue({ ...DEFAULTS, optional_secrets: [...DEFAULTS.optional_secrets, 'SS_SMTP_PASSWORD'] });
  open(SMTP_ENV);
  await userEvent.clear(screen.getByLabelText('SMTP host'));
  await userEvent.type(screen.getByLabelText('SMTP host'), 'SMTP.Example.COM');
  expect(screen.queryByText(HINT)).toBeNull();
  await userEvent.type(screen.getByLabelText('SMTP host'), 'x');
  expect(screen.getByText(HINT)).toBeTruthy();
});

it('Apps & mail: digests typed before the kiosk goes off never block Save and stay as stored', async () => {
  open({ ...ENV, kiosk_signing_digests: ['ab'.repeat(32)] });
  await userEvent.type(screen.getByLabelText('Kiosk signing digests'), '\nnope');
  await userEvent.click(screen.getByLabelText('Kiosk'));
  expect(screen.queryByLabelText('Kiosk signing digests')).toBeNull();
  await save();
  await waitFor(() => expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { apps: ['wiki', 'status', 'mailpit'] }));
});

it('Apps & mail: Mailpit to SMTP sets the SMTP password in the same save', async () => {
  api.getEnvironmentDefaults.mockResolvedValue({ ...DEFAULTS, optional_secrets: [...DEFAULTS.optional_secrets, 'SS_SMTP_PASSWORD'] });
  open();
  expect(screen.queryByText(/SMTP password/)).toBeNull();
  await userEvent.click(screen.getByRole('radio', { name: 'SMTP' }));
  await userEvent.type(screen.getByLabelText('SMTP host'), 'smtp.example.com');
  await userEvent.type(screen.getByLabelText('From address'), 'ops@example.com');
  await userEvent.click(await within(secret('SMTP password: not set')).findByRole('button', { name: 'Add' }));
  await userEvent.type(screen.getByLabelText('SMTP password'), 'new-pass');
  await save();
  await waitFor(() => expect(api.updateEnvironment).toHaveBeenCalledWith('uat', {
    mail: { mode: 'smtp', host: 'smtp.example.com', port: 587, from_address: 'ops@example.com', starttls: true },
    secrets: { SS_SMTP_PASSWORD: 'new-pass' } }));
});
