// @vitest-environment jsdom
/**
 * PrintContainerList — the container sibling of PrintAssetList: its own
 * columns (no Asset ID / rack / RU, which have no container meaning), its
 * own persisted prefs key, archived containers filtered out, and no rack
 * tie-break in the sort.
 */
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ContainerItem } from '../../lib/api';
import type { LabelStatus } from '../../lib/printLabels';

const auth = vi.hoisted(() => ({ updatePreferences: vi.fn(async (_prefs: unknown) => true) }));
vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ preferences: { list_prefs: {} }, updatePreferences: auth.updatePreferences }),
}));

const { default: PrintContainerList, containerCellText, sortContainerRows, PRINT_CONTAINER_LIST_PAGE_KEY } =
  await import('./PrintContainerList');
const { PRINT_LIST_PAGE_KEY } = await import('./PrintAssetList');

afterEach(cleanup);

const container = (id: string, over: Partial<ContainerItem> = {}): ContainerItem => ({
  id, name: `crate-${id}`, rfid_tag: null,
  container_type: 'pallet', type_label: 'Pallet', type_color: '#abc',
  status: 'packed', status_label: 'Packed', status_color: '#123456',
  site_id: 's1', site_name: 'NAP11', location_detail: '', asset_count: 3,
  last_audit_at: null, last_validated_at: null, archived_at: null, created_at: '2026-09-01T00:00:00Z',
  initiative_id: 'i1', initiative_name: 'NAP11 move', label_tag: 'priority',
  ...over,
});

const ROWS = [
  container('c1'),
  container('c2', { name: 'crate-blue', type_label: 'Cage', site_name: 'NAP22', asset_count: 10, label_tag: null }),
  container('c3', { name: 'crate-green', asset_count: 1 }),
];
const STATUS: Record<string, LabelStatus> = { c1: 'ready', c2: 'missing', c3: 'stale' };
const statusOf = (c: ContainerItem) => STATUS[c.id];

function setup(over: Partial<Parameters<typeof PrintContainerList>[0]> = {}) {
  const h = { onSelectedChange: vi.fn(), onDisplayedChange: vi.fn(), onRefresh: vi.fn() };
  const view = render(
    <PrintContainerList rows={ROWS} statusOf={statusOf} selected={[]} refreshing={false} {...h} {...over} />,
  );
  return { ...h, view };
}

