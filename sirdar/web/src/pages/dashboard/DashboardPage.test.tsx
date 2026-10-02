// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true, preferences: { motion: false } }),
}));
const api = vi.hoisted(() => ({ getDashboard: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import DashboardPage from './DashboardPage';
import { DEMO, EMPTY } from './testData';

let loc = '';
function Where() { loc = useLocation().search; return null; }

function show(path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <DashboardPage />
      <Where />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  api.getDashboard.mockReset();
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
  expect(deploy.getAttribute('title')).toBe('Coming in step 2');
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

it('production active (demo): active and standby slots, disabled Activate Green', async () => {
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
  expect(act.getAttribute('title')).toBe('Coming in step 2');
  expect(within(prod).getByText('Blue active')).toBeTruthy();
});

it('renders one card per environment, custom ones included', async () => {
  show();
  const dev = await screen.findByRole('region', { name: 'Development' });
  expect(within(dev).getByText('No active deployment')).toBeTruthy();
  expect(within(dev).getByText('No releases yet')).toBeTruthy();
  const btn = within(dev).getByRole('button', { name: 'Deploy to Dev' });
  expect(btn.getAttribute('aria-disabled')).toBe('true');
  expect(btn.getAttribute('title')).toBe('Coming in step 2');
  const custom = screen.getByRole('region', { name: 'Qa East' });
  expect(within(custom).getByRole('button', { name: 'Deploy to Qa East' })).toBeTruthy();
});

it('environment cards show the last release and the running state', async () => {
  api.getDashboard.mockResolvedValue({
    ...DEMO, environments: [{ ...DEMO.environments[0], state: 'active', version: 'v2.8.1-dev' }],
  });
  show();
  const dev = await screen.findByRole('region', { name: 'Development' });
  expect(within(dev).getByText('Running')).toBeTruthy();
  expect(within(dev).getByText('Last release: v2.8.1-dev')).toBeTruthy();
  expect(within(dev).queryByText('No active deployment')).toBeNull();
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
