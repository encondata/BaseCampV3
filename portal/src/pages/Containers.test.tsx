// @vitest-environment jsdom
/**
 * /logistics/containers — covers the "Label tag" column/facet/detail row
 * added on top of the addendum ("the label tag lives on the container"):
 * the colored `chip custom` cell (and its `—` fallback), the expanded
 * row's detail block, and the column-menu facet's unique-value list.
 * Generic toolbar/column-menu/reorder/CSV behavior is covered by
 * lib/listTools.test.tsx and lib/columnMenu.test.tsx; the edit modal's
 * own Label tag control is covered by ContainerEditModal.test.tsx.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { ContainerItem, UiPreferences } from '../lib/api';

const auth = vi.hoisted(() => {
  const state: { listPrefs: Record<string, unknown> } = { listPrefs: {} };
  return state;
});

vi.mock('../auth/AuthContext', () => ({
  useAuth: () => ({
    can: () => true,
    godMode: false,
    preferences: {
      accent: 'blue', theme: 'dark', density: 'comfortable', list_size: 'default',
      motion: true, nav_mode: 'expanded', nav_bg: 'default', nav_size: 'default',
      notif: { critical: true, email: true, maint: true, digest: true, sound: 'chime' },
      list_prefs: auth.listPrefs,
    } as unknown as UiPreferences,
    updatePreferences: vi.fn(() => Promise.resolve()),
  }),
}));

const api = vi.hoisted(() => ({
  listContainers: vi.fn(),
  listContainerStatuses: vi.fn(),
  listContainerTypes: vi.fn(),
  listSites: vi.fn(),
  listInitiatives: vi.fn(),
  listContainerAssets: vi.fn(),
  updateContainer: vi.fn(),
}));

vi.mock('../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../lib/api')>()),
  ...api,
}));

function container(over: Partial<ContainerItem> = {}): ContainerItem {
  return {
    id: 'c1', name: 'Rack Cart 1', rfid_tag: null,
    container_type: 'cart', type_label: 'Cart', type_color: '#1890ff',
    status: 'available', status_label: 'Available', status_color: '#22aa55',
    site_id: null, site_name: null, location_detail: '', asset_count: 3,
    last_audit_at: null, last_validated_at: null,
    archived_at: null, created_at: '2026-09-01T00:00:00Z',
    initiative_id: null, initiative_name: null,
    ...over,
  };
}

const CONTAINERS: ContainerItem[] = [
  container({ id: 'c1', name: 'Rack Cart 1', label_tag: 'priority' }),
  container({ id: 'c2', name: 'Server Bin', label_tag: null }),
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.listPrefs = {};
  localStorage.clear(); // the view-mode toggle persists here — isolate each test
  api.listContainers.mockResolvedValue(CONTAINERS);
  api.listContainerStatuses.mockResolvedValue([]);
  api.listContainerTypes.mockResolvedValue([]);
  api.listSites.mockResolvedValue([]);
  api.listInitiatives.mockResolvedValue([]);
  api.listContainerAssets.mockResolvedValue([]);
});

afterEach(cleanup);

const { default: Containers } = await import('./Containers');

const mount = () => render(<MemoryRouter><Containers /></MemoryRouter>);

// Same pattern as Assets.test.tsx's own `headerNames`/cell-lookup helpers:
// header labels (Name + the visible columns, in DOM order) line up
// positionally with a row's own `.cell` children.
const headerNames = () => Array.from(document.querySelectorAll('.list-head .col-head button.sortable'))
  .map((b) => b.textContent?.trim().replace(/\s*[▲▼]$/, '').trim() ?? '');

function cellFor(rowMain: HTMLElement, label: string): HTMLElement {
  const cells = Array.from(rowMain.querySelectorAll(':scope > .cell')) as HTMLElement[];
  const idx = headerNames().indexOf(label);
  return cells[idx];
}

it('shows a colored chip for a tagged container, and — for an untagged one', async () => {
  mount();
  await waitFor(() => expect(screen.queryByText('Rack Cart 1')).not.toBeNull());
  expect(headerNames()).toContain('Label tag');

  const rows = Array.from(document.querySelectorAll('.dir-row .row-main')) as HTMLElement[];
  const taggedRow = rows.find((r) => within(r).queryByText('Rack Cart 1'))!;
  const untaggedRow = rows.find((r) => within(r).queryByText('Server Bin'))!;

  const taggedCell = cellFor(taggedRow, 'Label tag');
  const chip = taggedCell.querySelector('.chip.custom') as HTMLElement;
  expect(chip).not.toBeNull();
  expect(chip.style.getPropertyValue('--chip')).toBe('#f5222d');
  expect(chip.textContent).toContain('Priority');

  const untaggedCell = cellFor(untaggedRow, 'Label tag');
  expect(untaggedCell.querySelector('.chip.custom')).toBeNull();
  expect(untaggedCell.textContent).toContain('—');
});

it('expanding a row shows the Label tag in the detail block', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('Rack Cart 1')).not.toBeNull());

  await user.click(screen.getByText('Rack Cart 1'));
  const dt = await waitFor(() => {
    const match = screen.getAllByText('Label tag').find((el) => el.tagName === 'DT');
    if (!match) throw new Error('detail dt not found yet');
    return match;
  });
  const dd = dt.nextElementSibling as HTMLElement;
  expect(dd.textContent).toBe('Priority');
  const chip = dd.querySelector('.chip.custom') as HTMLElement;
  expect(chip.style.getPropertyValue('--chip')).toBe('#f5222d');
});

it('shows — in the detail block for an untagged container', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('Server Bin')).not.toBeNull());

  await user.click(screen.getByText('Server Bin'));
  const dt = await waitFor(() => {
    const match = screen.getAllByText('Label tag').find((el) => el.tagName === 'DT');
    if (!match) throw new Error('detail dt not found yet');
    return match;
  });
  const dd = dt.nextElementSibling as HTMLElement;
  expect(dd.textContent).toBe('—');
});

it('the Label tag column facet lists Priority and — (blank collapsed)', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('Rack Cart 1')).not.toBeNull());

  await user.click(screen.getByRole('button', { name: 'Label tag column menu' }));
  const menu = document.querySelector('.colmenu-menu') as HTMLElement;
  expect(menu).not.toBeNull();
  const values = Array.from(menu.querySelectorAll('.colmenu-list .pop-item')).map((el) => el.textContent?.trim());
  expect(values).toContain('Priority');
  expect(values).toContain('—');
});

it('"+ Add in bulk" opens BulkContainersModal', async () => {
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('Rack Cart 1')).not.toBeNull());

  await user.click(screen.getByRole('button', { name: '+ Add in bulk' }));
  expect(await screen.findByText('Add containers in bulk')).toBeTruthy();
});

/* ── nested (by-initiative) view ──────────────────────────────────── */

