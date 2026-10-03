// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));
const api = vi.hoisted(() => ({
  getDeployment: vi.fn(), cancelDeployment: vi.fn(), retryDeployment: vi.fn(), trustKnownHost: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import DeploymentView, { POLL_MS } from './DeploymentView';
import { ENV, FAILED, RESET_FAILED, RUNNING, RUNNING_MORE, SUCCEEDED } from './testData';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  vi.useFakeTimers({ shouldAdvanceTime: true });
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function show(props: { id?: string; isLatest?: boolean } = {}) {
  const handlers = { onFinished: vi.fn(), onRetried: vi.fn(), onClose: vi.fn() };
  render(<DeploymentView id={props.id ?? 'd1'} env={ENV} isLatest={props.isLatest ?? true} {...handlers} />);
  return handlers;
}
const tick = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

it('polls every 2 s while running, shows the live log, and stops when it finishes', async () => {
  api.getDeployment.mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(RUNNING_MORE).mockResolvedValue(SUCCEEDED);
  const { onFinished } = show();
  expect(await screen.findByText(/Cloning the repo/)).toBeTruthy();
  expect(screen.getByText('Fetch code').closest('button')!.getAttribute('aria-expanded')).toBe('true');
  expect(api.getDeployment).toHaveBeenCalledTimes(1);
  await tick(POLL_MS);
  expect(await screen.findByText(/Checked out f00dbabe/)).toBeTruthy();
  expect(api.getDeployment).toHaveBeenCalledTimes(2);
  await tick(POLL_MS);
  await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
  expect(screen.getByText('Succeeded')).toBeTruthy();
  expect(screen.getByText(SUCCEEDED.dump_path!)).toBeTruthy();
  await tick(POLL_MS * 5);
  expect(api.getDeployment).toHaveBeenCalledTimes(3);
  expect(api.getDeployment).toHaveBeenCalledWith('d1');
});

it('stops polling when it closes', async () => {
  api.getDeployment.mockResolvedValue(RUNNING);
  show();
  await screen.findByText(/Cloning the repo/);
  cleanup();
  await tick(POLL_MS * 3);
  expect(api.getDeployment).toHaveBeenCalledTimes(1);
});

it('a finished deployment is fetched once and never polled', async () => {
  api.getDeployment.mockResolvedValue(FAILED);
  const { onFinished } = show();
  expect(await screen.findByText(/docker build exited 1/)).toBeTruthy();   // the failed step opens
  expect(screen.getByText('Step 5 (Build images) failed. See its log.')).toBeTruthy();
  await tick(POLL_MS * 3);
  expect(api.getDeployment).toHaveBeenCalledTimes(1);
  expect(onFinished).not.toHaveBeenCalled();
});

it('clicking a step shows its log; clicking it again hides it', async () => {
  api.getDeployment.mockResolvedValue({ ...FAILED, steps: FAILED.steps.map((s) => (s.number === 1 ? { ...s, log_tail: 'preflight ok\n', log_size: 13 } : s)) });
  show();
  await screen.findByText(/docker build exited 1/);
  await user.click(screen.getByText('Preflight'));
  expect(screen.getByText(/preflight ok/)).toBeTruthy();
  expect(screen.queryByText(/docker build exited 1/)).toBeNull();
  await user.click(screen.getByText('Preflight'));
  expect(screen.queryByText(/preflight ok/)).toBeNull();
});

it('Cancel asks first, then cancels; it needs deploy:change', async () => {
  api.getDeployment.mockResolvedValue(RUNNING);
  api.cancelDeployment.mockResolvedValue({ id: 'd1', status: 'cancelling' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  show();
  await user.click(await screen.findByRole('button', { name: 'Cancel deployment' }));
  expect(api.cancelDeployment).toHaveBeenCalledWith('d1');
  expect(screen.getByRole('button', { name: 'Cancelling…' })).toBeTruthy();
  cleanup();
  perms.change = false;
  show();
  await screen.findByText(/Cloning the repo/);
  expect(screen.queryByRole('button', { name: 'Cancel deployment' })).toBeNull();
});

it('a failed update retries from the step where it stopped', async () => {
  api.getDeployment.mockResolvedValue(FAILED);
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd2', retry_of: 'd1', start_step: 5 });
  const { onRetried } = show();
  await user.click(await screen.findByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(onRetried).toHaveBeenCalledWith(expect.objectContaining({ id: 'd2' })));
  expect(api.retryDeployment).toHaveBeenCalledWith('d1', { from_step: 5 });
});

it('Retry from step offers the steps up to where it stopped', async () => {
  api.getDeployment.mockResolvedValue(FAILED);
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd2' });
  show();
  await user.click(await screen.findByLabelText('Retry from step'));
  expect(await screen.findByText('3. Fetch code')).toBeTruthy();
  expect(screen.queryByText('6. Pre-deploy dump')).toBeNull();
  await user.click(screen.getByText('3. Fetch code'));
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.retryDeployment).toHaveBeenCalledWith('d1', { from_step: 3 }));
});

it('retrying a Reset needs deploy:change and the typed name', async () => {
  api.getDeployment.mockResolvedValue(RESET_FAILED);
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd4' });
  show({ id: 'd3' });
  const btn = (await screen.findByRole('button', { name: 'Retry' })) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  await user.type(screen.getByLabelText('Type uat to confirm'), 'uat');
  await user.click(btn);
  await waitFor(() => expect(api.retryDeployment).toHaveBeenCalledWith('d3', { from_step: 5, confirm_name: 'uat' }));
  cleanup();
  perms.change = false;
  show({ id: 'd3' });
  await screen.findByText(/docker build exited 1/);
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

it('only the latest deployment offers Retry, and retry errors show', async () => {
  api.getDeployment.mockResolvedValue(FAILED);
  show({ isLatest: false });
  expect(await screen.findByText('Only the most recent deployment can be retried.')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  cleanup();
  api.retryDeployment.mockRejectedValue(new ApiError(409, 'retry_not_latest', { code: 'retry_not_latest' }));
  show();
  await user.click(await screen.findByRole('button', { name: 'Retry' }));
  expect((await screen.findByRole('alert')).textContent).toBe('Only the most recent deployment can be retried.');
});

it('never overlaps requests: a slow fetch holds the next poll back', async () => {
  let resolve: (d: typeof RUNNING) => void = () => {};
  api.getDeployment.mockResolvedValueOnce(RUNNING)
    .mockImplementationOnce(() => new Promise((r) => { resolve = r; }))
    .mockResolvedValue(RUNNING);
  show();
  await screen.findByText(/Cloning the repo/);
  await tick(POLL_MS);
  expect(api.getDeployment).toHaveBeenCalledTimes(2);
  await tick(POLL_MS * 5);   // the second request is still out
  expect(api.getDeployment).toHaveBeenCalledTimes(2);
  await act(async () => { resolve(RUNNING_MORE); });
  await tick(POLL_MS);
  expect(api.getDeployment).toHaveBeenCalledTimes(3);
});

it('backs off on repeated errors and recovers on success', async () => {
  api.getDeployment.mockResolvedValueOnce(RUNNING)
    .mockRejectedValueOnce(new Error('down')).mockRejectedValueOnce(new Error('down'))
    .mockResolvedValue(RUNNING_MORE);
  show();
  await screen.findByText(/Cloning the repo/);
  await tick(POLL_MS);                       // 1st error
  expect(api.getDeployment).toHaveBeenCalledTimes(2);
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load this deployment.");
  await tick(POLL_MS);                       // backed off to 4 s
  expect(api.getDeployment).toHaveBeenCalledTimes(2);
  await tick(POLL_MS);
  expect(api.getDeployment).toHaveBeenCalledTimes(3);   // 2nd error → 8 s
  await tick(POLL_MS * 3);
  expect(api.getDeployment).toHaveBeenCalledTimes(3);
  await tick(POLL_MS);
  expect(api.getDeployment).toHaveBeenCalledTimes(4);   // success
  expect(await screen.findByText(/Checked out f00dbabe/)).toBeTruthy();
  expect(screen.queryByRole('alert')).toBeNull();
  await tick(POLL_MS);                       // back to every 2 s
  expect(api.getDeployment).toHaveBeenCalledTimes(5);
});

it('an orphaned run cancels at once; polling continues until the fetched status is final', async () => {
  const CANCELLED = { ...RUNNING, status: 'cancelled' as const, finished_at: '2026-10-03T13:02:00Z',
    steps: RUNNING.steps.map((s) => (s.number === 3 ? { ...s, status: 'cancelled' as const } : s)) };
  api.getDeployment.mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(RUNNING).mockResolvedValue(CANCELLED);
  api.cancelDeployment.mockResolvedValue({ id: 'd1', status: 'cancelled' });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const { onFinished } = show();
  await user.click(await screen.findByRole('button', { name: 'Cancel deployment' }));
  expect(api.cancelDeployment).toHaveBeenCalledWith('d1');
  await tick(POLL_MS);
  expect(api.getDeployment).toHaveBeenCalledTimes(2);   // still running server-side here
  await tick(POLL_MS);
  await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1));
  expect(screen.queryByRole('button', { name: /^Cancel(ling…| deployment)$/ })).toBeNull();
  await tick(POLL_MS * 3);
  expect(api.getDeployment).toHaveBeenCalledTimes(3);
});

it('a view-only reader sees the logs but no actions', async () => {
  perms.add = false; perms.change = false;
  api.getDeployment.mockResolvedValue(FAILED);
  show();
  expect(await screen.findByText(/docker build exited 1/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  expect(screen.queryByLabelText('Retry from step')).toBeNull();
  expect(screen.queryByText('Only the most recent deployment can be retried.')).toBeNull();
  cleanup();
  api.getDeployment.mockResolvedValue(RUNNING);
  show();
  expect(await screen.findByText(/Cloning the repo/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Cancel deployment' })).toBeNull();
});

it('renders logs as text, never as HTML', async () => {
  api.getDeployment.mockResolvedValue({ ...FAILED,
    steps: FAILED.steps.map((s) => (s.number === 5 ? { ...s, log_tail: '<img src=x onerror=alert(1)>boom\n' } : s)) });
  show();
  const log = await screen.findByLabelText('Step 5 log');
  expect(log.textContent).toContain('<img src=x onerror=alert(1)>boom');
  expect(log.querySelector('img')).toBeNull();
});
