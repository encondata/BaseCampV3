// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));

const api = vi.hoisted(() => ({
  getDeployTargets: vi.fn(), getDoRegions: vi.fn(), connectDeploy: vi.fn(), listKnownHosts: vi.fn(),
  trustKnownHost: vi.fn(), forgetKnownHost: vi.fn(), deleteSshTarget: vi.fn(),
  getSshTarget: vi.fn(), listKeyFiles: vi.fn(), createSshTarget: vi.fn(), updateSshTarget: vi.fn(),
  listEnvironments: vi.fn(), listSnapshots: vi.fn(),
}));
vi.mock('../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import Deploy from './Deploy';

const TARGETS = {
  targets: [
    { id: 'aws', label: 'AWS', available: false, configured: false },
    { id: 'gcp', label: 'Google Cloud', available: false, configured: false },
    { id: 'digitalocean', label: 'DigitalOcean', available: true, configured: false },
    { id: 'ssh', label: 'Custom (SSH)', available: true, configured: true },
  ],
  types: [
    { id: 'blue', label: 'Blue', description: 'Production slot' },
    { id: 'green', label: 'Green', description: 'Production slot' },
    { id: 'dev', label: 'Dev', description: 'Development' },
    { id: 'beta', label: 'Beta', description: 'External testing' },
    { id: 'custom', label: 'Custom', description: 'Your own named environment' },
  ],
};
const OK = { ok: true, target: 'ssh', type: 'dev', facts: { host: 'srv.example.com' },
             checks: [{ label: 'SSH login', status: 'pass', value: 'Connected as deploy' },
                      { label: 'Docker', status: 'warn', value: 'Not installed' }] };
const UNKNOWN = new ApiError(409, 'host_key_unknown',
  { code: 'host_key_unknown', host: 'srv.example.com', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' });
const MISMATCH = new ApiError(409, 'host_key_mismatch',
  { code: 'host_key_mismatch', host: 'srv.example.com', port: 22, key_type: 'ssh-ed25519',
    expected: 'SHA256:old', actual: 'SHA256:new' });

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getDeployTargets.mockResolvedValue(TARGETS);
  api.listKnownHosts.mockResolvedValue([]);
  api.listEnvironments.mockResolvedValue({ environments: [] });
  api.listSnapshots.mockResolvedValue({ snapshots: [] });
});
Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
afterEach(cleanup);

async function ready() {
  render(<MemoryRouter><Deploy /></MemoryRouter>);
  await waitFor(() => expect(screen.getAllByRole('radio').length).toBeGreaterThan(0));
}
const testBtn = () => screen.getByRole('button', { name: /test connection|connecting/i }) as HTMLButtonElement;

it('renders the four cards with the right chips; aws and gcp are disabled', async () => {
  await ready();
  const aws = screen.getByRole('radio', { name: /AWS/ });
  expect(aws.getAttribute('aria-disabled')).toBe('true');
  expect(within(aws).getByText('Coming soon')).toBeTruthy();
  expect(within(screen.getByRole('radio', { name: /DigitalOcean/ })).getByText('Not configured')).toBeTruthy();
  const ssh = screen.getByRole('radio', { name: /Custom \(SSH\)/ });
  expect(within(ssh).getByText('Ready')).toBeTruthy();
  expect(within(ssh).queryByText(/srv\.example\.com|deploy@|:22|nyc3/)).toBeNull();
  expect(ssh.textContent).not.toMatch(/srv\.example\.com|deploy@|:22|nyc3|token set/);
  await userEvent.click(aws);
  expect(aws.getAttribute('aria-checked')).toBe('false');
});

it('a not-configured target lists the env keys to set', async () => {
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /DigitalOcean/ }));
  expect(screen.getByText(/SIRDAR_DEPLOY_DO_TOKEN/)).toBeTruthy();
  expect(screen.getByText(/re-run the installer/i)).toBeTruthy();
  expect(testBtn().disabled).toBe(true);
});

it('Test connection stays disabled until a configured target and a type are chosen', async () => {
  await ready();
  expect(testBtn().disabled).toBe(true);
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  expect(testBtn().disabled).toBe(true);
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  expect(testBtn().disabled).toBe(false);
});

it('a successful test shows each check and the facts', async () => {
  api.connectDeploy.mockResolvedValue(OK);
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  await userEvent.click(testBtn());
  expect(api.connectDeploy).toHaveBeenCalledWith('ssh', 'dev');
  await waitFor(() => expect(screen.getByText('Connected as deploy')).toBeTruthy());
  expect(screen.getByText('SSH login')).toBeTruthy();
  expect(screen.getByText('Not installed')).toBeTruthy();
  expect(screen.getByText('srv.example.com')).toBeTruthy();
});

