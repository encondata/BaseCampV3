// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ deploy: true, view: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a?: string) => r !== 'deploy'
      || (a === 'change' ? perms.change : a === 'view' ? perms.view : perms.deploy),
    preferences: { motion: false },
  }),
}));
const api = vi.hoisted(() => ({
  getDashboard: vi.fn(), getEnvironment: vi.fn(), startDeployment: vi.fn(), trustKnownHost: vi.fn(), activateSlot: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { ENV, RUNNING } from '../environments/testData';

import DashboardPage from './DashboardPage';
import { CLOUD, DEMO, EMPTY, FAILED_DO_CARD, REAL } from './testData';

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
  perms.deploy = true; perms.view = true; perms.change = true;
  window.localStorage.clear();
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

it('cards with no environment yet offer Set up, which opens the Deploy page', async () => {
  show();
  const dev = await screen.findByRole('region', { name: 'Development' });
  expect(within(dev).getByText('Not built yet')).toBeTruthy();
  expect(within(dev).getByText('No releases yet')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Qa East' })).toBeTruthy();
  await userEvent.click(within(dev).getByRole('button', { name: 'Set up Development' }));
  expect(path).toBe('/deploy');
});

it('environment cards show the type, version, state and last release', async () => {
  api.getDashboard.mockResolvedValue(REAL);
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
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
  api.getDashboard.mockResolvedValue({ ...REAL, environments: [{ ...REAL.environments[1], state: 'deploying' }] });
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  expect(within(uat).getByText('Deploying')).toBeTruthy();
  const btn = within(uat).getByRole('button', { name: 'Deploy' });
  expect(btn.getAttribute('aria-disabled')).toBe('true');
  expect(btn.getAttribute('title')).toBe('A deployment is running.');
});

it('demo cards are inert, and without deploy:add cards have no actions', async () => {
  show('/?demo=1');
  const dev = await screen.findByRole('region', { name: 'Development' });
  const btn = within(dev).getByRole('button', { name: 'Deploy' });
  expect(btn.getAttribute('aria-disabled')).toBe('true');
  expect(btn.getAttribute('title')).toBe('Demo data');
  cleanup();
  perms.deploy = false;
  api.getDashboard.mockResolvedValue(REAL);
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  expect(within(uat).queryByRole('button', { name: /^(Deploy|Set up)/ })).toBeNull();
  expect(within(screen.getByRole('region', { name: 'Beta' })).queryByRole('button', { name: /^(Deploy|Set up)/ })).toBeNull();
  expect(within(uat).getByRole('button', { name: 'Show uat' })).toBeTruthy();
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

const spot = () => screen.getByRole('region', { name: 'Selected environment' });
const findSpot = () => screen.findByRole('region', { name: 'Selected environment' });
const cardToggle = (label: string) => screen.getByRole('button', { name: `Show ${label}` });

it('Production is the first card; without one the spotlight says Not built yet with Set up', async () => {
  show();
  await screen.findByText('No environments deployed');
  const cards = screen.getAllByRole('button', { name: /^Show / });
  expect(cards[0].getAttribute('aria-label')).toBe('Show Production');
  expect(cards[0].getAttribute('aria-pressed')).toBe('true');
  expect(cards[0].closest('.sd-env')!.className).toMatch(/is-production/);
  expect(cards[1].closest('.sd-env')!.className).not.toMatch(/is-production/);
  expect(within(spot()).getByRole('heading', { name: 'Production' })).toBeTruthy();
  expect(within(spot()).getAllByText('Not built yet').length).toBeGreaterThan(0);
  await userEvent.click(within(spot()).getByRole('button', { name: 'Set up' }));
  expect(path).toBe('/deploy');
});

it('selects the production environment by default and shows its flow and certificate', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  expect(within(spot()).getByText('Running')).toBeTruthy();
  expect(within(spot()).getByText('Certificate: 64 days left').className).toMatch(/is-ok/);
  expect(within(spot()).getByText('Blue')).toBeTruthy();
  expect(within(spot()).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe('/deploy/environments/prod');
});

it('without a production environment the first real environment is selected, not the placeholder', async () => {
  api.getDashboard.mockResolvedValue(REAL);
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'uat' })).toBeTruthy());
  expect(cardToggle('uat').getAttribute('aria-pressed')).toBe('true');
  expect(cardToggle('Production').getAttribute('aria-pressed')).toBe('false');
});

it('clicking a card changes the spotlight, the URL and the remembered pick', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  show();
  await screen.findByRole('button', { name: 'Show uat9' });
  await userEvent.click(cardToggle('uat9'));
  expect(within(spot()).getByRole('heading', { name: 'uat9' })).toBeTruthy();
  expect(within(spot()).getByText('Certificate: 10 days left').className).toMatch(/is-warn/);
  expect(cardToggle('uat9').getAttribute('aria-pressed')).toBe('true');
  expect(cardToggle('prod').getAttribute('aria-pressed')).toBe('false');
  expect(loc).toBe('?env=uat9');
  expect(window.localStorage.getItem('sirdar.dashboard.env')).toBe('uat9');
});

it('?env= picks the spotlight; a remembered pick is used without it; an unknown one falls back', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  show('/?env=uat');
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'uat' })).toBeTruthy());
  expect(within(spot()).getByText('Nginx Proxy Manager')).toBeTruthy();
  cleanup();
  window.localStorage.setItem('sirdar.dashboard.env', 'uat9');
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'uat9' })).toBeTruthy());
  cleanup();
  window.localStorage.setItem('sirdar.dashboard.env', 'gone');
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
});

