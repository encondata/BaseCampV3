// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  rollbackDeployment: vi.fn(), startDeployment: vi.fn(),
}));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import type { Environment } from '../../lib/sirdarApi';

import DeploymentView, { POLL_MS } from './DeploymentView';
import {
  DO_ENV, ENV, FAILED, PROD_ENV, PX_ENV, RESET_FAILED, RESTORE_FAILED, ROLLBACKABLE, RUNNING, RUNNING_MORE, SNAP, SUCCEEDED,
  VM_ROLLBACKABLE,
} from './testData';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
let user: ReturnType<typeof userEvent.setup>;
beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  vi.useFakeTimers({ shouldAdvanceTime: true });
  user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });

function show(props: { id?: string; isLatest?: boolean | null; env?: Environment } = {}) {
  const handlers = { onFinished: vi.fn(), onRetried: vi.fn(), onClose: vi.fn() };
  render(<DeploymentView id={props.id ?? 'd1'} env={props.env ?? ENV} isLatest={props.isLatest === undefined ? true : props.isLatest} {...handlers} />);
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
  expect(screen.getByRole('button', { name: 'Canceling…' })).toBeTruthy();
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
  expect(screen.queryByRole('button', { name: /^Cancel(ing…| deployment)$/ })).toBeNull();
  expect(screen.getAllByText('Canceled').length).toBeGreaterThan(0);
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

it('a failed first load retries with backoff and then shows the deployment; Close works meanwhile', async () => {
  api.getDeployment.mockRejectedValueOnce(new Error('down')).mockResolvedValue(FAILED);
  const { onClose } = show();
  expect((await screen.findByRole('alert')).textContent).toBe("Couldn't load this deployment.");
  await user.click(screen.getByRole('button', { name: 'Close' }));
  expect(onClose).toHaveBeenCalledTimes(1);
  await tick(POLL_MS);
  expect(api.getDeployment).toHaveBeenCalledTimes(1);   // backed off to 4 s
  await tick(POLL_MS);
  expect(api.getDeployment).toHaveBeenCalledTimes(2);
  expect(await screen.findByText(/docker build exited 1/)).toBeTruthy();
  expect(screen.queryByText("Couldn't load this deployment.")).toBeNull();
  await tick(POLL_MS * 5);
  expect(api.getDeployment).toHaveBeenCalledTimes(2);   // finished: no more polls
});

it('a deployment that does not exist stops at once', async () => {
  api.getDeployment.mockRejectedValue(new ApiError(404, 'deployment_not_found', { code: 'deployment_not_found' }));
  show();
  expect((await screen.findByRole('alert')).textContent).toBe('That deployment no longer exists.');
  await tick(POLL_MS * 20);
  expect(api.getDeployment).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
});

it('while it is unknown whether this is the latest, neither Retry nor the hint shows', async () => {
  api.getDeployment.mockResolvedValue(FAILED);
  show({ isLatest: null });
  await screen.findByText(/docker build exited 1/);
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  expect(screen.queryByText('Only the most recent deployment can be retried.')).toBeNull();
});

it('the log follows new output only when the reader is at the bottom', async () => {
  api.getDeployment.mockResolvedValueOnce(RUNNING).mockResolvedValueOnce(RUNNING_MORE)
    .mockResolvedValue({ ...RUNNING_MORE,
      steps: RUNNING_MORE.steps.map((s) => (s.number === 3 ? { ...s, log_tail: `${s.log_tail}more\n` } : s)) });
  show();
  await screen.findByText(/Cloning the repo/);
  const log = screen.getByLabelText('Step 3 log');
  Object.defineProperty(log, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(log, 'clientHeight', { configurable: true, value: 100 });
  Object.defineProperty(log, 'scrollTop', { configurable: true, writable: true, value: 200 });
  fireEvent.scroll(log);                     // scrolled up to read
  await tick(POLL_MS);
  await screen.findByText(/Checked out f00dbabe/);
  expect(log.scrollTop).toBe(200);           // left where the reader is
  log.scrollTop = 880;                       // within 40px of the bottom
  fireEvent.scroll(log);
  await tick(POLL_MS);
  await screen.findByText(/more/);
  expect(log.scrollTop).toBe(1000);          // follows the new output
});

it('any 4xx on load is final (no retries); other errors keep trying', async () => {
  api.getDeployment.mockRejectedValue(new ApiError(403, 'forbidden', { code: 'forbidden' }));
  show();
  expect(await screen.findByRole('alert')).toBeTruthy();
  await tick(POLL_MS * 20);
  expect(api.getDeployment).toHaveBeenCalledTimes(1);
  cleanup();
  api.getDeployment.mockReset();
  api.getDeployment.mockResolvedValueOnce(RUNNING).mockRejectedValue(new ApiError(401, 'not_authenticated', { code: 'not_authenticated' }));
  show();
  await screen.findByText(/Cloning the repo/);
  await tick(POLL_MS);
  expect(api.getDeployment).toHaveBeenCalledTimes(2);
  await tick(POLL_MS * 20);
  expect(api.getDeployment).toHaveBeenCalledTimes(2);   // a running deployment stops polling on a 4xx too
});

it('a step closed and opened again starts stuck to the bottom of its log', async () => {
  // Every <pre> reports a 1000px log in a 100px box; scrollTop is remembered per element.
  const tops = new WeakMap<Element, number>();
  const proto = HTMLPreElement.prototype;
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get: () => 1000 });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, get: () => 100 });
  Object.defineProperty(proto, 'scrollTop', {
    configurable: true, get(this: Element) { return tops.get(this) ?? 0; }, set(this: Element, v: number) { tops.set(this, v); },
  });
  try {
    api.getDeployment.mockResolvedValue(RUNNING);
    show();
    await screen.findByText(/Cloning the repo/);
    const first = screen.getByLabelText('Step 3 log');
    expect(first.scrollTop).toBe(1000);
    first.scrollTop = 200;                     // the reader scrolls up
    fireEvent.scroll(first);
    await user.click(screen.getByText('Fetch code'));   // close the step
    expect(screen.queryByLabelText('Step 3 log')).toBeNull();
    await user.click(screen.getByText('Fetch code'));   // and open it again
    expect(screen.getByLabelText('Step 3 log').scrollTop).toBe(1000);
  } finally {
    delete (proto as unknown as Record<string, unknown>).scrollHeight;
    delete (proto as unknown as Record<string, unknown>).clientHeight;
    delete (proto as unknown as Record<string, unknown>).scrollTop;
  }
});

