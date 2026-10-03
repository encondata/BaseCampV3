// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({
    can: (r: string, a: string) => r === 'deploy' && (a === 'view' || (a === 'add' && perms.add) || (a === 'change' && perms.change)),
  }),
}));
const api = vi.hoisted(() => ({ startDeployment: vi.fn(), trustKnownHost: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import DeployModal from './DeployModal';
import { ENV, RUNNING } from './testData';

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.startDeployment.mockResolvedValue(RUNNING);
});
afterEach(cleanup);

function open(env = ENV) {
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<DeployModal env={env} onStarted={onStarted} onClose={onClose} />);
  return { onStarted, onClose };
}
const deployBtn = () => screen.getByRole('button', { name: /^(Deploy|Reset and deploy|Starting…)$/ }) as HTMLButtonElement;

it("starts an Update from the environment's ref", async () => {
  const { onStarted } = open({ ...ENV, git_ref: 'release/2.9' });
  expect(screen.getByRole('heading', { name: 'Deploy uat' })).toBeTruthy();
  expect(screen.getByText(/Runs in \/opt\/serversherpa\/uat/)).toBeTruthy();
  expect((screen.getByLabelText('Git ref') as HTMLInputElement).value).toBe('release/2.9');
  expect(screen.getByRole('radio', { name: 'Update' }).getAttribute('aria-checked')).toBe('true');
  await userEvent.click(deployBtn());
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat', { mode: 'update', git_ref: 'release/2.9' });
});

it('Reset data needs the typed environment name', async () => {
  const { onStarted } = open();
  await userEvent.click(screen.getByRole('radio', { name: 'Reset data' }));
  expect(screen.getByText(/can't be undone/)).toBeTruthy();
  expect(deployBtn().textContent).toBe('Reset and deploy');
  expect(deployBtn().disabled).toBe(true);
  await userEvent.type(screen.getByLabelText('Type uat to confirm'), 'ua');
  expect(deployBtn().disabled).toBe(true);
  await userEvent.type(screen.getByLabelText('Type uat to confirm'), 't');
  await userEvent.click(deployBtn());
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
  expect(api.startDeployment).toHaveBeenCalledWith('uat', { mode: 'reset', git_ref: 'main', confirm_name: 'uat' });
});

it('without deploy:change Reset data is locked', async () => {
  perms.change = false;
  open();
  const reset = screen.getByRole('radio', { name: 'Reset data' });
  expect(reset.getAttribute('aria-disabled')).toBe('true');
  await userEvent.click(reset);
  expect(reset.getAttribute('aria-checked')).toBe('false');
  expect(screen.getByText('Reset data needs permission to change deployments.')).toBeTruthy();
});

it('checks the ref first, and shows ref and target errors where they belong', async () => {
  open();
  await userEvent.clear(screen.getByLabelText('Git ref'));
  await userEvent.type(screen.getByLabelText('Git ref'), 'a..b');
  await userEvent.click(deployBtn());
  expect(screen.getByText("That isn't a valid branch, tag or commit.")).toBeTruthy();
  expect(api.startDeployment).not.toHaveBeenCalled();

  api.startDeployment.mockRejectedValueOnce(new ApiError(422, 'ref_not_found', { code: 'ref_not_found' }));
  await userEvent.clear(screen.getByLabelText('Git ref'));
  await userEvent.type(screen.getByLabelText('Git ref'), 'nope');
  await userEvent.click(deployBtn());
  expect(await screen.findByText('The repository has no branch, tag or commit by that name.')).toBeTruthy();

  api.startDeployment.mockRejectedValueOnce(new ApiError(502, 'git_missing', {
    code: 'git_missing', reason: "git isn't installed on the target. Install it (sudo apt-get install git) and try again." }));
  await userEvent.click(deployBtn());
  expect(await screen.findByText(/sudo apt-get install git/)).toBeTruthy();

  api.startDeployment.mockRejectedValueOnce(new ApiError(409, 'deploy_in_progress', { code: 'deploy_in_progress' }));
  await userEvent.click(deployBtn());
  expect(await screen.findByText('A deployment of this environment is already running.')).toBeTruthy();
});

it('an unknown host key asks to trust it, then deploys', async () => {
  api.startDeployment
    .mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', {
      code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' }))
    .mockResolvedValueOnce(RUNNING);
  api.trustKnownHost.mockResolvedValue({});
  const { onStarted } = open({ ...ENV, target: 'ssh' });
  await userEvent.click(deployBtn());
  const trust = await screen.findByRole('button', { name: 'Trust and deploy' });
  // jsdom doesn't enforce inert: change the ref behind the prompt; the replay must ignore it.
  await userEvent.clear(screen.getByLabelText('Git ref'));
  await userEvent.type(screen.getByLabelText('Git ref'), 'release/other');
  await userEvent.click(trust);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc');
  expect(api.startDeployment).toHaveBeenCalledTimes(2);
  expect(api.startDeployment.mock.calls[0]).toEqual(['uat', { mode: 'update', git_ref: 'main' }]);
  expect(api.startDeployment.mock.calls[1]).toEqual(api.startDeployment.mock.calls[0]);
});

const UNKNOWN_KEY = () => new ApiError(409, 'host_key_unknown', {
  code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-ed25519', fingerprint: 'SHA256:abc' });

it('canceling the host-key prompt returns focus to the Git ref', async () => {
  api.startDeployment.mockRejectedValueOnce(UNKNOWN_KEY());
  open({ ...ENV, target: 'ssh' });
  await userEvent.click(deployBtn());
  await userEvent.click(within(await screen.findByRole('dialog', { name: 'Trust this server?' })).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Trust and deploy' })).toBeNull());
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Git ref')));
});

it('a failed start returns focus to the Git ref', async () => {
  api.startDeployment.mockRejectedValueOnce(new ApiError(409, 'deploy_in_progress', { code: 'deploy_in_progress' }));
  open();
  await userEvent.click(deployBtn());
  expect(await screen.findByText('A deployment of this environment is already running.')).toBeTruthy();
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Git ref')));
});

it('without deploy:add nothing can be started', () => {
  perms.add = false; perms.change = false;
  open();
  expect(deployBtn().disabled).toBe(true);
  expect(screen.getByText('You can view deployments but not start them.')).toBeTruthy();
});

it('Escape closes it, but not while starting', async () => {
  let release!: () => void;
  api.startDeployment.mockReturnValue(new Promise((r) => { release = () => r(RUNNING); }));
  const { onClose, onStarted } = open();
  await userEvent.click(deployBtn());
  await userEvent.keyboard('{Escape}');
  expect(onClose).not.toHaveBeenCalled();
  release();
  await waitFor(() => expect(onStarted).toHaveBeenCalled());
  cleanup();
  const again = open();
  await userEvent.keyboard('{Escape}');
  expect(again.onClose).toHaveBeenCalledTimes(1);
});
