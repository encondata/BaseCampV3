// @vitest-environment jsdom
/**
 * /people/time — the "Timesheet report" toolbar button: shown only with
 * reports:add + time:view, and it opens the Generate modal on the Timesheet
 * definition prefilled from the screen's own filters and status pill.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ReportDefinition, UiPreferences } from '../lib/api';
import { quickRange } from '../lib/timesheetReport';

const auth = vi.hoisted(() => ({ can: (_r: string, _a?: string): boolean => true }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: auth.can,
    person: { id: 'p-me', first_name: 'Mo', last_name: 'Manager' },
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default', motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default', list_view: 'expanded',
      notif: { critical: true, email: true, maint: true, digest: true, sound: 'chime' },
      list_prefs: {},
    } satisfies UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));
vi.mock('../lib/systemStatusContext', () => ({
  useSystemStatus: () => ({
    status: { read_only: false, read_only_message: '', workers_paused: false, banner: null },
    refresh: vi.fn(),
  }),
}));

const api = vi.hoisted(() => ({
  getMyTime: vi.fn(),
  getPunchOptions: vi.fn(),
  listActiveTimeEntries: vi.fn(),
  listTimeEntries: vi.fn(),
  listWorkerOptions: vi.fn(),
  listInitiatives: vi.fn(),
  listReportDefinitions: vi.fn(),
  getTimesheetPreview: vi.fn(),
  createReportRun: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const TS_DEF: ReportDefinition = {
  id: 'd10', name: 'Timesheet', description: 'Hours worked by person and job.',
  report_type: 'timesheet', is_system: true, updated_at: '2026-10-06T00:00:00Z',
  options: { default_format: 'xlsx', default_views: ['day', 'punch'], default_statuses: ['approved', 'pending'] },
};
const MOVE_DEF: ReportDefinition = {
  id: 'd1', name: 'Move Report', description: 'x', report_type: 'move_report',
  is_system: true, updated_at: '2026-10-06T00:00:00Z', options: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  api.getMyTime.mockResolvedValue({ open: null, entries: [] });
  api.getPunchOptions.mockResolvedValue({
    initiatives: [], sites: [{ id: 's1', name: 'Dallas DC' }],
  });
  api.listActiveTimeEntries.mockResolvedValue([]);
  api.listTimeEntries.mockResolvedValue([]);
  api.listWorkerOptions.mockResolvedValue([
    { person_id: 'p1', display_name: 'Alice Tech' },
  ]);
  api.listInitiatives.mockResolvedValue([
    { id: 'i1', name: 'NAP11', archived_at: null },
  ]);
  api.listReportDefinitions.mockResolvedValue([MOVE_DEF, TS_DEF]);
  api.getTimesheetPreview.mockResolvedValue({
    entries: 3, people: 2, days: 2, approved_minutes: 60, pending_minutes: 0,
    flagged_entries: 0, too_many: false,
  });
});

afterEach(cleanup);

const { default: TimeManagement } = await import('./TimeManagement');

const REPORT_BTN = { name: 'Timesheet report' };

it('shows the button only with reports:add and time:view', async () => {
  const cases: [Record<string, boolean>, boolean][] = [
    [{ 'reports:add': true, 'time:view': true }, true],
    [{ 'reports:add': false, 'time:view': true }, false],
    [{ 'reports:add': true, 'time:view': false }, false],
  ];
  for (const [grants, shown] of cases) {
    // `can('time')` (no action) is what gates the screen's Timesheet section.
    auth.can = (r, a) => (r === 'time' && !a) || !!grants[`${r}:${a}`];
    const { unmount } = render(<TimeManagement />);
    await screen.findByRole('group', { name: 'Timesheet filters' });
    expect(screen.queryByRole('button', REPORT_BTN) !== null).toBe(shown);
    unmount();
  }
});

it('opens the Generate modal on the Timesheet options with the screen filters', async () => {
  const user = userEvent.setup();
  render(<TimeManagement />);
  const filters = await screen.findByRole('group', { name: 'Timesheet filters' });

  await user.click(within(filters).getByRole('combobox', { name: 'Person' }));
  fireEvent.mouseDown(await screen.findByText('Alice Tech'));
  await user.click(within(filters).getByRole('combobox', { name: 'Job' }));
  fireEvent.mouseDown(await screen.findByText('NAP11'));
  await user.click(within(filters).getByRole('combobox', { name: 'Site' }));
  fireEvent.mouseDown(await screen.findByText('Dallas DC'));
  fireEvent.change(within(filters).getByLabelText('From date'), { target: { value: '2026-09-01' } });
  fireEvent.change(within(filters).getByLabelText('To date'), { target: { value: '2026-09-15' } });
  await user.click(screen.getByRole('tab', { name: 'Pending' }));

  await user.click(screen.getByRole('button', REPORT_BTN));

  // Straight on the options step: no initiative pick, From/To prefilled.
  expect(((await screen.findByLabelText('From')) as HTMLInputElement).value).toBe('2026-09-01');
  expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe('2026-09-15');
  await waitFor(() => expect(api.getTimesheetPreview).toHaveBeenCalledWith({
    from: '2026-09-01', to: '2026-09-15', person_id: 'p1', initiative_id: 'i1', site_id: 's1',
    statuses: ['pending'],
  }));
});

it.each([
  ['All', ['approved', 'pending', 'rejected', 'open']],
  ['Open', ['open']],
  ['Pending', ['pending']],
  ['Approved', ['approved']],
  ['Rejected', ['rejected']],
])('the %s pill prefills statuses %j', async (pill, statuses) => {
  const user = userEvent.setup();
  render(<TimeManagement />);
  await screen.findByRole('group', { name: 'Timesheet filters' });
  await user.click(screen.getByRole('tab', { name: pill }));
  await user.click(screen.getByRole('button', REPORT_BTN));
  await waitFor(() => expect(api.getTimesheetPreview).toHaveBeenCalledWith(
    expect.objectContaining({ statuses })));
});

it('empty dates open on This month', async () => {
  const user = userEvent.setup();
  render(<TimeManagement />);
  await screen.findByRole('group', { name: 'Timesheet filters' });
  await user.click(screen.getByRole('button', REPORT_BTN));
  const month = quickRange('this_month', new Date());
  expect(((await screen.findByLabelText('From')) as HTMLInputElement).value).toBe(month.from);
  expect((screen.getByLabelText('To') as HTMLInputElement).value).toBe(month.to);
});

it('says so when the Timesheet definition is missing', async () => {
  api.listReportDefinitions.mockResolvedValue([MOVE_DEF]);
  const user = userEvent.setup();
  render(<TimeManagement />);
  await screen.findByRole('group', { name: 'Timesheet filters' });
  await user.click(screen.getByRole('button', REPORT_BTN));
  expect(await screen.findByText("The Timesheet report isn't set up. Ask an administrator.")).not.toBeNull();
  expect(screen.queryByLabelText('From')).toBeNull();
});

it('says so when the definitions cannot be loaded', async () => {
  api.listReportDefinitions.mockRejectedValue(new Error('boom'));
  const user = userEvent.setup();
  render(<TimeManagement />);
  await screen.findByRole('group', { name: 'Timesheet filters' });
  await user.click(screen.getByRole('button', REPORT_BTN));
  expect(await screen.findByText("The Timesheet report isn't set up. Ask an administrator.")).not.toBeNull();
});
