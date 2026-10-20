// @vitest-environment jsdom
/**
 * Load from asset…: pick a move, then one of its assets, and the builder's
 * samples take that asset's values (GET /labels/sample-values). A field the
 * asset has blank keeps the sample it had.
 */

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InitiativeAssetRow, InitiativeItem } from '../../../lib/api';

const api = vi.hoisted(() => ({
  listInitiatives: vi.fn(), listInitiativeAssets: vi.fn(), loadSampleAsset: vi.fn(),
}));
vi.mock('../../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/api')>()), ...api,
}));

const { ApiError } = await import('../../../lib/api');
const { default: LoadFromAssetModal, fillSamples } = await import('./LoadFromAssetModal');

const ini = (id: string, name: string, type = 'move', archived: string | null = null, created = '2026-09-01T00:00:00Z') => ({
  id, name, initiative_type: type, type_label: type, type_color: '#000', status: 'planned', status_label: 'Planned',
  status_color: '#2f9e5e', client_name: 'Initech', archived_at: archived, created_at: created,
  scheduled_start: '2026-10-07T00:00:00Z', scheduled_end: null,
} as unknown as InitiativeItem);

const row = (id: string, legacy: number, name: string, serial: string, rack: string) => ({
  id: `ia-${id}`, asset_id: id, destination_rack: rack, destination_ru: 14, status: 'labeled',
  status_label: 'Labeled', status_color: '#2f9e5e',
  asset: { id, legacy_id: legacy, name, serial_number: serial },
} as unknown as InitiativeAssetRow);

beforeEach(() => {
  api.listInitiatives.mockResolvedValue([
    ini('m1', 'Vegas Move', 'move', null, '2026-08-01T00:00:00Z'),
    ini('p1', 'Rack audit', 'project'),
    ini('m2', 'Old Move', 'move', '2026-09-02T00:00:00Z'),
    ini('m3', 'Chicago Move', 'move', null, '2026-09-15T00:00:00Z'),
  ]);
  api.listInitiativeAssets.mockResolvedValue([
    row('a2', 100191, 'lvn-hm1w2-vc1-c1n8', '36B7145', '14.01.07C.02.04'),
    row('a1', 100190, 'lvn-hm1w2-vc1-c1n7', '36B7144', '14.01.07C.02.03'),
  ]);
  api.loadSampleAsset.mockResolvedValue({ asset_name: 'lvn-hm1w2-vc1-c1n7', destination_rack: '14.01.07C.02.03', owner: '' });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function setup() {
  const onLoad = vi.fn<(values: Record<string, string>) => void>();
  const onClose = vi.fn();
  render(<LoadFromAssetModal onLoad={onLoad} onClose={onClose} />);
  return { onLoad, onClose };
}

const dialog = () => screen.getByRole('dialog', { name: 'Load samples from an asset' });

describe('LoadFromAssetModal', () => {
  it('picks a move, then an asset, and hands back its values', async () => {
    const { onLoad } = setup();
    expect(within(dialog()).getByText('Label builder')).toBeTruthy();
    // moves only, live ones, newest first
    const moves = await within(dialog()).findAllByRole('radio');
    expect(moves.map((r) => r.getAttribute('aria-label'))).toEqual(['Chicago Move', 'Vegas Move']);
    const next = within(dialog()).getByRole('button', { name: 'Next' }) as HTMLButtonElement;
    expect(next.disabled).toBe(true);
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'Vegas Move' }));
    fireEvent.click(next);

    await waitFor(() => expect(api.listInitiativeAssets).toHaveBeenCalledWith('m1'));
    const assets = await within(dialog()).findAllByRole('radio');
    expect(assets.map((r) => r.getAttribute('aria-label'))).toEqual(['lvn-hm1w2-vc1-c1n7', 'lvn-hm1w2-vc1-c1n8']);
    fireEvent.change(within(dialog()).getByRole('searchbox', { name: 'Search assets' }), { target: { value: '7145' } });
    expect(within(dialog()).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual(['lvn-hm1w2-vc1-c1n8']);
    fireEvent.change(within(dialog()).getByRole('searchbox', { name: 'Search assets' }), { target: { value: '100190' } });
    fireEvent.click(within(dialog()).getByRole('radio', { name: 'lvn-hm1w2-vc1-c1n7' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Load samples' }));

    await waitFor(() => expect(onLoad).toHaveBeenCalledTimes(1));
    expect(api.loadSampleAsset).toHaveBeenCalledWith('m1', 'a1');
    expect(onLoad).toHaveBeenCalledWith({ asset_name: 'lvn-hm1w2-vc1-c1n7', destination_rack: '14.01.07C.02.03', owner: '' });
  });

  it('Back returns to the moves; Cancel closes', async () => {
    const { onClose } = setup();
    fireEvent.click(await within(dialog()).findByRole('radio', { name: 'Vegas Move' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Next' }));
    await within(dialog()).findByRole('radio', { name: 'lvn-hm1w2-vc1-c1n7' });
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Back' }));
    expect(within(dialog()).getByRole('radio', { name: 'Vegas Move' })).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('shows the error when the values cannot load', async () => {
    api.loadSampleAsset.mockRejectedValue(new ApiError(404, 'asset_not_on_move'));
    const { onLoad } = setup();
    fireEvent.click(await within(dialog()).findByRole('radio', { name: 'Vegas Move' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Next' }));
    fireEvent.click(await within(dialog()).findByRole('radio', { name: 'lvn-hm1w2-vc1-c1n7' }));
    fireEvent.click(within(dialog()).getByRole('button', { name: 'Load samples' }));
    expect((await within(dialog()).findByRole('alert')).textContent).toBe('That asset is no longer on this move.');
    expect(onLoad).not.toHaveBeenCalled();
  });
});

describe('fillSamples', () => {
  it('takes every value the asset has; a blank one keeps the old sample', () => {
    const out = fillSamples(
      { asset_name: 'old', owner: 'Data Services', move_code: 'LV3' },
      { asset_name: 'lvn-hm1w2-vc1-c1n7', owner: '', destination_rack: '14.01.07C.02.03', 'ft:Notes': 'Fragile' },
    );
    expect(out.samples).toEqual({
      asset_name: 'lvn-hm1w2-vc1-c1n7', owner: 'Data Services', move_code: 'LV3',
      destination_rack: '14.01.07C.02.03', 'ft:Notes': 'Fragile',
    });
    expect(out).toMatchObject({ filled: 3, kept: 1 });
  });
});
