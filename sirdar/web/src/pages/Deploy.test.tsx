// @vitest-environment jsdom
// /deploy is the Environments page (the Dashboard's environment cards, no traffic graph, and Snapshots);
// /deploy/new is New deployment (the step-by-step flow, tested in deploy/DeployFlow.test.tsx).
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
    preferences: { motion: false },
  }),
}));

const api = vi.hoisted(() => ({
  getDeployTargets: vi.fn(), getDoRegions: vi.fn(), connectDeploy: vi.fn(), listKnownHosts: vi.fn(),
  trustKnownHost: vi.fn(), forgetKnownHost: vi.fn(), deleteSshTarget: vi.fn(),
  getSshTarget: vi.fn(), listKeyFiles: vi.fn(), createSshTarget: vi.fn(), updateSshTarget: vi.fn(),
  listEnvironments: vi.fn(), listSnapshots: vi.fn(), getDoAccounts: vi.fn(),
  getEnvironmentDefaults: vi.fn(), getIntegrations: vi.fn(), getDashboard: vi.fn(), getEnvironment: vi.fn(),
}));
vi.mock('../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../lib/sirdarApi')>()), ...api }));
vi.mock('./environments/AdoptEnvironmentModal', () => ({
  default: ({ onAdopted, onClose }: { onAdopted: (env: { name: string }) => void; onClose: () => void }) => (
    <div role="dialog" aria-label="Adopt an environment">
      <button type="button" onClick={() => onAdopted({ name: 'old1' })}>fake adopt</button>
      <button type="button" onClick={onClose}>fake close</button>
    </div>
  ),
}));

import { ApiError } from '@portal/lib/api';

import Deploy from './Deploy';
import NewDeployment from './NewDeployment';
import { CLOUD, EMPTY, LAN_CARD, REAL } from './dashboard/testData';
import { FLOW_DEFAULTS, FLOW_INTEGRATIONS, FLOW_TARGETS } from './deploy/flowFixtures';
import { DO_ACCOUNTS_BOTH, ENV } from './environments/testData';

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
  api.getDashboard.mockResolvedValue(CLOUD);
});
Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
afterEach(cleanup);

let where = '';
function Where() { const l = useLocation(); where = l.pathname + l.search; return null; }

const renderAt = (url = '/deploy') => render(
  <MemoryRouter initialEntries={[url]}>
    <Routes>
      <Route path="/deploy" element={<Deploy />} />
      <Route path="/deploy/new" element={<NewDeployment />} />
      <Route path="/deploy/environments/:name" element={<p>detail page</p>} />
    </Routes>
    <Where />
  </MemoryRouter>,
);
const panel = (name: string) => document.querySelector<HTMLElement>(`[role="tabpanel"][aria-label="${name}"]`)!;

it('is the Environments page: New deployment and Adopt existing, then Environments and Snapshots tabs', async () => {
  renderAt();
  expect(screen.getByRole('heading', { level: 1, name: 'Environments' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'New deployment' }).className).toBe('btn-solid');
  expect(screen.getByRole('button', { name: 'Adopt existing' }).className).toBe('btn-ghost');
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Environments', 'Snapshots']);
  expect(screen.getByRole('tab', { name: 'Environments' }).getAttribute('aria-selected')).toBe('true');
  expect(panel('Environments').hidden).toBe(false);
  expect(panel('Snapshots').hidden).toBe(true);
  expect(screen.queryByRole('tab', { name: 'New environment' })).toBeNull();
  await screen.findByRole('heading', { name: 'prod' });
});

it("the Environments tab shows the Dashboard's cards with their details, and no traffic graph", async () => {
  renderAt();
  const tab = panel('Environments');
  expect((await within(tab).findAllByRole('heading', { level: 3 })).map((h) => h.textContent)).toEqual(
    ['prod', 'uat9', 'uat']);
  expect(api.getDashboard).toHaveBeenCalledWith({ demo: false, refresh: false });
  expect(within(tab).getAllByText('Running').length).toBe(3);
  expect(within(tab).getByRole('button', { name: 'Deploy prod' })).toBeTruthy();
  expect(within(tab).getAllByText(/Last release: e73b99ca/).length).toBe(3);
  // the Dashboard's spotlight (Cloudflare, the load balancer, the servers) and tree aren't here
  expect(document.querySelector('.sd-spot, .sd-flow, .sd-tree')).toBeNull();
  expect(within(tab).queryByText('Cloudflare')).toBeNull();
  expect(within(tab).queryByText('Load balancer')).toBeNull();
});

it("only real environments get a card (not the Dashboard's Set up placeholders)", async () => {
  api.getDashboard.mockResolvedValue(REAL);
  renderAt();
  const tab = panel('Environments');
  expect((await within(tab).findAllByRole('heading', { level: 3 })).map((h) => h.textContent)).toEqual(['uat', 'qa-east']);
});

