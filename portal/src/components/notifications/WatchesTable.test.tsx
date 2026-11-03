// @vitest-environment jsdom
/**
 * WatchesTable — a person's watches (and, on the group page, a group's) as a
 * DataTable: what is watched, which events, whose watch it is (optional), and a
 * row-actions menu for the rows that have actions.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { NotificationKindSetting, Watch } from '../../lib/api';
import type { RowAction } from '../hardware/RowActionsMenu';
import WatchesTable from './WatchesTable';

const INI_ID = '11111111-1111-4111-8111-111111111111';
const SITE_ID = '22222222-2222-4222-8222-222222222222';
const TRUCK_ID = '33333333-3333-4333-8333-333333333333';
const GROUP_ID = '44444444-4444-4444-8444-444444444444';
const DEVICE_ID = '55555555-5555-4555-8555-555555555555';
const LIBRARY_ID = '66666666-6666-4666-8666-666666666666';
const FOLDER_ID = '77777777-7777-4777-8777-777777777777';
const PAGE_ID = '88888888-8888-4888-8888-888888888888';
const WIKI = 'https://wiki.example.com';

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

// A wiki watch as the API lists it: the wiki's own label for the kind of thing, its absolute URL
// in the wiki (an app of its own), and no events named (it hears every update and comment).
const wikiLibrary: Watch = {
  id: 'w-library', thing: 'wiki_space', thing_id: LIBRARY_ID, thing_name: 'Library A',
  thing_label: 'Wiki library', link: `${WIKI}/library/library-a`, kinds: [], via: YOU,
  created_at: '2026-11-02T08:00:00Z',
};
const wikiFolder: Watch = {
  id: 'w-folder', thing: 'wiki_node', thing_id: FOLDER_ID, thing_name: 'Folder A',
  thing_label: 'Wiki folder', link: `${WIKI}/n/${FOLDER_ID}`, kinds: [],
  via: { type: 'group', id: GROUP_ID, name: 'Group A' }, created_at: '2026-11-02T07:00:00Z',
};
const wikiPage: Watch = {
  id: 'w-page', thing: 'wiki_node', thing_id: PAGE_ID, thing_name: 'Page A',
  thing_label: 'Wiki page', link: `${WIKI}/n/${PAGE_ID}`, kinds: [], via: YOU,
  created_at: '2026-11-02T06:00:00Z',
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

it('draws a thing\'s kind as the neutral tag chip, as a category is in the Delivery log', () => {
  setup();

  // `chip tag` and nothing else: the kind is not a status, so it takes no color class
  expect(within(row('Initiative A')).getByText('Initiative').className).toBe('chip tag');
  expect(within(row('Site A')).getByText('Site').className).toBe('chip tag');
  expect(within(row('Truck A')).getByText('Truck').className).toBe('chip tag');
});

it('shows a device as its name, linked to its list opened on its row, with a Device chip', () => {
  const device: Watch = {
    id: 'w-device', thing: 'device', thing_id: DEVICE_ID, thing_name: 'Device A',
    link: `/hardware/fixed-readers?focus=${DEVICE_ID}`, kinds: [], via: YOU,
    created_at: '2026-11-02T08:00:00Z',
  };
  setup({ watches: [device] });

  expect(screen.getByRole('link', { name: 'Device A' }).getAttribute('href'))
    .toBe(`/hardware/fixed-readers?focus=${DEVICE_ID}`);
  expect(within(row('Device A')).getByText('Device').className).toBe('chip tag');
  expect(cells(row('Device A'))[1].textContent).toBe('All events');
});

// ── wiki rows ───────────────────────────────────────────────────────────

it('a wiki row\'s chip is the label the API sends: Wiki library, Wiki folder or Wiki page', () => {
  setup({ watches: [wikiLibrary, wikiFolder, wikiPage] });

  expect(within(row('Library A')).getByText('Wiki library').className).toBe('chip tag');
  expect(within(row('Folder A')).getByText('Wiki folder').className).toBe('chip tag');
  expect(within(row('Page A')).getByText('Wiki page').className).toBe('chip tag');
});

it('a row the API sent no label for falls back to the portal\'s own, wiki rows included', () => {
  setup({
    watches: [
      { ...initiative, thing_label: null },
      { ...wikiLibrary, thing_label: undefined },
      { ...wikiPage, thing_label: null },
    ],
  });

  expect(within(row('Initiative A')).getByText('Initiative')).toBeTruthy();
  expect(within(row('Library A')).getByText('Wiki library')).toBeTruthy();
  expect(within(row('Page A')).getByText('Wiki page')).toBeTruthy();
});

it('the API\'s label wins over the portal\'s own, so a folder is not "Wiki page"', () => {
  setup({ watches: [wikiFolder] });

  expect(within(row('Folder A')).getByText('Wiki folder')).toBeTruthy();
  expect(within(row('Folder A')).queryByText('Wiki page')).toBeNull();
});

it('a wiki row\'s name links to its absolute wiki URL, as a plain link in the same tab', () => {
  setup({ watches: [wikiLibrary, wikiFolder, wikiPage] });

  const library = screen.getByRole('link', { name: 'Library A' });
  expect(library.tagName).toBe('A');
  expect(library.getAttribute('href')).toBe(`${WIKI}/library/library-a`);
  expect(screen.getByRole('link', { name: 'Folder A' }).getAttribute('href'))
    .toBe(`${WIKI}/n/${FOLDER_ID}`);
  expect(screen.getByRole('link', { name: 'Page A' }).getAttribute('href'))
    .toBe(`${WIKI}/n/${PAGE_ID}`);
  for (const link of screen.getAllByRole('link')) {
    expect(link.className).toBe('cell-top');
    expect(link.hasAttribute('target')).toBe(false);   // same tab, as the portal's other links into the wiki
    expect(link.hasAttribute('rel')).toBe(false);
  }
});

it('an absolute link is a plain anchor, not a router Link: it needs no router', () => {
  // A router Link outside a router throws, so rendering with none shows it is not one
  render(<WatchesTable watches={[wikiPage]} kinds={KINDS} showVia actionsFor={() => []} emptyText={EMPTY} />);

  expect(screen.getByRole('link', { name: 'Page A' }).getAttribute('href')).toBe(`${WIKI}/n/${PAGE_ID}`);
});

it('a relative link stays a router Link: clicking it moves the router, not the page', () => {
  function Here() {
    return <p data-testid="here">{useLocation().pathname}</p>;
  }
  render(
    <MemoryRouter>
      <Here />
      <WatchesTable watches={[initiative]} kinds={KINDS} showVia={false} actionsFor={() => []}
                    emptyText={EMPTY} />
    </MemoryRouter>,
  );

  fireEvent.click(screen.getByRole('link', { name: 'Initiative A' }));

  expect(screen.getByTestId('here').textContent).toBe(`/initiatives/${INI_ID}`);
});

it('opens a link by the inbox\'s rule: a javascript:, data: or "//host" link renders no such href, only the portal\'s home page', () => {
  setup({
    watches: [
      { ...initiative, link: 'javascript:alert(1)' },
      { ...site, link: 'data:text/html,x' },
      { ...truck, link: '//evil.example/x' },
    ],
  });

  for (const name of ['Initiative A', 'Site A', 'Truck A']) {
    const link = screen.getByRole('link', { name });
    expect(link.getAttribute('href')).toBe('/');
    expect(link.className).toBe('cell-top');
  }
  const hrefs = [...document.querySelectorAll('a')].map((a) => a.getAttribute('href') ?? '');
  expect(hrefs.filter((href) => /^(javascript|data):|^\/\//i.test(href))).toEqual([]);
});

it('a wiki row hears every update and comment: Events reads "All events"', () => {
  setup({ watches: [wikiLibrary, wikiFolder, wikiPage] });

  for (const name of ['Library A', 'Folder A', 'Page A']) {
    expect(cells(row(name))[1].textContent).toBe('All events');
  }
});

it('a wiki row names who watches it, as any row does', () => {
  setup({ watches: [wikiLibrary, wikiFolder] });

  expect(cells(row('Library A'))[2].textContent).toBe('You');
  expect(cells(row('Folder A'))[2].textContent).toBe('Group A');
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
