// @vitest-environment jsdom
/**
 * A container's contents as a standard list: default columns, the Columns
 * menu, the Packed column, search, sort, column filters, CSV export, row
 * click, and the fallback for rows whose asset the viewer cannot open.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { AssetItem, ContainerAssetRow, UiPreferences } from '../../lib/api';
import { LIST_FIT } from '../../lib/listTools';

const PREFS = vi.hoisted(() => ({
  accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
  motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
  list_prefs: {},
}));

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    godMode: false,
    preferences: PREFS as unknown as UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({ listContainerAssets: vi.fn() }));

vi.mock('../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../lib/api')>()),
  ...api,
}));

const asset = (over: Partial<AssetItem> = {}): AssetItem => ({
  id: 'a1', legacy_id: 101, serial_number: 'SN-2', name: 'Web-01',
  rfid_tag: '000ABC', pod_number: null,
  model_id: 'm1',
  model: {
    id: 'm1', make: 'Dell', model: 'R740', category: 'server',
    category_label: 'Server', category_color: null, ru_size: 2,
  },
  client_id: null, client_name: null, site_id: 's1', site_name: 'DC1',
  location_detail: '', status: 'active', status_label: 'Active',
  status_color: '#178a4c', has_rails: true, last_seen_at: null,
  archived_at: null, created_at: '2026-08-05T00:00:00Z',
  ...over,
});

const row = (a: AssetItem | null, over: Partial<ContainerAssetRow> = {}): ContainerAssetRow => ({
  asset_id: a?.id ?? 'x', serial_number: a?.serial_number ?? null, name: a?.name ?? null,
  model_name: a?.model ? `${a.model.make} ${a.model.model}` : null,
  status: a?.status ?? 'active', status_label: a?.status_label ?? 'Active',
  status_color: a?.status_color ?? '#178a4c',
  added_at: '2026-09-02T12:00:00Z', added_by_name: 'Pat Packer',
  asset: a,
  ...over,
});

const ROWS: ContainerAssetRow[] = [
  row(asset({ id: 'a1', legacy_id: 101, serial_number: 'SN-2', name: 'Web-01' })),
  row(asset({
    id: 'a2', legacy_id: 102, serial_number: 'SN-10', name: 'Db-01', rfid_tag: '000DEF',
    status: 'staged', status_label: 'Staged', status_color: '#c27a00',
    model: {
      id: 'm2', make: 'HPE', model: 'DL380', category: 'server',
      category_label: 'Server', category_color: null, ru_size: 2,
    },
  }), { added_by_name: 'Sam Stacker', added_at: '2026-09-05T12:00:00Z' }),
];

beforeEach(() => {
  vi.clearAllMocks();
  PREFS.list_prefs = {};
  api.listContainerAssets.mockResolvedValue(ROWS);
});

afterEach(cleanup);

const { default: ContainerContentsList } = await import('./ContainerContentsList');

const mount = () => render(
  <MemoryRouter initialEntries={['/c']}>
    <Routes>
      <Route path="/c" element={<ContainerContentsList containerId="c1" containerName="Rack Cart #1" />} />
      <Route path="/assets/:assetId" element={<div>ASSET PAGE</div>} />
    </Routes>
  </MemoryRouter>,
);

const headerNames = () => Array.from(document.querySelectorAll('.list-head .col-head button.sortable'))
  .map((b) => b.textContent?.trim().replace(/\s*[▲▼]$/, '').trim() ?? '');

const bodyRows = () => Array.from(document.querySelectorAll('.dir-row .row-main')) as HTMLElement[];
const cellsOf = (r: HTMLElement) => Array.from(r.querySelectorAll(':scope > .cell')) as HTMLElement[];
const cellText = (r: HTMLElement, label: string) =>
  cellsOf(r)[headerNames().indexOf(label)]?.textContent?.trim();

it('shows Loading… and then the empty text', async () => {
  api.listContainerAssets.mockResolvedValue([]);
  mount();
  expect(screen.getByText('Loading…')).toBeTruthy();
  expect(await screen.findByText('No assets in this container.')).toBeTruthy();
  expect(document.querySelector('.list-head')).toBeNull();
});

it('defaults to Asset ID, RFID, Name, Serial, Make / Model in that order', async () => {
  mount();
  await screen.findByText('SN-2');
  expect(headerNames()).toEqual(['Asset ID', 'RFID', 'Name', 'Serial', 'Make / Model']);
  expect(api.listContainerAssets).toHaveBeenCalledWith('c1');

  const first = bodyRows()[0];
  expect(cellText(first, 'Asset ID')).toBe('101');
  expect(cellText(first, 'RFID')).toBe('ABC');
  expect(cellText(first, 'Name')).toBe('Web-01');
  expect(cellText(first, 'Serial')).toBe('SN-2');
  expect(cellText(first, 'Make / Model')).toBe('Dell R740');
});

it('adds a column from the Columns menu', async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText('SN-2');
  expect(headerNames()).not.toContain('Status');

  await user.click(screen.getByRole('button', { name: /Columns/ }));
  const menu = document.querySelector('.pop-menu') as HTMLElement;
  expect(within(menu).queryByText('Serial / Name', { selector: '.pop-item' })).toBeNull();
  expect(within(menu).getByText('Packed', { selector: '.pop-item' })).toBeTruthy();
  await user.click(within(menu).getByText('Status', { selector: '.pop-item' }));

  await waitFor(() => expect(headerNames()).toContain('Status'));
  expect(cellText(bodyRows()[0], 'Status')).toBe('Active');
  expect(bodyRows()[0].querySelector('.chip.custom')).not.toBeNull();
});

it('the Packed column shows the date and who packed it', async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText('SN-2');

  await user.click(screen.getByRole('button', { name: /Columns/ }));
  const menu = document.querySelector('.pop-menu') as HTMLElement;
  await user.click(within(menu).getByText('Packed', { selector: '.pop-item' }));

  await waitFor(() => expect(headerNames()).toContain('Packed'));
  const cell = cellsOf(bodyRows()[0])[headerNames().indexOf('Packed')];
  expect(cell.textContent).toContain(new Date('2026-09-02T12:00:00Z').toLocaleDateString());
  expect(cell.textContent).toContain('Pat Packer');
});

it('search narrows the rows and the count follows', async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText('SN-2');
  expect(screen.getByText('2 of 2 shown')).toBeTruthy();

  await user.type(screen.getByPlaceholderText('Filter contents…'), 'db-01');
  await waitFor(() => expect(bodyRows()).toHaveLength(1));
  expect(cellText(bodyRows()[0], 'Serial')).toBe('SN-10');
  expect(screen.getByText('1 of 2 shown')).toBeTruthy();
});

it('a header click sorts naturally (SN-2 before SN-10, then reversed)', async () => {
  const user = userEvent.setup();
  // Seed the rows in the wrong order for the default Asset ID sort.
  api.listContainerAssets.mockResolvedValue([...ROWS].reverse());
  mount();
  await screen.findByText('SN-2');
  // Default sort: Asset ID ascending (101, 102).
  expect(bodyRows().map((r) => cellText(r, 'Serial'))).toEqual(['SN-2', 'SN-10']);

  const serialHead = () => Array.from(document.querySelectorAll('.list-head button.sortable'))
    .find((b) => b.textContent?.trim().startsWith('Serial')) as HTMLElement;
  await user.click(serialHead());
  expect(bodyRows().map((r) => cellText(r, 'Serial'))).toEqual(['SN-2', 'SN-10']);
  await user.click(serialHead());
  expect(bodyRows().map((r) => cellText(r, 'Serial'))).toEqual(['SN-10', 'SN-2']);
});

it('a column filter narrows the rows and the Clear chip resets it', async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText('SN-2');

  await user.click(screen.getByRole('button', { name: 'Serial column menu' }));
  const menu = document.querySelector('.colmenu-menu') as HTMLElement;
  await user.type(within(menu).getByPlaceholderText('Filter Serial'), 'SN-10');
  await waitFor(() => expect(bodyRows()).toHaveLength(1));
  expect(cellText(bodyRows()[0], 'Serial')).toBe('SN-10');
  expect(screen.getByText('1 of 2 shown')).toBeTruthy();

  await user.click(screen.getByText('Clear', { selector: '.colfilter-clear' }));
  await waitFor(() => expect(bodyRows()).toHaveLength(2));
  expect(document.querySelector('.colfilter-chip')).toBeNull();
});

it('Export writes the visible rows', async () => {
  let blob: Blob | null = null;
  const createUrl = vi.fn((b: Blob) => { blob = b; return 'blob:contents'; });
  const prevCreate = URL.createObjectURL, prevRevoke = URL.revokeObjectURL;
  URL.createObjectURL = createUrl as unknown as typeof URL.createObjectURL;
  URL.revokeObjectURL = vi.fn();
  let downloadName = '';
  const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) { downloadName = this.download; });
  const user = userEvent.setup();
  mount();
  await screen.findByText('SN-2');
  await user.type(screen.getByPlaceholderText('Filter contents…'), 'db-01');
  await waitFor(() => expect(bodyRows()).toHaveLength(1));

  await user.click(screen.getByRole('button', { name: /Export/ }));
  expect(createUrl).toHaveBeenCalledTimes(1);
  expect(downloadName).toMatch(/^container-contents-rack-cart-1-\d{4}-\d{2}-\d{2}\.csv$/);
  const text = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob as unknown as Blob);
  });
  const lines = text.split('\n');
  expect(lines).toHaveLength(2);
  const heads = lines[0].split(',');
  const cells = lines[1].split(',');
  expect(cells[heads.indexOf('Serial')]).toBe('SN-10');
  expect(cells[heads.indexOf('Model')]).toBe('DL380');
  expect(cells[heads.indexOf('Status')]).toBe('Staged');
  expect(cells[heads.indexOf('Packed by')]).toBe('Sam Stacker');
  expect(heads).toContain('Packed');
  clickSpy.mockRestore();
  URL.createObjectURL = prevCreate;
  URL.revokeObjectURL = prevRevoke;
});

it('clicking a row opens the asset page', async () => {
  const user = userEvent.setup();
  mount();
  await screen.findByText('SN-2');
  await user.click(bodyRows()[0]);
  expect(await screen.findByText('ASSET PAGE')).toBeTruthy();
});

it('a row whose asset the viewer cannot open renders from the flat fields and is not clickable', async () => {
  const user = userEvent.setup();
  api.listContainerAssets.mockResolvedValue([
    row(null, {
      asset_id: 'z9', serial_number: 'SN-LOCKED', name: 'Locked-01', model_name: 'Cisco C9300',
      status: 'active', status_label: 'Active', status_color: '#178a4c',
    }),
  ]);
  mount();
  await screen.findByText('SN-LOCKED');

  const r = bodyRows()[0];
  expect(cellText(r, 'Serial')).toBe('SN-LOCKED');
  expect(cellText(r, 'Name')).toBe('Locked-01');
  expect(cellText(r, 'Make / Model')).toBe('Cisco C9300');
  expect(cellText(r, 'Asset ID')).toBe('—');
  expect(cellText(r, 'RFID')).toBe('—');

  await user.click(screen.getByRole('button', { name: /Columns/ }));
  const menu = document.querySelector('.pop-menu') as HTMLElement;
  await user.click(within(menu).getByText('Status', { selector: '.pop-item' }));
  await waitFor(() => expect(headerNames()).toContain('Status'));
  expect(cellText(bodyRows()[0], 'Status')).toBe('Active');
  expect(bodyRows()[0].querySelector('.chip.custom')).not.toBeNull();

  // Search and filters read the same fallback text.
  await user.type(screen.getByPlaceholderText('Filter contents…'), 'cisco');
  expect(bodyRows()).toHaveLength(1);

  await user.click(bodyRows()[0]);
  expect(screen.queryByText('ASSET PAGE')).toBeNull();
});

it('sizes its grid with the shared floors and fits the page', async () => {
  mount();
  await screen.findByText('SN-2');
  const head = document.querySelector('.list-head') as HTMLElement;
  const main = bodyRows()[0];
  expect(head.style.gridTemplateColumns).toMatch(/^minmax\(\d+px, [\d.]+fr\)/);
  expect(main.style.gridTemplateColumns).toBe(head.style.gridTemplateColumns);
  expect(parseInt(head.style.minWidth, 10)).toBeLessThanOrEqual(LIST_FIT.page);
  expect(document.querySelector('.dir-list.list-scroll')).not.toBeNull();
});

it('a locked row with no model reads — in the Make / Model column', async () => {
  api.listContainerAssets.mockResolvedValue([row(null, { asset_id: 'z8', model_name: null })]);
  mount();
  await waitFor(() => expect(bodyRows()).toHaveLength(1));
  expect(cellText(bodyRows()[0], 'Make / Model')).toBe('—');
});