it('blocked storage still selects and follows clicks', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
  const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
  try {
    show();
    await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
    await userEvent.click(cardToggle('uat'));
    expect(within(spot()).getByRole('heading', { name: 'uat' })).toBeTruthy();
    expect(loc).toBe('?env=uat');
  } finally {
    get.mockRestore();
    set.mockRestore();
  }
});

it("a card's Deploy opens the Deploy modal without changing the selection", async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  api.getEnvironment.mockResolvedValue(ENV);
  show();
  const uat = await screen.findByRole('region', { name: 'uat' });
  await userEvent.click(within(uat).getByRole('button', { name: 'Deploy uat' }));
  expect(await screen.findByRole('dialog', { name: 'Deploy uat' })).toBeTruthy();
  expect(cardToggle('prod').getAttribute('aria-pressed')).toBe('true');
});

it("Activate on production's idle slot asks for the name, then follows the deployment", async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  api.activateSlot.mockResolvedValue({ ...RUNNING, id: 'd7' });
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  expect(within(spot()).queryByRole('button', { name: 'Activate Blue' })).toBeNull();     // the live one
  await userEvent.click(within(spot()).getByRole('button', { name: 'Activate Green' }));
  const dialog = await screen.findByRole('dialog', { name: 'Activate Green' });
  expect(dialog.closest('.sd-dash')).toBeNull();
  await userEvent.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Activate Green' }));
  await waitFor(() => expect(api.activateSlot).toHaveBeenCalledWith('prod', 'green', 'prod'));
  await waitFor(() => expect(path).toBe('/deploy/environments/prod'));
  expect(loc).toBe('?deployment=d7');
});

it('a non-production environment activates without a typed name', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  api.activateSlot.mockResolvedValue({ ...RUNNING, id: 'd8' });
  show('/?env=uat9');
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'uat9' })).toBeTruthy());
  await userEvent.click(within(spot()).getByRole('button', { name: 'Activate Purple' }));
  const dialog = await screen.findByRole('dialog', { name: 'Activate Purple' });
  expect(within(dialog).queryByLabelText(/to confirm/)).toBeNull();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Activate Purple' }));
  await waitFor(() => expect(api.activateSlot).toHaveBeenCalledWith('uat9', 'purple', undefined));
});