const GROUPED_CONTAINERS: ContainerItem[] = [
  container({ id: 'g1', name: 'Alpha Crate', initiative_id: 'i-alpha', initiative_name: 'Alpha Migration' }),
  container({
    id: 'g2', name: 'Alpha Crate 2', initiative_id: 'i-alpha', initiative_name: 'Alpha Migration',
    archived_at: '2026-01-01T00:00:00Z',
  }),
  container({ id: 'g3', name: 'Bravo Crate', initiative_id: 'i-bravo', initiative_name: 'Bravo Migration' }),
  container({ id: 'g4', name: 'Loose Crate', initiative_id: null, initiative_name: null }),
];

const groupHeaderNames = () => Array.from(document.querySelectorAll('.dir-grouprow b'))
  .map((b) => b.textContent);

it('defaults to Flat, and the toggle persists across remounts', async () => {
  api.listContainers.mockResolvedValue(GROUPED_CONTAINERS);
  const user = userEvent.setup();
  const { unmount } = mount();
  await waitFor(() => expect(screen.queryByText('Alpha Crate')).not.toBeNull());
  expect(screen.getByRole('tab', { name: 'Flat' }).getAttribute('aria-selected')).toBe('true');
  expect(document.querySelector('.dir-grouprow')).toBeNull();

  await user.click(screen.getByRole('tab', { name: 'By initiative' }));
  await waitFor(() => expect(document.querySelector('.dir-grouprow')).not.toBeNull());
  unmount();

  mount();
  await waitFor(() => expect(document.querySelector('.dir-grouprow')).not.toBeNull());
  expect(screen.getByRole('tab', { name: 'By initiative' }).getAttribute('aria-selected')).toBe('true');
});

it('grouped view shows group headers with counts, no container rows while collapsed, and No initiative last', async () => {
  api.listContainers.mockResolvedValue(GROUPED_CONTAINERS);
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('Alpha Crate')).not.toBeNull());
  await user.click(screen.getByRole('tab', { name: 'By initiative' }));

  await waitFor(() => expect(groupHeaderNames()).toEqual(
    ['Alpha Migration', 'Bravo Migration', 'No initiative']));

  // collapsed by default — group headers show counts, no container rows.
  // g2 (Alpha) is archived, so — like the flat view — it's hidden by the
  // page's own default (archived rows only show once that column filter
  // is set to "Yes"), leaving Alpha at 1 of its 2 total containers.
  expect(screen.queryByText('Alpha Crate')).toBeNull();
  expect(screen.queryByText('Bravo Crate')).toBeNull();
  expect(screen.queryByText('Loose Crate')).toBeNull();
  const alphaHeader = screen.getByText('Alpha Migration').closest('.dir-grouprow')!;
  expect(within(alphaHeader as HTMLElement).getByText('1 container')).toBeTruthy();
  expect(within(alphaHeader as HTMLElement).queryByText(/archived/)).toBeNull();
  const bravoHeader = screen.getByText('Bravo Migration').closest('.dir-grouprow')!;
  expect(within(bravoHeader as HTMLElement).getByText('1 container')).toBeTruthy();
});

