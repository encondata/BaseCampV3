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
  const px = await screen.findByRole('group', { name: 'Proxmox' });
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
  const px = await screen.findByRole('group', { name: 'Proxmox' });
  await userEvent.click(within(px).getByRole('button', { name: 'Remove Proxmox' }));
  expect(await within(px).findByText('Environments still use it: uat3. Delete them first.')).toBeTruthy();
});

it("the card's Test points to Edit when the certificate needs review", async () => {
  api.testIntegration.mockRejectedValue(new ApiError(409, 'tls_mismatch',
    { code: 'tls_mismatch', expected: 'AA', actual: 'BB' }));
  render(<IntegrationsSection />);
  const px = await screen.findByRole('group', { name: 'Proxmox' });
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
