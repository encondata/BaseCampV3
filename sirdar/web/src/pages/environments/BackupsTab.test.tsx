// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a !== 'change' || perms.change) }),
}));
const api = vi.hoisted(() => ({ listBackups: vi.fn(), startDeployment: vi.fn(), trustKnownHost: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import BackupsTab from './BackupsTab';
import { BACKUPS, BLOCKED_BACKUP, ENV, KEYS_CHANGED_REASON, PUBLISHING, RUNNING, summary } from './testData';

beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.listBackups.mockResolvedValue({ backups: BACKUPS });
  api.startDeployment.mockResolvedValue(RUNNING);
});
afterEach(cleanup);

function show(env = ENV) {
  const onStarted = vi.fn();
  render(<BackupsTab env={env} onStarted={onStarted} />);
  return { onStarted };
}

it('lists the pre-deploy dumps, newest first, with time and size', async () => {
  show();
  const table = await screen.findByRole('table', { name: 'Backups' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(
    ['20261004T010203Z.dump', '20261003T130500Z.dump']);
  expect(within(table).getByText('2.0 MB')).toBeTruthy();
  expect(screen.getByText(/the newest 5 stay in \/opt\/serversherpa\/uat\/backups/)).toBeTruthy();
  expect(screen.getByText(/Uploaded files are not rolled back/)).toBeTruthy();
  expect(api.listBackups).toHaveBeenCalledWith('uat');
});

it('restoring needs the typed name and starts a Restore backup deployment', async () => {
  const { onStarted } = show();
  await userEvent.click(await screen.findByRole('button', { name: 'Restore 20261003T130500Z.dump' }));
  const dialog = screen.getByRole('dialog', { name: 'Restore backup' });
  expect(within(dialog).getByText('Backups', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByText(/files deleted since stay deleted/)).toBeTruthy();
  const go = within(dialog).getByRole('button', { name: 'Restore backup' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(go);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat', {
    mode: 'restore_dump', backup: '20261003T130500Z.dump', confirm_name: 'uat' });
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('an unknown host key is trusted, then the same restore is replayed', async () => {
  api.startDeployment.mockRejectedValueOnce(new ApiError(409, 'host_key_unknown', {
    code: 'host_key_unknown', host: '10.10.48.63', port: 22, key_type: 'ssh-rsa', fingerprint: 'SHA256:abc' }));
  api.trustKnownHost.mockResolvedValue({});
  const { onStarted } = show();
  await userEvent.click(await screen.findByRole('button', { name: 'Restore 20261004T010203Z.dump' }));
  await userEvent.type(screen.getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Restore backup' }));
  await userEvent.click(await screen.findByRole('button', { name: 'Trust and restore' }));
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.trustKnownHost).toHaveBeenCalledWith('10.10.48.63', 22, 'SHA256:abc', 'ssh:lab');
  expect(api.startDeployment.mock.calls[1]).toEqual(api.startDeployment.mock.calls[0]);
});

it('a refused restore says why and keeps the modal open', async () => {
  api.startDeployment.mockRejectedValue(new ApiError(409, 'deploy_in_progress', { code: 'deploy_in_progress' }));
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Restore 20261004T010203Z.dump' }));
  await userEvent.type(screen.getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Restore backup' }));
  expect((await screen.findByRole('alert')).textContent).toBe('A deployment of this environment is already running.');
  expect(screen.getByRole('dialog', { name: 'Restore backup' })).toBeTruthy();
});

it('view-only, deploying, empty and unreachable states', async () => {
  perms.change = false;
  show();
  await screen.findByText('20261004T010203Z.dump');
  expect(screen.queryByRole('button', { name: /^Restore/ })).toBeNull();
  cleanup();
  perms.change = true;
  show({ ...ENV, status: 'deploying' });
  const btn = await screen.findByRole('button', { name: 'Restore 20261004T010203Z.dump' }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  cleanup();
  api.listBackups.mockResolvedValue({ backups: [] });
  show();
  expect(await screen.findByText('No backups yet. Each Update takes one before it migrates.')).toBeTruthy();
  cleanup();
  api.listBackups.mockRejectedValue(new ApiError(502, 'connect_failed', { code: 'connect_failed', reason: 'Timed out.' }));
  show();
  expect((await screen.findByRole('alert')).textContent).toBe('Timed out.');
});

it('Restore is disabled while the environment is being deleted or a publish job runs', async () => {
  for (const env of [{ ...ENV, status: 'deleting' as const }, { ...ENV, last_deployment: summary(PUBLISHING) }]) {
    show(env);
    const btn = await screen.findByRole('button', { name: 'Restore 20261004T010203Z.dump' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(btn.title).toBe('A deployment is running.');
    cleanup();
  }
});

it('a load error does not also claim there are no backups', async () => {
  api.listBackups.mockRejectedValue(new ApiError(502, 'connect_failed', { code: 'connect_failed', reason: 'Timed out.' }));
  show();
  await screen.findByRole('alert');
  expect(screen.queryByText(/No backups yet/)).toBeNull();
  expect(screen.queryByText('Loading…')).toBeNull();
});

it('a backup from before the sign-in keys changed shows why and offers no Restore', async () => {
  api.listBackups.mockResolvedValue({ backups: [...BACKUPS, BLOCKED_BACKUP] });
  show();
  const table = await screen.findByRole('table', { name: 'Backups' });
  const row = within(table).getByText(BLOCKED_BACKUP.name).closest('tr') as HTMLElement;
  expect(within(row).getByText(KEYS_CHANGED_REASON)).toBeTruthy();
  expect(within(row).queryByRole('button')).toBeNull();
  expect(screen.queryByRole('button', { name: `Restore ${BLOCKED_BACKUP.name}` })).toBeNull();
  // The others stay restorable.
  expect(screen.getByRole('button', { name: 'Restore 20261003T130500Z.dump' })).toBeTruthy();
});

it('a refused key-changed restore shows the dated reason', async () => {
  api.startDeployment.mockRejectedValue(new ApiError(409, 'backup_keys_changed', {
    code: 'backup_keys_changed', reason: KEYS_CHANGED_REASON }));
  show();
  await userEvent.click(await screen.findByRole('button', { name: 'Restore 20261004T010203Z.dump' }));
  await userEvent.type(screen.getByLabelText('Type uat to confirm'), 'uat');
  await userEvent.click(screen.getByRole('button', { name: 'Restore backup' }));
  expect((await screen.findByRole('alert')).textContent).toBe(KEYS_CHANGED_REASON);
});