it('connect_failed shows the reason inline', async () => {
  api.connectDeploy.mockRejectedValue(new ApiError(502, 'connect_failed', { code: 'connect_failed', reason: 'Connection timed out.' }));
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  await userEvent.click(testBtn());
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Connection timed out.'));
});

it('an unknown host key opens the trust modal; trusting calls trust then connects again', async () => {
  api.connectDeploy.mockRejectedValueOnce(UNKNOWN).mockResolvedValueOnce(OK);
  api.trustKnownHost.mockResolvedValue({});
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  await userEvent.click(testBtn());
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('SHA256:abc')).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Trust and connect' }));
  await waitFor(() => expect(screen.getByText('Connected as deploy')).toBeTruthy());
  expect(api.trustKnownHost).toHaveBeenCalledWith('srv.example.com', 22, 'SHA256:abc');
  expect(api.connectDeploy).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('host_key_changed while trusting closes the modal and shows the retry message on the page', async () => {
  api.connectDeploy.mockRejectedValueOnce(UNKNOWN);
  api.trustKnownHost.mockRejectedValue(new ApiError(409, 'host_key_changed', { code: 'host_key_changed' }));
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  await userEvent.click(testBtn());
  const dialog = await screen.findByRole('dialog');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Trust and connect' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('alert').textContent).toContain('key changed while you were looking. Try again.');
});

it('changing the target or type clears the result, mismatch and error', async () => {
  api.connectDeploy.mockResolvedValueOnce(OK).mockRejectedValueOnce(MISMATCH)
    .mockRejectedValueOnce(new ApiError(502, 'connect_failed', { code: 'connect_failed', reason: 'Timed out.' }));
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  await userEvent.click(testBtn());
  await waitFor(() => expect(screen.getByText('Connected as deploy')).toBeTruthy());
  await userEvent.click(screen.getByRole('radio', { name: /^Beta/ }));
  expect(screen.queryByText('Connected as deploy')).toBeNull();
  await userEvent.click(testBtn());
  await waitFor(() => expect(screen.getByText('SHA256:old')).toBeTruthy());
  await userEvent.click(screen.getByRole('radio', { name: /^Blue/ }));
  expect(screen.queryByText('SHA256:old')).toBeNull();
  await userEvent.click(testBtn());
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Timed out.'));
  await userEvent.click(screen.getByRole('radio', { name: /^Green/ }));
  expect(screen.queryByRole('alert')).toBeNull();
});

it('a double click on Test connection sends one request', async () => {
  let release: (v: unknown) => void = () => {};
  api.connectDeploy.mockReturnValue(new Promise((r) => { release = r; }));
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  const btn = testBtn();
  act(() => { btn.click(); btn.click(); });
  expect(api.connectDeploy).toHaveBeenCalledTimes(1);
  release(OK);
  await waitFor(() => expect(screen.getByText('Connected as deploy')).toBeTruthy());
});

it('forgetting after a mismatch deletes the key; the next test asks to trust again', async () => {
  api.connectDeploy.mockRejectedValueOnce(MISMATCH).mockRejectedValueOnce(UNKNOWN);
  api.forgetKnownHost.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  await userEvent.click(testBtn());
  await userEvent.click(await screen.findByRole('button', { name: 'Forget the old key' }));
  expect(api.forgetKnownHost).toHaveBeenCalledWith('srv.example.com', 22);
  await waitFor(() => expect(screen.queryByText('SHA256:old')).toBeNull());
  await userEvent.click(testBtn());
  expect(await screen.findByRole('dialog')).toBeTruthy();
});

it('a key mismatch shows both fingerprints and offers Forget with deploy:change', async () => {
  api.connectDeploy.mockRejectedValue(MISMATCH);
  api.forgetKnownHost.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  await userEvent.click(testBtn());
  await waitFor(() => expect(screen.getByText(/doesn't match the one Sirdar trusted/)).toBeTruthy());
  expect(screen.getByText('SHA256:old')).toBeTruthy();
  expect(screen.getByText('SHA256:new')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'Forget the old key' }));
  expect(api.forgetKnownHost).toHaveBeenCalledWith('srv.example.com', 22);
});

it('without deploy:change the mismatch panel has no forget button', async () => {
  perms.change = false;
  api.connectDeploy.mockRejectedValue(MISMATCH);
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  await userEvent.click(testBtn());
  await waitFor(() => expect(screen.getByText('SHA256:old')).toBeTruthy());
  expect(screen.queryByRole('button', { name: 'Forget the old key' })).toBeNull();
});

it('a view-only admin sees the page but the button is disabled with a note', async () => {
  perms.add = false; perms.change = false;
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  expect(testBtn().disabled).toBe(true);
  expect(screen.getByText(/you can view deployments but not run tests/i)).toBeTruthy();
});

it('lists trusted hosts and forgets one after confirming', async () => {
  api.listKnownHosts.mockResolvedValueOnce([
    { host: 'srv.example.com', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc',
      trusted_at: '2026-10-01T12:00:00Z', trusted_by_name: 'Jimmy' }]).mockResolvedValue([]);
  api.forgetKnownHost.mockResolvedValue(undefined);
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  await ready();
  const table = await screen.findByRole('table', { name: 'Trusted SSH hosts' });
  expect(within(table).getByText('srv.example.com:22')).toBeTruthy();
  await userEvent.click(within(table).getByRole('button', { name: /forget/i }));
  expect(api.forgetKnownHost).toHaveBeenCalledWith('srv.example.com', 22);
  await waitFor(() => expect(screen.getByText('No hosts trusted yet.')).toBeTruthy());
});

it('empty hosts list shows the empty state', async () => {
  await ready();
  expect(await screen.findByText('No hosts trusted yet.')).toBeTruthy();
});


const DO_TARGETS = { ...TARGETS, targets: TARGETS.targets.map((t) => t.id === 'digitalocean' ? { ...t, configured: true } : t) };
const REGIONS = { regions: [{ slug: 'nyc3', name: 'New York 3' }, { slug: 'sfo3', name: 'San Francisco 3' }], default: 'nyc3' };
const DO_OK = { ok: true, target: 'digitalocean', type: 'dev', facts: {}, checks: [{ label: 'Account', status: 'pass', value: 'ops@example.com · active' }] };

async function pickDo() {
  api.getDeployTargets.mockResolvedValue(DO_TARGETS);
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /DigitalOcean/ }));
}

