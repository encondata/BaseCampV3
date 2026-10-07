// @vitest-environment jsdom
// The targets, connection test and trusted-host tests live in deploy/TargetPanel.test.tsx;
// the flow's own tests in deploy/DeployFlow.test.tsx.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
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

const renderPage = (url = '/deploy') => render(<MemoryRouter initialEntries={[url]}><Deploy /></MemoryRouter>);
const panel = (name: string) => document.querySelector<HTMLElement>(`[role="tabpanel"][aria-label="${name}"]`)!;

it('opens on the New environment tab; the lists sit in their own tabs', async () => {
  renderPage();
  await screen.findByRole('heading', { name: 'Environment' });
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['New environment', 'Environments', 'Snapshots']);
  expect(screen.getByRole('tab', { name: 'New environment' }).getAttribute('aria-selected')).toBe('true');
  expect(panel('New environment').hidden).toBe(false);
  expect(panel('Environments').hidden).toBe(true);
  expect(panel('Snapshots').hidden).toBe(true);
});

it('switching tabs keeps the flow mounted, so its choices survive', async () => {
  renderPage();
  const heading = await screen.findByRole('heading', { name: 'Environment' });
  fireEvent.click(screen.getByRole('tab', { name: 'Snapshots' }));
  expect(panel('Snapshots').hidden).toBe(false);
  expect(panel('New environment').hidden).toBe(true);
  fireEvent.click(screen.getByRole('tab', { name: 'New environment' }));
  expect(screen.getByRole('heading', { name: 'Environment' })).toBe(heading);
  expect(panel('New environment').hidden).toBe(false);
});

it('?tab=environments opens the Environments tab', async () => {
  renderPage('/deploy?tab=environments');
  await screen.findByRole('heading', { name: 'Environments' });
  expect(screen.getByRole('tab', { name: 'Environments' }).getAttribute('aria-selected')).toBe('true');
  expect(panel('Environments').hidden).toBe(false);
  expect(panel('New environment').hidden).toBe(true);
});

it('without deploy:add there is no flow tab, only the lists and a note', async () => {
  perms.add = false;
  renderPage();
  expect(await screen.findByText(/You can view deployments but not create them/)).toBeTruthy();
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Environments', 'Snapshots']);
  expect(screen.queryByRole('heading', { name: 'Environment' })).toBeNull();
  expect(panel('Environments').hidden).toBe(false);
});

it("a targets load failure is shown on the page", async () => {
  api.getDeployTargets.mockRejectedValue(new Error('down'));
  renderPage();
  expect(await screen.findByText("Couldn't load deployment targets.")).toBeTruthy();
});