it('Activate needs deploy:add and deploy:change, a deployed idle slot and no running deployment', async () => {
  const prod = CLOUD.environments[0];
  const notDeployed = { ...prod, flow: { ...prod.flow,
    servers: prod.flow.servers.map((s) => (s.id === 'green' ? { ...s, deployed: false, version: null } : s)) } };
  const deploying = { ...prod, state: 'deploying', flow: { ...prod.flow, deploying_slot: 'green' } };
  for (const env of [notDeployed, deploying]) {
    api.getDashboard.mockResolvedValue({ ...CLOUD, environments: [env, ...CLOUD.environments.slice(1)] });
    show();
    await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
    expect(within(spot()).queryByRole('button', { name: /Activate/ })).toBeNull();
    cleanup();
  }
  api.getDashboard.mockResolvedValue(CLOUD);
  for (const p of ['change', 'deploy'] as const) {
    perms.change = p !== 'change';
    perms.deploy = p !== 'deploy';
    show();
    await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
    expect(within(spot()).queryByRole('button', { name: /Activate/ })).toBeNull();
    cleanup();
  }
});

it('a failed deploy on a two-slot environment says the live slot still serves', async () => {
  api.getDashboard.mockResolvedValue({ ...CLOUD, environments: [CLOUD.environments[0], FAILED_DO_CARD] });
  show('/?env=uat9');
  expect(await within(await findSpot()).findByText('Failed — Orange still live')).toBeTruthy();
  cleanup();
  // the environment itself still runs (a failed Activate leaves it active): the mark still shows
  api.getDashboard.mockResolvedValue({ ...CLOUD, environments: [CLOUD.environments[0], { ...FAILED_DO_CARD, state: 'active' }] });
  show('/?env=uat9');
  expect(await within(await findSpot()).findByText('Failed — Orange still live')).toBeTruthy();
  cleanup();
  // a one-server environment just says its last deploy failed
  api.getDashboard.mockResolvedValue(REAL);
  show('/?env=qa-east');
  expect(await within(await findSpot()).findByText('Last deploy failed')).toBeTruthy();
});

it('demo data: every spotlight action is inert', async () => {
  show('/?demo=1');
  await screen.findByText('All systems healthy');
  for (const name of [/^Deploy/, 'Open', 'Activate Green']) {
    const btn = within(spot()).getByRole('button', { name });
    expect(btn.getAttribute('aria-disabled')).toBe('true');
  }
});

it('Open shows only with deploy:view', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  perms.view = false;
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  expect(within(spot()).queryByRole('link', { name: 'Open' })).toBeNull();
});

it('a pick made on demo data is not remembered, and leaving demo drops it from the URL', async () => {
  api.getDashboard.mockImplementation(async (o: { demo?: boolean }) => (o?.demo ? DEMO : CLOUD));
  show('/?demo=1');
  await screen.findByText('All systems healthy');
  await userEvent.click(cardToggle('Development'));
  expect(within(spot()).getByRole('heading', { name: 'Development' })).toBeTruthy();
  await userEvent.click(cardToggle('UAT'));     // demo's "uat" id is also a real environment
  expect(loc).toBe('?demo=1&env=uat');
  expect(window.localStorage.getItem('sirdar.dashboard.env')).toBeNull();
  await userEvent.click(screen.getByLabelText('Demo data'));
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  expect(loc).toBe('');
});

it('an unknown ?env= falls back to the remembered pick before the default', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  window.localStorage.setItem('sirdar.dashboard.env', 'uat9');
  show('/?env=gone');
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'uat9' })).toBeTruthy());
});

it('the certificate pill: red when expired, singular at one day', async () => {
  const prod = CLOUD.environments[0];
  const withCert = (certificate: typeof prod.flow.certificate) =>
    ({ ...CLOUD, environments: [{ ...prod, flow: { ...prod.flow, certificate } }] });
  api.getDashboard.mockResolvedValue(withCert({ days_left: 0, expires_at: '2026-10-01T00:00:00+00:00', tone: 'bad', hosts: [] }));
  show();
  expect((await within(await findSpot()).findByText('Certificate expired')).className).toMatch(/is-bad/);
  cleanup();
  api.getDashboard.mockResolvedValue(withCert({ days_left: 1, expires_at: '2026-10-07T00:00:00+00:00', tone: 'warn', hosts: [] }));
  show();
  expect((await within(await findSpot()).findByText('Certificate: 1 day left')).className).toMatch(/is-warn/);
});