it('DigitalOcean: loads regions, preselects the default, and sends the chosen region', async () => {
  api.getDoRegions.mockResolvedValue(REGIONS);
  api.connectDeploy.mockResolvedValue(DO_OK);
  await pickDo();
  const box = await screen.findByRole('combobox', { name: 'Region' }) as HTMLInputElement;
  await waitFor(() => expect(box.value).toContain('New York 3 (nyc3)'));
  await userEvent.click(box);
  await userEvent.click(await screen.findByText('San Francisco 3 (sfo3)'));
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  await userEvent.click(testBtn());
  expect(api.connectDeploy).toHaveBeenCalledWith('digitalocean', 'dev', 'sfo3');
  await waitFor(() => expect(screen.getByText(/sfo3 ·/)).toBeTruthy());
});

it('DigitalOcean: sends the preselected default, and switching targets reuses the list', async () => {
  api.getDoRegions.mockResolvedValue(REGIONS);
  api.connectDeploy.mockResolvedValue(DO_OK);
  await pickDo();
  await screen.findByRole('combobox', { name: 'Region' });
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
  expect(screen.queryByRole('combobox', { name: 'Region' })).toBeNull();
  await userEvent.click(screen.getByRole('radio', { name: /DigitalOcean/ }));
  await screen.findByRole('combobox', { name: 'Region' });
  expect(api.getDoRegions).toHaveBeenCalledTimes(1);
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  await userEvent.click(testBtn());
  expect(api.connectDeploy).toHaveBeenCalledWith('digitalocean', 'dev', 'nyc3');
});

it('DigitalOcean: a region load error shows inline with Retry', async () => {
  api.getDoRegions
    .mockRejectedValueOnce(new ApiError(502, 'connect_failed', { code: 'connect_failed', reason: 'DigitalOcean rejected the API token.' }))
    .mockResolvedValueOnce(REGIONS);
  await pickDo();
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('DigitalOcean rejected the API token.'));
  await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('combobox', { name: 'Region' });
  expect(api.getDoRegions).toHaveBeenCalledTimes(2);
});

async function pickSsh() {
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\)/ }));
}

it('shows Custom as the fifth type with its description', async () => {
  await ready();
  const radios = screen.getAllByRole('radio', { name: /Blue|Green|Dev|Beta|Custom$|Your own/ });
  const custom = screen.getByRole('radio', { name: /^Custom\s*Your own named environment/ });
  expect(custom.textContent).toContain('Your own named environment');
  expect(radios.length).toBeGreaterThanOrEqual(5);
});

