// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a === 'view' || perms.change) }),
}));
const api = vi.hoisted(() => ({
  getIntegrations: vi.fn(), testIntegration: vi.fn(), removeIntegration: vi.fn(), saveIntegration: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { CF_CHECK, INTEGRATIONS, NO_INTEGRATIONS } from '../environments/testData';

import IntegrationsSection from './IntegrationsSection';

/** Proxmox lives under the collapsed "Other hosts". */
async function openOtherHosts() {
  await userEvent.click(await screen.findByRole('button', { name: 'Other hosts' }));
  return screen.getByRole('group', { name: 'Proxmox' });
}

beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getIntegrations.mockResolvedValue(INTEGRATIONS);
  api.testIntegration.mockResolvedValue(CF_CHECK);
  api.removeIntegration.mockResolvedValue(undefined);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

it('shows each integration, what is set, and never a secret', async () => {
  render(<IntegrationsSection />);
  const cf = await screen.findByRole('group', { name: 'Cloudflare' });
  expect(within(cf).getByText('Configured')).toBeTruthy();
  expect(within(cf).getByText('203.0.113.7')).toBeTruthy();
  expect(within(cf).getByText('Set', { selector: 'dd' })).toBeTruthy();
  expect(within(cf).getByText(/by Jimmy Henderson/)).toBeTruthy();
  const npm = screen.getByRole('group', { name: 'Nginx Proxy Manager' });
  expect(within(npm).getByText('http://10.10.48.6:81')).toBeTruthy();
  expect(within(npm).getAllByText('admin@example.com', { selector: 'dd' })).toHaveLength(2);   // login and Let's Encrypt
});

it('Set up opens the modal; saving shows the new state', async () => {
  api.getIntegrations.mockResolvedValue(NO_INTEGRATIONS);
  api.saveIntegration.mockResolvedValue(INTEGRATIONS);
  render(<IntegrationsSection />);
  const cf = await screen.findByRole('group', { name: 'Cloudflare' });
  expect(within(cf).getByText('Not set up')).toBeTruthy();
  expect(within(cf).queryByRole('button', { name: 'Test Cloudflare' })).toBeNull();
  await userEvent.click(within(cf).getByRole('button', { name: 'Set up Cloudflare' }));
  const dialog = screen.getByRole('dialog', { name: 'Cloudflare' });
  await userEvent.type(within(dialog).getByLabelText('Public IP'), '203.0.113.7');
  await userEvent.type(within(dialog).getByLabelText('API token'), 'cf-token-123456789012345');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(within(screen.getByRole('group', { name: 'Cloudflare' })).getByText('Configured')).toBeTruthy();
});

it('Test checks the saved settings and lists the result in the card', async () => {
  render(<IntegrationsSection />);
  const cf = await screen.findByRole('group', { name: 'Cloudflare' });
  await userEvent.click(within(cf).getByRole('button', { name: 'Test Cloudflare' }));
  const list = await within(cf).findByRole('list', { name: 'Cloudflare test' });
  expect(within(list).getByText('serversherpa.com (zone-1)')).toBeTruthy();
  expect(api.testIntegration).toHaveBeenCalledWith('cloudflare');
  api.testIntegration.mockRejectedValue(new ApiError(502, 'connect_failed',
    { code: 'connect_failed', reason: 'Nginx Proxy Manager rejected the login.' }));
  const npm = screen.getByRole('group', { name: 'Nginx Proxy Manager' });
  await userEvent.click(within(npm).getByRole('button', { name: 'Test Nginx Proxy Manager' }));
  expect(await within(npm).findByText('Nginx Proxy Manager rejected the login.')).toBeTruthy();
});

it('Remove asks first, then removes and reloads', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<IntegrationsSection />);
  const npm = await screen.findByRole('group', { name: 'Nginx Proxy Manager' });
  await userEvent.click(within(npm).getByRole('button', { name: 'Remove Nginx Proxy Manager' }));
  expect(api.removeIntegration).not.toHaveBeenCalled();
  api.getIntegrations.mockResolvedValue(NO_INTEGRATIONS);
  await userEvent.click(within(npm).getByRole('button', { name: 'Remove Nginx Proxy Manager' }));
  await waitFor(() => expect(api.removeIntegration).toHaveBeenCalledWith('npm'));
  expect(confirm.mock.calls[0][0]).toMatch(/Publishing stops until they are set again/);
  await waitFor(() => expect(within(screen.getByRole('group', { name: 'Nginx Proxy Manager' }))
    .getByText('Not set up')).toBeTruthy());
});

it('a view-only reader sees the settings and no buttons', async () => {
  perms.change = false;
  render(<IntegrationsSection />);
  const cf = await screen.findByRole('group', { name: 'Cloudflare' });
  expect(within(cf).queryByRole('button')).toBeNull();
  expect(screen.getByText('You can view these settings but not change them.')).toBeTruthy();
});

it('without SIRDAR_SECRETS_KEY nothing can be stored', async () => {
  api.getIntegrations.mockResolvedValue({ ...NO_INTEGRATIONS, secrets_key_configured: false });
  render(<IntegrationsSection />);
  expect(await screen.findByText(/SIRDAR_SECRETS_KEY isn't set on the Sirdar host/)).toBeTruthy();
  const setUp = screen.getByRole('button', { name: 'Set up Cloudflare' }) as HTMLButtonElement;
  expect(setUp.disabled).toBe(true);
});

it('shows the Proxmox card: where it builds VMs, the token id, never the token', async () => {
  render(<IntegrationsSection />);
  const px = await openOtherHosts();
  expect(within(px).getByText('Configured')).toBeTruthy();
  expect(within(px).getByText('https://10.10.48.5:8006')).toBeTruthy();
  expect(within(px).getByText('Set (sirdar@pve!sirdar)')).toBeTruthy();
  expect(within(px).getByText('ubuntu template 9000 · local-lvm · vmbr0', { exact: false })).toBeTruthy();
  await userEvent.click(within(px).getByRole('button', { name: 'Edit Proxmox' }));
  expect(screen.getByRole('dialog', { name: 'Proxmox' })).toBeTruthy();
});

it('Proxmox can only be removed when no environment uses it', async () => {
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  api.removeIntegration.mockRejectedValue(new ApiError(409, 'integration_in_use',
    { code: 'integration_in_use', environments: ['uat3'] }));
  render(<IntegrationsSection />);
  const px = await openOtherHosts();
  await userEvent.click(within(px).getByRole('button', { name: 'Remove Proxmox' }));
  expect(await within(px).findByText('Environments still use it: uat3. Delete them first.')).toBeTruthy();
});

it("the card's Test points to Edit when the certificate needs review", async () => {
  api.testIntegration.mockRejectedValue(new ApiError(409, 'tls_mismatch',
    { code: 'tls_mismatch', expected: 'AA', actual: 'BB' }));
  render(<IntegrationsSection />);
  const px = await openOtherHosts();
  await userEvent.click(within(px).getByRole('button', { name: 'Test Proxmox' }));
  expect(await within(px).findByText(
    "The server's certificate doesn't match the one Sirdar trusted. Open Edit to review the certificate."))
    .toBeTruthy();
});

it('lays the cards out to fill the row, with URLs and emails that wrap at sensible points', async () => {
  render(<IntegrationsSection />);
  const npm = await screen.findByRole('group', { name: 'Nginx Proxy Manager' });
  expect(npm.parentElement!.classList).toContain('sirdar-integration-cards');
  expect(npm.querySelector('.sirdar-card-head > h3')?.textContent).toBe('Nginx Proxy Manager');
  expect(npm.querySelector('.sirdar-card-head > .chip')?.textContent).toBe('Configured');
  const url = within(npm).getByText('http://10.10.48.6:81', { selector: 'dd' });
  expect(url.querySelectorAll('wbr').length).toBeGreaterThan(0);
  const email = within(npm).getAllByText('admin@example.com', { selector: 'dd' })[0];
  expect(email.querySelectorAll('wbr').length).toBeGreaterThan(0);
});

it('shows the VMware ESXi card: where it builds VMs, never the password', async () => {
  render(<IntegrationsSection />);
  const ex = await screen.findByRole('group', { name: 'VMware ESXi' });
  expect(ex.parentElement!.classList).toContain('sirdar-integration-cards');
  expect(within(ex).getByText('Configured')).toBeTruthy();
  expect(within(ex).getByText('https://10.10.48.10', { selector: 'dd' })).toBeTruthy();
  expect(within(ex).getByText('sirdar', { selector: 'dd' })).toBeTruthy();
  expect(within(ex).getByText('sirdar-ubuntu-2404-seed · datastore1 · VM Network', { selector: 'dd' })).toBeTruthy();
  expect(within(ex).getByText("Each VM's gateway", { selector: 'dd' })).toBeTruthy();
  expect(within(ex).getByText(`${INTEGRATIONS.esxi.tls_fingerprint!.slice(0, 23)}…`, { selector: 'dd' })).toBeTruthy();
  const dt = within(ex).getByText('Password', { selector: 'dt' });
  expect(dt.nextElementSibling!.textContent).toBe('Set');
});

it('Edit ESXi opens its modal; Remove names ESXi', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  render(<IntegrationsSection />);
  const ex = await screen.findByRole('group', { name: 'VMware ESXi' });
  await userEvent.click(within(ex).getByRole('button', { name: 'Remove VMware ESXi' }));
  expect(confirm.mock.calls[0][0]).toBe('Remove the VMware ESXi credentials? Nothing changes on ESXi itself.');
  expect(api.removeIntegration).not.toHaveBeenCalled();
  await userEvent.click(within(ex).getByRole('button', { name: 'Edit VMware ESXi' }));
  expect(screen.getByRole('dialog', { name: 'VMware ESXi' })).toBeTruthy();
});

it('Proxmox, when set up, waits under the collapsed Other hosts', async () => {
  render(<IntegrationsSection />);
  await screen.findByRole('group', { name: 'VMware ESXi' });
  expect(screen.queryByRole('group', { name: 'Proxmox' })).toBeNull();
  const toggle = screen.getByRole('button', { name: 'Other hosts' });
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  await userEvent.click(toggle);
  expect(screen.getByRole('button', { name: 'Hide other hosts' }).getAttribute('aria-expanded')).toBe('true');
  const px = screen.getByRole('group', { name: 'Proxmox' });
  expect(within(px).getByRole('button', { name: 'Edit Proxmox' })).toBeTruthy();
  expect(within(px).getByRole('button', { name: 'Test Proxmox' })).toBeTruthy();
  expect(within(px).getByRole('button', { name: 'Remove Proxmox' })).toBeTruthy();
});

it('Proxmox, when not set up, is one line with Set up', async () => {
  api.getIntegrations.mockResolvedValue(NO_INTEGRATIONS);
  render(<IntegrationsSection />);
  await userEvent.click(await screen.findByRole('button', { name: 'Other hosts' }));
  expect(screen.getByText('Proxmox · Not set up')).toBeTruthy();
  expect(screen.queryByRole('group', { name: 'Proxmox' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Set up Proxmox' }));
  expect(screen.getByRole('dialog', { name: 'Proxmox' })).toBeTruthy();
});

it('shows the DigitalOcean card in the main grid: whether a token is stored, never the token', async () => {
  render(<IntegrationsSection />);
  const dig = await screen.findByRole('group', { name: 'DigitalOcean' });
  expect(dig.parentElement!.classList).toContain('sirdar-integration-cards');
  expect(dig.querySelector('.sirdar-card-head > h3')?.textContent).toBe('DigitalOcean');
  expect(dig.querySelector('.sirdar-card-head > .chip')?.textContent).toBe('Configured');
  expect(dig.querySelector('dl.sirdar-kv')).toBeTruthy();
  const dt = within(dig).getByText('API token', { selector: 'dt' });
  expect(dt.nextElementSibling!.textContent).toBe('Set');
  expect(within(dig).getByText(/by Jimmy Henderson/)).toBeTruthy();
  expect(dig.textContent).not.toMatch(/dop_v1_/);
  await userEvent.click(within(dig).getByRole('button', { name: 'Test DigitalOcean' }));
  expect(api.testIntegration).toHaveBeenCalledWith('digitalocean');
  await userEvent.click(within(dig).getByRole('button', { name: 'Edit DigitalOcean' }));
  expect(screen.getByRole('dialog', { name: 'DigitalOcean' })).toBeTruthy();
});

it("a DigitalOcean token from the server environment: Test works, nothing to remove", async () => {
  api.getIntegrations.mockResolvedValue({
    ...NO_INTEGRATIONS,
    digitalocean: { configured: true, token_set: false, source: 'environment', updated_at: null, updated_by_name: null },
  });
  render(<IntegrationsSection />);
  const dig = await screen.findByRole('group', { name: 'DigitalOcean' });
  expect(within(dig).getByText('Configured')).toBeTruthy();
  const dt = within(dig).getByText('API token', { selector: 'dt' });
  expect(dt.nextElementSibling!.textContent).toBe('From the server environment');
  expect(within(dig).getByRole('button', { name: 'Test DigitalOcean' })).toBeTruthy();
  expect(within(dig).queryByRole('button', { name: 'Remove DigitalOcean' })).toBeNull();
  await userEvent.click(within(dig).getByRole('button', { name: 'Set up DigitalOcean' }));
  expect(screen.getByRole('dialog', { name: 'DigitalOcean' })).toBeTruthy();
});

it('no DigitalOcean token anywhere: Not set up, Set up only', async () => {
  api.getIntegrations.mockResolvedValue(NO_INTEGRATIONS);
  render(<IntegrationsSection />);
  const dig = await screen.findByRole('group', { name: 'DigitalOcean' });
  expect(within(dig).getByText('Not set up')).toBeTruthy();
  expect(within(dig).getByText('API token', { selector: 'dt' }).nextElementSibling!.textContent).toBe('Not set');
  expect(within(dig).queryByRole('button', { name: 'Test DigitalOcean' })).toBeNull();
  expect(within(dig).queryByRole('button', { name: 'Remove DigitalOcean' })).toBeNull();
});

it('removing the stored DigitalOcean token says it falls back to the environment', async () => {
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<IntegrationsSection />);
  const dig = await screen.findByRole('group', { name: 'DigitalOcean' });
  await userEvent.click(within(dig).getByRole('button', { name: 'Remove DigitalOcean' }));
  await waitFor(() => expect(api.removeIntegration).toHaveBeenCalledWith('digitalocean'));
  expect(confirm.mock.calls[0][0]).toBe('Remove the stored DigitalOcean API token? Sirdar then uses '
    + "SIRDAR_DEPLOY_DO_TOKEN from the server environment, if it is set; nothing changes in DigitalOcean itself.");
});
