// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
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
  getPublishPlan: vi.fn(), claimPublish: vi.fn(), updateEnvironment: vi.fn(), startDeployment: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import type { Environment, PublishPlan } from '../../lib/sirdarApi';

import PublishTab from './PublishTab';
import { DO_ENV, ENV, PUBLISHED_ENV, PUBLISHING, PUBLISH_PLAN, summary } from './testData';

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getPublishPlan.mockResolvedValue(PUBLISH_PLAN);
  api.startDeployment.mockResolvedValue(PUBLISHING);
});
afterEach(cleanup);

function show(env: Environment = ENV) {
  const onStarted = vi.fn();
  const onChanged = vi.fn();
  render(<MemoryRouter><PublishTab env={env} onStarted={onStarted} onChanged={onChanged} /></MemoryRouter>);
  return { onStarted, onChanged };
}

const cells = (row: HTMLElement) => within(row).getAllByRole('cell');

it('shows what publishing would do for each public name', async () => {
  show();
  const table = await screen.findByRole('table', { name: 'Public names' });
  const [api_, portal, kiosk] = within(table).getAllByRole('row').slice(1);
  expect(cells(api_)[1].textContent).toBe('api.uat.serversherpa.com');
  expect(cells(api_)[2].textContent).toBe('10.10.48.63:8000');
  expect(within(cells(api_)[3]).getByText("Not Sirdar's")).toBeTruthy();
  expect(within(cells(api_)[3]).getByText('A 203.0.113.7, made outside Sirdar.')).toBeTruthy();
  expect(within(cells(api_)[5]).getByText('Valid')).toBeTruthy();
  expect(within(cells(portal)[3]).getByText('Up to date')).toBeTruthy();
  expect(within(cells(kiosk)[3]).getByText('Blocked')).toBeTruthy();
  expect(within(cells(kiosk)[5]).getByText('Will request')).toBeTruthy();
  expect(api.getPublishPlan).toHaveBeenCalledWith('uat');
  expect(screen.getByText(/Claim them to let Sirdar keep them up to date/)).toBeTruthy();
});

