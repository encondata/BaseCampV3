// @vitest-environment jsdom
/**
 * /initiatives/timeline — the Gantt-style timeline and month-calendar
 * views over the same initiatives list. Pure range/tick/bar/grid math is
 * covered by lib/timeline.test.ts; this covers what's page-specific:
 * rows + bars rendering, the unscheduled section, type/status filters,
 * cancelled hidden until the pill-check, Month view's day chips, the
 * ‹ › range navigation, the 45-day scale, the month band above the day
 * ruler, and the hierarchy both views carry (nested rows and derived
 * spans on the timeline, the shared collapsed set and `Parent › Child`
 * segment labels on the calendar).
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
import { COLLAPSED_KEY } from '../lib/initiatives';

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
    color: null,
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
    parent_id: null, parent_role: null,
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

/* ── Bar color: the initiative's own color, falling back to its status ── */

it('paints the timeline bars with the initiative color, falling back to status', async () => {
  await renderPage([
    initiative({
      id: 'i1', name: 'Purple run', color: '#8b3fb8',
      scheduled_start: '2026-09-05', scheduled_end: '2026-09-10',
      real_start_at: '2026-09-06', real_end_at: '2026-09-09',
    }),
    initiative({
      id: 'i2', name: 'Uncolored run', color: null, status_color: '#2f7d4f',
      scheduled_start: '2026-09-12', scheduled_end: '2026-09-14',
      real_start_at: '2026-09-12', real_end_at: '2026-09-13',
    }),
  ]);
  const bars = [...document.querySelectorAll('.itl-bar')] as HTMLElement[];
  expect(bars).toHaveLength(2);
  expect(bars[0].style.getPropertyValue('--chip')).toBe('#8b3fb8');
  expect(bars[1].style.getPropertyValue('--chip')).toBe('#2f7d4f');

  const realBars = [...document.querySelectorAll('.itl-real-bar')] as HTMLElement[];
  expect(realBars).toHaveLength(2);
  expect(realBars[0].style.getPropertyValue('--chip')).toBe('#8b3fb8');
  expect(realBars[1].style.getPropertyValue('--chip')).toBe('#2f7d4f');
});

it('paints a calendar span with the initiative color, falling back to status', async () => {
  await renderPage([
    initiative({
      id: 'i1', name: 'Purple run', color: '#8b3fb8',
      scheduled_start: '2026-09-05', scheduled_end: '2026-09-05',
    }),
    initiative({
      id: 'i2', name: 'Uncolored run', color: null, status_color: '#2f7d4f',
      scheduled_start: '2026-09-12', scheduled_end: '2026-09-12',
    }),
  ]);
  fireEvent.click(within(viewSwitch()).getByRole('button', { name: 'Calendar' }));
  const spans = [...document.querySelectorAll('.itl-span')] as HTMLElement[];
  expect(spans).toHaveLength(2);
  expect(spans[0].style.getPropertyValue('--chip')).toBe('#8b3fb8');
  expect(spans[1].style.getPropertyValue('--chip')).toBe('#2f7d4f');
});

/* ── The 45-day scale and the month band above the day ruler ────────── */

/** The Scale switch (Month / 45 days / Quarter / Year) is the last
 *  `.segmented` tablist in the toolbar — it shares the label "Month" with
 *  the View switch, so scale clicks scope to this tablist. */
function scaleSwitch() {
  const lists = screen.getAllByRole('tablist');
  return lists[lists.length - 1];
}

function bandLabels() {
  return [...document.querySelectorAll('.itl-band-seg')].map((s) => s.textContent);
}

it('offers a "45 days" scale between Month and Quarter', async () => {
  await renderPage([initiative()]);
  const labels = within(scaleSwitch()).getAllByRole('button').map((b) => b.textContent);
  expect(labels).toEqual(['Month', '45 days', 'Quarter', 'Year']);
});