it('a group with a visible archived row shows the muted "(M archived)" count', async () => {
  // Same fixture, but with the archived column filter set to both Yes and
  // No (as if restored from persisted prefs) so archived rows join the
  // rest of `visible` instead of being excluded — this is the case the
  // group header's archived badge is actually for. (Selecting only "Yes"
  // is a strict facet match that would show archived rows exclusively,
  // same idiom as Assets.tsx's own showArchived/passesColumnFilters pair.)
  auth.listPrefs = { containers: { filters: { archived: { values: ['Yes', 'No'] } } } };
  api.listContainers.mockResolvedValue(GROUPED_CONTAINERS);
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('Alpha Crate')).not.toBeNull());
  await user.click(screen.getByRole('tab', { name: 'By initiative' }));

  await waitFor(() => expect(groupHeaderNames()).toEqual(
    ['Alpha Migration', 'Bravo Migration', 'No initiative']));
  const alphaHeader = screen.getByText('Alpha Migration').closest('.dir-grouprow')!;
  expect(within(alphaHeader as HTMLElement).getByText('2 containers')).toBeTruthy();
  expect(within(alphaHeader as HTMLElement).getByText('(1 archived)')).toBeTruthy();
  const bravoHeader = screen.getByText('Bravo Migration').closest('.dir-grouprow')!;
  expect(within(bravoHeader as HTMLElement).queryByText(/archived/)).toBeNull();
});

it('clicking a group header reveals its rows; Expand all / Collapse all affect every group', async () => {
  api.listContainers.mockResolvedValue(GROUPED_CONTAINERS);
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('Alpha Crate')).not.toBeNull());
  await user.click(screen.getByRole('tab', { name: 'By initiative' }));
  await waitFor(() => expect(groupHeaderNames().length).toBe(3));

  await user.click(screen.getByText('Alpha Migration'));
  await waitFor(() => expect(screen.queryByText('Alpha Crate')).not.toBeNull());
  expect(screen.queryByText('Bravo Crate')).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Expand all' }));
  await waitFor(() => {
    expect(screen.queryByText('Bravo Crate')).not.toBeNull();
    expect(screen.queryByText('Loose Crate')).not.toBeNull();
  });

  await user.click(screen.getByRole('button', { name: 'Collapse all' }));
  await waitFor(() => expect(screen.queryByText('Alpha Crate')).toBeNull());
  expect(screen.queryByText('Bravo Crate')).toBeNull();
  expect(screen.queryByText('Loose Crate')).toBeNull();
  // headers themselves never disappear
  expect(groupHeaderNames()).toEqual(['Alpha Migration', 'Bravo Migration', 'No initiative']);
});

it('search narrows rows before grouping, so counts and the group set reflect the filter', async () => {
  api.listContainers.mockResolvedValue(GROUPED_CONTAINERS);
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('Alpha Crate')).not.toBeNull());
  await user.click(screen.getByRole('tab', { name: 'By initiative' }));
  await waitFor(() => expect(groupHeaderNames().length).toBe(3));

  await user.type(screen.getByPlaceholderText('Filter this list…'), 'Bravo');
  await waitFor(() => expect(groupHeaderNames()).toEqual(['Bravo Migration']));
  const bravoHeader = screen.getByText('Bravo Migration').closest('.dir-grouprow') as HTMLElement;
  expect(within(bravoHeader).getByText('1 container')).toBeTruthy();
});

// Scoped to `.dir-grouprow b` (the header's own bold label) rather than
// `screen.getByText` — an open container row's own detail block can show
// the same initiative name as plain text (its "Initiative" field), which
// would otherwise collide with the header's label.
const groupHeaderButton = (label: string) => {
  const b = Array.from(document.querySelectorAll('.dir-grouprow b'))
    .find((el) => el.textContent === label)!;
  return b.closest('button') as HTMLElement;
};

