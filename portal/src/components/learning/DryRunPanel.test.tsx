// @vitest-environment jsdom
/**
 * The dry run: pick an initiative and see what the rules would assign (four
 * summary tiles, then who gets what and why, what was skipped, who has no
 * email). Download summary is a CSV; "Assign and schedule invites" posts the
 * same call with apply=true and is offered only to managers with learning:add.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '../../lib/api';
import type { AssignSummary } from '../../lib/learning';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../lib/notificationsContext', () => ({ useToast: () => toast }));

const auth = vi.hoisted(() => ({
  perms: { view: true, add: true, change: true, delete: true } as Record<string, boolean>,
}));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string, action = 'view') => resource === 'learning' && auth.perms[action] === true,
    scope: { global: true },
    preferences: {},
    updatePreferences: vi.fn(),
    hasRole: () => false,
  }),
}));

const listTools = vi.hoisted(() => ({ exportCsv: vi.fn() }));
vi.mock('../../lib/listTools', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/listTools')>()),
  ...listTools,
}));

const api = vi.hoisted(() => ({ dryRunInitiative: vi.fn() }));
vi.mock('../../lib/learning', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/learning')>()),
  ...api,
}));
const apiLib = vi.hoisted(() => ({ listInitiatives: vi.fn() }));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...apiLib,
}));

const { default: DryRunPanel } = await import('./DryRunPanel');

const SUMMARY: AssignSummary = {
  totals: { checked: 42, to_assign: 96, skipped: 38, no_email: 2 },
  rows: [
    {
      person_id: 'p1', name: 'Tom Becker', will_get: ['Site rules', 'Acme NDA'],
      why: ['every_initiative', 'every_initiative'],
      skipped: [{ title: 'Standard', reason: 'valid_until:2027-03-03' }], no_email: false,
    },
    {
      person_id: 'p2', name: 'Ana Lim', will_get: ['Standard'], why: ['never_signed'],
      skipped: [], no_email: true,
    },
  ],
};

beforeEach(() => {
  auth.perms = { view: true, add: true, change: true, delete: true };
  apiLib.listInitiatives.mockReset().mockResolvedValue([
    { id: 'i1', name: 'Acme DFW data center move', code: 'DFW', archived_at: null },
    { id: 'i2', name: 'Old move', code: null, archived_at: '2026-01-01T00:00:00Z' },
  ]);
  api.dryRunInitiative.mockReset().mockResolvedValue(SUMMARY);
  listTools.exportCsv.mockReset();
  toast.mockReset();
});
afterEach(cleanup);

async function runFor(name = 'Acme DFW data center move') {
  render(<DryRunPanel />);
  await waitFor(() => expect(apiLib.listInitiatives).toHaveBeenCalled());
  fireEvent.focus(screen.getByLabelText('Initiative to check'));
  fireEvent.mouseDown(await screen.findByText(name));
}

it('asks for an initiative first and offers only live ones', async () => {
  render(<DryRunPanel />);
  expect(screen.getByText(/pick an initiative/i)).toBeTruthy();
  await waitFor(() => expect(apiLib.listInitiatives).toHaveBeenCalled());
  fireEvent.focus(screen.getByLabelText('Initiative to check'));
  expect(await screen.findByText('Acme DFW data center move')).toBeTruthy();
  expect(screen.queryByText('Old move')).toBeNull();
  expect(api.dryRunInitiative).not.toHaveBeenCalled();
});

it('shows the four tiles and the per-row table after picking an initiative', async () => {
  await runFor();
  await waitFor(() => expect(api.dryRunInitiative).toHaveBeenCalledWith('i1', false));
  const tiles = await screen.findByRole('group', { name: 'Dry run totals' });
  for (const [value, label] of [['42', 'Workers checked'], ['96', 'Documents to assign'],
    ['38', 'Already valid, skipped'], ['2', 'No email on file']]) {
    const tile = within(tiles).getByText(label).closest('.lrn-tile') as HTMLElement;
    expect(within(tile).getByText(value)).toBeTruthy();
  }
  const tom = (await screen.findByText('Tom Becker')).closest('.dir-row') as HTMLElement;
  expect(within(tom).getByText('Site rules, Acme NDA')).toBeTruthy();
  expect(within(tom).getByText('Signs again every initiative')).toBeTruthy();   // one reason, not two
  expect(within(tom).getByText('Standard: Valid until Mar 3, 2027')).toBeTruthy();
  expect(within(tom).queryByText(/every_initiative|valid_until/)).toBeNull();
  const ana = screen.getByText('Ana Lim').closest('.dir-row') as HTMLElement;
  expect(within(ana).getByText(/no email: print code/i)).toBeTruthy();
  expect(within(ana).getByText('None')).toBeTruthy();
});

it('Download summary writes the rows as CSV', async () => {
  const user = userEvent.setup();
  await runFor();
  await screen.findByText('Tom Becker');
  await user.click(screen.getByRole('button', { name: 'Download summary' }));
  expect(listTools.exportCsv).toHaveBeenCalledTimes(1);
  const [filename, columns, rows] = listTools.exportCsv.mock.calls[0];
  expect(filename).toBe('learning-dry-run');
  expect(rows).toBe(SUMMARY.rows);
  const cell = (head: string, row: number) =>
    (columns as [string, (r: unknown) => string][]).find(([h]) => h === head)![1](SUMMARY.rows[row]);
  expect(cell('Worker', 0)).toBe('Tom Becker');
  expect(cell('Will get', 0)).toBe('Site rules; Acme NDA');
  expect(cell('Skipped', 0)).toBe('Standard: Valid until Mar 3, 2027');
  expect(cell('Why', 0)).toBe('Signs again every initiative');
  expect(cell('Why', 1)).toBe('Never signed');
  expect(cell('No email', 0)).toBe('No');
  expect(cell('No email', 1)).toBe('Yes');
});

it('Assign and schedule invites posts apply=true, then re-runs the preview', async () => {
  const user = userEvent.setup();
  await runFor();
  await screen.findByText('Tom Becker');
  api.dryRunInitiative
    .mockResolvedValueOnce({
      totals: { checked: 42, to_assign: 96, skipped: 38, no_email: 2 }, rows: SUMMARY.rows,
    })
    .mockResolvedValueOnce({
      totals: { checked: 42, to_assign: 0, skipped: 134, no_email: 2 },
      rows: [{ person_id: 'p3', name: 'Zed Fresh', will_get: [], why: [],
        skipped: [{ title: 'Standard', reason: 'already_assigned' }], no_email: false }],
    });
  await user.click(screen.getByRole('button', { name: 'Assign and schedule invites' }));
  await waitFor(() => expect(api.dryRunInitiative).toHaveBeenLastCalledWith('i1', false));
  expect(api.dryRunInitiative.mock.calls.map((c) => c[1])).toEqual([false, true, false]);
  expect(await screen.findByText(/assigned 96 documents/i)).toBeTruthy();
  expect(toast).toHaveBeenCalled();
  // the stale preview is gone: the table shows the state after the assignment
  expect(await screen.findByText('Zed Fresh')).toBeTruthy();
  expect(screen.queryByText('Tom Becker')).toBeNull();
  expect(screen.getByText('Standard: Already assigned')).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Assign and schedule invites' }).hasAttribute('disabled')).toBe(true);
});

it('without learning:add there is no apply button', async () => {
  auth.perms = { view: true, change: true };
  await runFor();
  await screen.findByText('Tom Becker');
  expect(screen.queryByRole('button', { name: 'Assign and schedule invites' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Download summary' })).toBeTruthy();
});

it('says so when nobody needs anything, and when the run fails', async () => {
  api.dryRunInitiative.mockResolvedValueOnce({
    totals: { checked: 5, to_assign: 0, skipped: 5, no_email: 0 }, rows: [],
  });
  await runFor();
  expect(await screen.findByText(/nobody needs anything/i)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Assign and schedule invites' }).hasAttribute('disabled')).toBe(true);
  cleanup();

  api.dryRunInitiative.mockRejectedValueOnce(new ApiError(500, 'boom'));
  await runFor();
  expect(await screen.findByText(/couldn.t run the dry run/i)).toBeTruthy();
});

it('an apply failure keeps the preview and shows the reason', async () => {
  const user = userEvent.setup();
  await runFor();
  await screen.findByText('Tom Becker');
  api.dryRunInitiative.mockRejectedValueOnce(new ApiError(403, 'forbidden', { code: 'forbidden' }));
  await user.click(screen.getByRole('button', { name: 'Assign and schedule invites' }));
  expect(await screen.findByText(/don.t have permission/i)).toBeTruthy();
  expect(screen.getByText('Tom Becker')).toBeTruthy();
});
