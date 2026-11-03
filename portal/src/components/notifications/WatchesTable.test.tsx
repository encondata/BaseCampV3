// @vitest-environment jsdom
/**
 * WatchesTable — a person's watches (and, on the group page, a group's) as a
 * DataTable: what is watched, which events, whose watch it is (optional), and a
 * row-actions menu for the rows that have actions.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { NotificationKindSetting, Watch } from '../../lib/api';
import type { RowAction } from '../hardware/RowActionsMenu';
import WatchesTable from './WatchesTable';

const INI_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const TRUCK_ID = '33333333-3333-4333-8333-333333333333';
const GROUP_ID = '44444444-4444-4444-8444-444444444444';

const kind = (
  key: string, label: string, category: NotificationKindSetting['category'],
  over: Partial<NotificationKindSetting> = {},
): NotificationKindSetting => ({
  kind: key, label, category, email: true, owner_always: false, critical: false, locked: false,
  watchable: false, everywhere: false, reaches: [], ...over,
});

const KINDS: NotificationKindSetting[] = [
  kind('initiative_status_changed', 'Initiative status changed', 'initiatives',
    { watchable: true, everywhere: true, reaches: ['initiative', 'site'] }),
  kind('truck_status_changed', 'Truck status changed', 'trucks',
    { watchable: true, everywhere: true, reaches: ['truck', 'initiative', 'site'] }),
];

const YOU: Watch['via'] = { type: 'you', id: null, name: null };

const initiative: Watch = {
  id: 'w-ini', thing: 'initiative', thing_id: INI_ID, thing_name: 'Initiative A',
  link: `/initiatives/${INI_ID}`, kinds: [], via: YOU, created_at: '2026-11-02T12:00:00Z',
};
const site: Watch = {
  id: 'w-site', thing: 'site', thing_id: SITE_ID, thing_name: 'Site A',
  link: `/sites/${SITE_ID}`, kinds: ['initiative_status_changed', 'truck_status_changed'],
  via: { type: 'group', id: GROUP_ID, name: 'Group A' }, created_at: '2026-11-02T11:00:00Z',
};
const truck: Watch = {
  id: 'w-truck', thing: 'truck', thing_id: TRUCK_ID, thing_name: 'Truck A',
  link: `/logistics/trucks/${TRUCK_ID}`, kinds: ['truck_status_changed'], via: YOU,
  created_at: '2026-11-02T10:00:00Z',
};
const everything: Watch = {
  id: 'w-all', thing: 'everything', thing_id: null, thing_name: null, link: null,
  kinds: ['truck_status_changed'], via: YOU, created_at: '2026-11-02T09:00:00Z',
};

const EMPTY = 'Nothing watched here.';

afterEach(cleanup);

function setup(over: Partial<{
  watches: Watch[]; kinds: NotificationKindSetting[]; showVia: boolean;
  actionsFor: (w: Watch) => RowAction[];
}> = {}) {
  const props = {
    watches: [initiative, site, truck, everything], kinds: KINDS, showVia: true,
    actionsFor: () => [] as RowAction[], emptyText: EMPTY, ...over,
  };
  return render(<MemoryRouter><WatchesTable {...props} /></MemoryRouter>);
}

const headers = () => screen.queryAllByRole('columnheader').map((h) => h.textContent);
const row = (name: string) => screen.getByText(name).closest('tr') as HTMLElement;
const cells = (r: HTMLElement) => within(r).getAllByRole('cell');

it('is a DataTable inside div.watch-table', () => {
  const { container } = setup();

  const wrapper = container.querySelector('div.watch-table') as HTMLElement;
  expect(wrapper).not.toBeNull();
  expect(wrapper.querySelector('.data-table-scroll > table.data-table')).not.toBeNull();
  expect(screen.getByRole('table', { name: 'Watches' })).toBeTruthy();
  expect(container.querySelectorAll('table')).toHaveLength(1);
});

it('has the columns Watching, Events, Via and Actions, in that order', () => {
  setup({ actionsFor: () => [{ key: 'x', label: 'Do it', onSelect: () => {} }] });

  expect(headers()).toEqual(['Watching', 'Events', 'Via', 'Actions']);
});

it('leaves Via out when showVia is off', () => {
  setup({ showVia: false, actionsFor: () => [{ key: 'x', label: 'Do it', onSelect: () => {} }] });

  expect(headers()).toEqual(['Watching', 'Events', 'Actions']);
  expect(screen.queryByText('You')).toBeNull();
  expect(screen.queryByText('Group A')).toBeNull();
  expect(cells(row('Initiative A'))).toHaveLength(3);
});

it('gives the Actions column 88px, as the other converted lists do', () => {
  const { container } = setup({ actionsFor: () => [{ key: 'x', label: 'Do it', onSelect: () => {} }] });

  const cols = [...container.querySelectorAll('col')] as HTMLElement[];
  expect(cols).toHaveLength(4);
  expect(cols[3].style.width).toBe('88px');
  expect(cols[0].style.width).toBe('');
});

it('has no Actions column when no row has an action', () => {
  const { container } = setup({ actionsFor: () => [] });

  expect(headers()).toEqual(['Watching', 'Events', 'Via']);
  expect(container.querySelectorAll('col')).toHaveLength(3);
  expect(screen.queryByRole('button', { name: /Actions/ })).toBeNull();
});

it('shows a thing as its name, linked to its page, with its kind as a chip', () => {
  setup();

  const link = screen.getByRole('link', { name: 'Initiative A' });
  expect(link.getAttribute('href')).toBe(`/initiatives/${INI_ID}`);
  const chip = within(row('Initiative A')).getByText('Initiative');
  expect(chip.tagName).toBe('SPAN');
  expect(chip.classList.contains('chip')).toBe(true);

  expect(screen.getByRole('link', { name: 'Site A' }).getAttribute('href')).toBe(`/sites/${SITE_ID}`);
  expect(within(row('Site A')).getByText('Site').classList.contains('chip')).toBe(true);
  expect(screen.getByRole('link', { name: 'Truck A' }).getAttribute('href'))
    .toBe(`/logistics/trucks/${TRUCK_ID}`);
  expect(within(row('Truck A')).getByText('Truck').classList.contains('chip')).toBe(true);
});

it('shows Everything as plain "Everything": no link, no chip', () => {
  setup();

  const everythingRow = screen.getByText('Everything').closest('tr') as HTMLElement;
  expect(within(everythingRow).queryByRole('link')).toBeNull();
  expect(everythingRow.querySelector('.chip')).toBeNull();
  expect(cells(everythingRow)[0].textContent).toBe('Everything');
});

it('shows a thing whose page is not known as its name, not a link', () => {
  setup({ watches: [{ ...initiative, link: null }] });

  expect(screen.queryByRole('link')).toBeNull();
  expect(screen.getByText('Initiative A')).toBeTruthy();
});

it('Events reads "All events" for a watch that names none, else the events\' labels', () => {
  setup();

  expect(cells(row('Initiative A'))[1].textContent).toBe('All events');
  expect(cells(row('Site A'))[1].textContent).toBe('Initiative status changed, Truck status changed');
  expect(cells(row('Truck A'))[1].textContent).toBe('Truck status changed');
});

it('an event the registry no longer has shows as itself', () => {
  setup({ watches: [{ ...truck, kinds: ['truck_status_changed', 'gone_kind'] }] });

  expect(cells(row('Truck A'))[1].textContent).toBe('Truck status changed, gone_kind');
});

it('Via reads "You" for a person\'s own watch, and the group\'s name for a group\'s', () => {
  setup();

  expect(cells(row('Initiative A'))[2].textContent).toBe('You');
  expect(cells(row('Site A'))[2].textContent).toBe('Group A');
  expect(cells(row('Truck A'))[2].textContent).toBe('You');
});

it('keeps the order it is given', () => {
  setup({ watches: [truck, everything, initiative, site] });

  const rows = screen.getAllByRole('row').slice(1);
  expect(rows).toHaveLength(4);
  expect(rows.map((r) => within(r).queryByRole('link')?.textContent ?? 'Everything'))
    .toEqual(['Truck A', 'Everything', 'Initiative A', 'Site A']);
});

it('puts a row-actions menu on each row that has actions, and none on the others', () => {
  const onSelect = vi.fn();
  setup({
    actionsFor: (w) => (w.via.type === 'you'
      ? [
        { key: 'choose', label: 'Choose events…', onSelect: () => onSelect('choose', w.id) },
        { key: 'stop', label: 'Stop watching', destructive: true, onSelect: () => onSelect('stop', w.id) },
      ]
      : []),
  });

  expect(screen.getAllByRole('button', { name: /Actions/ })).toHaveLength(3);   // not Site A's
  expect(within(row('Site A')).queryByRole('button', { name: /Actions/ })).toBeNull();

  fireEvent.click(within(row('Truck A')).getByRole('button', { name: /Actions/ }));
  expect(screen.getAllByRole('menuitem').map((m) => m.textContent))
    .toEqual(['Choose events…', 'Stop watching']);
  expect(screen.getByRole('menuitem', { name: 'Stop watching' }).className).toContain('danger');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Stop watching' }));
  expect(onSelect).toHaveBeenCalledWith('stop', 'w-truck');
});

it('asks for each row\'s actions with that row\'s watch', () => {
  const actionsFor = vi.fn((): RowAction[] => []);
  setup({ actionsFor });

  const asked = actionsFor.mock.calls.map((call) => (call as unknown as [Watch])[0].id);
  expect(new Set(asked)).toEqual(new Set(['w-ini', 'w-site', 'w-truck', 'w-all']));
});

it('shows the empty text, and nothing else, when there are no watches', () => {
  setup({ watches: [] });

  expect(screen.getByText(EMPTY)).toBeTruthy();
  expect(headers()).toEqual(['Watching', 'Events', 'Via']);
  expect(screen.getAllByRole('row')).toHaveLength(2);       // header + the empty line
  expect(screen.queryByRole('link')).toBeNull();
});
