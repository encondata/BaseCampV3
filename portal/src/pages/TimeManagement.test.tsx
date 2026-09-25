// @vitest-environment jsdom
/**
 * /time — the timesheet list's per-row actions. Covers what the row
 * offers (Approve / Reject only while pending, Edit always), that the
 * approve round trip still refetches, and the action track's width.
 * The punch clock, the column menu and TimeEntryEditModal's own
 * validation are covered elsewhere (lib/columnMenu.test.tsx,
 * components/time/TimeEntryEditModal.test.tsx).
 *
 * Mocking style mirrors Warehouse.test.tsx (hoisted AuthContext +
 * lib/api mocks, fixtures at module scope).
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { TimeEntryItem, UiPreferences } from '../lib/api';
import { LIST_FIT } from '../lib/listTools';
import { dayStartIso } from '../lib/timeBulk';

const auth = vi.hoisted(() => ({ can: (_r: string, _a?: string): boolean => true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
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
  approveTimeEntry: vi.fn(),
  rejectTimeEntry: vi.fn(),
  updateTimeEntry: vi.fn(),
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

const PENDING = entry({ id: 'e1', person_name: 'Alice Tech', status: 'pending', status_label: 'Pending' });
const APPROVED = entry({
  id: 'e2', person_id: 'p2', person_name: 'Bob Builder',
  status: 'approved', status_label: 'Approved', status_color: '#178a4c',
  approved_by: 'p9', approved_by_name: 'Cara Boss', approved_at: '2026-09-02T00:00:00Z',
});

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.getMyTime.mockResolvedValue({ open: null, entries: [] });
  api.getPunchOptions.mockResolvedValue({ initiatives: [], sites: [] });
  api.listActiveTimeEntries.mockResolvedValue([]);
  api.listTimeEntries.mockResolvedValue([PENDING, APPROVED]);
  api.listWorkerOptions.mockResolvedValue([]);
  api.listInitiatives.mockResolvedValue([]);
  api.approveTimeEntry.mockResolvedValue(APPROVED);
});

afterEach(cleanup);

const { default: TimeManagement } = await import('./TimeManagement');

/** Open one timesheet row's Actions menu. Items are then queried via
 *  `screen`, NOT `within(row)`: RowActionsMenu portals the open menu to
 *  document.body (see RowActionsMenu.tsx and the note at
 *  KioskDevices.test.tsx:178), so they leave the row's DOM subtree once
 *  open. Only one menu is open at a time here. */
async function openRowMenu(user: ReturnType<typeof userEvent.setup>, name: string) {
  const row = screen.getByText(name).closest('.dir-row') as HTMLElement;
  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  return row;
}

it('timesheet row: one Actions trigger replaces the inline Approve/Reject/Edit buttons', async () => {
  const user = userEvent.setup();
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');

  const row = screen.getByText('Alice Tech').closest('.dir-row') as HTMLElement;
  expect(within(row).queryByRole('button', { name: 'Approve' })).toBeNull();
  expect(within(row).queryByRole('button', { name: 'Reject' })).toBeNull();
  expect(within(row).queryByRole('button', { name: 'Edit' })).toBeNull();

  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  expect(screen.getByRole('menuitem', { name: 'Approve' })).not.toBeNull();
  const reject = screen.getByRole('menuitem', { name: 'Reject' });
  expect(reject.className).toContain('danger');
  expect(screen.getByRole('menuitem', { name: 'Edit' })).not.toBeNull();
});

it('timesheet row: a non-pending entry offers Edit only — Approve/Reject are dropped, not disabled', async () => {
  const user = userEvent.setup();
  render(<TimeManagement />);
  await screen.findByText('Bob Builder');

  await openRowMenu(user, 'Bob Builder');
  expect(screen.getByRole('menuitem', { name: 'Edit' })).not.toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Approve' })).toBeNull();
  expect(screen.queryByRole('menuitem', { name: 'Reject' })).toBeNull();
});

it('timesheet row: Actions → Approve approves the entry and refetches', async () => {
  const user = userEvent.setup();
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');

  await openRowMenu(user, 'Alice Tech');
  await user.click(screen.getByRole('menuitem', { name: 'Approve' }));

  await waitFor(() => expect(api.approveTimeEntry).toHaveBeenCalledWith('e1'));
  await waitFor(() => expect(api.listTimeEntries).toHaveBeenCalledTimes(2));
});

