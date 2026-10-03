// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a === 'view' || perms.add) }),
}));
const api = vi.hoisted(() => ({ listEnvironments: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));
vi.mock('./NewEnvironmentModal', () => ({
  default: ({ onCreated }: { onCreated: (env: typeof ENV) => void }) => (
    <div role="dialog" aria-label="New environment">
      <button type="button" onClick={() => onCreated(ENV)}>fake create</button>
    </div>
  ),
}));

import { ApiError } from '@portal/lib/api';

import EnvironmentsSection from './EnvironmentsSection';
import { ENV, TARGETS } from './testData';

beforeEach(() => {
  perms.add = true;
  api.listEnvironments.mockReset();
  api.listEnvironments.mockResolvedValue({ environments: [] });
});
afterEach(cleanup);

function show() {
  return render(
    <MemoryRouter initialEntries={['/deploy']}>
      <Routes>
        <Route path="/deploy" element={<EnvironmentsSection targets={TARGETS.targets} />} />
        <Route path="/deploy/environments/:name" element={<p>detail page</p>} />
      </Routes>
    </MemoryRouter>,
  );
}

it('lists each environment with its target, type, ref and SHA, status and last deploy', async () => {
  api.listEnvironments.mockResolvedValue({ environments: [
    ENV, { ...ENV, id: 'e2', name: 'qa', type: 'custom', status: 'new', current_sha: null, last_deployment: null },
  ] });
  show();
  const table = await screen.findByRole('table', { name: 'Environments' });
  expect(within(table).getByRole('link', { name: 'uat' }).getAttribute('href')).toBe('/deploy/environments/uat');
  expect(within(table).getAllByText('Lab box')).toHaveLength(2);
  expect(within(table).getByText('Dev')).toBeTruthy();
  expect(within(table).getByText('Custom')).toBeTruthy();
  expect(within(table).getByText('main · e73b99ca')).toBeTruthy();
  expect(within(table).getByText('main · —')).toBeTruthy();
  expect(within(table).getByText('Ready')).toBeTruthy();
  expect(within(table).getByText('New')).toBeTruthy();
  expect(within(table).getByText('Adopted')).toBeTruthy();
});

it('shows the empty state, and a load error as an alert', async () => {
  show();
  expect(await screen.findByText('No environments yet.')).toBeTruthy();
  cleanup();
  api.listEnvironments.mockRejectedValue(new ApiError(500, 'http_500', null));
  show();
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load environments.");
});

it('New environment needs deploy:add; creating one opens its page', async () => {
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'New environment' }));
  await userEvent.click(within(screen.getByRole('dialog', { name: 'New environment' })).getByRole('button', { name: 'fake create' }));
  expect(await screen.findByText('detail page')).toBeTruthy();
  cleanup();
  perms.add = false;
  show();
  await screen.findByText('No environments yet.');
  expect(screen.queryByRole('button', { name: 'New environment' })).toBeNull();
});