it('renders 45 day ticks on the 45-day scale', async () => {
  await renderPage([initiative()]);
  fireEvent.click(within(scaleSwitch()).getByRole('button', { name: '45 days' }));
  const ticks = [...document.querySelectorAll('.itl-tick')];
  // Today is Tue Sep 8 2026, so the range runs Mon Sep 7 → Wed Oct 21.
  expect(ticks).toHaveLength(45);
  expect(ticks[0].textContent).toBe('7');
  expect(ticks[44].textContent).toBe('21');
});

it('‹ and › step the 45-day range by 45 days', async () => {
  await renderPage([
    initiative({
      id: 'i1', name: 'September item',
      scheduled_start: '2026-09-09', scheduled_end: '2026-09-09',
    }),
    initiative({
      id: 'i2', name: 'November item',
      scheduled_start: '2026-11-02', scheduled_end: '2026-11-03',
    }),
  ]);
  fireEvent.click(within(scaleSwitch()).getByRole('button', { name: '45 days' }));
  const firstTick = () => document.querySelector('.itl-tick')?.textContent;
  expect(firstTick()).toBe('7'); // Mon Sep 7
  expect(screen.getByText('September item', { selector: 'b' })).not.toBeNull();
  expect(screen.queryByText('November item', { selector: 'b' })).toBeNull();

  // Anchor Sep 8 + 45 days = Fri Oct 23, whose week begins Mon Oct 19.
  // (A month step would land on Oct 8, whose week begins Mon Oct 5.)
  fireEvent.click(screen.getByRole('button', { name: 'Next period' }));
  expect(firstTick()).toBe('19');
  expect(screen.queryByText('September item', { selector: 'b' })).toBeNull();
  expect(screen.getByText('November item', { selector: 'b' })).not.toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Previous period' }));
  expect(firstTick()).toBe('7');
  expect(screen.getByText('September item', { selector: 'b' })).not.toBeNull();
});

it('names every month the range covers above the day ruler', async () => {
  await renderPage([initiative()]);

  // Month scale: Sep 1 → Oct 1, one band.
  expect(bandLabels()).toEqual(['Sep 2026']);
  const header = document.querySelector('.itl-header-row') as HTMLElement;
  const band = header.querySelector('.itl-band') as HTMLElement;
  const ticks = header.querySelector('.itl-ticks') as HTMLElement;
  expect(band).not.toBeNull();
  expect(ticks).not.toBeNull();
  // The band row sits above the day ruler, inside the sticky header.
  expect(band.compareDocumentPosition(ticks) & Node.DOCUMENT_POSITION_FOLLOWING)
    .toBeTruthy();

  // 45-day scale: Mon Sep 7 → Oct 22, so Sep (24 days) then Oct (21).
  fireEvent.click(within(scaleSwitch()).getByRole('button', { name: '45 days' }));
  expect(bandLabels()).toEqual(['Sep 2026', 'Oct 2026']);
  const segs = [...document.querySelectorAll('.itl-band-seg')] as HTMLElement[];
  expect(parseFloat(segs[0].style.left)).toBeCloseTo(0, 0);
  expect(parseFloat(segs[0].style.width)).toBeCloseTo((24 / 45) * 100, 0);
  expect(parseFloat(segs[1].style.left)).toBeCloseTo((24 / 45) * 100, 0);
  expect(parseFloat(segs[1].style.width)).toBeCloseTo((21 / 45) * 100, 0);

  // Quarter scale: Jul 1 → Oct 1, three bands in order.
  fireEvent.click(within(scaleSwitch()).getByRole('button', { name: 'Quarter' }));
  expect(bandLabels()).toEqual(['Jul 2026', 'Aug 2026', 'Sep 2026']);
});

it('leaves the Year scale bandless — its ticks are already month names', async () => {
  await renderPage([initiative()]);
  expect(bandLabels()).toEqual(['Sep 2026']); // Month scale has one

  fireEvent.click(within(scaleSwitch()).getByRole('button', { name: 'Year' }));
  expect(bandLabels()).toEqual([]);
  expect(document.querySelector('.itl-band')).toBeNull();
  // The year ruler already names the months itself.
  expect(document.querySelector('.itl-tick')?.textContent).toBe('Jan');
});

