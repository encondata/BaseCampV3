// @vitest-environment jsdom
/**
 * Smoke-mounts the actual RackViewModal (not just its pure helpers) so a
 * runtime SVG-rendering bug — bad JSX nesting, a NaN geometry value, a
 * missing key — fails a test instead of only showing up visually. Covers
 * the redesign's three render branches: populated rack, empty rack, and a
 * decimal-RU / overlapping-lane rack (the collision-lane path).
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import RackViewModal from './RackViewModal';
import type { InitiativeAssetRow, InitiativeAssetSummary } from '../../lib/api';

afterEach(cleanup);

function makeAsset(overrides: Partial<InitiativeAssetSummary> = {}): InitiativeAssetSummary {
  return {
    id: 'asset-1', legacy_id: null, serial_number: 'SN-1', name: 'w1-hs4-m0407',
    rfid_tag: null, model_make: null, model_name: null, ru_size: 1,
    location_detail: null, client_name: null,
    status: 'active', status_label: 'Active', status_color: '#000',
    ...overrides,
  };
}

function makeRow(overrides: Partial<InitiativeAssetRow> = {}): InitiativeAssetRow {
  return {
    id: 'row-1', asset_id: 'asset-1',
    priority_wave: null, disposition: null, owner: null,
    source_rack: 'R1', source_ru: 10, source_verified: true, source_position: 'rear',
    destination_rack: null, destination_ru: null,
    destination_verified: null, destination_position: null,
    cable_info: null, vendor_involved: null,
    status: 'active', status_label: 'Active', status_color: '#000',
    created_at: '2026-01-01', updated_at: '2026-01-01',
    asset: makeAsset(),
    ...overrides,
  };
}

describe('RackViewModal (render smoke)', () => {
  it('renders a populated rack with a verified faceplate and its label', () => {
    render(
      <RackViewModal rackName="R1" side="source" rows={[makeRow()]} onClose={() => {}} />,
    );
    expect(screen.getByText('Rack R1 — Source')).toBeTruthy();
    // Matches twice by design: the visible <text> label and its nested
    // <title> hover tooltip both carry the untruncated string here.
    expect(screen.getAllByText('w1-hs4-m0407 (rear)').length).toBeGreaterThan(0);
    expect(screen.getByRole('img', { name: /Rack R1 elevation, source/i })).toBeTruthy();
  });

  it('renders the empty-state message inside the SVG when nothing matches', () => {
    render(
      <RackViewModal rackName="R1" side="destination" rows={[makeRow()]} onClose={() => {}} />,
    );
    expect(screen.getByText('No assets recorded at this rack')).toBeTruthy();
  });

  it('renders overlapping decimal-RU blocks (collision lanes) without crashing', () => {
    const rows: InitiativeAssetRow[] = [
      makeRow({
        id: 'row-a', source_ru: 10.5,
        asset: makeAsset({ id: 'asset-a', name: 'server-a', ru_size: 2 }),
      }),
      makeRow({
        id: 'row-b', source_ru: 10.5, source_verified: false, source_position: null,
        asset: makeAsset({ id: 'asset-b', name: null, serial_number: 'SN-B', ru_size: 2 }),
      }),
    ];
    render(<RackViewModal rackName="R1" side="source" rows={rows} onClose={() => {}} />);
    expect(screen.getAllByText('server-a (rear)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SN-B').length).toBeGreaterThan(0);
  });
});