it('a deep-linked container auto-expands its group in the nested view', async () => {
  api.listContainers.mockResolvedValue(GROUPED_CONTAINERS);
  localStorage.setItem('containers.view', 'grouped');
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[{ pathname: '/', state: { openRow: 'g3' } }]}>
      <Containers />
    </MemoryRouter>,
  );

  // its group (Bravo) auto-expanded; useRecordFocus also opens the row's own
  // detail and pre-fills the search box with its name — clear the search so
  // all three groups (not just the search-narrowed one) are back in view,
  // then check aria-expanded per header rather than relying on visible text
  // alone (that stayed true even while every group was expanded).
  await waitFor(() => expect(screen.getAllByText('Bravo Crate').length).toBeGreaterThan(0));
  await user.clear(screen.getByPlaceholderText('Filter this list…'));

  await waitFor(() => expect(groupHeaderNames()).toEqual(
    ['Alpha Migration', 'Bravo Migration', 'No initiative']));
  expect(groupHeaderButton('Alpha Migration').getAttribute('aria-expanded')).toBe('false');
  expect(groupHeaderButton('Bravo Migration').getAttribute('aria-expanded')).toBe('true');
  expect(groupHeaderButton('No initiative').getAttribute('aria-expanded')).toBe('false');

  expect(screen.queryByText('Alpha Crate')).toBeNull();
  expect(screen.queryByText('Loose Crate')).toBeNull();
  expect(screen.getAllByText('Bravo Crate').length).toBeGreaterThan(0);
});

it('collapsing the group that holds the open row closes it, so re-expanding does not reopen its detail', async () => {
  api.listContainers.mockResolvedValue(GROUPED_CONTAINERS);
  localStorage.setItem('containers.view', 'grouped');
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[{ pathname: '/', state: { openRow: 'g3' } }]}>
      <Containers />
    </MemoryRouter>,
  );
  await waitFor(() => expect(screen.getAllByText('Bravo Crate').length).toBeGreaterThan(0));
  await user.clear(screen.getByPlaceholderText('Filter this list…'));
  await waitFor(() => expect(groupHeaderNames()).toEqual(
    ['Alpha Migration', 'Bravo Migration', 'No initiative']));

  // Bravo's row starts open (the deep link's target row detail).
  const bravoRow = screen.getAllByText('Bravo Crate')[0].closest('.dir-row') as HTMLElement;
  expect(bravoRow.classList.contains('open')).toBe(true);

  const bravoHeader = groupHeaderButton('Bravo Migration');
  await user.click(bravoHeader); // collapse — should also close the open row
  await waitFor(() => expect(screen.queryByText('Bravo Crate')).toBeNull());

  await user.click(bravoHeader); // re-expand
  await waitFor(() => expect(screen.queryAllByText('Bravo Crate').length).toBeGreaterThan(0));
  // exactly one match now (just the row's own name) — the detail block
  // (which would add a second, in the Name <dd>) never came back, proving
  // `openId` was cleared rather than surviving the collapse.
  expect(screen.getAllByText('Bravo Crate').length).toBe(1);
  const reopenedRow = screen.getAllByText('Bravo Crate')[0].closest('.dir-row') as HTMLElement;
  expect(reopenedRow.classList.contains('open')).toBe(false);
});

it('Enter and Space toggle a group header via native button semantics, flipping aria-expanded', async () => {
  api.listContainers.mockResolvedValue(GROUPED_CONTAINERS);
  const user = userEvent.setup();
  mount();
  await waitFor(() => expect(screen.queryByText('Alpha Crate')).not.toBeNull());
  await user.click(screen.getByRole('tab', { name: 'By initiative' }));
  await waitFor(() => expect(groupHeaderNames().length).toBe(3));

  const alphaHeader = groupHeaderButton('Alpha Migration');
  expect(alphaHeader.getAttribute('aria-expanded')).toBe('false');

  alphaHeader.focus();
  await user.keyboard('{Enter}');
  await waitFor(() => expect(alphaHeader.getAttribute('aria-expanded')).toBe('true'));
  expect(screen.queryByText('Alpha Crate')).not.toBeNull();

  await user.keyboard(' ');
  await waitFor(() => expect(alphaHeader.getAttribute('aria-expanded')).toBe('false'));
  expect(screen.queryByText('Alpha Crate')).toBeNull();
});

it('flat view is unchanged: no group rows, all containers render directly', async () => {
  api.listContainers.mockResolvedValue(GROUPED_CONTAINERS);
  mount();
  await waitFor(() => expect(screen.queryByText('Alpha Crate')).not.toBeNull());
  expect(document.querySelector('.dir-grouprow')).toBeNull();
  expect(screen.queryByText('Bravo Crate')).not.toBeNull();
  expect(screen.queryByText('Loose Crate')).not.toBeNull();
});