const envCard = (label: string) => screen.getByRole('region', { name: label });

it('every environment card shows its certificate pill, LAN and DigitalOcean alike', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  show();
  await screen.findByRole('button', { name: 'Show uat9' });
  expect(within(envCard('prod')).getByText('Certificate: 64 days left').className).toMatch(/is-ok/);
  expect(within(envCard('uat9')).getByText('Certificate: 10 days left').className).toMatch(/is-warn/);
  expect(within(envCard('uat')).getByText('Certificate: 47 days left').className).toMatch(/is-ok/);
});

it('placeholder cards have no certificate pill', async () => {
  show();
  await screen.findByRole('region', { name: 'Development' });
  expect(screen.queryByText(/^Certificate/)).toBeNull();
});

it('a LAN environment shows its certificate in the spotlight', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  show();
  await screen.findByRole('button', { name: 'Show uat' });
  await userEvent.click(cardToggle('uat'));
  expect(within(spot()).getByRole('heading', { name: 'uat' })).toBeTruthy();
  expect(within(spot()).getByText('Certificate: 47 days left').className).toMatch(/is-ok/);
});

it("a certificate no host answered for is gray: couldn't check", async () => {
  const lan = CLOUD.environments[2];
  const unknown = { ...lan, flow: { ...lan.flow, certificate: {
    days_left: null, expires_at: null, tone: 'unknown' as const,
    hosts: [{ hostname: 'portal.uat.serversherpa.com', expires_at: null, days_left: null, error: "Couldn't connect" }] } } };
  api.getDashboard.mockResolvedValue({ ...CLOUD, environments: [unknown] });
  show();
  const pill = await within(await findSpot()).findByText("Certificate: couldn't check");
  expect(pill.className).toMatch(/is-muted/);
  expect(pill.getAttribute('title')).toBe("portal.uat.serversherpa.com — couldn't check");
  expect(within(envCard('uat')).getByText("Certificate: couldn't check").className).toMatch(/is-muted/);
});

it('hovering the pill lists every host: days left, singular at one, expired, or couldn\'t check', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  show();
  await screen.findByRole('button', { name: 'Show uat' });
  expect(within(envCard('uat')).getByText('Certificate: 47 days left').getAttribute('title')).toBe(
    "portal.uat.serversherpa.com — 47 days left\nkiosk.uat.serversherpa.com — couldn't check");
  cleanup();
  const prod = CLOUD.environments[0];
  const hosts = [
    { hostname: 'api.serversherpa.com', expires_at: '2026-10-07T00:00:00+00:00', days_left: 1, error: null },
    { hostname: 'portal.serversherpa.com', expires_at: '2026-10-01T00:00:00+00:00', days_left: 0, error: null }];
  api.getDashboard.mockResolvedValue({ ...CLOUD, environments: [{ ...prod, flow: { ...prod.flow, certificate: {
    days_left: 0, expires_at: '2026-10-01T00:00:00+00:00', tone: 'bad' as const, hosts } } }] });
  show();
  const pill = await within(await findSpot()).findByText('Certificate expired');
  expect(pill.getAttribute('title')).toBe('api.serversherpa.com — 1 day left\nportal.serversherpa.com — expired');
});

it('switching cards remounts the flow, so it re-measures and restarts', async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  const before = spot().querySelector('.sd-flow')!;
  await userEvent.click(cardToggle('uat9'));
  expect(before.isConnected).toBe(false);
  expect(spot().querySelector('.sd-flow')).toBeTruthy();
});

