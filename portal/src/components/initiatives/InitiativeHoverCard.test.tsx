// @vitest-environment jsdom
/**
 * InitiativeHoverCard — the hover card behind a calendar bar on
 * /initiatives/timeline. Covers the mechanics (nothing before the intent
 * delay, the card after it, gone on leave) and the content: name, status
 * and type chips, client · site, the scheduled and actual ranges (with
 * the "still running" wording while real_end_at is unset) and a move's
 * origin → destination.
 */

import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import InitiativeHoverCard from './InitiativeHoverCard';
import type { InitiativeItem } from '../../lib/api';
import { longDateOf } from '../../lib/format';

function initiative(over: Partial<InitiativeItem> = {}): InitiativeItem {
  return {
    id: 'i1', name: 'Denver DC migration', description: null,
    initiative_type: 'move', type_label: 'Move', type_color: '#1668a7',
    sub_type: null, sub_type_label: null, sub_type_color: null,
    status: 'scheduled', status_label: 'Scheduled', status_color: '#c8862a',
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
    archived_at: null, created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

/** The local calendar day a date-only API field names — what the card
 *  must print, and what `new Date(iso)` would get wrong west of UTC. */
function day(y: number, m: number, d: number): string {
  return longDateOf(new Date(y, m - 1, d));
}

const HOVER_DELAY_MS = 180;

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderBar(item: InitiativeItem) {
  render(
    <InitiativeHoverCard item={item}>
      <a className="itl-span" href={`/initiatives/${item.id}`}>{item.name}</a>
    </InitiativeHoverCard>,
  );
  return document.querySelector('.ihv-wrap') as HTMLElement;
}

function card(): HTMLElement | null {
  return document.querySelector('.ihv-card');
}

function hover(el: HTMLElement) {
  fireEvent.mouseOver(el);
  act(() => { vi.advanceTimersByTime(HOVER_DELAY_MS + 20); });
}

it('shows nothing until the bar has been hovered for the intent delay', () => {
  const wrap = renderBar(initiative());
  expect(card()).toBeNull();

  fireEvent.mouseOver(wrap);
  act(() => { vi.advanceTimersByTime(HOVER_DELAY_MS - 20); });
  expect(card()).toBeNull(); // still inside the intent delay

  act(() => { vi.advanceTimersByTime(40); });
  expect(card()).not.toBeNull();
});

it('names the initiative and chips its status and type', () => {
  const wrap = renderBar(initiative());
  hover(wrap);

  const el = card()!;
  expect(el.querySelector('.ihv-name')?.textContent).toBe('Denver DC migration');

  const chips = [...el.querySelectorAll('.chip.custom')] as HTMLElement[];
  expect(chips).toHaveLength(2);
  expect(chips[0].textContent).toBe('Scheduled');
  expect(chips[0].style.getPropertyValue('--chip')).toBe('#c8862a');
  expect(chips[1].textContent).toBe('Move');
  expect(chips[1].style.getPropertyValue('--chip')).toBe('#1668a7');
});

it('shows client · site and the scheduled range', () => {
  const wrap = renderBar(initiative());
  hover(wrap);

  const text = card()!.textContent ?? '';
  expect(text).toContain('Acme · DC-East');
  expect(text).toContain(`Scheduled: ${day(2026, 9, 5)} → ${day(2026, 9, 10)}`);
});

it('omits the client · site line when the initiative has neither', () => {
  const wrap = renderBar(initiative({
    client_name: null, site_name: null, scheduled_end: null,
  }));
  hover(wrap);

  const text = card()!.textContent ?? '';
  expect(text).not.toContain('·');
  // A one-day run prints the single day, not an arrow.
  expect(text).toContain(`Scheduled: ${day(2026, 9, 5)}`);
  expect(text).not.toContain('→');
});

it('says a run with no real end is still running', () => {
  const wrap = renderBar(initiative({ real_start_at: '2026-09-06', real_end_at: null }));
  hover(wrap);

  expect(card()!.textContent).toContain(`Actual: ${day(2026, 9, 6)} → still running`);
});

it('names both real dates once the run has finished', () => {
  const wrap = renderBar(initiative({
    real_start_at: '2026-09-06', real_end_at: '2026-09-11',
  }));
  hover(wrap);

  expect(card()!.textContent).toContain(`Actual: ${day(2026, 9, 6)} → ${day(2026, 9, 11)}`);
});

it('leaves the Actual line off when the run has not started', () => {
  const wrap = renderBar(initiative());
  hover(wrap);

  expect(card()!.textContent).not.toContain('Actual');
});

it('shows origin → destination for a move', () => {
  const wrap = renderBar(initiative({
    initiative_type: 'move',
    origin_site_name: 'Sunnyvale HQ', destination_site_name: 'Denver DC',
  }));
  hover(wrap);

  expect(card()!.textContent).toContain('Sunnyvale HQ → Denver DC');
});

it('leaves the move line off for a project, even with sites on the record', () => {
  const wrap = renderBar(initiative({
    initiative_type: 'project', type_label: 'Project',
    origin_site_name: 'Sunnyvale HQ', destination_site_name: 'Denver DC',
  }));
  hover(wrap);

  expect(card()!.textContent).not.toContain('Sunnyvale HQ → Denver DC');
});

it('takes the card away on mouse leave', () => {
  const wrap = renderBar(initiative());
  hover(wrap);
  expect(card()).not.toBeNull();

  fireEvent.mouseOut(wrap);
  expect(card()).toBeNull();
});

it('drops a pending card when the pointer leaves inside the intent delay', () => {
  const wrap = renderBar(initiative());
  fireEvent.mouseOver(wrap);
  fireEvent.mouseOut(wrap);
  act(() => { vi.advanceTimersByTime(HOVER_DELAY_MS + 20); });

  expect(card()).toBeNull();
});

it('portals the card to <body>, outside the calendar grid that would clip it', () => {
  const wrap = renderBar(initiative());
  hover(wrap);

  const el = card()!;
  expect(wrap.contains(el)).toBe(false);
  expect(el.parentElement).toBe(document.body);
});
