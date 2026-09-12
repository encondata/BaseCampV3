// @vitest-environment jsdom
/**
 * DbTestingTab — Developer › Database › Testing. Covers the god-mode
 * lock, every status-card rendering (idle/snapshotting/active with live
 * changes/reverting/failed+hint), the password-cleared start/keep/revert
 * actions and their error-code mapping, the worker-offline disable, the
 * 5-second status poll, and the recent-sessions list. The API surface
 * (getDbTestingStatus/startDbTesting/endDbTesting) is mocked per the
 * contract in docs/superpowers/specs/2026-09-12-db-testing-mode-
 * design.md — this is a portal-only unit test, not a live check.
 */

import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError, type DbTestingSession, type DbTestingStatusOut } from '../../lib/api';
import DbTestingTab from './DbTestingTab';

const auth = vi.hoisted(() => ({ godMode: true }));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ godMode: auth.godMode }),
}));

const api = vi.hoisted(() => ({
  getDbTestingStatus: vi.fn(),
  startDbTesting: vi.fn(),
  endDbTesting: vi.fn(),
}));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

function session(overrides: Partial<DbTestingSession> = {}): DbTestingSession {
  return {
    id: 's1',
    status: 'active',
    started_by_name: 'Jimmy Henderson',
    started_at: '2026-09-12T10:00:00Z',
    ended_at: null,
    ended_with: null,
    snapshot_filename: 'testing_snapshot_20260912_1000.sql',
    error: null,
    ...overrides,
  };
}

function statusOut(overrides: Partial<DbTestingStatusOut> = {}): DbTestingStatusOut {
  return {
    session: null,
    changes: null,
    recent: [],
    worker_online: true,
    ...overrides,
  };
}

