// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const perms = vi.hoisted(() => ({ change: true }));
vi.mock('@portal/auth/AuthContext', () => ({
  useAuth: () => ({ can: (r: string, a: string) => r === 'deploy' && (a !== 'change' || perms.change) }),
}));
const api = vi.hoisted(() => ({ listVmSnapshots: vi.fn(), listBackups: vi.fn(), startDeployment: vi.fn() }));
vi.mock('../../lib/sirdarApi', async (orig) => ({ ...(await orig<typeof import('../../lib/sirdarApi')>()), ...api }));

import { ApiError } from '@portal/lib/api';

import BackupsTab from './BackupsTab';
import { ENV, KEYS_CHANGED_REASON, PX_ENV, RUNNING, VM_SNAPSHOTS } from './testData';

beforeEach(() => {
  perms.change = true;
  Object.values(api).forEach((f) => f.mockReset());
  api.listVmSnapshots.mockResolvedValue({ snapshots: VM_SNAPSHOTS });
  api.listBackups.mockResolvedValue({ backups: [] });
  api.startDeployment.mockResolvedValue(RUNNING);
});
afterEach(cleanup);

it('a Proxmox environment lists its VM snapshots above the backups', async () => {
  render(<BackupsTab env={PX_ENV} onStarted={vi.fn()} />);
  const table = await screen.findByRole('table', { name: 'VM snapshots' });
  const rows = within(table).getAllByRole('row').slice(1);
  expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(
    ['sirdar-20261004T120000Z', 'sirdar-20261002T080000Z']);
  expect(within(rows[0]).getByText('e73b99ca')).toBeTruthy();
  expect(within(rows[1]).getByText(KEYS_CHANGED_REASON)).toBeTruthy();
  expect(screen.getByText(/the newest 3 stay on Proxmox/)).toBeTruthy();
  expect(api.listVmSnapshots).toHaveBeenCalledWith('uat3');
  expect(screen.getByRole('heading', { name: 'Backups' })).toBeTruthy();
});

it('restoring one needs the typed name and starts a Restore VM snapshot deployment', async () => {
  const onStarted = vi.fn();
  render(<BackupsTab env={PX_ENV} onStarted={onStarted} />);
  await userEvent.click(await screen.findByRole('button', { name: 'Restore sirdar-20261004T120000Z' }));
  const dialog = screen.getByRole('dialog', { name: 'Restore VM snapshot' });
  expect(within(dialog).getByText('Backups', { selector: '.eyebrow' })).toBeTruthy();
  expect(within(dialog).getByText(/whole VM/)).toBeTruthy();
  const go = within(dialog).getByRole('button', { name: 'Restore VM snapshot' }) as HTMLButtonElement;
  expect(go.disabled).toBe(true);
  await userEvent.type(within(dialog).getByLabelText('Type uat3 to confirm'), 'uat3');
  await userEvent.click(go);
  await waitFor(() => expect(onStarted).toHaveBeenCalledWith(RUNNING));
  expect(api.startDeployment).toHaveBeenCalledWith('uat3', {
    mode: 'vm_restore', vm_snapshot: 'sirdar-20261004T120000Z', confirm_name: 'uat3' });
});

it('view-only readers see no Restore; a Proxmox error shows its reason; SSH environments have no list', async () => {
  perms.change = false;
  render(<BackupsTab env={PX_ENV} onStarted={vi.fn()} />);
  await screen.findByRole('table', { name: 'VM snapshots' });
  expect(screen.queryByRole('button', { name: /^Restore sirdar/ })).toBeNull();
  cleanup();
  api.listVmSnapshots.mockRejectedValue(new ApiError(502, 'connect_failed',
    { code: 'connect_failed', reason: 'Proxmox rejected the API token.' }));
  render(<BackupsTab env={PX_ENV} onStarted={vi.fn()} />);
  expect(await screen.findByText('Proxmox rejected the API token.')).toBeTruthy();
  cleanup();
  render(<BackupsTab env={ENV} onStarted={vi.fn()} />);
  await waitFor(() => expect(api.listBackups).toHaveBeenCalledWith('uat'));
  expect(screen.queryByRole('heading', { name: 'VM snapshots' })).toBeNull();
  expect(api.listVmSnapshots).toHaveBeenCalledTimes(2);
});
