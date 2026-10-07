// @vitest-environment jsdom
// The targets, connection test and trusted-host tests live in deploy/TargetPanel.test.tsx;
// the flow's own tests in deploy/DeployFlow.test.tsx.
import { cleanup, render, screen } from '@testing-library/react';
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
  listEnvironments: vi.fn(), listSnapshots: vi.fn(), getDoAccounts: vi.fn(),
  getEnvironmentDefaults: vi.fn(), getIntegrations: vi.fn(),
}));
vi.mock('../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../lib/sirdarApi')>()), ...api }));

import Deploy from './Deploy';
import { FLOW_DEFAULTS, FLOW_INTEGRATIONS, FLOW_TARGETS } from './deploy/flowFixtures';
import { DO_ACCOUNTS_BOTH } from './environments/testData';

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getDeployTargets.mockResolvedValue({ targets: FLOW_TARGETS, types: [] });
  api.listKnownHosts.mockResolvedValue([]);
  api.listEnvironments.mockResolvedValue({ environments: [] });
  api.listSnapshots.mockResolvedValue({ snapshots: [] });
  api.getDoAccounts.mockResolvedValue({ accounts: DO_ACCOUNTS_BOTH });
  api.getEnvironmentDefaults.mockResolvedValue(FLOW_DEFAULTS);
  api.getIntegrations.mockResolvedValue(FLOW_INTEGRATIONS);
});
Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
afterEach(cleanup);

const renderPage = () => render(<MemoryRouter><Deploy /></MemoryRouter>);

it('puts the flow first, then the Environments and Snapshots lists', async () => {
  renderPage();
  await screen.findByRole('heading', { name: 'Environment' });
  expect(screen.getByText('Create an environment and deploy it, step by step. Your environments and snapshots are below.'))
    .toBeTruthy();
  const order = ['Environment', 'Environments', 'Snapshots'].map((n) => screen.getByRole('heading', { name: n }));
  expect(order[0].compareDocumentPosition(order[1]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(order[1].compareDocumentPosition(order[2]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

it('without deploy:add there is no flow, only the lists and a note', async () => {
  perms.add = false;
  renderPage();
  expect(await screen.findByText(/You can view deployments but not create them/)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Environment' })).toBeNull();
  expect(screen.getByRole('heading', { name: 'Environments' })).toBeTruthy();
});

it("a targets load failure is shown on the page", async () => {
  api.getDeployTargets.mockRejectedValue(new Error('down'));
  renderPage();
  expect(await screen.findByText("Couldn't load deployment targets.")).toBeTruthy();
});
