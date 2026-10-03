// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./DeploymentView', () => ({
  default: ({ id, isLatest }: { id: string; isLatest: boolean }) => <div>view {id} {isLatest ? 'latest' : 'older'}</div>,
}));
const api = vi.hoisted(() => ({ listDeployments: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import DeploymentsTab from './DeploymentsTab';
import { ADOPTED, ENV, FAILED, summary } from './testData';

beforeEach(() => {
  api.listDeployments.mockReset();
  api.listDeployments.mockResolvedValue({ deployments: [summary(FAILED), ADOPTED] });
});
afterEach(cleanup);

it('lists the history newest first; Open selects one', async () => {
  const onSelect = vi.fn();
  render(<DeploymentsTab env={ENV} selected={null} onSelect={onSelect} onChanged={vi.fn()} />);
  const table = await screen.findByRole('table', { name: 'Deployments' });
  expect(api.listDeployments).toHaveBeenCalledWith('uat');
  expect(within(table).getByText('main · f00dbabe')).toBeTruthy();
  expect(within(table).getByText('Failed')).toBeTruthy();
  expect(within(table).getByText('Update')).toBeTruthy();
  expect(within(table).getByText('Adopt')).toBeTruthy();
  await userEvent.click(within(table).getAllByRole('button', { name: /^Open the deployment from/ })[0]);
  expect(onSelect).toHaveBeenCalledWith('d1');
});

it('shows the selected deployment, marked latest only when it is the newest', async () => {
  const props = { env: ENV, onSelect: vi.fn(), onChanged: vi.fn() };
  const { rerender } = render(<DeploymentsTab {...props} selected="d1" />);
  expect(await screen.findByText('view d1 latest')).toBeTruthy();
  rerender(<DeploymentsTab {...props} selected="d0" />);
  expect(await screen.findByText('view d0 older')).toBeTruthy();
});

it('shows the empty state', async () => {
  api.listDeployments.mockResolvedValue({ deployments: [] });
  render(<DeploymentsTab env={ENV} selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText('No deployments yet.')).toBeTruthy();
});
