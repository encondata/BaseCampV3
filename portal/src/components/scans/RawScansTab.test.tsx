// @vitest-environment jsdom
/**
 * Raw scans list on the paged API: first page, result count from the server
 * total, infinite scroll, and every control (sort, column filters, search,
 * Scanned date range, export) reaching the API with the right params; column
 * menus fed by facets; saved prefs restored.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { RawScanRow, UiPreferences } from '../../lib/api';

const auth = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('../../auth/AuthContext', () => ({ useAuth: () => auth.value }));

function setPrefs(listPrefs: Record<string, unknown> = {}) {
  auth.value = {
    can: () => true,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
      motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      list_prefs: listPrefs,
    } as unknown as UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  };
}

const api = vi.hoisted(() => ({
  getRawScanPage: vi.fn(),
  getRawScanFacets: vi.fn(),
  downloadRawScansCsv: vi.fn(),
}));
vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

function scan(id: number, over: Partial<RawScanRow> = {}): RawScanRow {
  return {
    id, scanned_value: `EPC-${id}`, scan_type: 'rfid',
    scan_type_label: 'RFID', scan_type_color: '#1668a7',
    status: null, status_label: null, status_color: null,
    scanned_at: '2026-10-20T09:00:00Z', device_id: 'dock-1',
    operator_id: null, operator_name: null, site_id: null, site_name: 'HQ',
    location_detail: '', source: 'reader', created_at: '2026-10-20T09:01:00Z',
    ...over,
  };
}

// jsdom does no layout. The list asks "is the end near?" by comparing the
// list's bottom with the scroller's, so give the scroller a fixed bottom and
// let each test move the list's.
const layout = { listBottom: 9000 };
const SCROLLER_BOTTOM = 800;
let rectSpy: ReturnType<typeof vi.spyOn>;

function atEnd() {
  layout.listBottom = SCROLLER_BOTTOM + 100;
  fireEvent.scroll(document.querySelector('.portal-main') as HTMLElement);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setPrefs();
  layout.listBottom = 9000;
  rectSpy = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    function (this: HTMLElement) {
      const bottom = this.classList.contains('portal-main')
        ? SCROLLER_BOTTOM : layout.listBottom;
      return {
        top: 0, left: 0, right: 800, bottom, width: 800, height: bottom,
        x: 0, y: 0, toJSON: () => ({}),
      } as DOMRect;
    });
  api.getRawScanPage.mockResolvedValue({
    rows: [scan(1), scan(2)], next_cursor: 'c1', total: 250,
  });
  api.getRawScanFacets.mockResolvedValue([]);
  api.downloadRawScansCsv.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  rectSpy.mockRestore();
});

const { default: RawScansTab } = await import('./RawScansTab');
const onCount = vi.fn();
const mount = () => render(
  <div className="portal-main"><RawScansTab onCount={onCount} /></div>);

const lastPageCall = () => api.getRawScanPage.mock.calls.at(-1)![0];

/** The header's sort button (not the column menu trigger beside it). */
const sortButton = (label: string) =>
  (Array.from(document.querySelectorAll('.list-head .sortable')) as HTMLElement[])
    .find((b) => b.textContent?.trim().startsWith(label)) as HTMLElement;

async function openMenu(label: string) {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: `${label} column menu` }));
  return { user, menu: document.querySelector('.colmenu-menu') as HTMLElement };
}

it('shows the first page, newest first, with the count from the server total', async () => {
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  expect(screen.queryByText('EPC-2')).not.toBeNull();
  expect(api.getRawScanPage).toHaveBeenCalledTimes(1);
  expect(api.getRawScanPage.mock.calls[0][0]).toMatchObject({
    sort: 'scanned', dir: 'desc', limit: 100, cursor: null, filters: {},
  });
  expect(api.getRawScanPage.mock.calls[0][0].since).toBeUndefined();
  expect(document.querySelector('.result-count')?.textContent).toBe('2 of 250 shown');
  await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(250));
});