it('honors a remembered 45-day scale from a previous visit', async () => {
  localStorage.setItem('initiatives-timeline.scale', '45d');
  await renderPage([initiative()]);
  const pill = within(scaleSwitch()).getByRole('button', { name: '45 days' });
  expect(pill.className).toContain('on');
  expect(document.querySelectorAll('.itl-tick')).toHaveLength(45);
});

/* ── Calendar hover card ────────────────────────────────────────────── */

/** The calendar's bars carry a hover card (components/initiatives/
 *  InitiativeHoverCard) instead of a native `title`. The card's own
 *  content is covered beside the component; this is the wiring: it
 *  reaches the calendar bars, it carries this item's details, and the
 *  wrapper it adds leaves the bar's grid placement alone. */
it('opens a hover card over a calendar bar, and carries no native title', async () => {
  await renderPage([
    initiative({ scheduled_start: '2026-09-05', scheduled_end: '2026-09-05' }),
  ]);
  fireEvent.click(within(viewSwitch()).getByRole('button', { name: 'Calendar' }));

  const bar = document.querySelector('.itl-span') as HTMLElement;
  expect(bar.getAttribute('title')).toBeNull(); // the card replaces it
  expect(document.querySelector('.ihv-card')).toBeNull();

  fireEvent.mouseOver(bar);
  act(() => { vi.advanceTimersByTime(200); });
  const card = document.querySelector('.ihv-card') as HTMLElement;
  expect(card).not.toBeNull();
  expect(card.textContent).toContain('Denver DC migration');
  expect(card.textContent).toContain('Acme · DC-East');
  expect(card.querySelectorAll('.chip.custom')).toHaveLength(2);

  fireEvent.mouseOut(bar);
  expect(document.querySelector('.ihv-card')).toBeNull();
});

it('leaves the calendar bar its own grid placement under the hover wrapper', async () => {
  await renderPage([
    initiative({ scheduled_start: '2026-09-05', scheduled_end: '2026-09-05' }),
  ]);
  fireEvent.click(within(viewSwitch()).getByRole('button', { name: 'Calendar' }));

  const bar = document.querySelector('.itl-span') as HTMLElement;
  expect(bar.parentElement?.className).toContain('ihv-wrap');
  expect(bar.style.gridColumn).toBe('6 / span 1'); // Sat Sep 5, one day
});

it("leaves the timeline view's bars on their native title (calendar only)", async () => {
  await renderPage([initiative()]);
  const bar = document.querySelector('.itl-bar') as HTMLElement;
  expect(bar.getAttribute('title')).toContain('Denver DC migration');
  expect(document.querySelector('.ihv-wrap')).toBeNull();
});

/* ── Hierarchy: nested rows, derived spans, calendar provenance ──────
 * The flattening itself is covered by lib/initiatives.test.ts
 * (buildInitiativeTree / derivedSpan); these cover what this page adds:
 * the indent and chevron in the sticky row label, the outline bar a
 * dateless parent borrows from its scheduled descendants, which rows the
 * Unscheduled divider still owns, and the calendar's shared collapsed set
 * and `Parent › Child` segment labels. */

const PARENT = initiative({
  id: 'p1', name: 'Denver DC migration',
  initiative_type: 'project', type_label: 'Project',
});
const CHILD = initiative({
  id: 'e1', name: 'Kickoff walkthrough',
  initiative_type: 'event', type_label: 'Event',
  parent_id: 'p1', parent_role: 'Event 1',
  scheduled_start: '2026-09-07', scheduled_end: '2026-09-08',
});

const dateless = { scheduled_start: null, scheduled_end: null };

/** Data rows only — the Unscheduled divider is an `.itl-row` too. */
const itlRows = () =>
  [...document.querySelectorAll('.itl-row:not(.itl-divider-row)')] as HTMLElement[];
const itlRowNames = () =>
  itlRows().map((r) => r.querySelector('.itl-row-label .pn b')?.textContent);
const itlRowFor = (name: string) => itlRows().find(
  (r) => r.querySelector('.itl-row-label .pn b')?.textContent === name) as HTMLElement;
const chevronIn = (row: HTMLElement) =>
  row.querySelector('button[aria-expanded]') as HTMLButtonElement | null;

