// @vitest-environment jsdom
/**
 * Smoke-mounts the actual RackViewModal (not just its pure helpers) so a
 * runtime SVG-rendering bug — bad JSX nesting, a NaN geometry value, a
 * missing key — fails a test instead of only showing up visually. Covers
 * the redesign's three render branches (populated rack, empty rack,
 * decimal-RU / overlapping-lane rack) plus the front/rear split follow-up:
 * same-half collisions still squeeze into lanes, but a front device and a
 * rear device at the same RU land in separate, full-width halves instead.
 */
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import RackViewModal, { FACEPLATE_HALF_USABLE_WIDTH } from './RackViewModal';
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

  it('renders overlapping decimal-RU blocks in the same half (collision lanes) without crashing', () => {
    const rows: InitiativeAssetRow[] = [
      makeRow({
        id: 'row-a', source_ru: 10.5, // both "rear" -> same half -> must share lanes
        asset: makeAsset({ id: 'asset-a', name: 'server-a', ru_size: 2 }),
      }),
      makeRow({
        id: 'row-b', source_ru: 10.5, source_verified: false,
        asset: makeAsset({ id: 'asset-b', name: null, serial_number: 'SN-B', ru_size: 2 }),
      }),
    ];
    render(<RackViewModal rackName="R1" side="source" rows={rows} onClose={() => {}} />);
    expect(screen.getAllByText('server-a (rear)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('SN-B (rear)').length).toBeGreaterThan(0);
  });

  it('splits front/rear devices at the same RU into separate, full-width halves', () => {
    const rows: InitiativeAssetRow[] = [
      makeRow({
        id: 'row-front', source_ru: 20, source_position: 'front',
        asset: makeAsset({ id: 'asset-front', name: 'front-box', ru_size: 1 }),
      }),
      makeRow({
        id: 'row-rear', source_ru: 20, source_position: 'rear',
        asset: makeAsset({ id: 'asset-rear', name: 'rear-box', ru_size: 1 }),
      }),
    ];
    const { container } = render(
      <RackViewModal rackName="R1" side="source" rows={rows} onClose={() => {}} />,
    );

    // Column chrome from the follow-up request.
    expect(screen.getByText('FRONT')).toBeTruthy();
    expect(screen.getByText('REAR')).toBeTruthy();
    expect(container.querySelector('.rack-separator')).toBeTruthy();

    // Same RU, opposite halves -> neither should be squeezed by the other's
    // lane-collision pass; each faceplate gets the full half width.
    const faceplates = Array.from(container.querySelectorAll('.rack-faceplate'));
    expect(faceplates).toHaveLength(2);
    for (const el of faceplates) {
      expect(Number(el.getAttribute('width'))).toBe(FACEPLATE_HALF_USABLE_WIDTH);
    }
  });

  it('does not let an unrelated collision squeeze an unrelated lone faceplate in the same half (visual-review regression)', () => {
    // Mirrors the exact bug reported from a rendered screenshot: a single
    // isolated device (san-arr-04-like, ru 40) shared its half with a real
    // collision elsewhere (two devices at ru 20) and was wrongly squeezed
    // to the two-lane width even though nothing overlapped it.
    const rows: InitiativeAssetRow[] = [
      makeRow({
        id: 'row-lone', source_ru: 40, source_position: 'front',
        asset: makeAsset({ id: 'asset-lone', name: 'san-arr-04', ru_size: 4 }),
      }),
      makeRow({
        id: 'row-c1', source_ru: 20, source_position: 'front',
        asset: makeAsset({ id: 'asset-c1', name: 'net-sw-01', ru_size: 1 }),
      }),
      makeRow({
        id: 'row-c2', source_ru: 20, source_position: 'front',
        asset: makeAsset({ id: 'asset-c2', name: 'net-sw-02', ru_size: 1 }),
      }),
    ];
    const { container } = render(
      <RackViewModal rackName="R1" side="source" rows={rows} onClose={() => {}} />,
    );
    const faceplates = Array.from(container.querySelectorAll('.rack-faceplate'));
    expect(faceplates).toHaveLength(3);
    const widths = faceplates.map((el) => Number(el.getAttribute('width')));
    // The lone block must get the full half width...
    expect(widths).toContain(FACEPLATE_HALF_USABLE_WIDTH);
    // ...while the two that actually collide are still squeezed narrower.
    const squeezed = widths.filter((w) => w < FACEPLATE_HALF_USABLE_WIDTH);
    expect(squeezed).toHaveLength(2);
  });

  it('renders exactly one rail-hole column per post, fully inside the viewBox', () => {
    const { container } = render(
      <RackViewModal rackName="R1" side="source" rows={[makeRow()]} onClose={() => {}} />,
    );
    const svg = container.querySelector('svg.rack-svg')!;
    const viewBoxWidth = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
    const holes = Array.from(container.querySelectorAll('.rack-rail-hole'));
    expect(holes).toHaveLength(54 * 3 * 2); // 54 RUs x 3 holes x 2 posts
    const leftXs = new Set(holes.map((h) => h.getAttribute('x')).filter((x) => Number(x) < viewBoxWidth / 2));
    const rightXs = new Set(holes.map((h) => h.getAttribute('x')).filter((x) => Number(x) >= viewBoxWidth / 2));
    expect(leftXs.size).toBe(1); // exactly one hole column on the left post
    expect(rightXs.size).toBe(1); // exactly one hole column on the right post
    for (const h of holes) {
      const x = Number(h.getAttribute('x'));
      const width = Number(h.getAttribute('width'));
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x + width).toBeLessThanOrEqual(viewBoxWidth);
    }
  });
});