it('shows the name field only for Custom, validates it and gates the button', async () => {
  await pickSsh();
  expect(screen.queryByLabelText('Environment name')).toBeNull();
  await userEvent.click(screen.getByRole('radio', { name: /^Custom\s*Your own/ }));
  const input = screen.getByLabelText('Environment name');
  expect(screen.getByText('Lowercase letters, numbers and hyphens; starts with a letter; 2–32 characters.')).toBeTruthy();
  expect(testBtn().disabled).toBe(true);
  await userEvent.type(input, 'Demo');
  expect(screen.getByText(/Use lowercase letters, numbers and hyphens, starting with a letter/)).toBeTruthy();
  expect(testBtn().disabled).toBe(true);
  await userEvent.clear(input);
  await userEvent.type(input, 'beta');
  expect(screen.getByText(/reserved/i)).toBeTruthy();
  expect(testBtn().disabled).toBe(true);
  await userEvent.clear(input);
  await userEvent.type(input, 'demo-');
  expect(testBtn().disabled).toBe(true);
  await userEvent.type(input, 'acme');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(testBtn().disabled).toBe(false);
});

it('sends the name and shows it in the results header; other types do not send it', async () => {
  api.connectDeploy.mockResolvedValue({ ...OK, type: 'custom', name: 'demo-acme' });
  await pickSsh();
  await userEvent.click(screen.getByRole('radio', { name: /^Custom\s*Your own/ }));
  await userEvent.type(screen.getByLabelText('Environment name'), 'demo-acme');
  await userEvent.click(testBtn());
  await waitFor(() => expect(api.connectDeploy).toHaveBeenCalledWith('ssh', 'custom', undefined, 'demo-acme'));
  expect(await screen.findByText(/Custom \(SSH\) · Custom: demo-acme/)).toBeTruthy();
  // switching away clears results, hides the field, and does not send the name
  api.connectDeploy.mockResolvedValue(OK);
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  expect(screen.queryByText(/demo-acme/)).toBeNull();
  expect(screen.queryByLabelText('Environment name')).toBeNull();
  await userEvent.click(testBtn());
  await waitFor(() => expect(api.connectDeploy).toHaveBeenLastCalledWith('ssh', 'dev'));
  // the typed name is kept when switching back
  await userEvent.click(screen.getByRole('radio', { name: /^Custom\s*Your own/ }));
  expect((screen.getByLabelText('Environment name') as HTMLInputElement).value).toBe('demo-acme');
});


// ---- saved Custom (SSH) targets ----
const SAVED_T = { id: 'ssh:edge-box', label: 'Edge Box', kind: 'ssh', source: 'saved', available: true, configured: true };
const INSTALLER_T = { id: 'ssh', label: 'Custom (SSH) · Installer', kind: 'ssh', source: 'installer', available: true, configured: true };
const withSsh = (extra: object = {}, targets = [INSTALLER_T, SAVED_T]) => ({
  ...TARGETS, targets: [...TARGETS.targets.filter((t) => t.id !== 'ssh'), ...targets],
  can_add_ssh: true, ssh_store_hint: null, ...extra,
});
const SAVED_DETAIL = { slug: 'edge-box', name: 'Edge Box', host: '10.0.0.5', port: 2222, user: 'deployer',
                       key_path: null, password_set: true, passphrase_set: false };