it('loads the next page when the list nears the end, and appends it', async () => {
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  expect(api.getRawScanPage).toHaveBeenCalledTimes(1);

  api.getRawScanPage.mockResolvedValueOnce({
    rows: [scan(3), scan(4)], next_cursor: null, total: 250,
  });
  act(() => atEnd());
  await waitFor(() => expect(screen.queryByText('EPC-4')).not.toBeNull());
  expect(api.getRawScanPage).toHaveBeenCalledTimes(2);
  expect(lastPageCall()).toMatchObject({ cursor: 'c1', sort: 'scanned', dir: 'desc' });
  expect(screen.queryByText('EPC-1')).not.toBeNull();
  expect(document.querySelector('.result-count')?.textContent).toBe('4 of 250 shown');

  // No next page: scrolling at the end asks for nothing more.
  act(() => atEnd());
  expect(api.getRawScanPage).toHaveBeenCalledTimes(2);
});

it('offers Retry after a load-more failure and keeps the rows', async () => {
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());

  api.getRawScanPage.mockRejectedValueOnce(new Error('boom'));
  act(() => atEnd());
  await waitFor(() => expect(screen.queryByText('Couldn’t load more scans.')).not.toBeNull());
  expect(screen.queryByText('EPC-1')).not.toBeNull();
  expect(api.getRawScanPage).toHaveBeenCalledTimes(2);

  // The list stays idle (no tight retry loop) until Retry is pressed.
  act(() => atEnd());
  expect(api.getRawScanPage).toHaveBeenCalledTimes(2);

  api.getRawScanPage.mockResolvedValueOnce({
    rows: [scan(3)], next_cursor: null, total: 250,
  });
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(screen.queryByText('EPC-3')).not.toBeNull());
  expect(lastPageCall()).toMatchObject({ cursor: 'c1' });
  expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
});

it('shows the existing error state with Reload when page one fails', async () => {
  api.getRawScanPage.mockRejectedValueOnce(new Error('nope'));
  mount();
  await waitFor(() => expect(screen.queryByText('Cannot load scans')).not.toBeNull());
  expect(screen.queryByText('Failed to load raw scans.')).not.toBeNull();
  await waitFor(() => expect(onCount).toHaveBeenLastCalledWith(null));

  await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }));
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  expect(screen.queryByText('Cannot load scans')).toBeNull();
});

it('keeps the rows on screen while a new sort loads', async () => {
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  let release!: () => void;
  api.getRawScanPage.mockReturnValueOnce(new Promise((resolve) => {
    release = () => resolve({ rows: [scan(9)], next_cursor: null, total: 1 });
  }));
  await userEvent.setup().click(sortButton('Device'));
  await waitFor(() => expect(document.querySelector('.result-count')?.textContent)
    .toBe('Updating…'));
  expect(screen.queryByText('EPC-1')).not.toBeNull();
  act(() => release());
  await waitFor(() => expect(screen.queryByText('EPC-9')).not.toBeNull());
  expect(screen.queryByText('EPC-1')).toBeNull();
});

it('sorts on the server: column key, then direction', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());

  await user.click(sortButton('Device'));
  await waitFor(() => expect(lastPageCall()).toMatchObject({ sort: 'device', dir: 'asc' }));
  await user.click(sortButton('Device'));
  await waitFor(() => expect(lastPageCall()).toMatchObject({ sort: 'device', dir: 'desc' }));
  await user.click(sortButton('Value'));
  await waitFor(() => expect(lastPageCall()).toMatchObject({ sort: 'primary', dir: 'asc' }));
});

it('sends the search box text as q after a pause', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  await user.type(screen.getByPlaceholderText('Filter this list…'), 'dock');
  await waitFor(() => expect(lastPageCall()).toMatchObject({ q: 'dock', cursor: null }));
  // Debounced: one request for the whole word, not one per key.
  expect(api.getRawScanPage.mock.calls.filter((c) => c[0].q).length).toBe(1);
});