it('Claim existing claims the hand-made entries and says what it claimed', async () => {
  api.claimPublish.mockResolvedValue({
    ...PUBLISH_PLAN, claimed: ['dns:api.uat.serversherpa.com', 'proxy:api.uat.serversherpa.com'],
    services: PUBLISH_PLAN.services.map((s) => (s.service === 'api'
      ? { ...s, dns: { ...s.dns, state: 'ok', origin: 'claimed' }, proxy: { ...s.proxy, state: 'ok', origin: 'claimed' } }
      : s)),
  });
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Claim existing' }));
  expect(await screen.findByRole('status')).toHaveProperty('textContent',
    'Claimed 2: dns:api.uat.serversherpa.com, proxy:api.uat.serversherpa.com. Sirdar keeps them up to date and '
    + 'never deletes them.');
  expect(api.claimPublish).toHaveBeenCalledWith('uat');
  const row = within(screen.getByRole('table', { name: 'Public names' })).getAllByRole('row')[1];
  expect(within(cells(row)[3]).getByText('claimed')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Claim existing' }) as HTMLButtonElement).disabled).toBe(true);
});

it('the switch turns Publish on through the environment PATCH', async () => {
  api.updateEnvironment.mockResolvedValue(PUBLISHED_ENV);
  const { onChanged } = show();
  const group = await screen.findByRole('radiogroup', { name: 'Publish DNS and proxy' });
  expect(within(group).getByRole('radio', { name: 'Off' }).getAttribute('aria-checked')).toBe('true');
  expect(screen.getByText('Deploys leave DNS and the proxy as they are.')).toBeTruthy();
  await userEvent.click(within(group).getByRole('radio', { name: 'On' }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledWith(PUBLISHED_ENV));
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { publish: true });
});

it('Publish now starts a publish job once publishing is on, set up and deployed', async () => {
  const { onStarted } = show(PUBLISHED_ENV);
  const button = (await screen.findByRole('button', { name: 'Publish now' })) as HTMLButtonElement;
  await waitFor(() => expect(button.disabled).toBe(false));
  await userEvent.click(button);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(PUBLISHING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat', { mode: 'publish' });
});

it('Publish now waits for the switch, both integrations and a deployed commit', async () => {
  show();
  const off = (await screen.findByRole('button', { name: 'Publish now' })) as HTMLButtonElement;
  expect(off.disabled).toBe(true);
  cleanup();
  api.getPublishPlan.mockResolvedValue({ ...PUBLISH_PLAN, npm: { configured: false, url: null, error: null } });
  show(PUBLISHED_ENV);
  const link = await screen.findByRole('link', { name: 'Settings › Integrations' });
  expect(link.getAttribute('href')).toBe('/settings');
  expect((screen.getByRole('button', { name: 'Publish now' }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  api.getPublishPlan.mockResolvedValue(PUBLISH_PLAN);
  show({ ...PUBLISHED_ENV, current_sha: null });
  await screen.findByRole('table', { name: 'Public names' });
  expect((screen.getByRole('button', { name: 'Publish now' }) as HTMLButtonElement).disabled).toBe(true);
});

it('says why a section is unknown', async () => {
  api.getPublishPlan.mockResolvedValue({
    ...PUBLISH_PLAN, cloudflare: { ...PUBLISH_PLAN.cloudflare, error: "Couldn't reach the Cloudflare API." },
    services: PUBLISH_PLAN.services.map((s) => ({ ...s, dns: { ...s.dns, state: 'unknown', detail: '' } })),
  });
  show();
  expect(await screen.findByText("Cloudflare: Couldn't reach the Cloudflare API.")).toBeTruthy();
  const row = within(screen.getByRole('table', { name: 'Public names' })).getAllByRole('row')[1];
  expect(within(cells(row)[3]).getByText('Unknown')).toBeTruthy();
});

it('a view-only reader gets no Claim or Publish now and a locked switch', async () => {
  perms.add = false; perms.change = false;
  show();
  await screen.findByRole('table', { name: 'Public names' });
  expect(screen.queryByRole('button', { name: 'Claim existing' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Publish now' })).toBeNull();
  const on = screen.getByRole('radio', { name: 'On' });
  expect(on.getAttribute('aria-disabled')).toBe('true');
  await userEvent.click(on);
  expect(api.updateEnvironment).not.toHaveBeenCalled();
});

it('a certificate that waits for its proxy host reads neutrally, not as an error', async () => {
  api.getPublishPlan.mockResolvedValue({
    ...PUBLISH_PLAN,
    services: PUBLISH_PLAN.services.map((s) => ({
      ...s, certificate: { state: 'unknown', detail: 'Waits for the proxy host.', expires_on: null },
    })),
  });
  show();
  const table = await screen.findByRole('table', { name: 'Public names' });
  const cert = cells(within(table).getAllByRole('row')[1])[5];
  expect(within(cert).getByText('Unknown').className).not.toMatch(/c-red/);
  expect(within(cert).getByText('Waits for the proxy host.')).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('a failed first load shows the error and stops saying Loading', async () => {
  api.getPublishPlan.mockRejectedValue(new ApiError(500, 'server_error', { code: 'server_error' }));
  show();
  expect(await screen.findByText("Couldn't load the publish plan.")).toBeTruthy();
  expect(screen.getByRole('alert').textContent).toBe("Couldn't read what publishing would do.");
  expect(screen.queryByText('Loading…')).toBeNull();
});

it('Refresh is disabled and says so while a read is in flight', async () => {
  let release: (p: PublishPlan) => void = () => {};
  api.getPublishPlan.mockImplementation(() => new Promise((r) => { release = r; }));
  show();
  const refresh = screen.getByRole('button', { name: 'Refreshing…' }) as HTMLButtonElement;
  expect(refresh.disabled).toBe(true);
  release(PUBLISH_PLAN);
  await waitFor(() => expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false));
  await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
  expect((screen.getByRole('button', { name: 'Refreshing…' }) as HTMLButtonElement).disabled).toBe(true);
  expect(api.getPublishPlan).toHaveBeenCalledTimes(2);
  release(PUBLISH_PLAN);
  await screen.findByRole('button', { name: 'Refresh' });
});

it('while a deployment runs the switch is locked and says why', async () => {
  show({ ...PUBLISHED_ENV, last_deployment: summary(PUBLISHING) });
  await screen.findByRole('table', { name: 'Public names' });
  const group = screen.getByRole('radiogroup', { name: 'Publish DNS and proxy' });
  expect(group.getAttribute('title')).toBe('A deployment is running.');
  expect(within(group).getByRole('radio', { name: 'Off' }).getAttribute('aria-disabled')).toBe('true');
  expect(screen.getByText("Publish can't change while a deployment is running.")).toBeTruthy();
  await userEvent.click(within(group).getByRole('radio', { name: 'Off' }));
  expect(api.updateEnvironment).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'Publish now' }) as HTMLButtonElement).title).toBe('A deployment is running.');
});

/** A DigitalOcean environment's plan: DNS at the load balancer, no Nginx Proxy Manager section. */
const DO_PLAN: PublishPlan = {
  ...PUBLISH_PLAN, publish: true,
  cloudflare: { configured: true, zone: 'serversherpa.com', public_ip: '203.0.113.50', error: null },
  npm: { configured: false, url: null, error: null },
  services: PUBLISH_PLAN.services.map((s) => ({
    ...s, proxy: { state: 'unknown', detail: '', origin: null, host_id: null },
    certificate: { state: 'unknown', detail: '', expires_on: null },
  })),
};

it('DigitalOcean: the switch is read-only, DNS only, and Claim and Publish now still work', async () => {
  api.getPublishPlan.mockResolvedValue(DO_PLAN);
  api.claimPublish.mockResolvedValue({ ...DO_PLAN, claimed: ['dns:api.uat.serversherpa.com'] });
  const { onStarted } = show(DO_ENV);
  const table = await screen.findByRole('table', { name: 'Public names' });
  expect(within(table).queryByRole('columnheader', { name: 'Proxy host' })).toBeNull();
  expect(within(table).queryByRole('columnheader', { name: 'Certificate' })).toBeNull();
  const group = screen.getByRole('radiogroup', { name: 'Publish DNS' });
  expect(within(group).getByRole('radio', { name: 'On' }).getAttribute('aria-disabled')).toBe('true');
  await userEvent.click(within(group).getByRole('radio', { name: 'Off' }));
  expect(api.updateEnvironment).not.toHaveBeenCalled();
  expect(screen.getByText('DigitalOcean environments publish their DNS during each deploy.')).toBeTruthy();
  expect(screen.queryByRole('link', { name: 'Settings › Integrations' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Claim existing' }));
  await waitFor(() => expect(api.claimPublish).toHaveBeenCalledWith('uat9'));
  const now = screen.getByRole('button', { name: 'Publish now' }) as HTMLButtonElement;
  expect(now.disabled).toBe(false);
  await userEvent.click(now);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(PUBLISHING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat9', { mode: 'publish' });
});

it('DigitalOcean: without Cloudflare it asks for Cloudflare only', async () => {
  api.getPublishPlan.mockResolvedValue({ ...DO_PLAN, cloudflare: { ...DO_PLAN.cloudflare, configured: false } });
  show(DO_ENV);
  expect(await screen.findByText(/Set up Cloudflare in/)).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Publish now' }) as HTMLButtonElement).disabled).toBe(true);
});
