// @vitest-environment jsdom
import { act, cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('./DeploymentView', () => ({
  default: ({ id, isLatest, onClose }: { id: string; isLatest: boolean | null; onClose: () => void }) => (
    <div>view {id} {isLatest === null ? 'unknown' : isLatest ? 'latest' : 'older'}
      <button type="button" onClick={onClose}>fake close</button></div>
  ),
}));
const api = vi.hoisted(() => ({ listDeployments: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import DeploymentsTab from './DeploymentsTab';
import { ADOPTED, DO_ENV, DO_UPDATE, ENV, FAILED, RUNNING, summary } from './testData';

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

it('the open deployment is neither latest nor older until the list loads, or if it fails', async () => {
  let fail: (e: Error) => void = () => {};
  api.listDeployments.mockImplementation(() => new Promise((_, reject) => { fail = reject; }));
  render(<DeploymentsTab env={ENV} selected="d1" onSelect={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText('view d1 unknown')).toBeTruthy();
  await act(async () => { fail(new Error('down')); });
  expect(await screen.findByRole('alert')).toBeTruthy();
  expect(screen.getByText('view d1 unknown')).toBeTruthy();
});

it('closing a running deployment reloads the history, so its row is not left Running', async () => {
  api.listDeployments.mockResolvedValueOnce({ deployments: [summary(RUNNING), ADOPTED] })
    .mockResolvedValue({ deployments: [summary(FAILED), ADOPTED] });
  function Host() {
    const [selected, setSelected] = useState<string | null>('d1');
    return <DeploymentsTab env={ENV} selected={selected} onSelect={setSelected} onChanged={vi.fn()} />;
  }
  render(<Host />);
  const table = await screen.findByRole('table', { name: 'Deployments' });
  expect(await within(table).findByText('Running')).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'fake close' }));
  expect(await within(table).findByText('Failed')).toBeTruthy();
  expect(api.listDeployments).toHaveBeenCalledTimes(2);
});

it('a reloaded environment whose deploy ended reloads the history', async () => {
  api.listDeployments.mockResolvedValueOnce({ deployments: [summary(RUNNING), ADOPTED] })
    .mockResolvedValue({ deployments: [summary(FAILED), ADOPTED] });
  const props = { selected: null, onSelect: vi.fn(), onChanged: vi.fn() };
  const { rerender } = render(<DeploymentsTab {...props} env={{ ...ENV, status: 'deploying' }} />);
  const table = await screen.findByRole('table', { name: 'Deployments' });
  expect(await within(table).findByText('Running')).toBeTruthy();
  rerender(<DeploymentsTab {...props} env={{ ...ENV, status: 'deploying' }} />);   // same state: no reload
  expect(api.listDeployments).toHaveBeenCalledTimes(1);
  rerender(<DeploymentsTab {...props} env={{ ...ENV, status: 'failed', updated_at: '2026-10-03T14:00:00Z' }} />);
  expect(await within(table).findByText('Failed')).toBeTruthy();
  expect(api.listDeployments).toHaveBeenCalledTimes(2);
});

it('names a DigitalOcean deployment by its slot', async () => {
  api.listDeployments.mockResolvedValue({ deployments: [DO_UPDATE] });
  render(<DeploymentsTab env={DO_ENV} selected={null} onSelect={vi.fn()} onChanged={vi.fn()} />);
  expect(await screen.findByText('Update to Purple, not live')).toBeTruthy();
});

it("a renew newer than a failed Update doesn't stop the Update counting as latest (as the API's retry does)", async () => {
  const renew = { ...summary(FAILED), id: 'r1', mode: 'renew', status: 'succeeded' };
  const renew2 = { ...renew, id: 'r0' };
  api.listDeployments.mockResolvedValue({ deployments: [renew, summary(FAILED), renew2, ADOPTED] });
  const props = { env: DO_ENV, onSelect: vi.fn(), onChanged: vi.fn() };
  const { rerender } = render(<DeploymentsTab {...props} selected="d1" />);
  expect(await screen.findByText('view d1 latest')).toBeTruthy();
  // a renew itself is latest only against everything
  rerender(<DeploymentsTab {...props} selected="r1" />);
  expect(await screen.findByText('view r1 latest')).toBeTruthy();
  rerender(<DeploymentsTab {...props} selected="r0" />);
  expect(await screen.findByText('view r0 older')).toBeTruthy();
});
