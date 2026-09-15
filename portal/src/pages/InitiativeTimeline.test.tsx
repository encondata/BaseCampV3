// @vitest-environment jsdom
/**
 * /initiatives/timeline — the Gantt-style timeline and month-calendar
 * views over the same initiatives list. Pure range/tick/bar/grid math is
 * covered by lib/timeline.test.ts; this covers what's page-specific:
 * rows + bars rendering, the unscheduled section, type/status filters,
 * cancelled hidden until the pill-check, Month view's day chips, and the
 * ‹ › range navigation.
 *
 * A scheduled row's name renders twice when its bar is wide enough for
 * an inline label (once in the sticky `.pn b` row label, once in the
 * bar itself) — name lookups below use `{ selector: 'b' }` to pin to
 * the row label and avoid an ambiguous match.
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { InitiativeItem, StatusValue } from '../lib/api';

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({ can: () => true }),
}));

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(),
  listInitiativeStatuses: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const { default: InitiativeTimeline } = await import('./InitiativeTimeline');

function initiative(over: Partial<InitiativeItem> = {}): InitiativeItem {
  return {
    id: 'i1', name: 'Denver DC migration', description: null,
    initiative_type: 'move', type_label: 'Move', type_color: '#1668a7',
    sub_type: null, sub_type_label: null, sub_type_color: null,
    status: 'scheduled', status_label: 'Scheduled', status_color: '#1668a7',
    client_id: 'c1', client_name: 'Acme',
    site_id: 's1', site_name: 'DC-East', location: null,
    scheduled_start: '2026-09-05', scheduled_end: '2026-09-10',
    sky_command_project_id: null,
    origin_site_id: null, origin_site_name: null,
    destination_site_id: null, destination_site_name: null,
    real_start_at: null, real_end_at: null,
    priority_devices: null, shipping_types: [],
    shipping_partner_id: null, shipping_partner_name: null,
    origin_tech_partner_id: null, origin_cable_partner_id: null,
    origin_logistics_partner_id: null,
    destination_tech_partner_id: null, destination_cable_partner_id: null,
    destination_logistics_partner_id: null,
    origin_vendor_involved: null, destination_vendor_involved: null,
    people_count: 0, links_count: 0,
    archived_at: null, created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function status(key: string, label: string): StatusValue {
  return {
    record_type: 'initiative', key, label, description: '', color: '#1668a7',
    sort_order: 0, is_active: true, usage_count: null, progress_weight: null,
  };
}

const STATUSES = [
  status('planned', 'Planned'),
  status('scheduled', 'Scheduled'),
  status('in_progress', 'In progress'),
  status('on_hold', 'On hold'),
  status('completed', 'Completed'),
  status('cancelled', 'Cancelled'),
];

beforeEach(() => {
  localStorage.clear(); // view/scale/type/status persist across renders — not across tests
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 8, 8)); // Sep 8 2026
  api.listInitiativeStatuses.mockResolvedValue(STATUSES);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function renderPage(items: InitiativeItem[]) {
  api.listInitiatives.mockResolvedValue(items);
  render(<MemoryRouter><InitiativeTimeline /></MemoryRouter>);
  await act(() => vi.advanceTimersByTimeAsync(0));
}

/** The View switch is the first `.segmented` tablist in the toolbar — the
 *  Scale switch (Month/Quarter/Year) also has a "Month" button, so tests
 *  that click the view switch scope to this tablist to avoid ambiguity. */
function viewSwitch() {
  return screen.getAllByRole('tablist')[0];
}

it('renders a row and bar for a scheduled initiative', async () => {
  await renderPage([initiative()]);
  expect(screen.getByText('Denver DC migration', { selector: 'b' })).not.toBeNull();
  expect(screen.getByText('Acme · DC-East')).not.toBeNull();
  const bar = document.querySelector('.itl-bar');
  expect(bar).not.toBeNull();
  expect(bar?.getAttribute('title')).toContain('Denver DC migration');
  expect(bar?.getAttribute('title')).toContain('Scheduled');
});

it('lists an unscheduled initiative under the Unscheduled divider', async () => {
  await renderPage([
    initiative({ id: 'i2', name: 'Someday project', scheduled_start: null, scheduled_end: null }),
  ]);
  expect(screen.getByText('Unscheduled')).not.toBeNull();
  expect(screen.getByText('Someday project', { selector: 'b' })).not.toBeNull();
  expect(screen.getByText('No dates yet')).not.toBeNull();
});

it('narrows rows with the type pill', async () => {
  await renderPage([
    initiative({ id: 'i1', name: 'A move', initiative_type: 'move' }),
    initiative({ id: 'i2', name: 'A project', initiative_type: 'project' }),
  ]);
  expect(screen.getByText('A move', { selector: 'b' })).not.toBeNull();
  expect(screen.getByText('A project', { selector: 'b' })).not.toBeNull();

  fireEvent.click(screen.getByRole('button', { name: /^Projects/ }));
  expect(screen.queryByText('A move', { selector: 'b' })).toBeNull();
  expect(screen.getByText('A project', { selector: 'b' })).not.toBeNull();
});

