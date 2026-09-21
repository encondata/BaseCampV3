// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { InitiativeAssetRow } from '../../lib/api';
import type { LabelStatus } from '../../lib/printLabels';

vi.mock('../../auth/AuthContext', () => ({
  useAuth: () => ({ preferences: { list_prefs: {} }, updatePreferences: vi.fn(async () => true) }),
}));

const { default: PrintAssetList, assetCellText, sortRows } = await import('./PrintAssetList');

afterEach(cleanup);

const row = (n: number, over: Partial<InitiativeAssetRow> & { name?: string; serial?: string; make?: string; model?: string } = {}): InitiativeAssetRow => ({
  id: `j${n}`, asset_id: `a${n}`, priority_wave: null, disposition: null, owner: null,
  source_pod: null, destination_pod: null,
  source_rack: over.source_rack ?? `R${n}`, source_ru: over.source_ru ?? n,
  source_verified: null, source_position: null, destination_rack: null, destination_ru: null,
  destination_verified: null, destination_position: null, cable_info: null, vendor_involved: null,
  status: 'planned', status_label: 'Planned', status_color: '#123456', created_at: '', updated_at: '',
  asset: {
    id: `a${n}`, legacy_id: 38000 + n, serial_number: over.serial ?? `SN${n}`, name: over.name ?? `asset-${n}`,
    rfid_tag: null, model_make: over.make ?? 'Dell', model_name: over.model ?? `R${n}40`, ru_size: 1,
    model_category: null, model_category_label: null, model_category_color: null,
    location_detail: null, client_name: 'Acme', status: 'active', status_label: 'Active', status_color: '#000',
  } as unknown as InitiativeAssetRow['asset'],
});

const ROWS = [row(1), row(2, { source_rack: 'R1', source_ru: 40 }), row(3, { name: 'core-switch', make: 'Cisco' })];
const STATUS: Record<string, LabelStatus> = { a1: 'ready', a2: 'missing', a3: 'stale' };
const statusOf = (r: InitiativeAssetRow) => STATUS[r.asset_id];

function setup(over: Partial<Parameters<typeof PrintAssetList>[0]> = {}) {
  const h = { onSelectedChange: vi.fn(), onDisplayedChange: vi.fn(), onRefresh: vi.fn() };
  const view = render(<PrintAssetList rows={ROWS} statusOf={statusOf} selected={[]} refreshing={false} {...h} {...over} />);
  return { ...h, view };
}