it('renders a child indented under its parent, with a chevron on the parent', async () => {
  await renderPage([PARENT, CHILD]);
  expect(itlRowNames()).toEqual(['Denver DC migration', 'Kickoff walkthrough']);

  const parent = itlRowFor('Denver DC migration');
  const child = itlRowFor('Kickoff walkthrough');
  expect(parent.style.getPropertyValue('--depth')).toBe('0');
  expect(child.style.getPropertyValue('--depth')).toBe('1');

  // the link's role reads as a chip after a child's name, parent-side only
  expect(child.querySelector('.itl-row-label .chip.c-slate')?.textContent)
    .toBe('Event 1');
  expect(parent.querySelector('.itl-row-label .chip.c-slate')).toBeNull();

  const toggle = chevronIn(parent)!;
  expect(toggle).not.toBeNull();
  expect(toggle.getAttribute('aria-expanded')).toBe('true');
  expect(toggle.getAttribute('aria-label')).toBe('Collapse');
  expect(toggle.textContent).toContain('1');
  // a leaf never offers a chevron, however "expanded" the builder calls it
  expect(chevronIn(child)).toBeNull();
});

it('the chevron collapses the branch and writes the shared collapsed key', async () => {
  await renderPage([PARENT, CHILD]);
  expect(itlRowNames()).toHaveLength(2);

  fireEvent.click(chevronIn(itlRowFor('Denver DC migration'))!);
  expect(itlRowNames()).toEqual(['Denver DC migration']);
  const toggle = chevronIn(itlRowFor('Denver DC migration'))!;
  expect(toggle.getAttribute('aria-expanded')).toBe('false');
  expect(toggle.getAttribute('aria-label')).toBe('Expand');
  expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')).toEqual(['p1']);

  fireEvent.click(toggle);
  expect(itlRowNames()).toEqual(['Denver DC migration', 'Kickoff walkthrough']);
  expect(JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')).toEqual([]);
});

it('a dateless parent borrows an outline bar from its scheduled children', async () => {
  await renderPage([
    { ...PARENT, ...dateless },
    CHILD,                                  // Sep 7 → Sep 8
    initiative({
      id: 'e2', name: 'Cutover weekend', parent_id: 'p1', parent_role: 'Event 2',
      scheduled_start: '2026-09-12', scheduled_end: '2026-09-14',
    }),
  ]);
  // a dateless parent with scheduled work is NOT unscheduled
  expect(screen.queryByText('Unscheduled')).toBeNull();
  expect(itlRowNames()).toEqual(
    ['Denver DC migration', 'Kickoff walkthrough', 'Cutover weekend']);

  const derived = itlRowFor('Denver DC migration')
    .querySelector('.itl-bar.itl-bar-derived') as HTMLElement;
  expect(derived).not.toBeNull();
  expect(derived.getAttribute('title')).toBe('Derived from 2 scheduled initiatives');
  // the envelope Sep 7 → Sep 14 inside the Sep 1 → Oct 1 month range
  expect(parseFloat(derived.style.left)).toBeCloseTo((6 / 30) * 100, 4);
  expect(parseFloat(derived.style.width)).toBeCloseTo((8 / 30) * 100, 4);
  // never drawn as a real bar, and never over real dates
  expect(document.querySelectorAll('.itl-bar-derived')).toHaveLength(1);
});

it('collects the envelope from the whole subtree, not just direct children', async () => {
  await renderPage([
    initiative({ id: 'g1', name: 'Program', ...dateless }),
    initiative({
      id: 's1', name: 'Site survey', parent_id: 'g1',
      scheduled_start: '2026-09-05', scheduled_end: '2026-09-06',
    }),
    initiative({ id: 'p1', name: 'Phase two', parent_id: 'g1', ...dateless }),
    initiative({                              // a GRANDCHILD sets the far end
      id: 't1', name: 'Rack and stack', parent_id: 'p1',
      scheduled_start: '2026-09-09', scheduled_end: '2026-09-11',
    }),
  ]);
  const derived = itlRowFor('Program')
    .querySelector('.itl-bar.itl-bar-derived') as HTMLElement;
  expect(derived.getAttribute('title')).toBe('Derived from 2 scheduled initiatives');
  // Sep 5 → Sep 11: without the grandchild it would stop at Sep 6
  expect(parseFloat(derived.style.left)).toBeCloseTo((4 / 30) * 100, 4);
  expect(parseFloat(derived.style.width)).toBeCloseTo((7 / 30) * 100, 4);
});

it('keeps a dateless root with no scheduled descendants under Unscheduled', async () => {
  await renderPage([
    { ...PARENT, ...dateless },
    { ...CHILD, ...dateless },
  ]);
  expect(screen.getByText('Unscheduled')).not.toBeNull();
  expect(document.querySelector('.itl-bar-derived')).toBeNull();
  // the divider comes first; the branch keeps its shape below it
  const divider = document.querySelector('.itl-divider-row') as HTMLElement;
  const parent = itlRowFor('Denver DC migration');
  expect(divider.compareDocumentPosition(parent) & Node.DOCUMENT_POSITION_FOLLOWING)
    .toBeTruthy();
  expect(itlRowFor('Kickoff walkthrough').style.getPropertyValue('--depth')).toBe('1');
  expect(screen.getAllByText('No dates yet')).toHaveLength(2);
});

it('leaves a dateless child nested under its scheduled parent', async () => {
  await renderPage([PARENT, { ...CHILD, ...dateless }]);
  // it must not jump out of the tree to the bottom of the page
  expect(screen.queryByText('Unscheduled')).toBeNull();
  expect(itlRowNames()).toEqual(['Denver DC migration', 'Kickoff walkthrough']);
  const child = itlRowFor('Kickoff walkthrough');
  expect(child.style.getPropertyValue('--depth')).toBe('1');
  expect(within(child).getByText('No dates yet')).not.toBeNull();
});

it('a type pill matching only the child keeps the parent as a context row', async () => {
  await renderPage([PARENT, CHILD]);
  fireEvent.click(screen.getByRole('button', { name: /^Events/ }));

  expect(itlRowNames()).toEqual(['Denver DC migration', 'Kickoff walkthrough']);
  expect(itlRowFor('Denver DC migration').classList.contains('context')).toBe(true);
  expect(itlRowFor('Kickoff walkthrough').classList.contains('context')).toBe(false);
});

/* ── Calendar: the shared collapsed set and `Parent › Child` labels ── */

const spanNames = () =>
  [...document.querySelectorAll('.itl-span-name')].map((s) => s.textContent);

it("names a child's calendar segment after its parent", async () => {
  await renderPage([
    { ...PARENT, scheduled_start: '2026-09-05', scheduled_end: '2026-09-05' },
    { ...CHILD, scheduled_start: '2026-09-12', scheduled_end: '2026-09-12' },
  ]);
  fireEvent.click(within(viewSwitch()).getByRole('button', { name: 'Calendar' }));
  expect(spanNames()).toEqual([
    'Denver DC migration',
    'Denver DC migration › Kickoff walkthrough',
  ]);
});

it('honors the timeline\'s collapsed set on the calendar', async () => {
  localStorage.setItem(COLLAPSED_KEY, JSON.stringify(['p1']));
  await renderPage([
    { ...PARENT, scheduled_start: '2026-09-05', scheduled_end: '2026-09-05' },
    { ...CHILD, scheduled_start: '2026-09-12', scheduled_end: '2026-09-12' },
  ]);
  fireEvent.click(within(viewSwitch()).getByRole('button', { name: 'Calendar' }));
  expect(spanNames()).toEqual(['Denver DC migration']);
});

it('draws no calendar segment for a dateless parent — the envelope is timeline-only', async () => {
  await renderPage([
    { ...PARENT, ...dateless },
    { ...CHILD, scheduled_start: '2026-09-12', scheduled_end: '2026-09-12' },
  ]);
  fireEvent.click(within(viewSwitch()).getByRole('button', { name: 'Calendar' }));
  expect(document.querySelectorAll('.itl-span')).toHaveLength(1);
  expect(spanNames()).toEqual(['Denver DC migration › Kickoff walkthrough']);
});