it('a card opens its environment page; its Deploy button opens the deploy dialog', async () => {
  api.getEnvironment.mockResolvedValue(ENV);
  renderAt();
  await userEvent.click(await screen.findByRole('button', { name: `Deploy ${LAN_CARD.label}` }));
  expect(api.getEnvironment).toHaveBeenCalledWith('uat');
  expect(await screen.findByRole('dialog')).toBeTruthy();
  expect(where).toBe('/deploy');
  cleanup();
  renderAt();
  await userEvent.click(await screen.findByRole('button', { name: 'Open uat9' }));
  expect(await screen.findByText('detail page')).toBeTruthy();
  expect(where).toBe('/deploy/environments/uat9');
});

it('says when there are no environments yet, and shows a load error', async () => {
  api.getDashboard.mockResolvedValue(EMPTY);
  renderAt();
  expect(await screen.findByText('No environments yet.')).toBeTruthy();
  cleanup();
  api.getDashboard.mockRejectedValue(new ApiError(500, 'http_500', null));
  renderAt();
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load environments.");
});

it('New deployment opens /deploy/new: the flow from step 1, a back link and no tabs', async () => {
  renderAt();
  await userEvent.click(screen.getByRole('button', { name: 'New deployment' }));
  expect(where).toBe('/deploy/new');
  expect(screen.getByRole('heading', { level: 1, name: 'New deployment' })).toBeTruthy();
  expect(await screen.findByRole('heading', { name: 'Environment' })).toBeTruthy();   // step 1
  expect(screen.getByRole('link', { name: 'Environments' }).getAttribute('href')).toBe('/deploy');
  expect(screen.queryByRole('tab')).toBeNull();
});

it('leaving New deployment and coming back starts the flow fresh', async () => {
  renderAt('/deploy/new');
  const first = await screen.findByRole('heading', { name: 'Environment' });
  fireEvent.click(screen.getByRole('link', { name: 'Environments' }));
  expect(where).toBe('/deploy');
  await userEvent.click(screen.getByRole('button', { name: 'New deployment' }));
  const again = await screen.findByRole('heading', { name: 'Environment' });
  expect(again).not.toBe(first);
});

it('old links still work: ?tab=new goes to /deploy/new, ?tab=environments and ?tab=snapshots open their tabs', async () => {
  renderAt('/deploy?tab=new');
  expect(where).toBe('/deploy/new');
  expect(await screen.findByRole('heading', { name: 'Environment' })).toBeTruthy();
  cleanup();
  renderAt('/deploy?tab=environments');
  expect(screen.getByRole('tab', { name: 'Environments' }).getAttribute('aria-selected')).toBe('true');
  expect(panel('Environments').hidden).toBe(false);
  await screen.findByRole('heading', { name: 'prod' });
  cleanup();
  renderAt('/deploy?tab=snapshots');
  expect(screen.getByRole('tab', { name: 'Snapshots' }).getAttribute('aria-selected')).toBe('true');
  expect(panel('Snapshots').hidden).toBe(false);
  await screen.findByRole('heading', { name: 'prod', hidden: true });
});

it('switching tabs keeps the address in step', async () => {
  renderAt();
  await screen.findByRole('heading', { name: 'prod' });
  fireEvent.click(screen.getByRole('tab', { name: 'Snapshots' }));
  expect(where).toBe('/deploy?tab=snapshots');
  expect(panel('Environments').hidden).toBe(true);
});

it('without deploy:add there is no New deployment or Adopt existing, and /deploy/new says why', async () => {
  perms.add = false;
  renderAt();
  expect(await screen.findByText(/You can view deployments but not create them/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'New deployment' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Adopt existing' })).toBeNull();
  await screen.findByRole('heading', { name: 'prod' });
  expect(screen.queryByRole('button', { name: 'Deploy prod' })).toBeNull();
  cleanup();
  renderAt('/deploy/new');
  expect(screen.getByText(/You can view deployments but not create them/)).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Environment' })).toBeNull();
  expect(api.getDeployTargets).not.toHaveBeenCalled();
});

it('Adopt existing opens the adopt dialog; adopting opens its page, closing reloads the cards', async () => {
  renderAt();
  await screen.findByRole('heading', { name: 'prod' });
  await userEvent.click(screen.getByRole('button', { name: 'Adopt existing' }));
  await userEvent.click(within(screen.getByRole('dialog', { name: 'Adopt an environment' }))
    .getByRole('button', { name: 'fake close' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  await vi.waitFor(() => expect(api.getDashboard).toHaveBeenCalledTimes(2));
  await userEvent.click(screen.getByRole('button', { name: 'Adopt existing' }));
  await userEvent.click(screen.getByRole('button', { name: 'fake adopt' }));
  expect(await screen.findByText('detail page')).toBeTruthy();
  expect(where).toBe('/deploy/environments/old1');
});

it("New deployment shows a targets load failure", async () => {
  api.getDeployTargets.mockRejectedValue(new Error('down'));
  renderAt('/deploy/new');
  expect(await screen.findByText("Couldn't load deployment targets.")).toBeTruthy();
});
