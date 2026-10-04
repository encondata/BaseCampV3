// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('@portal/auth/AuthContext', () => ({ useAuth: () => ({ can: () => true }) }));
const api = vi.hoisted(() => ({ takeSnapshot: vi.fn(), trustKnownHost: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import { ENV, RUNNING, SNAP_TAKING } from '../environments/testData';

import TakeSnapshotModal, { defaultSnapshotName } from './TakeSnapshotModal';

Element.prototype.scrollIntoView = () => {};   // jsdom lacks it (ComboBox calls it)
const QA = { ...ENV, id: 'e2', name: 'qa', base_domain: 'qa.serversherpa.com', target: 'ssh:other' };
const TODAY = defaultSnapshotName('uat');
beforeEach(() => {
  Object.values(api).forEach((f) => f.mockReset());
  api.takeSnapshot.mockResolvedValue({ snapshot: SNAP_TAKING, deployment: RUNNING });
});
afterEach(cleanup);

function open(initialEnv?: string) {
  const onStarted = vi.fn();
  const onClose = vi.fn();
  render(<TakeSnapshotModal envs={[ENV, QA]} initialEnv={initialEnv} onStarted={onStarted} onClose={onClose} />);
  return { onStarted, onClose };
}
const takeBtn = () => screen.getByRole('button', { name: /^(Take snapshot|Starting…)$/ }) as HTMLButtonElement;

it('takes a snapshot of the chosen environment with a dated default name', async () => {
  const { onStarted } = open();
  expect(screen.getByRole('dialog', { name: 'Take snapshot' })).toBeTruthy();
  expect(TODAY).toMatch(/^uat-\d{4}-\d{2}-\d{2}$/);
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(TODAY);
  await userEvent.type(screen.getByLabelText('Notes'), 'before uat2');
  await userEvent.click(takeBtn());
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith({ snapshot: SNAP_TAKING, deployment: RUNNING }));
  expect(api.takeSnapshot).toHaveBeenCalledWith('uat', TODAY, 'before uat2');
});

it('picking another environment renames until the name is edited', async () => {
  open();
  await userEvent.click(screen.getByRole('combobox', { name: 'Environment' }));
  await userEvent.click(await screen.findByRole('button', { name: 'qa · qa.serversherpa.com' }));
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe(defaultSnapshotName('qa'));
  await userEvent.clear(screen.getByLabelText('Name'));
  await userEvent.type(screen.getByLabelText('Name'), 'mine');
  await userEvent.click(screen.getByRole('combobox', { name: 'Environment' }));
  await userEvent.click(await screen.findByRole('button', { name: 'uat · uat.serversherpa.com' }));
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('mine');
});

it('shows API errors; an unknown host key is trusted and the same attempt replayed', async () => {
  open('qa');
  api.takeSnapshot.mockRejectedValueOnce(new ApiError(409, 'snapshot_exists', { code: 'snapshot_exists' }));
  await userEvent.click(takeBtn());
  expect((await screen.findByRole('alert')).textContent).toBe('A snapshot with that name already exists.');
  api.takeSnapshot.mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', {
    code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-rsa', fingerprint: 'SHA256:abc' }));
  api.trustKnownHost.mockResolvedValue({});
  await userEvent.click(takeBtn());
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and take snapshot' }));
  await waitFor(() => expect(api.takeSnapshot).toHaveBeenCalledTimes(3));
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc', 'ssh:other');
  expect(api.takeSnapshot.mock.calls[2]).toEqual(api.takeSnapshot.mock.calls[1]);
});

it('says so when nothing has been deployed', () => {
  render(<TakeSnapshotModal envs={[]} onStarted={vi.fn()} onClose={vi.fn()} />);
  expect(screen.getByText('No environment has been deployed yet.')).toBeTruthy();
  expect(takeBtn().disabled).toBe(true);
});