it('narrows rows with the status pill', async () => {
  await renderPage([
    initiative({ id: 'i1', name: 'Planned one', status: 'planned', status_label: 'Planned' }),
    initiative({ id: 'i2', name: 'On hold one', status: 'on_hold', status_label: 'On hold' }),
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'On hold' }));
  expect(screen.queryByText('Planned one', { selector: 'b' })).toBeNull();
  expect(screen.getByText('On hold one', { selector: 'b' })).not.toBeNull();
});

it('hides cancelled initiatives until "Show cancelled" is checked', async () => {
  await renderPage([
    initiative({ id: 'i1', name: 'Live one', status: 'scheduled' }),
    initiative({ id: 'i2', name: 'Dead one', status: 'cancelled', status_label: 'Cancelled' }),
  ]);
  expect(screen.queryByText('Dead one', { selector: 'b' })).toBeNull();

  fireEvent.click(screen.getByLabelText('Show cancelled'));
  expect(screen.getByText('Dead one', { selector: 'b' })).not.toBeNull();
});

it('switching to Calendar shows the grid with the item on its day', async () => {
  await renderPage([
    initiative({ scheduled_start: '2026-09-05', scheduled_end: '2026-09-05' }), // single day
  ]);
  fireEvent.click(within(viewSwitch()).getByRole('button', { name: 'Calendar' }));
  expect(document.querySelector('.itl-month-grid')).not.toBeNull();
  const bar = document.querySelector('.itl-span') as HTMLElement;
  expect(bar).not.toBeNull();
  expect(within(bar).getByText('Denver DC migration')).not.toBeNull();
  // Sep 5 2026 is a Saturday: column 6 of the week, one day wide.
  expect(bar.style.gridColumn).toBe('6 / span 1');
});

it('draws a run as one bar per week, spanning the days it covers', async () => {
  await renderPage([
    // Thu Sep 10 → Wed Sep 16, so two week rows.
    initiative({ scheduled_start: '2026-09-10', scheduled_end: '2026-09-16' }),
  ]);
  fireEvent.click(within(viewSwitch()).getByRole('button', { name: 'Calendar' }));
  const bars = [...document.querySelectorAll('.itl-span')] as HTMLElement[];
  expect(bars).toHaveLength(2);
  expect(bars[0].style.gridColumn).toBe('4 / span 4');
  expect(bars[0].className).toContain('cont-after');
  expect(bars[0].className).not.toContain('cont-before');
  expect(bars[1].style.gridColumn).toBe('1 / span 3');
  expect(bars[1].className).toContain('cont-before');
  expect(bars[1].className).not.toContain('cont-after');
  // Both halves link to the initiative and name it.
  for (const bar of bars) {
    expect(bar.getAttribute('href')).toBe('/initiatives/i1');
    expect(within(bar).getByText('Denver DC migration')).not.toBeNull();
  }
});

it('folds a crowded week into "+N more" and expands it on click', async () => {
  // Five runs all crossing Tue Sep 8 — one more than the lane cap.
  await renderPage([1, 2, 3, 4, 5].map((n) => initiative({
    id: `i${n}`, name: `Run ${n}`,
    scheduled_start: '2026-09-08', scheduled_end: '2026-09-09',
  })));
  fireEvent.click(within(viewSwitch()).getByRole('button', { name: 'Calendar' }));
  expect(document.querySelectorAll('.itl-span')).toHaveLength(4);
  expect(screen.queryByText('Run 5')).toBeNull();

  const more = screen.getAllByRole('button', { name: /Show all initiatives/ });
  expect(more).toHaveLength(2); // Sep 8 and Sep 9 are both crowded
  expect(more[0].textContent).toBe('+1 more');

  fireEvent.click(more[0]);
  expect(document.querySelectorAll('.itl-span')).toHaveLength(5);
  expect(screen.getByText('Run 5')).not.toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
  expect(document.querySelectorAll('.itl-span')).toHaveLength(4);
});

it('‹ and › move the visible range', async () => {
  await renderPage([
    initiative({ id: 'i1', name: 'September item', scheduled_start: '2026-09-05', scheduled_end: '2026-09-06' }),
    initiative({ id: 'i2', name: 'August item', scheduled_start: '2026-08-05', scheduled_end: '2026-08-06' }),
  ]);
  expect(screen.getByText('September item', { selector: 'b' })).not.toBeNull();
  expect(screen.queryByText('August item', { selector: 'b' })).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
  expect(screen.queryByText('September item', { selector: 'b' })).toBeNull();
  expect(screen.getByText('August item', { selector: 'b' })).not.toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Next period' }));
  expect(screen.getByText('September item', { selector: 'b' })).not.toBeNull();
  expect(screen.queryByText('August item', { selector: 'b' })).toBeNull();
});