it('timesheet row: Actions → Reject opens the review modal in reject mode', async () => {
  const user = userEvent.setup();
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');

  await openRowMenu(user, 'Alice Tech');
  await user.click(screen.getByRole('menuitem', { name: 'Reject' }));

  expect(await screen.findByLabelText(/rejection reason/i)).not.toBeNull();
});

it('timesheet row: Actions → Edit opens the entry edit modal', async () => {
  const user = userEvent.setup();
  render(<TimeManagement />);
  await screen.findByText('Bob Builder');

  await openRowMenu(user, 'Bob Builder');
  await user.click(screen.getByRole('menuitem', { name: 'Edit' }));

  expect(await screen.findByRole('heading', { name: /edit — bob builder/i })).not.toBeNull();
});

it('timesheet row: items are disabled, not dropped, while the row is in flight', async () => {
  const user = userEvent.setup();
  api.approveTimeEntry.mockReturnValue(new Promise(() => {}));
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');

  const row = await openRowMenu(user, 'Alice Tech');
  await user.click(screen.getByRole('menuitem', { name: 'Approve' }));

  await user.click(within(row).getByRole('button', { name: /Actions/ }));
  await waitFor(() => {
    expect((screen.getByRole('menuitem', { name: 'Approve' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('menuitem', { name: 'Edit' }) as HTMLButtonElement).disabled).toBe(true);
  });
});

it('timesheet: column floors, shared template + minimum, sideways-scroll card', async () => {
  render(<TimeManagement />);
  const row = (await screen.findByText('Alice Tech')).closest('.dir-row') as HTMLElement;
  const card = row.closest('.dir-list') as HTMLElement;
  expect(card.classList.contains('list-scroll')).toBe(true);
  const head = card.querySelector('.list-head') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  // time:change adds the 32px selection track in front of the columns
  expect(head.style.gridTemplateColumns).toMatch(/^32px minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(row.style.minWidth).toBe(head.style.minWidth);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
});

it('timesheet: the action track is trigger-sized', async () => {
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');

  const row = screen.getByText('Alice Tech').closest('.dir-row') as HTMLElement;
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(main.style.gridTemplateColumns.includes('210px')).toBe(false);
  expect(main.style.gridTemplateColumns.endsWith('88px')).toBe(true);
});

it('timesheet row: no trigger without can(time, change)', async () => {
  auth.can = (resource, action) => resource === 'time' && action === undefined;
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');

  const row = screen.getByText('Alice Tech').closest('.dir-row') as HTMLElement;
  expect(within(row).queryByRole('button', { name: /Actions/ })).toBeNull();
  const main = row.querySelector('.row-main') as HTMLElement;
  expect(main.style.gridTemplateColumns.endsWith('88px')).toBe(false);
});

it('timesheet filters: a person and a From day refetch the list server-side, Clear filters resets', async () => {
  api.listWorkerOptions.mockResolvedValue([{ person_id: 'p7', display_name: 'Wes Worker' }]);
  render(<TimeManagement />);
  await screen.findByText('Alice Tech');
  expect(api.listTimeEntries).toHaveBeenLastCalledWith({});

  fireEvent.focus(screen.getByLabelText('Person', { selector: 'input' }));
  fireEvent.mouseDown(await screen.findByText('Wes Worker'));
  await waitFor(() => expect(api.listTimeEntries).toHaveBeenLastCalledWith({ person_id: 'p7' }));

  fireEvent.change(screen.getByLabelText('From date'), { target: { value: '2026-09-01' } });
  await waitFor(() => expect(api.listTimeEntries).toHaveBeenLastCalledWith({
    person_id: 'p7', since: dayStartIso('2026-09-01'),
  }));

  fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
  await waitFor(() => expect(api.listTimeEntries).toHaveBeenLastCalledWith({}));
});

it('timesheet filters: when the person list cannot load, the Person filter says so', async () => {
  // GET /workers needs workers:view, which a time:view holder may not have
  api.listWorkerOptions.mockRejectedValue(new Error('403'));
  render(<TimeManagement />);
  expect(await screen.findByText('The person list could not be loaded.')).toBeTruthy();
  expect(screen.queryByLabelText('Person', { selector: 'input' })).toBeNull();
  expect(screen.getByLabelText('Job', { selector: 'input' })).toBeTruthy();
});