it('feeds column menus from the facets endpoint and filters through the API', async () => {
  api.getRawScanFacets.mockResolvedValue([
    { value: 'HQ', count: 90 }, { value: 'Dock 7', count: 1234 },
  ]);
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  expect(api.getRawScanFacets).not.toHaveBeenCalled();

  const { user, menu } = await openMenu('Site');
  await waitFor(() => expect(menu.textContent).toContain('Dock 7'));
  expect(menu.textContent).toContain('1,234');
  expect(api.getRawScanFacets.mock.calls[0][0]).toBe('site');
  expect(api.getRawScanFacets.mock.calls[0][1]).toMatchObject({ search: '', filters: {} });

  await user.click(screen.getByText('Dock 7'));
  await waitFor(() => expect(lastPageCall()).toMatchObject({
    filters: { site: { exclude: ['Dock 7'] } },
  }));
  expect(screen.queryByText('1 filter active')).not.toBeNull();
});

it('other columns’ facets carry the search text and filters', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  await user.type(screen.getByPlaceholderText('Filter this list…'), 'abc');
  await waitFor(() => expect(lastPageCall().q).toBe('abc'));

  await user.click(screen.getByRole('button', { name: 'Device column menu' }));
  await waitFor(() => expect(api.getRawScanFacets).toHaveBeenCalled());
  expect(api.getRawScanFacets.mock.calls[0][0]).toBe('device');
  expect(api.getRawScanFacets.mock.calls[0][1]).toMatchObject({ q: 'abc' });
});

it('the Value menu shows the displayed read but filters on the raw value', async () => {
  api.getRawScanPage.mockResolvedValue({
    rows: [scan(1, { scanned_value: '0000ABC1', scan_type: 'rfid' })],
    next_cursor: null, total: 1,
  });
  api.getRawScanFacets.mockResolvedValue([{ value: '0000ABC1', count: 3 }]);
  mount();
  await waitFor(() => expect(screen.queryByText('ABC1')).not.toBeNull());

  const { user, menu } = await openMenu('Value');
  await waitFor(() => expect(menu.querySelector('.colmenu-value')).not.toBeNull());
  expect(menu.querySelector('.colmenu-value')?.textContent).toBe('ABC1');
  expect(api.getRawScanFacets.mock.calls[0][0]).toBe('primary');

  await user.click(menu.querySelector('.colmenu-list .pop-item') as HTMLElement);
  await waitFor(() => expect(lastPageCall()).toMatchObject({
    filters: { primary: { exclude: ['0000ABC1'] } },
  }));
});

it('the Scanned menu filters by a From / To date range', async () => {
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());

  const { menu } = await openMenu('Scanned');
  // A range, not a checklist: no facet request, no text box.
  expect(menu.querySelector('.colmenu-list')).toBeNull();
  expect(api.getRawScanFacets).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText('Scanned from date'), { target: { value: '2026-10-01' } });
  fireEvent.change(screen.getByLabelText('Scanned to date'), { target: { value: '2026-10-05' } });
  await waitFor(() => expect(lastPageCall()).toMatchObject({
    since: new Date('2026-10-01T00:00:00').toISOString(),
    until: new Date('2026-10-05T23:59:59.999').toISOString(),
  }));
  // The range is not sent as a column filter, and counts as an active filter.
  expect(lastPageCall().filters).toEqual({});
  expect(screen.queryByText('1 filter active')).not.toBeNull();

  // Other menus see it.
  await userEvent.setup().click(screen.getByRole('button', { name: 'Device column menu' }));
  await waitFor(() => expect(api.getRawScanFacets).toHaveBeenCalled());
  expect(api.getRawScanFacets.mock.calls.at(-1)![1]).toMatchObject({
    since: new Date('2026-10-01T00:00:00').toISOString(),
  });
});

it('Clear removes the date range', async () => {
  setPrefs({ raw_scans: { filters: { scanned: { values: ['from:2026-10-01'] } } } });
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  expect(api.getRawScanPage.mock.calls[0][0].since)
    .toBe(new Date('2026-10-01T00:00:00').toISOString());
  await userEvent.setup().click(screen.getByText('Clear'));
  await waitFor(() => expect(lastPageCall().since).toBeUndefined());
  expect(screen.queryByText('1 filter active')).toBeNull();
});

