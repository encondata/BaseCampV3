// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a === 'view' || a === 'add' || a === 'change') }),
}));

const api = vi.hoisted(() => ({
  getDeployTargets: vi.fn(), getDoRegions: vi.fn(), connectDeploy: vi.fn(), listKnownHosts: vi.fn(),
  trustKnownHost: vi.fn(), forgetKnownHost: vi.fn(), deleteSshTarget: vi.fn(),
  getSshTarget: vi.fn(), listKeyFiles: vi.fn(), createSshTarget: vi.fn(), updateSshTarget: vi.fn(),
  getDoAccounts: vi.fn(),
}));
vi.mock('../../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../../lib/sirdarApi')>()), ...api }));

import { DO_ACCOUNTS, DO_ACCOUNTS_BOTH } from '../../environments/testData';
import { FLOW_TARGETS, flowCtx } from '../flowFixtures';
import { initialState, type Errors, type FlowContext, type FlowState } from '../flowState';

import TargetStep from './TargetStep';

const REGIONS = { regions: [{ slug: 'nyc3', name: 'New York 3' }, { slug: 'sfo3', name: 'San Francisco 3' }], default: 'nyc3' };

beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.getDeployTargets.mockResolvedValue({ targets: FLOW_TARGETS, types: [] });
  api.listKnownHosts.mockResolvedValue([]);
  api.getDoAccounts.mockResolvedValue({ accounts: DO_ACCOUNTS_BOTH });
  api.getDoRegions.mockResolvedValue(REGIONS);
});
Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
afterEach(cleanup);

async function renderStep(over: Partial<FlowState>, ctxOver: Partial<FlowContext> = {}, errors: Errors = {}) {
  const ctx = flowCtx(ctxOver);
  const set = vi.fn();
  render(<MemoryRouter><TargetStep state={{ ...initialState(ctx), name: 'qa', ...over }} set={set} errors={errors}
                                   ctx={ctx} onTargetsChanged={vi.fn()} /></MemoryRouter>);
  await screen.findByText('Connection test and trusted SSH hosts');
  return { set };
}

it('a VM target asks for sizes and the address; Single can be DHCP', async () => {
  const { set } = await renderStep({ target: 'esxi' });
  expect(screen.getByLabelText('vCPUs')).toBeTruthy();
  expect(screen.getByLabelText('Address')).toBeTruthy();
  expect(screen.getByLabelText('Gateway')).toBeTruthy();
  await userEvent.click(screen.getByRole('radio', { name: 'DHCP' }));
  expect(set).toHaveBeenCalledWith({ ipMode: 'dhcp' });
  expect(screen.getByText(/Sirdar copies the Ubuntu seed VM's disk into a VM named ss-qa on ESXi/)).toBeTruthy();
});

it('DHCP needs no address or gateway', async () => {
  await renderStep({ target: 'proxmox', ipMode: 'dhcp' });
  expect(screen.queryByLabelText('Address')).toBeNull();
  expect(screen.queryByLabelText('Gateway')).toBeNull();
  expect(screen.getByText(/Sirdar clones the Ubuntu template into a VM named ss-qa on Proxmox/)).toBeTruthy();
});

it('Blue/Green asks for three addresses and the data VM size', async () => {
  await renderStep({ target: 'proxmox', servers: 'bluegreen' });
  for (const label of ['Gateway', 'Orange VM address', 'Purple VM address', 'Data VM address', 'Data VM vCPUs'])
    expect(screen.getByLabelText(label)).toBeTruthy();
  expect(screen.queryByRole('radio', { name: 'DHCP' })).toBeNull();
  expect(screen.getByText(/ss-qa-data, ss-qa-orange and ss-qa-purple/)).toBeTruthy();
});

it('the LAN proxy IP starts at Nginx Proxy Manager\'s address', async () => {
  await renderStep({ target: 'ssh:lab' });
  expect((screen.getByLabelText('Proxy IP') as HTMLInputElement).value).toBe('10.10.48.6');
  expect(screen.getByLabelText('Bind IP')).toBeTruthy();
  expect(screen.queryByLabelText('vCPUs')).toBeNull();
});

it('DigitalOcean: the account, its region and the sizes; no proxy IP', async () => {
  const { set } = await renderStep({ target: 'digitalocean' });
  expect(screen.queryByLabelText('Proxy IP')).toBeNull();
  await userEvent.click(screen.getByRole('radio', { name: 'Production' }));
  expect(set).toHaveBeenCalledWith({ doAccount: 'production' });
  expect(screen.getByLabelText('Droplet size')).toBeTruthy();
  expect(screen.getByLabelText('Database size')).toBeTruthy();
  expect(screen.getByText(/Built in nyc3/)).toBeTruthy();
});

it("DigitalOcean: an account that isn't set up can't be chosen", async () => {
  await renderStep({ target: 'digitalocean', doAccount: 'production' }, { accounts: DO_ACCOUNTS });
  expect((screen.getByRole('radio', { name: 'Development' }) as HTMLButtonElement).disabled).toBe(true);
  expect(screen.getAllByRole('radio', { name: 'Production' })).toHaveLength(1);     // the panel has no picker of its own
});

it('production in the Development account warns', async () => {
  await renderStep({ target: 'digitalocean', type: 'production', servers: 'bluegreen', doAccount: 'development' });
  expect(screen.getByText(/shares its renewal token with every development droplet/)).toBeTruthy();
});

it("a chosen target that isn't ready says why", async () => {
  await renderStep({ target: 'digitalocean' }, { accounts: DO_ACCOUNTS.map((a) => ({ ...a, configured: false })) });
  expect(screen.getByText(/Set up a DigitalOcean account \(token and region\)/)).toBeTruthy();
});

it('shows the step errors', async () => {
  await renderStep({ target: 'esxi' }, {}, { machine: 'Use 1 to 64 vCPUs.', proxyIp: 'The proxy IP must be an IPv4 address.',
                                             target: 'Choose a target.' });
  expect(screen.getByText('Use 1 to 64 vCPUs.')).toBeTruthy();
  expect(screen.getByText('The proxy IP must be an IPv4 address.')).toBeTruthy();
  expect(screen.getByText('Choose a target.')).toBeTruthy();
});

it('shows the DigitalOcean and bind IP errors', async () => {
  await renderStep({ target: 'digitalocean' }, {}, { cloud: 'Enter a droplet size.' });
  expect(screen.getByText('Enter a droplet size.')).toBeTruthy();
  cleanup();
  await renderStep({ target: 'ssh:lab' }, {}, { bindIp: 'The bind IP must be an IPv4 address.' });
  expect(screen.getByText('The bind IP must be an IPv4 address.')).toBeTruthy();
});

it('production with the Production account set up: Development is aria-disabled and does nothing', async () => {
  const { set } = await renderStep({ target: 'digitalocean', type: 'production', servers: 'bluegreen', doAccount: 'production' });
  const dev = screen.getByRole('radio', { name: 'Development' });
  expect(dev.getAttribute('aria-disabled')).toBe('true');
  await userEvent.click(dev);
  expect(set).not.toHaveBeenCalledWith({ doAccount: 'development' });
  expect(screen.getByRole('radio', { name: 'Production' }).getAttribute('aria-disabled')).toBeNull();
});
