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
import { DO_ENV, ENV, ESXI_ENV, LAN_ENV, ESXI_NEW_ENV, ESXI_VM, PUBLISHED_ENV, PX_ENV, PROD_ENV, PX_NEW_ENV, TEARDOWN } from './testData';

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
  return { onStarted, onClose, dialog: screen.getByRole('dialog', { name: `Delete ${env.name}` }) };
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
  expect(screen.getByText(/Removes the partly built VM ss-uat3 \(VM 120\) if Proxmox has it\./)).toBeTruthy();
  expect(screen.queryByText(/nothing on Proxmox is removed/)).toBeNull();
  expect(screen.queryByText(/Destroys the VM/)).toBeNull();
});

it('an ESXi environment names ESXi: built, never created, and partly built', () => {
  render(<DeleteEnvironmentModal env={ESXI_ENV} onStarted={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByText(
    /Destroys the VM ss-uat3 \(VM 12\) on ESXi with everything on it: the database, files, backups and VM snapshots/,
  )).toBeTruthy();
  cleanup();
  render(<DeleteEnvironmentModal env={ESXI_NEW_ENV} onStarted={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByText(/No VM was created yet; nothing on ESXi is removed\./)).toBeTruthy();
  expect(screen.queryByText(/Destroys the VM/)).toBeNull();
  cleanup();
  render(<DeleteEnvironmentModal env={{ ...ESXI_ENV, vm: { ...ESXI_VM, stage: 'partial', created: false } }}
                                 onStarted={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByText(/Removes the partly built VM ss-uat3 \(VM 12\) if ESXi has it\./)).toBeTruthy();
  expect(screen.queryByText(/Destroys the VM/)).toBeNull();
});

it('DigitalOcean: lists what goes there and saves a snapshot first unless unticked', async () => {
  const { dialog } = show(DO_ENV);
  const removes = within(dialog).getByRole('list', { name: 'Sirdar removes' });
  expect(within(removes).getAllByRole('listitem').map((li) => li.textContent)).toEqual(
    expect.arrayContaining(['VPC ss-uat9', 'Droplet ss-uat9-orange', 'Database ss-uat9-db', 'Load balancer ss-uat9-lb']));
  const snap = within(dialog).getByRole('checkbox', { name: 'Save a snapshot first' }) as HTMLInputElement;
  expect(snap.checked).toBe(true);
  await userEvent.click(snap);
  await userEvent.type(within(dialog).getByLabelText('Type uat9 to confirm'), 'uat9');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  expect(api.startDeployment).toHaveBeenCalledWith('uat9', { mode: 'teardown', confirm_name: 'uat9', snapshot: false });
});

it('DigitalOcean: with the snapshot kept on, the default is sent', async () => {
  const { dialog } = show(DO_ENV);
  await userEvent.type(within(dialog).getByLabelText('Type uat9 to confirm'), 'uat9');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  expect(api.startDeployment).toHaveBeenCalledWith('uat9', { mode: 'teardown', confirm_name: 'uat9' });
});

it('production: retiring first, then deactivated, then both phrases and always a snapshot', async () => {
  let dialog = show(PROD_ENV).dialog;
  expect(within(dialog).getByText('Mark this production environment retiring first (Settings).')).toBeTruthy();
  expect((within(dialog).getByRole('button', { name: 'Delete environment' }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  dialog = show({ ...PROD_ENV, retiring: true }).dialog;
  expect(within(dialog).getByText(/Deactivate it first/)).toBeTruthy();
  expect((within(dialog).getByRole('button', { name: 'Delete environment' }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  dialog = show({ ...PROD_ENV, retiring: true, active_slot: null }).dialog;
  expect(within(dialog).queryByRole('checkbox', { name: 'Save a snapshot first' })).toBeNull();
  expect(within(dialog).getByText(/A snapshot is always saved first/)).toBeTruthy();
  const del = within(dialog).getByRole('button', { name: 'Delete environment' }) as HTMLButtonElement;
  await userEvent.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod');
  expect(del.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type delete production prod to confirm'), 'delete production prod');
  await userEvent.click(del);
  expect(api.startDeployment).toHaveBeenCalledWith('prod', {
    mode: 'teardown', confirm_name: 'prod', confirm_production: 'delete production prod' });
});

it('production that was never deployed: no snapshot to save', () => {
  const { dialog } = show({ ...PROD_ENV, retiring: true, active_slot: null, current_sha: null });
  expect(within(dialog).getByText('Nothing was deployed, so there is no snapshot to save.')).toBeTruthy();
  expect(within(dialog).queryByText(/always saved first/)).toBeNull();
});

it('Blue/Green: names the three VMs and saves a snapshot first unless unticked', async () => {
  const { dialog } = show(LAN_ENV);
  const removes = within(dialog).getByRole('list', { name: 'Sirdar removes' });
  expect(within(removes).getAllByRole('listitem').map((li) => li.textContent)).toEqual(
    expect.arrayContaining(['VM ss-lan9-data', 'VM ss-lan9-orange', 'VM ss-lan9-purple',
                            'Proxy host portal.lan9.serversherpa.com', 'DNS record portal.lan9.serversherpa.com']));
  const snap = within(dialog).getByRole('checkbox', { name: 'Save a snapshot first' }) as HTMLInputElement;
  expect(snap.checked).toBe(true);
  await userEvent.click(snap);
  await userEvent.type(within(dialog).getByLabelText('Type lan9 to confirm'), 'lan9');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  expect(api.startDeployment).toHaveBeenCalledWith('lan9', { mode: 'teardown', confirm_name: 'lan9', snapshot: false });
});

it('Blue/Green: with the snapshot kept on, the default is sent', async () => {
  const { dialog } = show(LAN_ENV);
  await userEvent.type(within(dialog).getByLabelText('Type lan9 to confirm'), 'lan9');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  expect(api.startDeployment).toHaveBeenCalledWith('lan9', { mode: 'teardown', confirm_name: 'lan9' });
});

it('Blue/Green with a slot deployed but none live: offers the snapshot, as the API takes it', async () => {
  const { dialog } = show({ ...LAN_ENV, current_sha: null, active_slot: null });
  const snap = within(dialog).getByRole('checkbox', { name: 'Save a snapshot first' }) as HTMLInputElement;
  expect(snap.checked).toBe(true);
  await userEvent.click(snap);
  await userEvent.type(within(dialog).getByLabelText('Type lan9 to confirm'), 'lan9');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  expect(api.startDeployment).toHaveBeenCalledWith('lan9', { mode: 'teardown', confirm_name: 'lan9', snapshot: false });
});

it('Blue/Green never deployed: no snapshot, and it says why', () => {
  const { dialog } = show({
    ...LAN_ENV, current_sha: null, active_slot: null,
    lan_slots: LAN_ENV.lan_slots!.map((s) => ({ ...s, sha: null, image_tag: null, active: false })),
  });
  expect(within(dialog).queryByRole('checkbox', { name: 'Save a snapshot first' })).toBeNull();
  expect(within(dialog).getByText(/No slot has run a deploy yet/)).toBeTruthy();
});

const FORCE_HINT = "For an environment Sirdar can't reach. Every step that fails is skipped, the environment is removed "
  + 'from Sirdar anyway, and the log lists what may be left behind to clean up by hand. DNS records are always '
  + "removed first; if Cloudflare can't be reached, the delete stops.";

it('Force delete is off by default; on, it sends force and the button says so', async () => {
  const { onStarted, dialog } = show();
  const force = within(dialog).getByRole('checkbox', { name: 'Force delete' }) as HTMLInputElement;
  expect(force.checked).toBe(false);
  expect(within(dialog).getByText(FORCE_HINT)).toBeTruthy();
  expect(within(dialog).queryByRole('button', { name: 'Force delete' })).toBeNull();
  await userEvent.click(force);
  const go = within(dialog).getByRole('button', { name: 'Force delete' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);                            // the typed name is still needed
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(go);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(TEARDOWN));
  expect(api.startDeployment).toHaveBeenCalledWith('uat', { mode: 'teardown', confirm_name: 'uat', force: true });
});

it('Force delete hides the snapshot choice and never sends one', async () => {
  const { dialog } = show(DO_ENV);
  expect(within(dialog).getByRole('checkbox', { name: 'Save a snapshot first' })).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Force delete' }));
  expect(within(dialog).queryByRole('checkbox', { name: 'Save a snapshot first' })).toBeNull();
  await userEvent.type(within(dialog).getByLabelText('Type uat9 to confirm'), 'uat9');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Force delete' }));
  expect(api.startDeployment).toHaveBeenCalledWith('uat9', { mode: 'teardown', confirm_name: 'uat9', force: true });
});

it('a forced production delete keeps the phrase but drops the snapshot line', async () => {
  const { dialog } = show({ ...PROD_ENV, retiring: true, active_slot: null });
  await userEvent.click(within(dialog).getByRole('checkbox', { name: 'Force delete' }));
  expect(within(dialog).queryByText(/A snapshot is always saved first/)).toBeNull();
  await userEvent.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod');
  const go = within(dialog).getByRole('button', { name: 'Force delete' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type delete production prod to confirm'), 'delete production prod');
  await userEvent.click(go);
  expect(api.startDeployment).toHaveBeenCalledWith('prod', {
    mode: 'teardown', confirm_name: 'prod', confirm_production: 'delete production prod', force: true });
});

it('opened with force, the switch starts on', () => {
  render(<DeleteEnvironmentModal env={DO_ENV} force onStarted={vi.fn()} onClose={vi.fn()} />);
  const dialog = screen.getByRole('dialog', { name: 'Delete uat9' });
  expect((within(dialog).getByRole('checkbox', { name: 'Force delete' }) as HTMLInputElement).checked).toBe(true);
  expect(within(dialog).queryByRole('checkbox', { name: 'Save a snapshot first' })).toBeNull();
  expect(within(dialog).getByRole('button', { name: 'Force delete' })).toBeTruthy();
});