beforeEach(() => {
  auth.godMode = true;
  api.getDbTestingStatus.mockReset().mockResolvedValue(statusOut());
  api.startDbTesting.mockReset().mockResolvedValue(session({ status: 'snapshotting' }));
  api.endDbTesting.mockReset().mockResolvedValue(session({ status: 'ended', ended_with: 'kept' }));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it('shows a locked notice without god mode', async () => {
  auth.godMode = false;
  render(<DbTestingTab />);
  expect(screen.queryByText('Unlock god mode to use database testing.')).not.toBeNull();
  expect(api.getDbTestingStatus).not.toHaveBeenCalled();
});

it('renders the idle status', async () => {
  render(<DbTestingTab />);
  await waitFor(() => expect(screen.queryByText(/Idle/)).not.toBeNull());
});

it('renders the snapshotting status', async () => {
  api.getDbTestingStatus.mockResolvedValue(statusOut({ session: session({ status: 'snapshotting' }) }));
  render(<DbTestingTab />);
  await waitFor(() => expect(screen.queryByText('Snapshotting…')).not.toBeNull());
});

it('renders the active status with live changes', async () => {
  api.getDbTestingStatus.mockResolvedValue(statusOut({
    session: session(),
    changes: {
      audit_rows: 42,
      tables: [{ table: 'containers', before: 10, after: 25, delta: 15 }],
      since: '2026-09-12T10:00:00Z',
    },
  }));
  render(<DbTestingTab />);
  await waitFor(() => expect(screen.queryByText(/Testing mode ON/)).not.toBeNull());
  expect(screen.queryByText(/Jimmy Henderson/)).not.toBeNull();
  expect(screen.queryByText('testing_snapshot_20260912_1000.sql')).not.toBeNull();
  expect(screen.queryByText(/42 audited changes/)).not.toBeNull();
  expect(screen.queryByText(/containers/)).not.toBeNull();
  expect(screen.queryByText('+15')).not.toBeNull();
});

it('renders the reverting status', async () => {
  api.getDbTestingStatus.mockResolvedValue(statusOut({ session: session({ status: 'reverting' }) }));
  render(<DbTestingTab />);
  await waitFor(() => expect(screen.queryByText('Reverting…')).not.toBeNull());
});

it('renders the failed status with the read-only hint', async () => {
  api.getDbTestingStatus.mockResolvedValue(statusOut({
    session: session({ status: 'failed', error: 'psql exited 1' }),
  }));
  render(<DbTestingTab />);
  await waitFor(() => expect(screen.queryByText(/Failed: psql exited 1/)).not.toBeNull());
  expect(screen.queryByText(/read-only on purpose/)).not.toBeNull();
  expect(screen.queryByText(/Settings › Maintenance/)).not.toBeNull();
});

it('start posts the password and clears the field', async () => {
  const user = userEvent.setup();
  render(<DbTestingTab />);
  await waitFor(() => expect(screen.queryByText(/Idle/)).not.toBeNull());

  const input = screen.getByLabelText('Testing password') as HTMLInputElement;
  await user.type(input, 'hunter2');
  expect(input.value).toBe('hunter2');

  await user.click(screen.getByRole('button', { name: 'Set DB for Testing' }));

  expect(api.startDbTesting).toHaveBeenCalledWith('hunter2');
  await waitFor(() => expect(input.value).toBe(''));
});

it('worker offline disables Start with a hint', async () => {
  api.getDbTestingStatus.mockResolvedValue(statusOut({ worker_online: false }));
  const user = userEvent.setup();
  render(<DbTestingTab />);
  await waitFor(() => expect(screen.queryByText('Worker offline')).not.toBeNull());
  expect(screen.queryByText(/Start the db-testing worker/)).not.toBeNull();

  await user.type(screen.getByLabelText('Testing password'), 'hunter2');
  const startBtn = screen.getByRole('button', { name: 'Set DB for Testing' }) as HTMLButtonElement;
  expect(startBtn.disabled).toBe(true);
});

it('maps a start error code to plain-English copy', async () => {
  api.startDbTesting.mockRejectedValue(new ApiError(403, 'invalid_testing_password'));
  const user = userEvent.setup();
  render(<DbTestingTab />);
  await waitFor(() => expect(screen.queryByText(/Idle/)).not.toBeNull());

  await user.type(screen.getByLabelText('Testing password'), 'wrong');
  await user.click(screen.getByRole('button', { name: 'Set DB for Testing' }));

  await waitFor(() => expect(screen.queryByText('That is not the testing password.')).not.toBeNull());
});

it('keep posts revert:false', async () => {
  api.getDbTestingStatus.mockResolvedValue(statusOut({ session: session() }));
  const user = userEvent.setup();
  render(<DbTestingTab />);
  await waitFor(() => expect(screen.queryByText(/Testing mode ON/)).not.toBeNull());

  const input = screen.getByLabelText('Testing password') as HTMLInputElement;
  await user.type(input, 'hunter2');
  await user.click(screen.getByRole('button', { name: 'End testing · Keep changes' }));

  expect(api.endDbTesting).toHaveBeenCalledWith('hunter2', false);
  await waitFor(() => expect(input.value).toBe(''));
});

it('revert requires its own password and posts revert:true', async () => {
  api.getDbTestingStatus.mockResolvedValue(statusOut({ session: session() }));
  api.endDbTesting.mockResolvedValue(session({ status: 'ended', ended_with: 'reverted' }));
  const user = userEvent.setup();
  render(<DbTestingTab />);
  await waitFor(() => expect(screen.queryByText(/Testing mode ON/)).not.toBeNull());

  await user.click(screen.getByRole('button', { name: 'End testing · Revert to snapshot' }));
  const modalRevertBtn = screen.getByRole('button', { name: 'Revert' }) as HTMLButtonElement;
  expect(modalRevertBtn.disabled).toBe(true); // no password yet

  await user.type(screen.getByLabelText('Testing password', { selector: '#dbt-revert-password' }), 'hunter2');
  await user.click(modalRevertBtn);

  expect(api.endDbTesting).toHaveBeenCalledWith('hunter2', true);
});

it('shows revert error copy inside the modal', async () => {
  api.getDbTestingStatus.mockResolvedValue(statusOut({ session: session() }));
  api.endDbTesting.mockRejectedValue(new ApiError(409, 'session_not_active'));
  const user = userEvent.setup();
  render(<DbTestingTab />);
  await waitFor(() => expect(screen.queryByText(/Testing mode ON/)).not.toBeNull());

  await user.click(screen.getByRole('button', { name: 'End testing · Revert to snapshot' }));
  await user.type(screen.getByLabelText('Testing password', { selector: '#dbt-revert-password' }), 'hunter2');
  await user.click(screen.getByRole('button', { name: 'Revert' }));

  await waitFor(() => expect(
    screen.queryByText('There is no active testing session to end.'),
  ).not.toBeNull());
});

it('renders the recent sessions list', async () => {
  api.getDbTestingStatus.mockResolvedValue(statusOut({
    recent: [session({
      id: 'r1', status: 'ended', ended_with: 'reverted', ended_at: '2026-09-12T11:00:00Z',
    })],
  }));
  render(<DbTestingTab />);
  await waitFor(() => expect(screen.queryByText('Jimmy Henderson')).not.toBeNull());
  expect(screen.queryByText('Reverted')).not.toBeNull();
  expect(screen.queryByText('testing_snapshot_20260912_1000.sql')).not.toBeNull();
});

it('polls status again after 5 seconds while a session is active', async () => {
  vi.useFakeTimers();
  api.getDbTestingStatus.mockResolvedValue(statusOut({ session: session() }));
  render(<DbTestingTab />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const before = api.getDbTestingStatus.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(api.getDbTestingStatus.mock.calls.length).toBeGreaterThan(before);
});

it('does not poll while idle', async () => {
  vi.useFakeTimers();
  render(<DbTestingTab />);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const before = api.getDbTestingStatus.mock.calls.length;
  await act(() => vi.advanceTimersByTimeAsync(5000));
  expect(api.getDbTestingStatus.mock.calls.length).toBe(before);
});
