// @vitest-environment jsdom
/**
 * /time — Timesheet bulk approval: checkboxes on pending rows only, select
 * all (with the indeterminate state), Approve / Reject selected, "Approve
 * all pending in this view" (dry run, then confirm), the result note and
 * its Show skipped list, and the time:change gate. The harness mirrors
 * TimeManagement.test.tsx.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { TimeEntryItem, UiPreferences } from '../lib/api';

const auth = vi.hoisted(() => ({ can: (_r: string, _a?: string): boolean => true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    person: { id: 'p-me', first_name: 'Mo', last_name: 'Manager' },
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: true, sound: 'chime' },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  getMyTime: vi.fn(),
  getPunchOptions: vi.fn(),
  listActiveTimeEntries: vi.fn(),
  listTimeEntries: vi.fn(),
  listWorkerOptions: vi.fn(),
  listInitiatives: vi.fn(),
  bulkApproveTimeEntries: vi.fn(),
  countBulkApproveTimeEntries: vi.fn(),
  bulkRejectTimeEntries: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

function entry(over: Partial<TimeEntryItem>): TimeEntryItem {
  return {
    id: 'e1', person_id: 'p1', person_name: 'Alice Tech',
    initiative_id: null, initiative_name: null, site_id: null, site_name: null,
    clock_in_at: '2026-09-01T13:00:00Z', clock_out_at: '2026-09-01T21:00:00Z',
    break_minutes: 30, minutes: 450,
    status: 'pending', status_label: 'Pending', status_color: '#a36207',
    source: 'kiosk', notes: '', adjusted: false, adjust_reason: null,
    approved_by: null, approved_by_name: null, approved_at: null, reject_reason: null,
    created_at: '2026-09-01T13:00:00Z', updated_at: '2026-09-01T21:00:00Z',
    ...over,
  };
}

const ALICE = entry({ id: 'e1', person_name: 'Alice Tech' });
const CY = entry({
  id: 'e3', person_id: 'p3', person_name: 'Cy Pending',
  clock_in_at: '2026-09-02T13:00:00Z', clock_out_at: '2026-09-02T21:00:00Z',
});
const BOB = entry({
  id: 'e2', person_id: 'p2', person_name: 'Bob Builder',
  status: 'approved', status_label: 'Approved', status_color: '#178a4c',
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.getMyTime.mockResolvedValue({ open: null, entries: [] });
  api.getPunchOptions.mockResolvedValue({ initiatives: [], sites: [] });
  api.listActiveTimeEntries.mockResolvedValue([]);
  api.listTimeEntries.mockResolvedValue([ALICE, BOB, CY]);
  api.listWorkerOptions.mockResolvedValue([]);
  api.listInitiatives.mockResolvedValue([]);
});

afterEach(cleanup);

const { default: TimeManagement } = await import('./TimeManagement');

const rowOf = (name: string) => screen.getByText(name).closest('.dir-row') as HTMLElement;
const selectAll = () =>
  screen.getByRole('checkbox', { name: 'Select all pending entries shown' }) as HTMLInputElement;

it('only pending rows get a checkbox; the header selects every pending row shown', async () => {
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  expect(within(rowOf('Alice Tech')).getByRole('checkbox', { name: /^Select Alice Tech, / }))
    .toBeTruthy();
  expect(within(rowOf('Bob Builder')).queryByRole('checkbox')).toBeNull();

  fireEvent.click(within(rowOf('Alice Tech')).getByRole('checkbox'));
  expect(selectAll().indeterminate).toBe(true);
  expect(screen.getByText('1 selected')).toBeTruthy();

  fireEvent.click(selectAll());
  expect(selectAll().checked).toBe(true);
  expect(selectAll().indeterminate).toBe(false);
  expect(screen.getByText('2 selected')).toBeTruthy();

  fireEvent.click(selectAll());
  expect(screen.queryByText(/^\d+ selected$/)).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve selected' })).toBeNull();
});

it('Approve selected sends the ids, reports the result, refreshes and clears the selection', async () => {
  api.bulkApproveTimeEntries.mockResolvedValue({
    approved: 1,
    skipped: [{ entry_id: 'e3', person: 'Cy Pending', date: '2026-09-02T13:00:00Z',
                reason: 'no longer pending' }],
  });
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  fireEvent.click(selectAll());
  fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));

  await waitFor(() => expect(api.bulkApproveTimeEntries).toHaveBeenCalledWith({ entry_ids: ['e1', 'e3'] }));
  expect(await screen.findByText('Approved 1 entry. Skipped 1: no longer pending (1).')).toBeTruthy();
  await waitFor(() => expect(api.listTimeEntries).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('2 selected')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Show skipped' }));
  const table = screen.getByRole('table', { name: 'Skipped entries' });
  expect(within(table).getByText('Cy Pending')).toBeTruthy();
  expect(within(table).getByText('no longer pending')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Hide skipped' }));
  expect(screen.queryByRole('table', { name: 'Skipped entries' })).toBeNull();
});

it('Reject selected asks for one reason in a dialog and sends it with every id', async () => {
  api.bulkRejectTimeEntries.mockResolvedValue({ rejected: 1, skipped: [] });
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  fireEvent.click(within(rowOf('Alice Tech')).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Reject selected' }));

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Timesheet')).toBeTruthy();
  expect(within(dialog).getByRole('heading', { name: 'Reject 1 entry' })).toBeTruthy();
  const submit = within(dialog).getByRole('button', { name: 'Reject 1 entry' }) as HTMLButtonElement;
  expect(submit.disabled).toBe(true);
  fireEvent.change(within(dialog).getByLabelText(/rejection reason/i), { target: { value: ' No show ' } });
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);

  await waitFor(() => expect(api.bulkRejectTimeEntries).toHaveBeenCalledWith(['e1'], 'No show'));
  expect(await screen.findByText('Rejected 1 entry.')).toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});

const AS_OF = '2026-09-25T12:00:00.123456+00:00';

it('Approve all pending in this view counts with a dry run, confirms, then sends the filter', async () => {
  api.countBulkApproveTimeEntries.mockResolvedValue({ count: 214, as_of: AS_OF });
  api.bulkApproveTimeEntries.mockResolvedValue({ approved: 214, skipped: [] });
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  fireEvent.click(screen.getByRole('button', { name: 'Approve all pending in this view' }));

  await waitFor(() => expect(api.countBulkApproveTimeEntries).toHaveBeenCalledWith({ filter: {} }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText('Approve 214 pending entries that match these filters?')).toBeTruthy();
  expect(api.bulkApproveTimeEntries).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole('button', { name: 'Approve 214 entries' }));

  // as_of from the count, so an entry created since is not approved unseen
  await waitFor(() => expect(api.bulkApproveTimeEntries).toHaveBeenCalledWith({ filter: { as_of: AS_OF } }));
  expect(await screen.findByText('Approved 214 entries.')).toBeTruthy();
});

it('more than 5,000 matches says to narrow the filters', async () => {
  const { ApiError } = await import('../lib/api');
  api.countBulkApproveTimeEntries.mockRejectedValue(new ApiError(422, 'too_many'));
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  fireEvent.click(screen.getByRole('button', { name: 'Approve all pending in this view' }));
  expect(await screen.findByText('More than 5,000 entries match. Narrow the filters and try again.'))
    .toBeTruthy();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('search text disables Approve all, since search only narrows the loaded rows', async () => {
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  fireEvent.change(screen.getByPlaceholderText('Filter entries…'), { target: { value: 'alice' } });
  const btn = screen.getByRole('button', { name: 'Approve all pending in this view' }) as HTMLButtonElement;
  expect(btn.disabled).toBe(true);
  expect(screen.getByText(/Column filters and search narrow only the loaded rows/)).toBeTruthy();
});

it('Approve all is not offered on the Approved pill', async () => {
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  api.listTimeEntries.mockResolvedValue([BOB]);
  fireEvent.click(screen.getByRole('tab', { name: 'Approved' }));
  await waitFor(() => expect(api.listTimeEntries).toHaveBeenLastCalledWith({ status: 'approved' }));
  expect(screen.queryByRole('button', { name: 'Approve all pending in this view' })).toBeNull();
});

it('without time:change there are no checkboxes and no bulk buttons', async () => {
  auth.can = (resource, action) => resource === 'time' && action === undefined;
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  expect(screen.queryByRole('button', { name: 'Approve all pending in this view' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve selected' })).toBeNull();
});

it('hiding a selected row with search prunes it from the selection', async () => {
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  fireEvent.click(within(rowOf('Alice Tech')).getByRole('checkbox'));
  expect(screen.getByText('1 selected')).toBeTruthy();

  // Search for "Cy" hides Alice's row, so the selection it held is no
  // longer visible — the chip and the bulk button must disappear with it.
  fireEvent.change(screen.getByPlaceholderText('Filter entries…'), { target: { value: 'Cy' } });
  await waitFor(() => expect(screen.queryByText('Alice Tech')).toBeNull());
  expect(screen.queryByText('1 selected')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Approve selected' })).toBeNull();

  // Clearing the search brings Alice's row back, but pruning already
  // dropped her id from `selected`, so the checkbox comes back unchecked.
  fireEvent.change(screen.getByPlaceholderText('Filter entries…'), { target: { value: '' } });
  await screen.findByText('Alice Tech');
  expect((within(rowOf('Alice Tech')).getByRole('checkbox') as HTMLInputElement).checked).toBe(false);
});

it('a zero dry-run count replaces the result and collapses an open skipped list', async () => {
  api.bulkApproveTimeEntries.mockResolvedValue({
    approved: 0,
    skipped: [{ entry_id: 'e1', person: 'Alice Tech', date: '2026-09-01T13:00:00Z',
                reason: 'your own entry' }],
  });
  api.countBulkApproveTimeEntries.mockResolvedValue({ count: 0, as_of: AS_OF });
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  fireEvent.click(within(rowOf('Alice Tech')).getByRole('checkbox'));
  fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Show skipped' }));
  expect(screen.getByRole('table', { name: 'Skipped entries' })).toBeTruthy();

  fireEvent.click(screen.getByRole('button', { name: 'Approve all pending in this view' }));
  expect(await screen.findByText('No pending entries that you can approve match these filters.'))
    .toBeTruthy();
  expect(screen.queryByRole('table', { name: 'Skipped entries' })).toBeNull();
  expect(screen.queryByRole('dialog')).toBeNull();
});

it('your own pending rows get no checkbox, and select all leaves them out', async () => {
  const MINE = entry({ id: 'e9', person_id: 'p-me', person_name: 'Mo Manager',
                       clock_in_at: '2026-09-03T13:00:00Z', clock_out_at: '2026-09-03T21:00:00Z' });
  api.listTimeEntries.mockResolvedValue([ALICE, BOB, CY, MINE]);
  api.bulkApproveTimeEntries.mockResolvedValue({ approved: 2, skipped: [] });
  render(<TimeManagement />);
  await screen.findByText('Mo Manager');
  expect(within(rowOf('Mo Manager')).queryByRole('checkbox')).toBeNull();
  fireEvent.click(selectAll());
  expect(selectAll().checked).toBe(true);
  expect(screen.getByText('2 selected')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve selected' }));
  await waitFor(() => expect(api.bulkApproveTimeEntries).toHaveBeenCalledWith({ entry_ids: ['e1', 'e3'] }));
});
