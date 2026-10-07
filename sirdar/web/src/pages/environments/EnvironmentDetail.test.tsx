// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));
const api = vi.hoisted(() => ({
  getEnvironment: vi.fn(), getDeployTargets: vi.fn(), startDeployment: vi.fn(), trustKnownHost: vi.fn(),
  listDeployments: vi.fn(), updateEnvironment: vi.fn(), getEnvironmentDefaults: vi.fn(),
  listSnapshots: vi.fn(), listBackups: vi.fn(), getPublishPlan: vi.fn(), claimPublish: vi.fn(),
  activateSlot: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));
vi.mock('./DeploymentView', () => ({ default: ({ id }: { id: string }) => <div>deployment view {id}</div> }));

import { ApiError } from '@portal/lib/api';

import EnvironmentDetail, { ENV_POLL_MS } from './EnvironmentDetail';
import {
  ADOPTED, BACKUPS, DEFAULTS, DO_ENV, ENV, LAN_ENV, FAILED, PUBLISHED_ENV, PUBLISHING, PUBLISH_PLAN, RUNNING, TARGETS, TEARDOWN, summary,
} from './testData';

Element.prototype.scrollIntoView = () => {};
beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getEnvironmentDefaults.mockResolvedValue(DEFAULTS);
  api.getEnvironment.mockResolvedValue(ENV);
  api.getDeployTargets.mockResolvedValue(TARGETS);
  api.listDeployments.mockResolvedValue({ deployments: [summary(RUNNING), ADOPTED] });
  api.listSnapshots.mockResolvedValue({ snapshots: [] });
  api.listBackups.mockResolvedValue({ backups: BACKUPS });
  api.getPublishPlan.mockResolvedValue(PUBLISH_PLAN);
});
afterEach(cleanup);

function show(path = '/deploy/environments/uat') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/deploy/environments/:name" element={<><EnvironmentDetail /><Link to="/deploy/environments/beta">Go to beta</Link></>} />
      </Routes>
    </MemoryRouter>,
  );
}

it('shows the header and the Overview: commit, image tag, services and links', async () => {
  show();
  expect(await screen.findByRole('heading', { level: 1, name: 'uat' })).toBeTruthy();
  expect(api.getEnvironment).toHaveBeenCalledWith('uat');
  expect(await screen.findByText('Dev · Lab box · uat.serversherpa.com')).toBeTruthy();
  expect(screen.getByText('Ready')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.getByText(ENV.current_sha!)).toBeTruthy();
  expect(screen.getByText('/opt/serversherpa/uat')).toBeTruthy();
  const table = screen.getByRole('table', { name: 'Services' });
  expect(within(table).getByRole('link', { name: 'https://api.uat.serversherpa.com' }).getAttribute('href'))
    .toBe('https://api.uat.serversherpa.com');
  expect(within(table).getByRole('link', { name: '10.10.48.63:8025' }).getAttribute('href')).toBe('http://10.10.48.63:8025');
  expect(within(table).getByText('10.10.48.63:8000')).toBeTruthy();
  expect(screen.getByText('Deploy', { selector: '.eyebrow a' }).getAttribute('href')).toBe('/deploy');
});

it('Deploy opens the Deploy modal; starting reloads the environment', async () => {
  api.startDeployment.mockResolvedValue(RUNNING);
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }));
  const dialog = await screen.findByRole('dialog', { name: 'Deploy uat' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Deploy' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(api.getEnvironment).toHaveBeenCalledTimes(2);
  expect(api.startDeployment).toHaveBeenCalledTimes(1);
  expect(api.startDeployment).toHaveBeenCalledWith('uat', { mode: 'update', git_ref: 'main' });
});

it('a view-only reader has no Deploy button; a running deployment disables it', async () => {
  perms.add = false; perms.change = false;
  show();
  await screen.findByRole('heading', { level: 1, name: 'uat' });
  expect(screen.queryByRole('button', { name: 'Deploy' })).toBeNull();
  cleanup();
  perms.add = true;
  api.getEnvironment.mockResolvedValue({ ...ENV, status: 'deploying' });
  show();
  expect(((await screen.findByRole('button', { name: 'Deploy' })) as HTMLButtonElement).disabled).toBe(true);
});

it('an unknown environment shows the error', async () => {
  api.getEnvironment.mockRejectedValue(new ApiError(404, 'environment_not_found', { code: 'environment_not_found' }));
  show('/deploy/environments/gone');
  expect((await screen.findByRole('alert')).textContent).toBe('That environment no longer exists.');
});

