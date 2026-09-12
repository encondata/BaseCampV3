// @vitest-environment jsdom
/**
 * /dev/database — the tab shell (Reconcile / Backups / Testing). Most of
 * each tab's own behavior is covered elsewhere (pendingDeletes.test.ts,
 * components/dev/DbTestingTab.test.tsx); this file covers what only the
 * shell can: the tab bar itself, and the Backups row picking up the
 * "Testing snapshot" chip for `purpose === 'testing_snapshot'` rows.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DbBackupItem } from '../lib/api';
import DevDatabase from './DevDatabase';

const auth = vi.hoisted(() => ({ godMode: true, canChange: true }));

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => auth.canChange,
    godMode: auth.godMode,
  }),
}));

const api = vi.hoisted(() => ({
  listPendingDeletes: vi.fn(),
  listDbBackups: vi.fn(),
  getDbTestingStatus: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

function backup(overrides: Partial<DbBackupItem> = {}): DbBackupItem {
  return {
    id: 'b1',
    filename: 'backup_20260912.sql',
    size_bytes: 2048,
    encrypted: true,
    created_at: '2026-09-12T09:00:00Z',
    created_by: 'u1',
    created_by_name: 'Jimmy Henderson',
    purpose: 'manual',
    ...overrides,
  };
}

beforeEach(() => {
  auth.godMode = true;
  auth.canChange = true;
  api.listPendingDeletes.mockReset().mockResolvedValue([]);
  api.listDbBackups.mockReset().mockResolvedValue([]);
  api.getDbTestingStatus.mockReset().mockResolvedValue({
    session: null, changes: null, recent: [], worker_online: true,
  });
});

afterEach(() => cleanup());

it('renders three tabs and switches between them', async () => {
  const user = userEvent.setup();
  render(<MemoryRouter><DevDatabase /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Nothing pending delete.')).not.toBeNull());

  expect(screen.queryByRole('tab', { name: 'Reconcile' })).not.toBeNull();
  expect(screen.queryByRole('tab', { name: 'Backups' })).not.toBeNull();
  expect(screen.queryByRole('tab', { name: 'Testing' })).not.toBeNull();

  await user.click(screen.getByRole('tab', { name: 'Testing' }));
  await waitFor(() => expect(screen.queryByText(/Idle/)).not.toBeNull());
});

it('shows the testing lock notice when god mode is off', async () => {
  auth.godMode = false;
  const user = userEvent.setup();
  render(<MemoryRouter><DevDatabase /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Nothing pending delete.')).not.toBeNull());

  await user.click(screen.getByRole('tab', { name: 'Testing' }));
  expect(screen.queryByText('Unlock god mode to use database testing.')).not.toBeNull();
});

it('tags testing-snapshot backups with a chip', async () => {
  api.listDbBackups.mockResolvedValue([
    backup({ id: 'b1', filename: 'backup_manual.sql', purpose: 'manual' }),
    backup({ id: 'b2', filename: 'testing_snapshot_20260912.sql', purpose: 'testing_snapshot' }),
  ]);
  const user = userEvent.setup();
  render(<MemoryRouter><DevDatabase /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Nothing pending delete.')).not.toBeNull());

  await user.click(screen.getByRole('tab', { name: 'Backups' }));
  await waitFor(() => expect(screen.queryByText('backup_manual.sql')).not.toBeNull());

  expect(screen.queryByText('Testing snapshot')).not.toBeNull();
  // the manual row's filename cell has no such chip alongside it
  const manualCell = screen.getByText('backup_manual.sql').closest('.cell-top');
  expect(manualCell?.textContent).not.toMatch(/Testing snapshot/);
});