it('Ingested is sort-only', async () => {
  setPrefs({ raw_scans: { visible: ['status', 'ingested'] } });
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  const { user, menu } = await openMenu('Ingested');
  expect(menu.querySelector('.colmenu-list')).toBeNull();
  expect(menu.querySelector('input')).toBeNull();
  expect(api.getRawScanFacets).not.toHaveBeenCalled();
  await user.click(screen.getByText('Oldest first'));
  await waitFor(() => expect(lastPageCall()).toMatchObject({ sort: 'ingested', dir: 'asc' }));
});

it('exports through the server with the current sort, filters, search and range', async () => {
  setPrefs({ raw_scans: {
    sortKey: 'device', sortDir: 1,
    filters: {
      site: { values: ['HQ'] },
      scanned: { values: ['from:2026-10-01', 'to:2026-10-05'] },
    },
  } });
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  await user.type(screen.getByPlaceholderText('Filter this list…'), 'dock');
  await waitFor(() => expect(lastPageCall().q).toBe('dock'));

  await user.click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(api.downloadRawScansCsv).toHaveBeenCalledTimes(1));
  expect(api.downloadRawScansCsv).toHaveBeenCalledWith({
    q: 'dock', filters: { site: { values: ['HQ'] } },
    since: new Date('2026-10-01T00:00:00').toISOString(),
    until: new Date('2026-10-05T23:59:59.999').toISOString(),
    sort: 'device', dir: 'asc',
  });
});

it('says so when the export fails', async () => {
  api.downloadRawScansCsv.mockRejectedValueOnce(new Error('500'));
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  await userEvent.setup().click(screen.getByRole('button', { name: 'Export' }));
  await waitFor(() => expect(screen.queryByText('Export failed. Try again.')).not.toBeNull());
});

it('restores saved sort and filters, and ignores old Scanned / Ingested filters', async () => {
  setPrefs({ raw_scans: {
    sortKey: 'device', sortDir: 1,
    filters: {
      site: { values: ['HQ'] },
      scanned: { text: '10/20/2026' },
      ingested: { values: ['10/20/2026, 9:01:00 AM'] },
    },
  } });
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  expect(api.getRawScanPage).toHaveBeenCalledTimes(1);
  const first = api.getRawScanPage.mock.calls[0][0];
  expect(first).toMatchObject({ sort: 'device', dir: 'asc', filters: { site: { values: ['HQ'] } } });
  expect(first.since).toBeUndefined();
  // Only Site counts: the stale entries are not shown as active filters.
  expect(screen.queryByText('1 filter active')).not.toBeNull();
});

it('shows the empty state with Clear all filters when nothing matches', async () => {
  setPrefs({ raw_scans: { filters: { site: { values: ['Nowhere'] } } } });
  api.getRawScanPage.mockResolvedValue({ rows: [], next_cursor: null, total: 0 });
  mount();
  await waitFor(() => expect(screen.queryByText('No matches')).not.toBeNull());
  expect(screen.queryByText('Clear all filters')).not.toBeNull();
  expect(document.querySelector('.result-count')?.textContent).toBe('0 of 0 shown');
});

it('keeps the date range ordered: an end before the start pulls the start with it', async () => {
  mount();
  await waitFor(() => expect(screen.queryByText('EPC-1')).not.toBeNull());
  await openMenu('Scanned');
  fireEvent.change(screen.getByLabelText('Scanned from date'), { target: { value: '2026-10-10' } });
  fireEvent.change(screen.getByLabelText('Scanned to date'), { target: { value: '2026-10-03' } });
  await waitFor(() => expect(lastPageCall()).toMatchObject({
    since: new Date('2026-10-03T00:00:00').toISOString(),
    until: new Date('2026-10-03T23:59:59.999').toISOString(),
  }));
});