describe('PrintContainerList', () => {
  it('renders the container columns plus Label status chips', () => {
    setup();
    for (const label of ['Container', 'Type', 'Label tag', 'Site', 'Assets', 'Status', 'Label']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('crate-blue')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Containers' });
    expect(within(list).getByText('Ready')).toBeTruthy();
    expect(within(list).getByText('Missing')).toBeTruthy();
    expect(within(list).getByText('Stale')).toBeTruthy();
    expect(screen.getByText('Showing 3 of 3 containers')).toBeTruthy();
  });

  it('does not list archived containers', () => {
    const live = container('live', { name: 'live-crate' });
    const archived = container('old', { name: 'old-crate', archived_at: '2026-01-01T00:00:00Z' });
    setup({ rows: [live, archived] });
    expect(screen.queryByText('old-crate')).toBeNull();
    expect(screen.getByText('live-crate')).toBeTruthy();
    expect(screen.getByText('Showing 1 of 1 containers')).toBeTruthy();
  });

  // Asserting the two exported constants differ proves nothing — they differ
  // by construction, and would still differ if this list were wired to the
  // ASSET key, which would silently corrupt both lists' column state. So
  // assert the key that actually reaches the preferences layer.
  it('saves its column state under its own prefs key, never the asset list key', async () => {
    auth.updatePreferences.mockClear();
    const { view } = setup();
    // Any change to persisted state schedules a debounced save; unmounting
    // flushes it synchronously.
    await userEvent.click(screen.getByText('Site'));
    view.unmount();

    expect(auth.updatePreferences).toHaveBeenCalledTimes(1);
    const saved = auth.updatePreferences.mock.calls[0][0] as
      { list_prefs: Record<string, { sortKey?: string }> };
    expect(Object.keys(saved.list_prefs)).toEqual([PRINT_CONTAINER_LIST_PAGE_KEY]);
    expect(saved.list_prefs[PRINT_LIST_PAGE_KEY]).toBeUndefined();
    expect(saved.list_prefs[PRINT_CONTAINER_LIST_PAGE_KEY].sortKey).toBe('site');
  });

  it('row click toggles, header checkbox selects the filtered rows', async () => {
    const h = setup({ selected: ['c1'] });
    await userEvent.click(screen.getByText('crate-green'));
    expect(h.onSelectedChange).toHaveBeenLastCalledWith(['c1', 'c3']);
    // select-all replaces the selection with the displayed rows, in display
    // order — the default sort is Container name ascending
    await userEvent.click(screen.getByLabelText('Select all filtered containers'));
    expect(h.onSelectedChange).toHaveBeenLastCalledWith(['c2', 'c1', 'c3']);
  });

  it('search narrows rows and reports the displayed rows to the parent', async () => {
    const h = setup();
    await userEvent.type(screen.getByPlaceholderText('Search containers…'), 'cage');
    expect(screen.getByText('Showing 1 of 3 containers')).toBeTruthy();
    expect(h.onDisplayedChange).toHaveBeenLastCalledWith([ROWS[1]]);
  });

  it('Label filter: Ready shows ready + stale, Missing shows missing', async () => {
    setup();
    await userEvent.click(screen.getByRole('tab', { name: 'Ready' }));
    expect(screen.getByText('Showing 2 of 3 containers')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Missing' }));
    expect(screen.getByText('Showing 1 of 3 containers')).toBeTruthy();
    expect(screen.getByText('crate-blue')).toBeTruthy();
  });

  it('hides the Label column and filter for Custom (statusOf null)', () => {
    setup({ statusOf: null });
    expect(screen.queryByRole('tab', { name: 'Ready' })).toBeNull();
    expect(screen.queryByText('Label')).toBeNull();
  });

  it('sorts naturally on the chosen column with no rack tie-break', () => {
    const rows = [container('a', { name: 'crate-10' }), container('b', { name: 'crate-2' }), container('c', { name: 'crate-1' })];
    expect(sortContainerRows(rows, () => 'ready', 'name', 1).map((r) => r.id)).toEqual(['c', 'b', 'a']);
    expect(sortContainerRows(rows, () => 'ready', 'name', -1).map((r) => r.id)).toEqual(['a', 'b', 'c']);
    const counts = [container('a', { asset_count: 9 }), container('b', { asset_count: 10 })];
    expect(sortContainerRows(counts, () => 'ready', 'assets', 1).map((r) => r.id)).toEqual(['a', 'b']);
  });

  it('cell text feeds search/filters for every column', () => {
    const r = ROWS[0];
    expect(containerCellText(r, 'ready', 'name')).toBe('crate-c1');
    expect(containerCellText(r, 'ready', 'type')).toBe('Pallet');
    expect(containerCellText(r, 'ready', 'tag')).toBe('Priority');
    expect(containerCellText(ROWS[1], 'ready', 'tag')).toBe('');
    expect(containerCellText(r, 'ready', 'site')).toBe('NAP11');
    expect(containerCellText(r, 'ready', 'assets')).toBe('3');
    expect(containerCellText(r, 'ready', 'status')).toBe('Packed');
    expect(containerCellText(r, 'stale', 'label')).toBe('Stale');
    expect(containerCellText(r, null, 'label')).toBe('');
  });

  it('shows the empty state when the search matches nothing', async () => {
    setup();
    await userEvent.type(screen.getByPlaceholderText('Search containers…'), 'zzz');
    expect(screen.getByText('No containers match your search')).toBeTruthy();
  });

  it('clears search when resetKey changes (new initiative swapped in)', async () => {
    const h = setup({ resetKey: 'i1' });
    await userEvent.type(screen.getByPlaceholderText('Search containers…'), 'cage');
    expect(screen.getByText('Showing 1 of 3 containers')).toBeTruthy();

    h.view.rerender(
      <PrintContainerList rows={ROWS} statusOf={statusOf} selected={[]} refreshing={false} resetKey="i2"
                          onSelectedChange={h.onSelectedChange} onDisplayedChange={h.onDisplayedChange}
                          onRefresh={h.onRefresh} />,
    );

    expect((screen.getByPlaceholderText('Search containers…') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Showing 3 of 3 containers')).toBeTruthy();
  });

  it('refresh button calls back and disables while refreshing', async () => {
    const h = setup({ refreshing: true });
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    const h2 = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(h2.onRefresh).toHaveBeenCalledTimes(1);
    expect(h.onRefresh).not.toHaveBeenCalled();
  });
});