it('?deployment= opens the Deployments tab on that deployment', async () => {
  show('/deploy/environments/uat?deployment=d1');
  expect(await screen.findByText('deployment view d1')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Deployments' }).getAttribute('aria-selected')).toBe('true');
});

it('a started deployment opens on the Deployments tab', async () => {
  api.startDeployment.mockResolvedValue(RUNNING);
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Deploy' }));
  await userEvent.click(within(await screen.findByRole('dialog', { name: 'Deploy uat' })).getByRole('button', { name: 'Deploy' }));
  expect(await screen.findByText('deployment view d1')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Deployments' }).getAttribute('aria-selected')).toBe('true');
});

it('switching tabs closes the deployment view (and so stops its polling)', async () => {
  show('/deploy/environments/uat?deployment=d1');
  await screen.findByText('deployment view d1');
  await userEvent.click(screen.getByRole('tab', { name: 'Overview' }));
  expect(screen.queryByText('deployment view d1')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
});

it('moving to another environment resets the page and ignores late answers for the old one', async () => {
  const BETA = { ...ENV, id: 'e2', name: 'beta', base_domain: 'beta.serversherpa.com' };
  let lateUat: (e: typeof ENV) => void = () => {};
  api.getEnvironment.mockResolvedValueOnce(ENV)
    .mockImplementationOnce(() => new Promise((r) => { lateUat = r; }))   // a reload still out for uat
    .mockResolvedValueOnce(BETA);
  api.startDeployment.mockResolvedValue(RUNNING);
  show('/deploy/environments/uat?deployment=d1');
  await screen.findByText('deployment view d1');
  // A deploy reloads uat; that answer is held back while we move to beta.
  await userEvent.click(screen.getByRole('button', { name: 'Deploy' }));
  await userEvent.click(within(await screen.findByRole('dialog', { name: 'Deploy uat' })).getByRole('button', { name: 'Deploy' }));
  await waitFor(() => expect(api.getEnvironment).toHaveBeenCalledTimes(2));
  await userEvent.click(screen.getByRole('link', { name: 'Go to beta' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'beta' })).toBeTruthy();
  expect(api.getEnvironment).toHaveBeenLastCalledWith('beta');
  expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
  expect(screen.queryByText(/deployment view/)).toBeNull();
  await act(async () => { lateUat(ENV); });
  expect(screen.getByRole('heading', { level: 1, name: 'beta' })).toBeTruthy();
  expect(screen.queryByRole('heading', { level: 1, name: 'uat' })).toBeNull();
});

it('shows Loading, not the old environment, while the new one loads', async () => {
  api.getEnvironment.mockResolvedValueOnce(ENV).mockImplementationOnce(() => new Promise(() => {}));
  show();
  await screen.findByRole('heading', { level: 1, name: 'uat' });
  await userEvent.click(screen.getByRole('link', { name: 'Go to beta' }));
  expect(await screen.findByText('Loading…')).toBeTruthy();
  expect(screen.queryByRole('heading', { level: 1, name: 'uat' })).toBeNull();
});

it('the Settings tab edits the environment and updates the page', async () => {
  api.updateEnvironment.mockResolvedValue({ ...ENV, base_domain: 'uat2.serversherpa.com' });
  show();
  await userEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
  await userEvent.clear(screen.getByLabelText('Base domain'));
  await userEvent.type(screen.getByLabelText('Base domain'), 'uat2.serversherpa.com');
  await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
  expect(await screen.findByText('Dev · Lab box · uat2.serversherpa.com')).toBeTruthy();
  expect(api.updateEnvironment).toHaveBeenCalledWith('uat', { base_domain: 'uat2.serversherpa.com' });
});

describe('while the environment is deploying', () => {
  beforeEach(() => { vi.useFakeTimers({ shouldAdvanceTime: true }); });
  afterEach(() => { vi.useRealTimers(); });
  const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it('reloads it every 5 s on any tab; a later Ready re-enables Deploy', async () => {
    api.getEnvironment.mockResolvedValueOnce({ ...ENV, status: 'deploying' })
      .mockResolvedValueOnce({ ...ENV, status: 'deploying' })
      .mockResolvedValue(ENV);
    show();
    const deploy = (await screen.findByRole('button', { name: 'Deploy' })) as HTMLButtonElement;
    expect(deploy.disabled).toBe(true);
    expect(screen.getByRole('tab', { name: 'Overview' }).getAttribute('aria-selected')).toBe('true');
    expect(ENV_POLL_MS).toBe(5000);
    await tick(ENV_POLL_MS);
    expect(api.getEnvironment).toHaveBeenCalledTimes(2);
    expect(deploy.disabled).toBe(true);
    await tick(ENV_POLL_MS);
    expect(api.getEnvironment).toHaveBeenCalledTimes(3);
    await waitFor(() => expect((screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText('Ready')).toBeTruthy();
    await tick(ENV_POLL_MS * 4);                 // ready: polling stops
    expect(api.getEnvironment).toHaveBeenCalledTimes(3);
  });

  it('a publish job keeps the status Ready, yet the page polls and locks Deploy, Claim and Delete until it ends', async () => {
    const publishing = { ...PUBLISHED_ENV, last_deployment: summary(PUBLISHING) };
    const done = { ...PUBLISHED_ENV, last_deployment: summary({ ...PUBLISHING, status: 'succeeded' }) };
    api.getEnvironment.mockResolvedValueOnce(publishing).mockResolvedValueOnce(publishing).mockResolvedValue(done);
    show();
    const deploy = (await screen.findByRole('button', { name: 'Deploy' })) as HTMLButtonElement;
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(deploy.disabled).toBe(true);
    await userEvent.click(screen.getByRole('tab', { name: 'Publish' }));
    await screen.findByRole('table', { name: 'Public names' });
    expect((screen.getByRole('button', { name: 'Claim existing' }) as HTMLButtonElement).disabled).toBe(true);
    expect(api.getPublishPlan).toHaveBeenCalledTimes(1);
    await tick(ENV_POLL_MS);
    expect(api.getEnvironment).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    expect((screen.getByRole('button', { name: 'Delete environment…' }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole('tab', { name: 'Publish' }));
    await screen.findByRole('table', { name: 'Public names' });
    const plans = api.getPublishPlan.mock.calls.length;
    await tick(ENV_POLL_MS);                     // the job ended
    expect(api.getEnvironment).toHaveBeenCalledTimes(3);
    await waitFor(() => expect(deploy.disabled).toBe(false));
    expect((screen.getByRole('button', { name: 'Claim existing' }) as HTMLButtonElement).disabled).toBe(false);
    expect(api.getPublishPlan.mock.calls.length).toBe(plans + 1);   // the plan is read again
    await tick(ENV_POLL_MS * 4);                 // polling stops
    expect(api.getEnvironment).toHaveBeenCalledTimes(3);
  });

  it('never overlaps reloads, and stops when the page goes away', async () => {
    let release: (e: typeof ENV) => void = () => {};
    api.getEnvironment.mockResolvedValueOnce({ ...ENV, status: 'deploying' })
      .mockImplementationOnce(() => new Promise((r) => { release = r; }))
      .mockResolvedValue({ ...ENV, status: 'deploying' });
    show();
    await screen.findByRole('heading', { level: 1, name: 'uat' });
    await tick(ENV_POLL_MS);
    expect(api.getEnvironment).toHaveBeenCalledTimes(2);
    await tick(ENV_POLL_MS * 4);                 // the second request is still out
    expect(api.getEnvironment).toHaveBeenCalledTimes(2);
    await act(async () => { release({ ...ENV, status: 'deploying' }); });
    await tick(ENV_POLL_MS);
    expect(api.getEnvironment).toHaveBeenCalledTimes(3);
    cleanup();
    await tick(ENV_POLL_MS * 4);
    expect(api.getEnvironment).toHaveBeenCalledTimes(3);
  });

  it('once a deleting environment is gone, the page says so', async () => {
    api.getEnvironment.mockResolvedValueOnce({ ...ENV, status: 'deleting' })
      .mockRejectedValue(new ApiError(404, 'environment_not_found', { code: 'environment_not_found' }));
    show();
    expect(await screen.findByText('Deleting')).toBeTruthy();
    await tick(ENV_POLL_MS);
    expect(await screen.findByText('uat was deleted.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Back to Deploy' }).getAttribute('href')).toBe('/deploy');
    await tick(ENV_POLL_MS * 3);                 // gone: polling stops
    expect(api.getEnvironment).toHaveBeenCalledTimes(2);
  });
});

it('the Overview names the seed snapshot the first deploy restores', async () => {
  api.getEnvironment.mockResolvedValue({ ...ENV, current_sha: null, status: 'new', last_deployment: null,
                                         seed_snapshot: { id: 's1', name: 'dev-2026-10-04' } });
  show();
  expect(await screen.findByText('dev-2026-10-04 (the first deploy restores it)')).toBeTruthy();
});

it('the Backups tab restores a dump and then follows it on the Deployments tab', async () => {
  api.startDeployment.mockResolvedValue({ ...RUNNING, id: 'd7', mode: 'restore_dump' });
  show();
  await userEvent.click(await screen.findByRole('tab', { name: 'Backups' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Restore 20261004T010203Z.dump' }));
  await userEvent.type(screen.getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Restore backup' }));
  expect(await screen.findByText('deployment view d7')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Deployments' }).getAttribute('aria-selected')).toBe('true');
});

it('the Publish tab sits between Deployments and Backups and shows the plan', async () => {
  show();
  await screen.findByRole('heading', { level: 1, name: 'uat' });
  expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(
    ['Overview', 'Deployments', 'Publish', 'Backups', 'Settings']);
  await userEvent.click(screen.getByRole('tab', { name: 'Publish' }));
  expect(await screen.findByRole('table', { name: 'Public names' })).toBeTruthy();
  expect(api.getPublishPlan).toHaveBeenCalledWith('uat');
});

it('Delete environment from the Settings tab: typed name, then the page follows the teardown', async () => {
  api.startDeployment.mockResolvedValue(TEARDOWN);
  api.getEnvironment.mockResolvedValueOnce(ENV).mockResolvedValue({ ...ENV, status: 'deleting' });
  show();
  await userEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
  await userEvent.click(screen.getByRole('button', { name: 'Delete environment…' }));
  const dialog = screen.getByRole('dialog', { name: 'Delete uat' });
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Delete environment' }));
  expect(await screen.findByText('deployment view d7')).toBeTruthy();
  expect(screen.getByRole('tab', { name: 'Deployments' }).getAttribute('aria-selected')).toBe('true');
  expect(await screen.findByText('Deleting')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Deploy' }) as HTMLButtonElement).disabled).toBe(true);
});

it('a view-only reader has no Delete environment button', async () => {
  perms.change = false;
  show();
  await userEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
  expect(screen.queryByRole('button', { name: 'Delete environment…' })).toBeNull();
});

it('the Overview says who keeps the public names', async () => {
  api.getEnvironment.mockResolvedValue({ ...ENV, publish: true });
  show();
  expect(await screen.findByText(/Sirdar keeps their DNS records and proxy hosts up to date/)).toBeTruthy();
});

it('DigitalOcean: Overview shows the slots; Activate opens its dialog, then follows the deployment', async () => {
  api.getEnvironment.mockResolvedValue(DO_ENV);
  api.activateSlot.mockResolvedValue(RUNNING);
  show('/deploy/environments/uat9');
  const section = await screen.findByRole('region', { name: 'DigitalOcean' });
  await userEvent.click(within(section).getByRole('button', { name: 'Activate Purple' }));
  const dialog = await screen.findByRole('dialog', { name: 'Activate Purple' });
  await userEvent.click(within(dialog).getByRole('button', { name: 'Activate Purple' }));
  await waitFor(() => expect(api.activateSlot).toHaveBeenCalledWith('uat9', 'purple', undefined));
  expect(await screen.findByRole('tab', { name: 'Deployments', selected: true })).toBeTruthy();
});

it('DigitalOcean: the header says a failed slot leaves the live one serving', async () => {
  api.getEnvironment.mockResolvedValue({ ...DO_ENV, last_deployment: { ...summary(FAILED), mode: 'activate', slot: 'purple' } });
  show('/deploy/environments/uat9');
  const chip = await screen.findByText('Failed — Orange still live', { selector: '.page-title *' });
  expect(chip.className).toMatch(/c-amber/);
});

it('Blue/Green: Activate on the idle VM names its version, then follows the deployment', async () => {
  api.getEnvironment.mockResolvedValue(LAN_ENV);
  api.activateSlot.mockResolvedValue(RUNNING);
  show('/deploy/environments/lan9');
  const section = await screen.findByRole('region', { name: 'Blue/Green' });
  await userEvent.click(within(section).getByRole('button', { name: 'Activate Purple' }));
  const dialog = await screen.findByRole('dialog', { name: 'Activate Purple' });
  expect(within(dialog).getByText(/bbbbbbbb/)).toBeTruthy();
  expect(within(dialog).getByText(/Nginx Proxy Manager/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Activate Purple' }));
  await waitFor(() => expect(api.activateSlot).toHaveBeenCalledWith('lan9', 'purple', undefined));
});
