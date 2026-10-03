// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ deploy: true, view: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a?: string) => r !== 'deploy' || (a === 'view' ? perms.view : perms.deploy),
    preferences: { motion: false },
  }),
}));
const api = vi.hoisted(() => ({ getDashboard: vi.fn(), getEnvironment: vi.fn(), startDeployment: vi.fn(), trustKnownHost: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { ENV, RUNNING } from '../environments/testData';

import DashboardPage from './DashboardPage';
import { DEMO, EMPTY, REAL } from './testData';

let loc = '';
let path = '';
function Where() { const l = useLocation(); loc = l.search; path = l.pathname; return null; }

function show(at = '/') {
  return render(
    <MemoryRouter initialEntries={[at]}>
      <DashboardPage />
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  perms.deploy = true; perms.view = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getDashboard.mockImplementation(async (o: { demo?: boolean }) => (o?.demo ? DEMO : EMPTY));
});
afterEach(cleanup);

it('renders the header and the health pill from the data', async () => {
  show();
  expect(screen.getByRole('heading', { level: 1, name: 'Deployments' })).toBeTruthy();
  expect(screen.getByText('Independent environments. Blue/Green routing for production.')).toBeTruthy();
  const pill = await screen.findByText('No environments deployed');
  expect(pill.closest('.sd-health')!.className).toMatch(/is-unknown/);
  const deploy = screen.getByRole('button', { name: /Deploy release/ });
  expect(deploy.getAttribute('aria-disabled')).toBe('true');
  expect(deploy.getAttribute('title')).toBe('Coming later');
  expect(api.getDashboard).toHaveBeenCalledWith({ demo: false, refresh: false });
});

it('shows a loading skeleton, then content', async () => {
  let resolve!: (v: unknown) => void;
  api.getDashboard.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
  const { container } = show();
  expect(container.querySelector('.sd-skeleton')).toBeTruthy();
  resolve(EMPTY);
  await screen.findByText('No environments deployed');
  expect(container.querySelector('.sd-skeleton')).toBeNull();
});

it('production inactive: gray pill, empty slots, no Activate button', async () => {
  show();
  const prod = await screen.findByRole('region', { name: 'Production' });
  expect(within(prod).getByText('No active deployment').closest('.sd-pill')!.className).toMatch(/is-muted/);
  expect(within(prod).getAllByText('Not deployed')).toHaveLength(2);
  expect(within(prod).getByText('Not configured')).toBeTruthy();
  expect(within(prod).queryByRole('button', { name: /Activate/ })).toBeNull();
  expect(prod.querySelector('.sd-slot-tag')).toBeNull();
});

it('production active (demo): active and standby slots, Activate Green coming later', async () => {
  show('/?demo=1');
  const prod = await screen.findByRole('region', { name: 'Production' });
  expect(within(prod).getByText('Deployment active').closest('.sd-pill')!.className).toMatch(/is-ok/);
  const blue = within(prod).getByText('Production Blue').closest('.sd-slot') as HTMLElement;
  expect(blue.className).toMatch(/is-active/);
  expect(within(blue).getByText('Active')).toBeTruthy();
  expect(within(blue).getByText('v2.8.0')).toBeTruthy();
  expect(within(blue).getByText('Healthy')).toBeTruthy();
  expect(within(blue).getByText('3 / 3 instances')).toBeTruthy();
  expect(within(blue).getByText('100% traffic')).toBeTruthy();
  const green = within(prod).getByText('Production Green').closest('.sd-slot') as HTMLElement;
  expect(green.className).toMatch(/is-standby/);
  expect(within(green).getByText('0 / 3 instances')).toBeTruthy();
  const act = within(green).getByRole('button', { name: 'Activate Green' });
  expect(act.getAttribute('aria-disabled')).toBe('true');
  expect(act.getAttribute('title')).toBe('Coming later');
  expect(within(prod).getByText('Blue active')).toBeTruthy();
});

it('cards with no environment yet offer Set up, which opens the Deploy page', async () => {
  show();
  const dev = await screen.findByRole('region', { name: 'Development' });
  expect(within(dev).getByText('No active deployment')).toBeTruthy();
  expect(within(dev).getByText('No releases yet')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Qa East' })).toBeTruthy();
  await userEvent.click(within(dev).getByRole('button', { name: 'Set up Dev' }));
  expect(path).toBe('/deploy');
});

it('environment cards show the type, version, state and last release', async () => {
  api.getDashboard.mockResolvedValue(REAL);
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  expect(within(uat).getByRole('link', { name: 'uat' }).getAttribute('href')).toBe('/deploy/environments/uat');
  expect(within(uat).getByText('Development')).toBeTruthy();
  expect(within(uat).getByText('e73b99ca')).toBeTruthy();
  expect(within(uat).getByText('Running')).toBeTruthy();
  expect(within(uat).getByText(/^Last release: e73b99ca · /)).toBeTruthy();
  const qa = screen.getByRole('region', { name: 'qa-east' });
  expect(within(qa).getByText('Last deploy failed')).toBeTruthy();
  expect(within(qa).getByText('No releases yet')).toBeTruthy();
  expect(screen.getByText('A deployment failed').closest('.sd-health')!.className).toMatch(/is-degraded/);
});

it("an environment card's Deploy opens the Deploy modal and follows the new deployment", async () => {
  api.getDashboard.mockResolvedValue(REAL);
  api.getEnvironment.mockResolvedValue(ENV);
  api.startDeployment.mockResolvedValue(RUNNING);
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  await userEvent.click(within(uat).getByRole('button', { name: 'Deploy uat' }));
  const dialog = await screen.findByRole('dialog', { name: 'Deploy uat' });
  expect(api.getEnvironment).toHaveBeenCalledWith('uat');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Deploy' }));
  await waitFor(() => expect(path).toBe('/deploy/environments/uat'));
  expect(loc).toBe('?deployment=d1');
});

it('a card whose environment is deploying has an inert Deploy', async () => {
  api.getDashboard.mockResolvedValue({ ...REAL, environments: [{ ...REAL.environments[0], state: 'deploying' }] });
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  expect(within(uat).getByText('Deploying')).toBeTruthy();
  const btn = within(uat).getByRole('button', { name: 'Deploy uat' });
  expect(btn.getAttribute('aria-disabled')).toBe('true');
  expect(btn.getAttribute('title')).toBe('A deployment is running.');
});

it('demo cards are inert, and without deploy:add cards have no actions', async () => {
  show('/?demo=1');
  const dev = await screen.findByRole('region', { name: 'Development' });
  const btn = within(dev).getByRole('button', { name: 'Deploy to Dev' });
  expect(btn.getAttribute('aria-disabled')).toBe('true');
  expect(btn.getAttribute('title')).toBe('Demo data');
  cleanup();
  perms.deploy = false;
  api.getDashboard.mockResolvedValue(REAL);
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  expect(within(uat).queryByRole('button')).toBeNull();
  expect(within(screen.getByRole('region', { name: 'Beta' })).queryByRole('button')).toBeNull();
});

it('the demo toggle sets ?demo=1, calls the API with demo and shows the strip', async () => {
  show();
  await screen.findByText('No environments deployed');
  expect(screen.queryByText(/Showing demo data/)).toBeNull();
  await userEvent.click(screen.getByLabelText('Demo data'));
  await screen.findByText('All systems healthy');
  expect(loc).toBe('?demo=1');
  expect(api.getDashboard).toHaveBeenLastCalledWith({ demo: true, refresh: false });
  expect(screen.getByText('Showing demo data — nothing here is real.')).toBeTruthy();
  await userEvent.click(screen.getByLabelText('Demo data'));
  await screen.findByText('No environments deployed');
  expect(loc).toBe('');
});

it('Refresh refetches with refresh=1', async () => {
  show('/?demo=1');
  await screen.findByText('All systems healthy');
  await userEvent.click(screen.getByRole('button', { name: /Refresh/ }));
  await waitFor(() => expect(api.getDashboard).toHaveBeenLastCalledWith({ demo: true, refresh: true }));
});

it('a failed load shows an alert with Retry', async () => {
  api.getDashboard.mockRejectedValueOnce(new ApiError(500, 'http_500', null));
  show();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toMatch(/Couldn't load the dashboard/);
  await userEvent.click(within(alert).getByRole('button', { name: 'Retry' }));
  await screen.findByText('No environments deployed');
  expect(screen.queryByRole('alert')).toBeNull();
});

it('the Deploy modal and its host-key prompt render outside .sd-dash', async () => {
  api.getDashboard.mockResolvedValue(REAL);
  api.getEnvironment.mockResolvedValue({ ...ENV, target: 'ssh' });
  api.startDeployment.mockRejectedValue(new ApiError(409, 'host_key_unknown', {
    code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' }));
  const { container } = show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  await userEvent.click(within(uat).getByRole('button', { name: 'Deploy uat' }));
  const dialog = await screen.findByRole('dialog', { name: 'Deploy uat' });
  expect(dialog.closest('.sd-dash')).toBeNull();
  expect(container.contains(dialog)).toBe(true);   // still inside the app (and its theme tokens), not portaled
  await userEvent.click(within(dialog).getByRole('button', { name: 'Deploy' }));
  const hostKey = await screen.findByRole('dialog', { name: 'Trust this server?' });
  expect(hostKey.closest('.sd-dash')).toBeNull();
  expect(container.contains(hostKey)).toBe(true);
});

it("an environment card's heading links to its page only with deploy:view", async () => {
  api.getDashboard.mockResolvedValue(REAL);
  perms.view = false;
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  expect(within(uat).queryByRole('link')).toBeNull();
  expect(within(uat).getByRole('heading', { name: 'uat' })).toBeTruthy();
});
