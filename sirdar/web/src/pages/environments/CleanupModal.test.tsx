// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ add: true, change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a === 'add' ? perms.add : a !== 'change' || perms.change) }),
}));
const api = vi.hoisted(() => ({ startDeployment: vi.fn(), trustKnownHost: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import type { Environment } from '../../lib/sirdarApi';

import CleanupModal from './CleanupModal';
import { CLEANUP, NEVER_DEPLOYED_ENV, PROD_ENV, TEARDOWN } from './testData';

const NEW_PROD: Environment = { ...PROD_ENV, current_sha: null, never_deployed: true, status: 'failed', active_slot: null };

beforeEach(() => {
  perms.add = true; perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.startDeployment.mockResolvedValue(CLEANUP);
});
afterEach(cleanup);

function show(keep: boolean, env: Environment = NEVER_DEPLOYED_ENV) {
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<CleanupModal env={env} keep={keep} onStarted={onStarted} onClose={onClose} />);
  return { onStarted, onClose, dialog: screen.getByRole('dialog') };
}

it('Clean up and keep settings: the typed name starts a cleanup', async () => {
  const { onStarted, dialog } = show(true);
  expect(within(dialog).getByRole('heading', { name: 'Clean up uat' })).toBeTruthy();
  expect(within(dialog).getByText(/The environment and its settings stay, and Deploy starts fresh\./)).toBeTruthy();
  expect(within(dialog).queryByRole('checkbox')).toBeNull();   // no snapshot switch
  const go = within(dialog).getByRole('button', { name: 'Clean up' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'ua');
  expect(go.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 't');
  await userEvent.click(go);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(CLEANUP));
  expect(api.startDeployment).toHaveBeenCalledWith('uat', { mode: 'cleanup', confirm_name: 'uat' });
});

it('Remove everything: a teardown, with no snapshot sent', async () => {
  api.startDeployment.mockResolvedValue(TEARDOWN);
  const { onStarted, dialog } = show(false);
  expect(within(dialog).getByRole('heading', { name: 'Remove uat' })).toBeTruthy();
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Remove everything' }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(TEARDOWN));
  expect(api.startDeployment).toHaveBeenCalledWith('uat', { mode: 'teardown', confirm_name: 'uat' });
  expect(api.startDeployment.mock.calls[0][1]).not.toHaveProperty('snapshot');
});

it('production: needs retiring, then the phrase as well', async () => {
  let dialog = show(true, NEW_PROD).dialog;
  expect(within(dialog).getByText('Mark this production environment retiring first (Settings).')).toBeTruthy();
  expect((within(dialog).getByRole('button', { name: 'Clean up' }) as HTMLButtonElement).disabled).toBe(true);
  cleanup();
  dialog = show(true, { ...NEW_PROD, retiring: true }).dialog;
  const go = within(dialog).getByRole('button', { name: 'Clean up' }) as HTMLButtonElement;
  await userEvent.type(within(dialog).getByLabelText('Type prod to confirm'), 'prod');
  expect(go.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type delete production prod to confirm'), 'delete production prod');
  await userEvent.click(go);
  expect(api.startDeployment).toHaveBeenCalledWith('prod', {
    mode: 'cleanup', confirm_name: 'prod', confirm_production: 'delete production prod' });
});

it('an environment that deployed before: the refusal shows under the form', async () => {
  api.startDeployment.mockRejectedValue(new ApiError(409, 'cleanup_not_allowed', { code: 'cleanup_not_allowed' }));
  const { onStarted, dialog } = show(true);
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Clean up' }));
  expect((await within(dialog).findByRole('alert')).textContent).toBe(
    "This environment has deployed before, so clean-up isn't offered. Use Delete environment in Settings.");
  expect(onStarted).not.toHaveBeenCalled();
});

it('an unknown host key is trusted, then the same cleanup is replayed', async () => {
  api.startDeployment.mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', {
    code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-rsa', fingerprint: 'SHA256:abc' }));
  api.trustKnownHost.mockResolvedValue({});
  const { onStarted, dialog } = show(true);
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Clean up' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and clean up' }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(CLEANUP));
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc', 'ssh:lab');
  expect(api.startDeployment.mock.calls[1]).toEqual(api.startDeployment.mock.calls[0]);
});

it('Cancel closes it', async () => {
  const { onClose, dialog } = show(false);
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  expect(onClose).toHaveBeenCalled();
});

it('production, keep settings: says to un-retire it before deploying; not for Remove everything or other types', () => {
  const sentence = 'Afterwards, un-retire it in Settings before deploying.';
  let dialog = show(true, { ...NEW_PROD, retiring: true }).dialog;
  expect(within(dialog).getByText(sentence)).toBeTruthy();
  cleanup();
  dialog = show(false, { ...NEW_PROD, retiring: true }).dialog;
  expect(within(dialog).queryByText(sentence)).toBeNull();
  cleanup();
  dialog = show(true).dialog;
  expect(within(dialog).queryByText(sentence)).toBeNull();
});
