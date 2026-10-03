// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));
const api = vi.hoisted(() => ({
  getEnvironment: vi.fn(), getDeployTargets: vi.fn(), startDeployment: vi.fn(), trustKnownHost: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import EnvironmentDetail from './EnvironmentDetail';
import { ENV, RUNNING, TARGETS } from './testData';

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.getEnvironment.mockResolvedValue(ENV);
  api.getDeployTargets.mockResolvedValue(TARGETS);
});
afterEach(cleanup);

function show(path = '/deploy/environments/uat') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/deploy/environments/:name" element={<EnvironmentDetail />} />
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
