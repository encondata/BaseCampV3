// @vitest-environment jsdom
/**
 * /dev/database — the tab shell (Reconcile / Backups / Testing). Most of
 * each tab's own behavior is covered elsewhere (pendingDeletes.test.ts,
 * components/dev/DbTestingTab.test.tsx); this file covers what only the
 * shell can: the tab bar itself, the Backups row picking up the
 * "Testing snapshot" chip for `purpose === 'testing_snapshot'` rows, and
 * both tabs' row actions living in a single RowActionsMenu.
 *
 * The open RowActionsMenu is portaled to document.body, so menu items are
 * queried via `screen` and never `within(row)` — see the note at
 * pages/KioskDevices.test.tsx:178.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { DbBackupItem, PendingDeleteItem, PendingDeleteReference } from '../lib/api';
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
  unmarkPendingDelete: vi.fn(),
  reconcilePendingDelete: vi.fn(),
  reconcilePendingDeletes: vi.fn(),
  getDbBackupDownload: vi.fn(),
  deleteDbBackup: vi.fn(),
  getCascadePreview: vi.fn(),
  cascadeDelete: vi.fn(),
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

function pendingDelete(overrides: Partial<PendingDeleteItem> = {}): PendingDeleteItem {
  return {
    id: 'pd1',
    entity_type: 'asset',
    entity_id: 'a1',
    entity_label: 'SN-0001',
    marked_by: 'u1',
    marked_by_name: 'Jimmy Henderson',
    marked_at: '2026-09-12T09:00:00Z',
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
  api.unmarkPendingDelete.mockReset().mockResolvedValue(undefined);
  api.reconcilePendingDelete.mockReset().mockResolvedValue({ deleted: 1, failed: [] });
  api.reconcilePendingDeletes.mockReset().mockResolvedValue({ deleted: 1, failed: [] });
  api.getDbBackupDownload.mockReset().mockResolvedValue({ url: 'blob:signed' });
  api.deleteDbBackup.mockReset().mockResolvedValue(undefined);
  api.getCascadePreview.mockReset().mockResolvedValue({
    entity_type: 'asset', entity_id: 'a1', label: 'SN-0001',
    steps: [], blocked: [], total_rows_deleted: 0, total_rows_cleared: 0,
  });
  api.cascadeDelete.mockReset();
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

/** Open the Backups tab with the given rows loaded. */
async function openBackups(rows: DbBackupItem[]) {
  api.listDbBackups.mockResolvedValue(rows);
  const user = userEvent.setup();
  render(<MemoryRouter><DevDatabase /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Nothing pending delete.')).not.toBeNull());
  await user.click(screen.getByRole('tab', { name: 'Backups' }));
  await waitFor(() => expect(screen.queryByText(rows[0].filename)).not.toBeNull());
  return user;
}

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

/** Render the Reconcile tab with one pending marker, run the bulk
 *  Reconcile action, and resolve it with a single failure carrying the
 *  given references — the shape a "some references remain" reconcile
 *  response takes. Confirm dialogs are auto-accepted for the duration. */
async function renderReconcileWithFailure(references: PendingDeleteReference[]) {
  api.listPendingDeletes.mockResolvedValue([pendingDelete()]);
  api.reconcilePendingDeletes.mockResolvedValue({
    deleted: 0,
    failed: [{
      entity_type: 'asset', entity_id: 'a1', label: 'SN-0001',
      reason: 'fk_violation', references,
    }],
  });
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = userEvent.setup();
  render(<MemoryRouter><DevDatabase /></MemoryRouter>);
  await screen.findByText('SN-0001');
  await user.click(screen.getByRole('button', { name: /Reconcile — permanently delete/ }));
  await waitFor(() => expect(api.reconcilePendingDeletes).toHaveBeenCalled());
}

// ── Reconcile tab: pending-delete row actions ─────────────────────────

it('a pending-delete row offers one Actions menu instead of inline Undo/Delete buttons', async () => {
  api.listPendingDeletes.mockResolvedValue([pendingDelete()]);
  const user = userEvent.setup();
  render(<MemoryRouter><DevDatabase /></MemoryRouter>);
  const row = (await screen.findByText('SN-0001')).closest('.dir-row') as HTMLElement;

  expect(within(row).queryByRole('button', { name: 'Undo' })).toBeNull();
  expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull();

  await user.click(within(row).getByRole('button', { name: /actions/i }));

  expect(await screen.findByRole('menuitem', { name: 'Undo' })).not.toBeNull();
  const del = screen.getByRole('menuitem', { name: 'Delete' });
  expect(del.className).toMatch(/danger/);
});

it('pending delete → Actions → Undo unmarks that row', async () => {
  api.listPendingDeletes.mockResolvedValue([pendingDelete()]);
  const user = userEvent.setup();
  render(<MemoryRouter><DevDatabase /></MemoryRouter>);
  const row = (await screen.findByText('SN-0001')).closest('.dir-row') as HTMLElement;

  await user.click(within(row).getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Undo' }));

  await waitFor(() => expect(api.unmarkPendingDelete).toHaveBeenCalledWith('pd1'));
});

it('pending delete → Actions → Delete confirms first, and a declined confirm deletes nothing', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
  api.listPendingDeletes.mockResolvedValue([pendingDelete()]);
  const user = userEvent.setup();
  render(<MemoryRouter><DevDatabase /></MemoryRouter>);
  const row = (await screen.findByText('SN-0001')).closest('.dir-row') as HTMLElement;

  await user.click(within(row).getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

  expect(confirmSpy).toHaveBeenCalled();
  expect(api.reconcilePendingDelete).not.toHaveBeenCalled();

  confirmSpy.mockReturnValue(true);
  await user.click(within(row).getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

  await waitFor(() => expect(api.reconcilePendingDelete).toHaveBeenCalledWith('pd1'));
});

it('the pending-delete list reclaims its action track for the trigger', async () => {
  api.listPendingDeletes.mockResolvedValue([pendingDelete()]);
  render(<MemoryRouter><DevDatabase /></MemoryRouter>);
  await screen.findByText('SN-0001');

  const head = document.querySelector('.list-head') as HTMLElement;
  expect(head.style.gridTemplateColumns.endsWith('88px')).toBe(true);
  expect(head.style.gridTemplateColumns).not.toMatch(/150px/);
});

// ── Backups tab: row actions ──────────────────────────────────────────

it('a backup row offers one Actions menu instead of inline Download/Delete buttons', async () => {
  const user = await openBackups([backup()]);
  const row = screen.getByText('backup_20260912.sql').closest('.dir-row') as HTMLElement;

  expect(within(row).queryByRole('button', { name: 'Download' })).toBeNull();
  expect(within(row).queryByRole('button', { name: 'Delete' })).toBeNull();

  await user.click(within(row).getByRole('button', { name: /actions/i }));

  expect(await screen.findByRole('menuitem', { name: 'Download' })).not.toBeNull();
  expect(screen.getByRole('menuitem', { name: 'Delete' }).className).toMatch(/danger/);
});

it('backups → Download is disabled, not dropped, while the row is downloading', async () => {
  // never settles: the row stays busy so the disabled state is observable
  api.getDbBackupDownload.mockImplementation(() => new Promise(() => {}));
  const user = await openBackups([backup()]);
  const row = screen.getByText('backup_20260912.sql').closest('.dir-row') as HTMLElement;

  await user.click(within(row).getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Download' }));
  await waitFor(() => expect(api.getDbBackupDownload).toHaveBeenCalledWith('b1'));

  await user.click(within(row).getByRole('button', { name: /actions/i }));
  const download = await screen.findByRole('menuitem', { name: 'Download' });
  expect((download as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByRole('menuitem', { name: 'Delete' }) as HTMLButtonElement).disabled).toBe(true);
});

it('backups → Delete confirms, then deletes and reloads', async () => {
  const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
  const user = await openBackups([backup()]);
  const row = screen.getByText('backup_20260912.sql').closest('.dir-row') as HTMLElement;

  await user.click(within(row).getByRole('button', { name: /actions/i }));
  await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));

  expect(confirmSpy).toHaveBeenCalled();
  await waitFor(() => expect(api.deleteDbBackup).toHaveBeenCalledWith('b1'));
});

it('backups → Delete is absent without devtools:change, but Download stays', async () => {
  auth.canChange = false;
  const user = await openBackups([backup()]);
  const row = screen.getByText('backup_20260912.sql').closest('.dir-row') as HTMLElement;

  await user.click(within(row).getByRole('button', { name: /actions/i }));

  expect(await screen.findByRole('menuitem', { name: 'Download' })).not.toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Delete' })).toBeNull();
});

it('the backups list reclaims its action track for the trigger', async () => {
  await openBackups([backup()]);

  const head = document.querySelector('.list-head') as HTMLElement;
  expect(head.style.gridTemplateColumns.endsWith('88px')).toBe(true);
  expect(head.style.gridTemplateColumns).not.toMatch(/170px/);
});

// ── Reconcile tab: cascade delete override ─────────────────────────

it('offers the override where force delete is impossible', async () => {
  // a required reference: force cannot help, the override must be offered
  await renderReconcileWithFailure([
    { table: 'person_roles', column: 'person_id', nullable: false, purgeable: false,
      check_guarded: false, db_handled: false, count: 1, labels: [] },
  ]);
  expect(await screen.findByRole('button', {
    name: 'Override — delete this and everything attached' })).toBeTruthy();
  expect(screen.queryByText(/Cannot force/)).toBeNull();
});

it('does not count a database-handled reference as a blocker', async () => {
  await renderReconcileWithFailure([
    { table: 'notification_group_members', column: 'person_id', nullable: false,
      purgeable: false, check_guarded: false, db_handled: true, count: 1, labels: ['Ops'] },
  ]);
  expect(await screen.findByText(/handled automatically by the database/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Force delete — detach references' })).toBeTruthy();
  expect(screen.getByRole('button', {
    name: 'Override — delete this and everything attached' })).toBeTruthy();
});

it('opens the override modal and refreshes after it deletes', async () => {
  api.getCascadePreview.mockResolvedValue({
    entity_type: 'asset', entity_id: 'a1', label: 'SN-0001',
    steps: [{ table: 'person_roles', column: 'person_id', action: 'purge', count: 1, labels: [], depth: 1 }],
    blocked: [], total_rows_deleted: 1, total_rows_cleared: 0,
  });
  api.cascadeDelete.mockResolvedValue({ deleted: 1, failed: [] });

  await renderReconcileWithFailure([
    { table: 'person_roles', column: 'person_id', nullable: false, purgeable: false,
      check_guarded: false, db_handled: false, count: 1, labels: [] },
  ]);
  fireEvent.click(await screen.findByRole('button', {
    name: 'Override — delete this and everything attached' }));
  expect(await screen.findByRole('dialog', { name: 'Cascade delete' })).toBeTruthy();

  const confirmInput = await screen.findByLabelText('Type SN-0001 to confirm');
  const destroyBtn = screen.getByRole('button', { name: 'Delete permanently' });
  fireEvent.change(confirmInput, { target: { value: 'SN-0001' } });
  await waitFor(() => expect((destroyBtn as HTMLButtonElement).disabled).toBe(false));

  const listCallsBefore = api.listPendingDeletes.mock.calls.length;
  fireEvent.click(destroyBtn);

  await waitFor(() => expect(api.cascadeDelete).toHaveBeenCalledWith('pd1', 'SN-0001'));
  await waitFor(() => expect(api.listPendingDeletes.mock.calls.length).toBeGreaterThan(listCallsBefore));

  const heading = await screen.findByText('Reconcile complete');
  expect(heading.closest('.dir-empty')?.textContent).toMatch(/1 deleted/);
});