it("a demo card's Deploy is inert and leaves the selection alone", async () => {
  show('/?demo=1');
  const dev = await screen.findByRole('region', { name: 'Development' });
  await userEvent.click(within(dev).getByRole('button', { name: 'Deploy' }));
  expect(cardToggle('Production').getAttribute('aria-pressed')).toBe('true');
  expect(cardToggle('Development').getAttribute('aria-pressed')).toBe('false');
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('Deploying reads the same on the card and in the spotlight', async () => {
  const prod = { ...CLOUD.environments[0], state: 'deploying' };
  api.getDashboard.mockResolvedValue({ ...CLOUD, environments: [prod, ...CLOUD.environments.slice(1)] });
  show();
  const spotPill = (await within(await findSpot()).findByText('Deploying', { selector: '.sd-pill' }));
  const card = screen.getByRole('button', { name: 'Show prod' }).closest('.sd-env') as HTMLElement;
  const cardPill = within(card).getByText('Deploying', { selector: '.sd-pill' });
  expect(cardPill.className).toBe(spotPill.className);
});

it("a card says a failed slot leaves the live one serving, as the spotlight does", async () => {
  api.getDashboard.mockResolvedValue({ ...CLOUD, environments: [CLOUD.environments[0], { ...FAILED_DO_CARD, state: 'active' }] });
  show();
  const card = await screen.findByRole('region', { name: 'uat9' });
  expect(within(card).getByText('Failed — Orange still live').className).toMatch(/is-warn/);
  expect(within(card).queryByText('Running')).toBeNull();
});

it('a retiring production offers no Activate', async () => {
  const prod = { ...CLOUD.environments[0], retiring: true };
  api.getDashboard.mockResolvedValue({ ...CLOUD, environments: [prod, ...CLOUD.environments.slice(1)] });
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  expect(within(spot()).queryByRole('button', { name: /Activate/ })).toBeNull();
});

it('a running deployment (a renew included) makes Deploy and Activate inert, saying why', async () => {
  const prod = { ...CLOUD.environments[0], running: true };   // the state still reads active during a renew
  api.getDashboard.mockResolvedValue({ ...CLOUD, environments: [prod, ...CLOUD.environments.slice(1)] });
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  for (const btn of [within(spot()).getByRole('button', { name: 'Deploy' }),
                     within(spot()).getByRole('button', { name: 'Activate Green' }),
                     within(screen.getByRole('region', { name: 'prod' })).getByRole('button', { name: 'Deploy' })]) {
    expect(btn.getAttribute('aria-disabled')).toBe('true');
    expect(btn.getAttribute('title')).toBe('A deployment is running.');
    await userEvent.click(btn);
  }
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(api.getEnvironment).not.toHaveBeenCalled();
});

it("the traffic box names the environment's traffic and opens its portal in a new tab", async () => {
  api.getDashboard.mockResolvedValue(CLOUD);
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'prod' })).toBeTruthy());
  const live = within(spot()).getByRole('link', { name: /Live traffic/ });
  expect(live.getAttribute('href')).toBe('https://portal.prod.serversherpa.com');
  expect(live.getAttribute('target')).toBe('_blank');
  expect(live.getAttribute('rel')).toBe('noopener noreferrer');
  await userEvent.click(cardToggle('uat9'));
  const dev = within(spot()).getByRole('link', { name: /uat9 traffic/ });
  expect(dev.getAttribute('href')).toBe('https://portal.uat9.serversherpa.com');
  expect(within(spot()).queryByText('Live traffic')).toBeNull();
});

it('without a portal address the traffic box is not a link', async () => {
  api.getDashboard.mockResolvedValue(REAL);
  show();
  await waitFor(() => expect(within(spot()).getByRole('heading', { name: 'uat' })).toBeTruthy());
  await userEvent.click(cardToggle('Production'));
  expect(within(spot()).getByText('Live traffic')).toBeTruthy();
  expect(within(spot()).queryByRole('link', { name: /traffic/ })).toBeNull();
});

it('demo data: the traffic box is not a link', async () => {
  show('/?demo=1');
  await screen.findByText('All systems healthy');
  expect(within(spot()).queryByRole('link', { name: /traffic/ })).toBeNull();
});
