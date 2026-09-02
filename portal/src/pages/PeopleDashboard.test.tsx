// @vitest-environment jsdom
/**
 * /dashboards/people — desk-density workforce dashboard. Covers what a
 * unit test can see: KPI values pulled from both getTimeStatsSummary and
 * getPeopleFlow, the walk-by rail's newest-first cards with the initials
 * fallback, the on-the-clock rows and event feed rendering together, the
 * auto-refresh interval re-fetching without blanking loaded panels, and
 * per-resource panel gating (Home.tsx style).
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { TimeEntryItem } from '../lib/api';

const auth = vi.hoisted(() => {
  const state: { can: (resource: string, action?: string) => boolean } = {
    can: () => true,
  };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: auth.can }),
}));

const api = vi.hoisted(() => ({
  getTimeStatsSummary: vi.fn(),
  getPeopleFlow: vi.fn(),
  listActiveTimeEntries: vi.fn(),
  listTimeEntries: vi.fn(),
  listWorkers: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const { default: PeopleDashboard } = await import('./PeopleDashboard');

const E = (over: Partial<TimeEntryItem>): TimeEntryItem => ({
  id: 'e1', person_id: 'p1', person_name: 'Ada Lovelace',
  initiative_id: null, initiative_name: null, site_id: null, site_name: null,
  clock_in_at: '2026-09-02T09:00:00Z', clock_out_at: null,
  break_minutes: 0, minutes: 0,
  status: 'open', status_label: 'Open', status_color: '#333',
  source: 'punch', notes: '', adjusted: false, adjust_reason: null,
  approved_by: null, approved_by_name: null, approved_at: null,
  reject_reason: null,
  created_at: '2026-09-02T09:00:00Z', updated_at: '2026-09-02T09:00:00Z',
  ...over,
});

const now = Date.now();
const hoursAgo = (h: number) => new Date(now - h * 3_600_000).toISOString();

function daysFixture() {
  const days: { day: string; minutes: number }[] = [];
  for (let i = 13; i >= 1; i -= 1) {
    days.push({ day: new Date(now - i * 86_400_000).toISOString().slice(0, 10), minutes: 0 });
  }
  days.push({ day: new Date(now).toISOString().slice(0, 10), minutes: 510 });
  return days;
}

const SUMMARY = { clocked_in: 3, pending_entries: 2, minutes_today: 510, days: daysFixture() };
const FLOW = {
  events: [{
    person_id: 'p1', display_name: 'Ada Lovelace', avatar_url: null,
    device_id: 'dock-reader-1', site_name: 'NAP11', scanned_at: hoursAgo(0.1),
  }],
  distinct_people_today: 4,
  person_scans_today: 12,
};
// Distinct person from the walk-by/event fixtures below (Grace Hopper,
// not Ada) — both panels render bare initials with no avatar, and using
// the same name for both would make `AL` an ambiguous queryByText match.
const ACTIVE: TimeEntryItem[] = [E({
  id: 'a1', person_id: 'p2', person_name: 'Grace Hopper', clock_in_at: hoursAgo(3),
})];
const ENTRIES: TimeEntryItem[] = [
  E({ id: 'e2', clock_in_at: '2026-09-02T08:00:00Z',
      clock_out_at: '2026-09-02T12:30:00Z', minutes: 270, site_name: 'NAP11' }),
  E({ id: 'e1', clock_in_at: '2026-09-02T09:00:00Z' }), // still open
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.can = () => true;
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  api.getTimeStatsSummary.mockResolvedValue(SUMMARY);
  api.getPeopleFlow.mockResolvedValue(FLOW);
  api.listActiveTimeEntries.mockResolvedValue(ACTIVE);
  api.listTimeEntries.mockResolvedValue(ENTRIES);
  api.listWorkers.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it('renders KPI values from both sources', async () => {
  render(<MemoryRouter><PeopleDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Clocked in now')).not.toBeNull());
  expect(screen.queryByText('3')).not.toBeNull();          // clocked in
  expect(screen.queryByText('4')).not.toBeNull();          // on site today
  expect(screen.queryByText('8h 30m')).not.toBeNull();     // 510 minutes
  expect(screen.queryByText('12')).not.toBeNull();         // badge scans
});

it('walk-by rail renders newest-first cards with initials fallback', async () => {
  render(<MemoryRouter><PeopleDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('Ada')).not.toBeNull());
  expect(screen.queryByText('AL')).not.toBeNull();         // initials, no avatar
  expect(screen.queryByText('dock-reader-1')).not.toBeNull();
});

it('on-the-clock rows show elapsed and the event feed interleaves', async () => {
  render(<MemoryRouter><PeopleDashboard /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByText('On the clock now')).not.toBeNull());
  expect(screen.queryAllByText(/clocked in/i).length).toBeGreaterThan(0);
  expect(screen.queryByText(/clocked out/i)).not.toBeNull();
});

it('auto-refresh interval refetches without blanking', async () => {
  vi.useFakeTimers();
  render(<MemoryRouter><PeopleDashboard /></MemoryRouter>);
  await act(() => vi.advanceTimersByTimeAsync(0));
  const before = api.getTimeStatsSummary.mock.calls.length;
  fireEvent.change(screen.getByLabelText(/Auto-refresh/i), { target: { value: '15' } });
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(api.getTimeStatsSummary.mock.calls.length).toBeGreaterThan(before);
});

it('panels hide without their resource', async () => {
  auth.can = (r: string) => r === 'dashboard';
  render(<MemoryRouter><PeopleDashboard /></MemoryRouter>);
  await waitFor(() =>
    expect(screen.queryByText(/Nothing your permissions/)).not.toBeNull());
  expect(screen.queryByText('Reader walk-bys')).toBeNull();
});
