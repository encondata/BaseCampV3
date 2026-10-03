// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));
const api = vi.hoisted(() => ({
  getEnvironment: vi.fn(), getDeployTargets: vi.fn(), startDeployment: vi.fn(), trustKnownHost: vi.fn(),
  listDeployments: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));
vi.mock('./DeploymentView', () => ({ default: ({ id }: { id: string }) => <div>deployment view {id}</div> }));

import { ApiError } from '@portal/lib/api';

import EnvironmentDetail from './EnvironmentDetail';
import { ADOPTED, ENV, RUNNING, TARGETS, summary } from './testData';

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getEnvironment.mockResolvedValue(ENV);
  api.getDeployTargets.mockResolvedValue(TARGETS);
  api.listDeployments.mockResolvedValue({ deployments: [summary(RUNNING), ADOPTED] });
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
