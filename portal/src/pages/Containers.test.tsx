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