describe('PrintAssetList', () => {
  it('renders V2 columns plus Label status chips', () => {
    setup();
    for (const label of ['Asset ID', 'Name', 'Serial', 'Make', 'Model', 'Source rack', 'RU', 'Status', 'Label']) {
      expect(screen.getByText(label)).toBeTruthy();
    }
    expect(screen.getByText('38001')).toBeTruthy();
    expect(screen.getByText('core-switch')).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Assets' });
    expect(within(list).getByText('Ready')).toBeTruthy();
    expect(within(list).getByText('Missing')).toBeTruthy();
    expect(within(list).getByText('Stale')).toBeTruthy();
    expect(screen.getByText('Showing 3 of 3 assets')).toBeTruthy();
  });

  it('row click toggles, header checkbox selects the filtered rows', async () => {
    const h = setup({ selected: ['a1'] });
    await userEvent.click(screen.getByText('core-switch'));
    expect(h.onSelectedChange).toHaveBeenLastCalledWith(['a1', 'a3']);
    await userEvent.click(screen.getByLabelText('Select all filtered assets'));
    expect(h.onSelectedChange).toHaveBeenLastCalledWith(['a2', 'a1', 'a3']);
  });

  it('search narrows rows and select-all then covers only the matches', async () => {
    const h = setup();
    await userEvent.type(screen.getByPlaceholderText('Search assets…'), 'cisco');
    expect(screen.getByText('Showing 1 of 3 assets')).toBeTruthy();
    await userEvent.click(screen.getByLabelText('Select all filtered assets'));
    expect(h.onSelectedChange).toHaveBeenLastCalledWith(['a3']);
    expect(h.onDisplayedChange).toHaveBeenLastCalledWith([ROWS[2]]);
  });

  it('Label filter: Ready shows ready + stale, Missing shows missing', async () => {
    setup();
    await userEvent.click(screen.getByRole('tab', { name: 'Ready' }));
    expect(screen.getByText('Showing 2 of 3 assets')).toBeTruthy();
    await userEvent.click(screen.getByRole('tab', { name: 'Missing' }));
    expect(screen.getByText('Showing 1 of 3 assets')).toBeTruthy();
    expect(screen.getByText('38002')).toBeTruthy();
  });

  it('hides the Label column and filter for Custom (statusOf null)', () => {
    setup({ statusOf: null });
    expect(screen.queryByRole('tab', { name: 'Ready' })).toBeNull();
    expect(screen.queryByText('Label')).toBeNull();
  });

  it('sorts by rack numeric-aware with RU top-down as the tie-break', () => {
    const rows = [row(1, { source_rack: 'R10', source_ru: 5 }), row(2, { source_rack: 'R2', source_ru: 40 }), row(3, { source_rack: 'R2', source_ru: 42 })];
    expect(sortRows(rows, () => 'ready', 'source_rack', 1).map((r) => r.asset_id)).toEqual(['a3', 'a2', 'a1']);
    expect(sortRows(rows, () => 'ready', 'source_rack', -1).map((r) => r.asset_id)).toEqual(['a1', 'a3', 'a2']);
    expect(sortRows(rows, () => 'ready', 'source_ru', -1).map((r) => r.asset_id)).toEqual(['a3', 'a2', 'a1']);
  });

  it('cell text feeds search/filters for every column', () => {
    const r = ROWS[0];
    expect(assetCellText(r, 'ready', 'asset_id')).toBe('38001');
    expect(assetCellText(r, 'ready', 'name')).toBe('asset-1');
    expect(assetCellText(r, 'ready', 'serial')).toBe('SN1');
    expect(assetCellText(r, 'ready', 'make')).toBe('Dell');
    expect(assetCellText(r, 'ready', 'source_rack')).toBe('R1');
    expect(assetCellText(r, 'ready', 'source_ru')).toBe('1');
    expect(assetCellText(r, 'ready', 'status')).toBe('Planned');
    expect(assetCellText(r, 'stale', 'label')).toBe('Stale');
    expect(assetCellText(r, null, 'label')).toBe('');
  });

  it('shows the empty state with a clear-filters action when a column filter hides everything', async () => {
    setup();
    await userEvent.type(screen.getByPlaceholderText('Search assets…'), 'zzz');
    expect(screen.getByText('No assets match your search')).toBeTruthy();
  });

  it('clears search/filters when resetKey changes (new initiative swapped in)', async () => {
    const h = setup({ resetKey: 'i1' });
    await userEvent.type(screen.getByPlaceholderText('Search assets…'), 'cisco');
    expect(screen.getByText('Showing 1 of 3 assets')).toBeTruthy();

    h.view.rerender(
      <PrintAssetList rows={ROWS} statusOf={statusOf} selected={[]} refreshing={false} resetKey="i2"
                      onSelectedChange={h.onSelectedChange} onDisplayedChange={h.onDisplayedChange} onRefresh={h.onRefresh} />,
    );

    expect((screen.getByPlaceholderText('Search assets…') as HTMLInputElement).value).toBe('');
    expect(screen.getByText('Showing 3 of 3 assets')).toBeTruthy();
  });

  it('does not re-report displayed rows on unrelated re-renders', () => {
    const onDisplayedChange = vi.fn();
    const onSelectedChange = vi.fn();
    const onRefresh = vi.fn();
    const selectedFixture: string[] = [];
    const { rerender } = render(
      <PrintAssetList rows={ROWS} statusOf={statusOf} selected={selectedFixture} refreshing={false}
                      onSelectedChange={onSelectedChange} onDisplayedChange={onDisplayedChange} onRefresh={onRefresh} />,
    );
    expect(onDisplayedChange).toHaveBeenCalledTimes(1);

    // Same rows/statusOf/selected references, only `refreshing` flips — the
    // `displayed` memo must not recompute, so onDisplayedChange must not re-fire.
    rerender(
      <PrintAssetList rows={ROWS} statusOf={statusOf} selected={selectedFixture} refreshing={true}
                      onSelectedChange={onSelectedChange} onDisplayedChange={onDisplayedChange} onRefresh={onRefresh} />,
    );
    expect(onDisplayedChange).toHaveBeenCalledTimes(1);

    const newRows = [...ROWS];
    rerender(
      <PrintAssetList rows={newRows} statusOf={statusOf} selected={selectedFixture} refreshing={true}
                      onSelectedChange={onSelectedChange} onDisplayedChange={onDisplayedChange} onRefresh={onRefresh} />,
    );
    expect(onDisplayedChange).toHaveBeenCalledTimes(2);
  });

  it('refresh button calls back and disables while refreshing', async () => {
    const h = setup({ refreshing: true });
    const btn = screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    cleanup();
    const h2 = setup();
    await userEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(h2.onRefresh).toHaveBeenCalledTimes(1);
    expect(h.onRefresh).not.toHaveBeenCalled();
  });
});
