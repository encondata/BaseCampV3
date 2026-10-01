// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));

const api = vi.hoisted(() => ({
  getDeployTargets: vi.fn(), connectDeploy: vi.fn(), listKnownHosts: vi.fn(),
  trustKnownHost: vi.fn(), forgetKnownHost: vi.fn(),
}));
vi.mock('../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import Deploy from './Deploy';

const TARGETS = {
  targets: [
    { id: 'aws', label: 'AWS', available: false, configured: false, summary: null },
    { id: 'gcp', label: 'Google Cloud', available: false, configured: false, summary: null },
    { id: 'digitalocean', label: 'DigitalOcean', available: true, configured: false, summary: null },
    { id: 'ssh', label: 'Custom (SSH)', available: true, configured: true, summary: 'deploy@srv.example.com:22 · key' },
  ],
  types: [
    { id: 'blue', label: 'Blue', description: 'Production slot' },
    { id: 'green', label: 'Green', description: 'Production slot' },
    { id: 'dev', label: 'Dev', description: 'Development' },
    { id: 'beta', label: 'Beta', description: 'External testing' },
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
});
afterEach(cleanup);

async function ready() {
  render(<Deploy />);
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
  expect(within(ssh).getByText(/deploy@srv\.example\.com:22/)).toBeTruthy();
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
