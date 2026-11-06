// @vitest-environment jsdom
/**
 * WatchesTable — a person's watches (and, on the group page, a group's) as a
 * DataTable: what is watched, which events, whose watch it is (optional), and a
 * row-actions menu for the rows that have actions. /me also gives it the person's
 * asset watches, which are rows after the others: the asset, what it waits for, and
 * their own actions.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';

import type { AssetWatch, NotificationKindSetting, Watch } from '../../lib/api';
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

// An asset watch as the API lists it: the asset's name, where the watch was set (`link`) and what it
// waits for. It is not a `Watch`: it names no events (`kinds`), and it is always the person's own.
const ASSET_ID = '99999999-9999-4999-8999-999999999999';
const ROW_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const assetWatch: AssetWatch = {
  id: 'aw-1', asset_id: ASSET_ID, asset_name: 'SN-1001',
  initiative_id: null, initiative_name: null, initiative_asset_id: null,
  condition: 'next_update', status: null, status_label: null,
  current_status: 'in_storage', current_status_label: 'In storage',
  link: `/assets/${ASSET_ID}`, created_at: '2026-11-05T12:00:00Z',
};
const assetOnInitiative: AssetWatch = {
  ...assetWatch, id: 'aw-2', asset_name: 'SN-2002',
  initiative_id: INI_ID, initiative_name: 'Initiative A', initiative_asset_id: ROW_ID,
  condition: 'status', status: 'shipped', status_label: 'Shipped',
  link: `/initiatives/${INI_ID}/assets/${ROW_ID}`, created_at: '2026-11-05T11:00:00Z',
};

const EMPTY = 'Nothing watched here.';

afterEach(cleanup);

function setup(over: Partial<{
  watches: Watch[]; kinds: NotificationKindSetting[]; showVia: boolean;
  actionsFor: (w: Watch) => RowAction[];
  assetWatches: AssetWatch[]; assetActionsFor: (w: AssetWatch) => RowAction[];
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

// ── asset rows ──────────────────────────────────────────────────────────

it('lists the asset watches as rows of the same table, after the watches, in the order given', () => {
  const { container } = setup({ assetWatches: [assetOnInitiative, assetWatch] });

  expect(container.querySelectorAll('table')).toHaveLength(1);
  const rows = screen.getAllByRole('row').slice(1);
  expect(rows).toHaveLength(6);
  expect(rows.map((r) => within(r).queryByRole('link')?.textContent ?? 'Everything'))
    .toEqual(['Initiative A', 'Site A', 'Truck A', 'Everything', 'SN-2002', 'SN-1001']);
});

it('shows an asset as its name, linked to where the watch was set, with an Asset chip', () => {
  setup({ watches: [], assetWatches: [assetWatch, assetOnInitiative] });

  const link = screen.getByRole('link', { name: 'SN-1001' });
  expect(link.getAttribute('href')).toBe(`/assets/${ASSET_ID}`);
  expect(link.className).toBe('cell-top');
  expect(within(row('SN-1001')).getByText('Asset').className).toBe('chip tag');

  expect(screen.getByRole('link', { name: 'SN-2002' }).getAttribute('href'))
    .toBe(`/initiatives/${INI_ID}/assets/${ROW_ID}`);
  expect(within(row('SN-2002')).getByText('Asset').className).toBe('chip tag');
});

it('a watch set on an initiative adds "on {initiative}" after the name, outside the link; one on the asset itself adds nothing', () => {
  setup({ watches: [], assetWatches: [assetWatch, assetOnInitiative] });

  const on = within(row('SN-2002')).getByText('on Initiative A');
  expect(on.className).toBe('cell-sub');
  expect(on.closest('a')).toBeNull();
  expect(screen.getByRole('link', { name: 'SN-2002' }).textContent).toBe('SN-2002');
  expect(within(row('SN-1001')).queryByText(/^on /)).toBeNull();
});

it('an asset row\'s name opens by the inbox\'s rule too: a javascript: link renders no such href', () => {
  setup({ watches: [], assetWatches: [{ ...assetWatch, link: 'javascript:alert(1)' }] });

  expect(screen.getByRole('link', { name: 'SN-1001' }).getAttribute('href')).toBe('/');
});

it('Events reads "Next update", or "Status becomes {label}" (its key without a label), never "All events"', () => {
  setup({
    watches: [],
    assetWatches: [
      assetWatch, assetOnInitiative,
      { ...assetOnInitiative, id: 'aw-3', asset_name: 'SN-3003', status_label: null },
    ],
  });

  expect(cells(row('SN-1001'))[1].textContent).toBe('Next update');
  expect(cells(row('SN-2002'))[1].textContent).toBe('Status becomes Shipped');
  expect(cells(row('SN-3003'))[1].textContent).toBe('Status becomes shipped');
  expect(screen.queryByText('All events')).toBeNull();
});

it('Via reads "You" for an asset watch, which is always the person\'s own', () => {
  setup({ watches: [], assetWatches: [assetWatch, assetOnInitiative] });

  expect(cells(row('SN-1001'))[2].textContent).toBe('You');
  expect(cells(row('SN-2002'))[2].textContent).toBe('You');
});

it('leaves an asset row\'s Via out when showVia is off', () => {
  setup({ watches: [], showVia: false, assetWatches: [assetWatch] });

  expect(headers()).toEqual(['Watching', 'Events']);
  expect(cells(row('SN-1001'))).toHaveLength(2);
  expect(screen.queryByText('You')).toBeNull();
});

it('puts a row-actions menu on each asset row that has actions, and none on the others', () => {
  const onSelect = vi.fn();
  setup({
    watches: [],
    assetWatches: [assetWatch, assetOnInitiative],
    assetActionsFor: (w) => (w.id === 'aw-1'
      ? [
        { key: 'change', label: 'Change…', onSelect: () => onSelect('change', w.id) },
        { key: 'stop', label: 'Stop watching', destructive: true, onSelect: () => onSelect('stop', w.id) },
      ]
      : []),
  });

  expect(screen.getAllByRole('button', { name: /Actions/ })).toHaveLength(1);
  expect(within(row('SN-2002')).queryByRole('button', { name: /Actions/ })).toBeNull();

  fireEvent.click(within(row('SN-1001')).getByRole('button', { name: /Actions/ }));
  expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Change…', 'Stop watching']);
  expect(screen.getByRole('menuitem', { name: 'Stop watching' }).className).toContain('danger');
  fireEvent.click(screen.getByRole('menuitem', { name: 'Change…' }));
  expect(onSelect).toHaveBeenCalledWith('change', 'aw-1');
});

it('gives the Actions column 88px when only an asset row has actions, and the other rows no menu', () => {
  const { container } = setup({
    assetWatches: [assetWatch],
    assetActionsFor: () => [{ key: 'x', label: 'Do it', onSelect: () => {} }],
  });

  expect(headers()).toEqual(['Watching', 'Events', 'Via', 'Actions']);
  expect(([...container.querySelectorAll('col')] as HTMLElement[])[3].style.width).toBe('88px');
  expect(screen.getAllByRole('button', { name: /Actions/ })).toHaveLength(1);
  expect(within(row('Initiative A')).queryByRole('button', { name: /Actions/ })).toBeNull();
});

it('asset rows have no actions, and no Actions column, unless assetActionsFor gives them', () => {
  setup({ assetWatches: [assetWatch] });

  expect(screen.getByRole('link', { name: 'SN-1001' })).toBeTruthy();   // the row is there
  expect(headers()).toEqual(['Watching', 'Events', 'Via']);
  expect(screen.queryByRole('button', { name: /Actions/ })).toBeNull();
});

it('asks each list\'s own actions for its own rows only: a watch is never an asset watch\'s', () => {
  const actionsFor = vi.fn((): RowAction[] => []);
  const assetActionsFor = vi.fn((): RowAction[] => []);
  setup({ actionsFor, assetActionsFor, assetWatches: [assetWatch, assetOnInitiative] });

  expect(new Set(actionsFor.mock.calls.map((call) => (call as unknown as [Watch])[0].id)))
    .toEqual(new Set(['w-ini', 'w-site', 'w-truck', 'w-all']));
  expect(new Set(assetActionsFor.mock.calls.map((call) => (call as unknown as [AssetWatch])[0].id)))
    .toEqual(new Set(['aw-1', 'aw-2']));
});

it('shows the empty text only when there is neither a watch nor an asset watch', () => {
  setup({ watches: [], assetWatches: [assetWatch] });
  expect(screen.queryByText(EMPTY)).toBeNull();
  expect(screen.getByRole('link', { name: 'SN-1001' })).toBeTruthy();

  cleanup();
  setup({ watches: [], assetWatches: [] });
  expect(screen.getByText(EMPTY)).toBeTruthy();
  expect(screen.queryByRole('link')).toBeNull();
});

it('an asset watch and a watch that share an id are two rows under two keys', () => {
  // the ids are two tables': React would warn of a repeated key, and could drop or repeat a row
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    setup({ watches: [initiative], assetWatches: [{ ...assetWatch, id: initiative.id }] });

    expect(screen.getAllByRole('row').slice(1)).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Initiative A' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'SN-1001' })).toBeTruthy();
    expect(errors.mock.calls.filter((args) => String(args[0]).includes('same key'))).toEqual([]);
  } finally {
    errors.mockRestore();
  }
});