it('shows the add card only with deploy:change and can_add_ssh; otherwise a hint', async () => {
  api.getDeployTargets.mockResolvedValue(withSsh());
  await ready();
  const add = screen.getByRole('button', { name: /Add SSH target/ });
  expect(add.getAttribute('role')).toBeNull();
  expect(screen.queryByText(/isn't writable/)).toBeNull();
  cleanup();

  api.getDeployTargets.mockResolvedValue(withSsh({ can_add_ssh: false, ssh_store_hint: "deploy-targets.env isn't writable; see the README." }));
  await ready();
  expect(screen.queryByRole('button', { name: /Add SSH target/ })).toBeNull();
  expect(screen.getByText("deploy-targets.env isn't writable; see the README.")).toBeTruthy();
  cleanup();

  perms.change = false;
  api.getDeployTargets.mockResolvedValue(withSsh({ can_add_ssh: false, ssh_store_hint: 'hint-text' }));
  await ready();
  expect(screen.queryByRole('button', { name: /Add SSH target/ })).toBeNull();
  expect(screen.queryByText('hint-text')).toBeNull();
});

it('saved SSH cards show names only; the installer card shows its label and note, with no Edit or Remove', async () => {
  api.getDeployTargets.mockResolvedValue(withSsh());
  await ready();
  const saved = screen.getByRole('radio', { name: /Edge Box/ });
  expect(saved.textContent).not.toMatch(/10\.0\.0\.5|deployer|:2222/);
  await userEvent.click(screen.getByRole('radio', { name: /Custom \(SSH\) · Installer/ }));
  expect(screen.getByText('Edit this target in sirdar/.env.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
});

it('adding a target selects it and reloads the list', async () => {
  api.getDeployTargets.mockResolvedValueOnce(withSsh({}, []));
  api.listKeyFiles.mockResolvedValue({ files: [] });
  api.createSshTarget.mockResolvedValue({ ...SAVED_DETAIL, slug: 'edge-box' });
  await ready();
  api.getDeployTargets.mockResolvedValue(withSsh({}, [SAVED_T]));
  await userEvent.click(screen.getByRole('button', { name: /Add SSH target/ }));
  await userEvent.type(await screen.findByLabelText('Name'), 'Edge Box');
  await userEvent.type(screen.getByLabelText('Host'), '10.0.0.5');
  await userEvent.type(screen.getByLabelText('User'), 'deployer');
  await userEvent.type(screen.getByLabelText('Password'), 'pw');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.getByRole('radio', { name: /Edge Box/ }).getAttribute('aria-checked')).toBe('true'));
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Edit opens the modal for the selected saved target and reselects it after saving', async () => {
  api.getDeployTargets.mockResolvedValue(withSsh());
  api.getSshTarget.mockResolvedValue(SAVED_DETAIL);
  api.listKeyFiles.mockResolvedValue({ files: [] });
  api.updateSshTarget.mockResolvedValue(SAVED_DETAIL);
  await ready();
  expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
  await userEvent.click(screen.getByRole('radio', { name: /Edge Box/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Edit' }));
  expect((await screen.findByLabelText('Host') as HTMLInputElement).value).toBe('10.0.0.5');
  expect(api.getSshTarget).toHaveBeenCalledWith('edge-box');
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('radio', { name: /Edge Box/ }).getAttribute('aria-checked')).toBe('true');
});

it('Remove confirms, deletes, refreshes and clears the selection', async () => {
  api.getDeployTargets.mockResolvedValueOnce(withSsh());
  api.deleteSshTarget.mockResolvedValue(undefined);
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Edge Box/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
  expect(confirm).toHaveBeenCalledWith('Remove Edge Box? Its saved password and key settings are deleted. Trusted host keys stay until you forget them.');
  expect(api.deleteSshTarget).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  api.getDeployTargets.mockResolvedValue(withSsh({}, [INSTALLER_T]));
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(api.deleteSshTarget).toHaveBeenCalledWith('edge-box'));
  await waitFor(() => expect(screen.queryByRole('radio', { name: /Edge Box/ })).toBeNull());
  expect(screen.queryByRole('button', { name: 'Remove' })).toBeNull();
  confirm.mockRestore();
});

it('connects with the saved target id, and trusts with it', async () => {
  api.getDeployTargets.mockResolvedValue(withSsh());
  api.connectDeploy.mockRejectedValueOnce(UNKNOWN).mockResolvedValue({ ...OK, target: 'ssh:edge-box' });
  api.trustKnownHost.mockResolvedValue({});
  await ready();
  await userEvent.click(screen.getByRole('radio', { name: /Edge Box/ }));
  await userEvent.click(screen.getByRole('radio', { name: /^Dev/ }));
  await userEvent.click(testBtn());
  expect(api.connectDeploy).toHaveBeenCalledWith('ssh:edge-box', 'dev');
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and connect' }));
  await waitFor(() => expect(api.trustKnownHost).toHaveBeenCalledWith('srv.example.com', 22, 'SHA256:abc', 'ssh:edge-box'));
});

it('shows the Environments section first', async () => {
  await ready();
  expect(await screen.findByRole('table', { name: 'Environments' })).toBeTruthy();
  expect(screen.getAllByRole('heading', { level: 2 })[0].textContent).toBe('Environments');
  expect(api.listEnvironments).toHaveBeenCalled();
});

it('shows the Snapshots section under Environments', async () => {
  await ready();
  const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
  expect(headings.slice(0, 2)).toEqual(['Environments', 'Snapshots']);
  expect(await screen.findByText('No snapshots yet.')).toBeTruthy();
});
