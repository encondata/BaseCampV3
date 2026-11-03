// @vitest-environment jsdom
/**
 * /initiatives/timeline — the project-plan overlay (spec "All-initiatives
 * Timeline page"): for `project_plans:view` holders only, a "Milestones"
 * pill-check (default on, remembered) beside "Show cancelled"; the tasks
 * flagged Show on timeline as diamonds on their initiative's row (Timeline)
 * or diamond chips on their day (Calendar), each with a hover card (name,
 * date, Complete / Late) and a link to the task in its plan; and a "Plan:"
 * line on the initiative hover card. Data from GET /plans/timeline for the
 * range the page shows (lib/plans/api getTimelineMilestones, mocked here).
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InitiativeItem, StatusValue } from '../lib/api';
import type { PlanTimeline } from '../lib/plans/api';

const auth = vi.hoisted(() => ({ perms: new Set<string>() }));
vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: (resource: string, action = 'view') => auth.perms.has(`${resource}:${action}`),
  }),
}));

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(),
  listInitiativeStatuses: vi.fn(),
}));
vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

const plans = vi.hoisted(() => ({ getTimelineMilestones: vi.fn() }));
vi.mock('../lib/plans/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/plans/api')>()),
  ...plans,
}));

const { default: InitiativeTimeline } = await import('./InitiativeTimeline');

const HOVER_DELAY_MS = 180;

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

const STATUSES: StatusValue[] = [{
  record_type: 'initiative', key: 'scheduled', label: 'Scheduled', description: '',
  color: '#1668a7', sort_order: 0, is_active: true, usage_count: null, progress_weight: null,
}];

const DENVER = initiative();
const PHOENIX = initiative({
  id: 'i2', name: 'Phoenix refresh', scheduled_start: '2026-09-15', scheduled_end: '2026-09-18',
});

const DATA: PlanTimeline = {
  milestones: [
    {
      initiative_id: 'i1', plan_id: 'p1', task_id: 't1', name: 'Crates staged',
      at: '2026-09-07T17:00', complete: true, late: false,
    },
    {
      initiative_id: 'i1', plan_id: 'p1', task_id: 't2', name: 'Move day',
      at: '2026-09-14T08:00', complete: false, late: false,
    },
  ],
  summaries: {
    i1: { percent_complete: 42, next: { name: 'Move day', at: '2026-09-14T08:00' } },
  },
};

beforeEach(() => {
  localStorage.clear();
  auth.perms = new Set(['initiatives:view', 'project_plans:view']);
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date(2026, 8, 8)); // Tue Sep 8 2026
  api.listInitiativeStatuses.mockResolvedValue(STATUSES);
  plans.getTimelineMilestones.mockResolvedValue(DATA);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function renderPage(items: InitiativeItem[] = [DENVER, PHOENIX]) {
  api.listInitiatives.mockResolvedValue(items);
  render(<MemoryRouter><InitiativeTimeline /></MemoryRouter>);
  await act(() => vi.advanceTimersByTimeAsync(0));
}

function rowOf(name: string): HTMLElement {
  return screen.getByText(name, { selector: 'b' }).closest('.itl-row') as HTMLElement;
}

function diamonds(scope: ParentNode = document): HTMLAnchorElement[] {
  return [...scope.querySelectorAll('.itl-milestone')] as HTMLAnchorElement[];
}

function toCalendar() {
  fireEvent.click(within(screen.getAllByRole('tablist')[0]).getByRole('button', { name: 'Calendar' }));
}

async function hover(el: Element) {
  fireEvent.mouseOver(el);
  await act(() => vi.advanceTimersByTimeAsync(HOVER_DELAY_MS + 20));
}

function card(): HTMLElement | null {
  return document.querySelector('.ihv-card');
}

describe('without project_plans:view', () => {
  beforeEach(() => { auth.perms = new Set(['initiatives:view']); });

  it('has no toggle, draws no diamonds and never asks for milestones', async () => {
    await renderPage();
    expect(screen.queryByLabelText('Milestones')).toBeNull();
    expect(screen.getByLabelText('Show cancelled')).not.toBeNull();
    expect(diamonds()).toHaveLength(0);

    toCalendar();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(document.querySelector('.itl-milestone-chip')).toBeNull();
    expect(plans.getTimelineMilestones).not.toHaveBeenCalled();
  });
});

describe('with project_plans:view', () => {
  it('asks for the range the timeline shows', async () => {
    await renderPage();
    // the Month scale on Sep 8: Sep 1 through Sep 30, both included
    expect(plans.getTimelineMilestones).toHaveBeenCalledWith('2026-09-01', '2026-09-30');
  });

  it('draws two diamonds on the right row, by day, linking to the task in the plan', async () => {
    await renderPage();
    expect(screen.getByLabelText('Milestones')).toHaveProperty('checked', true);

    const mine = diamonds(rowOf('Denver DC migration'));
    expect(mine).toHaveLength(2);
    expect(diamonds(rowOf('Phoenix refresh'))).toHaveLength(0);

    // the middle of each day in a 30-day range: Sep 7 → 6.5/30, Sep 14 → 13.5/30
    expect(parseFloat(mine[0].style.left)).toBeCloseTo((6.5 / 30) * 100, 5);
    expect(parseFloat(mine[1].style.left)).toBeCloseTo((13.5 / 30) * 100, 5);
    expect(mine[0].getAttribute('href')).toBe('/initiatives/i1?tab=plan&task=t1');
    expect(mine[1].getAttribute('href')).toBe('/initiatives/i1?tab=plan&task=t2');
    expect(mine[0].className).toContain('complete');
    expect(mine[1].getAttribute('aria-label')).toBe('Move day, Sep 14');
    expect(mine[0].getAttribute('aria-label')).toBe('Crates staged, Sep 7, Complete');
  });

  it('a diamond hover shows its name, date and Complete / Late', async () => {
    plans.getTimelineMilestones.mockResolvedValue({
      ...DATA,
      milestones: [...DATA.milestones, {
        initiative_id: 'i2', plan_id: 'p2', task_id: 't9', name: 'Cutover',
        at: '2026-09-04T17:00', complete: false, late: true,
      }],
    });
    await renderPage();

    const [done, next] = diamonds(rowOf('Denver DC migration'));
    await hover(next);
    expect(card()?.querySelector('.ihv-name')?.textContent).toBe('Move day');
    expect(card()?.textContent).toContain('Sep 14');
    expect(card()?.textContent).not.toMatch(/Complete|Late/);
    fireEvent.mouseOut(next);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(card()).toBeNull();

    await hover(done);
    expect(card()?.textContent).toContain('Complete');
    fireEvent.mouseOut(done);

    const [late] = diamonds(rowOf('Phoenix refresh'));
    expect(late.className).toContain('late');
    await hover(late);
    expect(card()?.querySelector('.ihv-name')?.textContent).toBe('Cutover');
    expect(card()?.textContent).toContain('Late');
  });

  it('sets diamonds on the same day side by side, not on top of each other', async () => {
    plans.getTimelineMilestones.mockResolvedValue({
      milestones: [
        { ...DATA.milestones[0], task_id: 'a', name: 'Assign crew leads', at: '2026-09-07T10:00' },
        { ...DATA.milestones[0], task_id: 'b', name: 'Kickoff meeting', at: '2026-09-07T12:00' },
      ],
      summaries: {},
    });
    await renderPage();
    // either side of the middle of Sep 7 (6.5/30 of the range)
    const [first, second] = diamonds(rowOf('Denver DC migration'));
    expect(first.style.left).toMatch(/^calc\(21\.66\d*% - 6px\)$/);
    expect(second.style.left).toMatch(/^calc\(21\.66\d*% \+ 6px\)$/);
  });

  it('keeps a row whose own dates are outside the range for its milestone in it', async () => {
    plans.getTimelineMilestones.mockResolvedValue({
      milestones: [{
        initiative_id: 'i3', plan_id: 'p3', task_id: 't3', name: 'Site survey',
        at: '2026-09-21T10:00', complete: false, late: false,
      }],
      summaries: {},
    });
    await renderPage([DENVER, initiative({
      id: 'i3', name: 'Austin cutover', scheduled_start: '2026-10-05', scheduled_end: '2026-10-06',
    })]);
    expect(diamonds(rowOf('Austin cutover'))).toHaveLength(1);
  });

  it('turning Milestones off hides the diamonds and is remembered', async () => {
    await renderPage();
    fireEvent.click(screen.getByLabelText('Milestones'));
    expect(diamonds()).toHaveLength(0);
    expect(localStorage.getItem('initiatives-timeline.milestones')).toBe('off');

    cleanup();
    await renderPage();
    expect(screen.getByLabelText('Milestones')).toHaveProperty('checked', false);
    expect(diamonds()).toHaveLength(0);

    fireEvent.click(screen.getByLabelText('Milestones'));
    expect(diamonds()).toHaveLength(2);
    expect(localStorage.getItem('initiatives-timeline.milestones')).toBe('on');
  });

  it('the Calendar shows diamond chips on their day and asks for the grid it shows', async () => {
    await renderPage();
    toCalendar();
    await act(() => vi.advanceTimersByTimeAsync(0));
    // Sep 2026's grid runs Mon Aug 31 through Sun Oct 11
    expect(plans.getTimelineMilestones).toHaveBeenLastCalledWith('2026-08-31', '2026-10-11');

    const chips = [...document.querySelectorAll('.itl-milestone-chip')] as HTMLAnchorElement[];
    expect(chips.map((c) => c.textContent)).toEqual(['Crates staged', 'Move day']);
    // Mon Sep 7 and Mon Sep 14: the first column of their weeks
    expect(chips.map((c) => c.style.gridColumn)).toEqual(['1 / span 1', '1 / span 1']);
    expect(chips[1].getAttribute('href')).toBe('/initiatives/i1?tab=plan&task=t2');
    expect(chips[1].querySelector('.itl-milestone-diamond')).not.toBeNull();

    fireEvent.click(screen.getByLabelText('Milestones'));
    expect(document.querySelector('.itl-milestone-chip')).toBeNull();
  });

  it('the initiative hover card shows the plan line', async () => {
    await renderPage();
    toCalendar();
    await act(() => vi.advanceTimersByTimeAsync(0));

    const denver = [...document.querySelectorAll('.itl-span:not(.itl-milestone-chip)')]
      .find((el) => el.textContent?.includes('Denver DC migration')) as HTMLElement;
    await hover(denver);
    expect(card()?.textContent).toContain('Plan: 42% complete · next: Move day Sep 14');
    fireEvent.mouseOut(denver);
    await act(() => vi.advanceTimersByTimeAsync(0));

    // no plan: no line
    const phoenix = [...document.querySelectorAll('.itl-span')]
      .find((el) => el.textContent?.includes('Phoenix refresh')) as HTMLElement;
    await hover(phoenix);
    expect(card()?.textContent).not.toContain('Plan:');
  });

  it('a plan with nothing left to do says only its percent', async () => {
    plans.getTimelineMilestones.mockResolvedValue({
      milestones: [], summaries: { i1: { percent_complete: 100, next: null } },
    });
    await renderPage();
    toCalendar();
    await act(() => vi.advanceTimersByTimeAsync(0));
    await hover(document.querySelector('.itl-span') as HTMLElement);
    expect(card()?.textContent).toContain('Plan: 100% complete');
    expect(card()?.textContent).not.toContain('next:');
  });

  it('a failed request leaves the page as it was', async () => {
    plans.getTimelineMilestones.mockRejectedValue(new Error('boom'));
    await renderPage();
    expect(screen.getByText('Denver DC migration', { selector: 'b' })).not.toBeNull();
    expect(diamonds()).toHaveLength(0);
  });
});