it('a failed Update with a dump offers Roll back behind the typed name', async () => {
  api.getDeployment.mockResolvedValue(ROLLBACKABLE);
  api.rollbackDeployment.mockResolvedValue({ ...RUNNING, id: 'd8', mode: 'rollback' });
  const { onRetried } = show({ id: 'd4' });
  expect(await screen.findByRole('heading', { name: 'Roll back' })).toBeTruthy();
  expect(screen.getByText(/Deploys the previous commit/).textContent).toContain('e73b99ca');
  // Which dump it restores, and when it was taken, before the typed-name gate.
  const which = screen.getByText(/Restores the backup/);
  expect(which.textContent).toContain('20261003T130500Z.dump');
  expect(which.textContent).toContain(new Date('2026-10-03T13:05:00Z').toLocaleString());
  const go = screen.getByRole('button', { name: 'Roll back' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await user.type(screen.getByLabelText('Type uat to confirm', { selector: '#rollback-confirm' }), 'uat');
  await user.click(go);
  await waitFor(() => expect(onRetried).toHaveBeenCalledWith(expect.objectContaining({ id: 'd8' })));
  expect(api.rollbackDeployment).toHaveBeenCalledWith('d4', 'uat');
});

it('Roll back is hidden without change, on an older deployment, and when unavailable', async () => {
  api.getDeployment.mockResolvedValue(ROLLBACKABLE);
  perms.change = false;
  show({ id: 'd4' });
  await screen.findByText(/migrate exited 1/);
  expect(screen.queryByRole('heading', { name: 'Roll back' })).toBeNull();
  cleanup();
  perms.change = true;
  show({ id: 'd4', isLatest: false });
  await screen.findByText(/migrate exited 1/);
  expect(screen.queryByRole('heading', { name: 'Roll back' })).toBeNull();
  cleanup();
  api.getDeployment.mockResolvedValue(FAILED);
  show();
  await screen.findByText(/docker build exited 1/);
  expect(screen.queryByRole('heading', { name: 'Roll back' })).toBeNull();
});

it('a failed Restore backup retries behind the typed name and shows its backup', async () => {
  api.getDeployment.mockResolvedValue(RESTORE_FAILED);
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd6' });
  show({ id: 'd5' });
  expect(await screen.findByRole('heading', { level: 2, name: /^Restore backup · e73b99ca/ })).toBeTruthy();
  expect(screen.getByText('20261003T130500Z.dump', { selector: 'dd' })).toBeTruthy();
  const retry = screen.getByRole('button', { name: 'Retry' }) as HTMLButtonElement;
  expect(retry.disabled).toBe(true);
  await user.type(screen.getByLabelText('Type uat to confirm', { selector: '#retry-confirm' }), 'uat');
  await user.click(retry);
  await waitFor(() => expect(api.retryDeployment).toHaveBeenCalledWith('d5', { from_step: 9, confirm_name: 'uat' }));
});

it('a snapshot job is never retried, and names its snapshot', async () => {
  api.getDeployment.mockResolvedValue({
    ...FAILED, mode: 'snapshot', snapshot: { id: SNAP.id, name: SNAP.name },
    steps: [{ ...FAILED.steps[0] }, { ...FAILED.steps[4], number: 11, key: 'export', name: 'Take snapshot' }],
  });
  show();
  expect(await screen.findByText('dev-2026-10-04', { selector: 'dd' })).toBeTruthy();
  expect(screen.getByRole('heading', { level: 2, name: /^Take snapshot ·/ })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

const RESTORE_HINT = 'Retry this deployment — a new Update would put the old sign-in keys back.';

it('a failed restoring deployment says to retry it rather than run a new Update', async () => {
  api.getDeployment.mockResolvedValue({
    ...RESET_FAILED, snapshot: { id: SNAP.id, name: SNAP.name },
    steps: [...RESET_FAILED.steps.slice(0, 6),
      { ...RESET_FAILED.steps[6], number: 9, key: 'restore', name: 'Restore snapshot', status: 'failed' }],
  });
  show({ id: 'd3' });
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
  expect(screen.getByText(RESTORE_HINT)).toBeTruthy();
  expect(screen.getByText('dev-2026-10-04', { selector: 'dd' })).toBeTruthy();
});

it('a failed deployment without a restore step has no restore hint', async () => {
  api.getDeployment.mockResolvedValue(RESET_FAILED);
  show({ id: 'd3' });
  expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy();
  expect(screen.queryByText(RESTORE_HINT)).toBeNull();
});

it('a failed Proxmox deploy offers its VM snapshot as well as the dump', async () => {
  api.getDeployment.mockResolvedValue(VM_ROLLBACKABLE);
  api.startDeployment.mockResolvedValue(RUNNING);
  const handlers = { onFinished: vi.fn(), onRetried: vi.fn(), onClose: vi.fn() };
  render(<DeploymentView id="d11" env={PX_ENV} isLatest {...handlers} />);
  expect(await screen.findByText('Prepare VM')).toBeTruthy();                         // step 0 is listed
  expect(screen.getAllByText('sirdar-20261004T120000Z').length).toBeGreaterThan(0);
  const panel = screen.getByRole('heading', { name: 'Restore VM snapshot' }).closest('div') as HTMLElement;
  expect(panel.textContent).toMatch(/Puts the whole VM back to sirdar-20261004T120000Z/);
  const go = screen.getByRole('button', { name: 'Restore VM snapshot' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await user.type(screen.getByLabelText('Type uat3 to restore the VM snapshot'), 'uat3');
  await user.click(go);
  await waitFor(() => expect(handlers.onRetried).toHaveBeenCalledWith(RUNNING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat3', {
    mode: 'vm_restore', vm_snapshot: 'sirdar-20261004T120000Z', confirm_name: 'uat3' });
});

it('no VM snapshot panel without the change permission or a snapshot', async () => {
  api.getDeployment.mockResolvedValue(ROLLBACKABLE);
  show();
  await screen.findByRole('heading', { name: 'Roll back' });
  expect(screen.queryByRole('heading', { name: 'Restore VM snapshot' })).toBeNull();
  cleanup();
  perms.change = false;
  api.getDeployment.mockResolvedValue(VM_ROLLBACKABLE);
  render(<DeploymentView id="d11" env={PX_ENV} isLatest onFinished={vi.fn()} onRetried={vi.fn()} onClose={vi.fn()} />);
  expect(await screen.findByText('Prepare VM')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Restore VM snapshot' })).toBeNull();
});

it('a failed Proxmox deploy can be retried from step 0', async () => {
  api.getDeployment.mockResolvedValue(VM_ROLLBACKABLE);
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd12' });
  render(<DeploymentView id="d11" env={PX_ENV} isLatest onFinished={vi.fn()} onRetried={vi.fn()} onClose={vi.fn()} />);
  await user.click(await screen.findByLabelText('Retry from step'));
  await user.click(await screen.findByText('0. Prepare VM'));
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.retryDeployment).toHaveBeenCalledWith('d11', { from_step: 0 }));
});

it("retrying production's Activate needs its name; another environment's doesn't", async () => {
  api.getDeployment.mockResolvedValue({ ...FAILED, mode: 'activate', cloud: true, slot: 'green', go_live: true });
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd2' });
  show({ env: PROD_ENV });
  const btn = (await screen.findByRole('button', { name: 'Retry' })) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  await user.type(screen.getByLabelText('Type prod to confirm'), 'prod');
  await user.click(btn);
  await waitFor(() => expect(api.retryDeployment).toHaveBeenCalledWith('d1', { from_step: 5, confirm_name: 'prod' }));
  cleanup();
  show({ env: DO_ENV });
  await user.click(await screen.findByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(api.retryDeployment).toHaveBeenLastCalledWith('d1', { from_step: 5 }));
});

it("retrying production's Delete asks for both phrases again", async () => {
  api.getDeployment.mockResolvedValue({ ...FAILED, mode: 'teardown', cloud: true, slot: 'blue' });
  api.retryDeployment.mockResolvedValue({ ...RUNNING, id: 'd2' });
  show({ env: { ...PROD_ENV, retiring: true, active_slot: null } });
  const btn = (await screen.findByRole('button', { name: 'Retry' })) as HTMLButtonElement;
  await user.type(screen.getByLabelText('Type prod to confirm'), 'prod');
  expect(btn.disabled).toBe(true);
  await user.type(screen.getByLabelText('Type delete production prod to confirm'), 'delete production prod');
  await user.click(btn);
  await waitFor(() => expect(api.retryDeployment).toHaveBeenCalledWith('d1', {
    from_step: 5, confirm_name: 'prod', confirm_production: 'delete production prod' }));
});

it('DigitalOcean offers no Roll back', async () => {
  api.getDeployment.mockResolvedValue({ ...ROLLBACKABLE, cloud: true, slot: 'purple' });
  show({ id: 'd4', env: DO_ENV });
  await screen.findByRole('button', { name: 'Retry' });
  expect(screen.queryByText('Roll back', { selector: 'h3' })).toBeNull();
});
