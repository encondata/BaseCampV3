// @vitest-environment jsdom
/**
 * Smoke-mounts the actual RackViewModal (not just its pure helpers) so a
 * runtime SVG-rendering bug — bad JSX nesting, a NaN geometry value, a
 * missing key — fails a test instead of only showing up visually. Covers
 * the redesign's render branches (populated elevation, empty elevation,
 * decimal-RU / overlapping-lane blocks), the front/rear SPLIT-ELEVATIONS
 * follow-up (two independent frames, REAR omitted entirely when nothing is
 * rear-mounted, per-elevation lane collisions), the per-cluster width fix,
 * the light-theme hover tooltip, round 3 (cage-nut holes removed,
 * cross-side ghost blocks, tooltip Position-row suppression), and round 4
 * (U numbers mirrored onto both rails with no every-5 emphasis, legend
 * chips moved from the modal header to its footer).
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import RackViewModal, { FACEPLATE_USABLE_WIDTH } from './RackViewModal';
import type { InitiativeAssetRow, InitiativeAssetSummary } from '../../lib/api';

afterEach(cleanup);

function makeAsset(overrides: Partial<InitiativeAssetSummary> = {}): InitiativeAssetSummary {
  return {
    id: 'asset-1', legacy_id: null, serial_number: 'SN-1', name: 'w1-hs4-m0407',
    rfid_tag: null, model_make: null, model_name: null, ru_size: 1,
    location_detail: null, client_name: null,
    model_category: null, model_category_label: null, model_category_color: null,
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
  it('renders a populated REAR elevation with a verified faceplate and its label', () => {
    render(
      <RackViewModal rackName="R1" side="source" rows={[makeRow()]} onClose={() => {}} />,
    );
    expect(screen.getByText('Rack R1 — Source')).toBeTruthy();
    expect(screen.getByText('w1-hs4-m0407 (rear)')).toBeTruthy();
    expect(screen.getByRole('img', { name: /Rack R1 — Source — rear elevation/i })).toBeTruthy();
  });

  it('omits the REAR elevation entirely when nothing is rear-mounted, centering FRONT alone', () => {
    render(
      <RackViewModal
        rackName="R1" side="source"
        rows={[makeRow({ source_position: 'front' })]} onClose={() => {}}
      />,
    );
    expect(screen.getByRole('img', { name: /Rack R1 — Source — front elevation/i })).toBeTruthy();
    expect(screen.queryByRole('img', { name: /rear elevation/i })).toBeNull();
    expect(screen.queryByText('REAR')).toBeNull();
    expect(screen.getByText('FRONT')).toBeTruthy();
  });

  it('renders the FRONT elevation\'s own empty-state message when the rack/side has no assets at all', () => {
    render(
      <RackViewModal rackName="R1" side="destination" rows={[makeRow()]} onClose={() => {}} />,
    );
    // makeRow's default row only has a SOURCE placement, so the destination
    // side has nothing -> FRONT renders empty, REAR is omitted (0 blocks).
    expect(screen.getByText('No assets recorded at this rack')).toBeTruthy();
    expect(screen.queryByText('REAR')).toBeNull();
  });

  it('renders overlapping decimal-RU blocks in the same elevation (collision lanes) without crashing', () => {
    const rows: InitiativeAssetRow[] = [
      makeRow({
        id: 'row-a', source_ru: 10.5, // both "rear" -> same elevation -> must share lanes
        asset: makeAsset({ id: 'asset-a', name: 'server-a', ru_size: 2 }),
      }),
      makeRow({
        id: 'row-b', source_ru: 10.5, source_verified: false,
        asset: makeAsset({ id: 'asset-b', name: null, serial_number: 'SN-B', ru_size: 2 }),
      }),
    ];
    render(<RackViewModal rackName="R1" side="source" rows={rows} onClose={() => {}} />);
    // Squeezed to a 2-lane width here, so the label truncates (exact
    // truncation math is covered by the dedicated `rackLabel` unit tests
    // above) — a prefix match is enough to confirm both blocks rendered.
    expect(screen.getByText(/^server-a/)).toBeTruthy();
    expect(screen.getByText(/^SN-B/)).toBeTruthy();
  });

  it('splits front/rear devices at the same RU into two independent elevations, each showing a ghost of the other', () => {
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

    expect(screen.getByText('FRONT')).toBeTruthy();
    expect(screen.getByText('REAR')).toBeTruthy();
    expect(container.querySelectorAll('.rack-elevation')).toHaveLength(2);
    expect(container.querySelectorAll('svg.rack-svg')).toHaveLength(2);

    // Both real devices AND both ghosts (front-box's ghost on REAR,
    // rear-box's ghost on FRONT) now share the same RU within their own
    // elevation, so each must lane-split against the other -> no longer
    // full width, per the round-3 "ghosts participate in lane collision
    // like real blocks" requirement.
    const realFaceplates = Array.from(container.querySelectorAll('.rack-faceplate'));
    const ghostFaceplates = Array.from(container.querySelectorAll('.rack-faceplate-ghost'));
    expect(realFaceplates).toHaveLength(2);
    expect(ghostFaceplates).toHaveLength(2);
    const squeezedWidth = Math.max(40, (FACEPLATE_USABLE_WIDTH - 14) / 2);
    for (const el of [...realFaceplates, ...ghostFaceplates]) {
      expect(Number(el.getAttribute('width'))).toBe(squeezedWidth);
    }
  });

  it('gives a lone real block the full width again once it has no opposite-side ghost to lane-split against', () => {
    // Same setup as above but at DIFFERENT RUs, so nothing collides: each
    // elevation's real block and its opposite-side ghost sit apart and
    // both get the full elevation width.
    const rows: InitiativeAssetRow[] = [
      makeRow({
        id: 'row-front', source_ru: 20, source_position: 'front',
        asset: makeAsset({ id: 'asset-front', name: 'front-box', ru_size: 1 }),
      }),
      makeRow({
        id: 'row-rear', source_ru: 40, source_position: 'rear',
        asset: makeAsset({ id: 'asset-rear', name: 'rear-box', ru_size: 1 }),
      }),
    ];
    const { container } = render(
      <RackViewModal rackName="R1" side="source" rows={rows} onClose={() => {}} />,
    );
    const realFaceplates = Array.from(container.querySelectorAll('.rack-faceplate'));
    const ghostFaceplates = Array.from(container.querySelectorAll('.rack-faceplate-ghost'));
    expect(realFaceplates).toHaveLength(2);
    expect(ghostFaceplates).toHaveLength(2);
    for (const el of [...realFaceplates, ...ghostFaceplates]) {
      expect(Number(el.getAttribute('width'))).toBe(FACEPLATE_USABLE_WIDTH);
    }
  });

  it('does not let an unrelated collision squeeze an unrelated lone faceplate in the same elevation (visual-review regression)', () => {
    // Mirrors the exact bug reported from a rendered screenshot: a single
    // isolated device (san-arr-04-like, ru 40) shared its elevation with a
    // real collision elsewhere (two devices at ru 20) and was wrongly
    // squeezed to the two-lane width even though nothing overlapped it.
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
    // The lone block must get the full elevation width...
    expect(widths).toContain(FACEPLATE_USABLE_WIDTH);
    // ...while the two that actually collide are still squeezed narrower.
    const squeezed = widths.filter((w) => w < FACEPLATE_USABLE_WIDTH);
    expect(squeezed).toHaveLength(2);
  });

  it('renders posts as clean outlined rails with no cage-nut hole pattern (round 3)', () => {
    const { container } = render(
      <RackViewModal rackName="R1" side="source" rows={[makeRow()]} onClose={() => {}} />,
    );
    expect(container.querySelectorAll('.rack-rail-hole')).toHaveLength(0);
    // makeRow's default row renders both elevations (FRONT always, REAR
    // because it's rear-mounted) -> 2 elevations x 2 posts each.
    expect(container.querySelectorAll('.rack-post')).toHaveLength(4);
    // U numbers are the only thing left "inside" the rails, mirrored onto
    // both rails (round 4) -> 54 x 2 rails x 2 elevations.
    expect(container.querySelectorAll('.rack-u-label').length).toBe(54 * 2 * 2);
    // ...and every one of them is the uniform, unemphasized style now.
    expect(container.querySelectorAll('.rack-u-label-major')).toHaveLength(0);
  });

  it('shows an HTML hover tooltip with name/serial/make-model/RU/position on mouseEnter, hides it on mouseLeave', () => {
    const rows: InitiativeAssetRow[] = [
      makeRow({
        id: 'row-1', source_ru: 12, source_position: 'rear', source_verified: true,
        asset: makeAsset({
          id: 'asset-1', name: 'db-primary-01', serial_number: 'SN-XYZ-99',
          model_make: 'Dell', model_name: 'R640', ru_size: 2,
        }),
      }),
    ];
    const { container } = render(
      <RackViewModal rackName="R1" side="source" rows={rows} onClose={() => {}} />,
    );

    // No tooltip until hovered.
    expect(container.querySelector('.rack-tooltip')).toBeNull();

    const faceplateGroup = container.querySelector('.rack-faceplate')!.parentElement!;
    fireEvent.mouseEnter(faceplateGroup);

    const tooltip = container.querySelector('.rack-tooltip');
    expect(tooltip).toBeTruthy();
    expect(tooltip!.textContent).toContain('db-primary-01');
    expect(tooltip!.textContent).toContain('SN-XYZ-99');
    expect(tooltip!.textContent).toContain('Dell R640');
    expect(tooltip!.textContent).toContain('12'); // RU
    expect(tooltip!.textContent).toContain('rear'); // position note

    fireEvent.mouseLeave(faceplateGroup);
    expect(container.querySelector('.rack-tooltip')).toBeNull();
  });

  it('omits the tooltip Position row when the position note is blank or "front"', () => {
    const rows: InitiativeAssetRow[] = [
      makeRow({
        id: 'row-1', source_ru: 12, source_position: 'front',
        asset: makeAsset({ id: 'asset-1', name: 'db-primary-01', serial_number: 'SN-XYZ-99' }),
      }),
    ];
    const { container } = render(
      <RackViewModal rackName="R1" side="source" rows={rows} onClose={() => {}} />,
    );
    const faceplateGroup = container.querySelector('.rack-faceplate')!.parentElement!;
    fireEvent.mouseEnter(faceplateGroup);
    const tooltip = container.querySelector('.rack-tooltip')!;
    expect(tooltip.textContent).toContain('Serial');
    expect(tooltip.textContent).not.toContain('Position');
  });

  it('shows a blank, unlabeled ghost box on FRONT for a rear-mounted device, hoverable with the same detail plus its "rear" position', () => {
    const rows: InitiativeAssetRow[] = [
      makeRow({
        id: 'row-1', source_ru: 30, source_position: 'rear', source_verified: true,
        asset: makeAsset({
          id: 'asset-1', name: 'kvm-rear-01', serial_number: 'SN-KVM-1',
          model_make: 'Raritan', model_name: 'DKX3',
        }),
      }),
    ];
    const { container } = render(
      <RackViewModal rackName="R1" side="source" rows={rows} onClose={() => {}} />,
    );
    // FRONT always renders; with a rear-mounted asset, it shows that
    // asset's ghost (blank box, no visible label) rather than staying empty.
    const frontElevation = screen.getByText('FRONT').closest('.rack-elevation')!;
    expect(frontElevation.querySelector('.rack-empty-label')).toBeNull();
    const ghost = frontElevation.querySelector('.rack-faceplate-ghost');
    expect(ghost).toBeTruthy();
    expect(frontElevation.querySelector('.rack-block-label')).toBeNull();

    fireEvent.mouseEnter(ghost!.parentElement!);
    const tooltip = container.querySelector('.rack-tooltip')!;
    expect(tooltip.textContent).toContain('kvm-rear-01');
    expect(tooltip.textContent).toContain('SN-KVM-1');
    expect(tooltip.textContent).toContain('Raritan DKX3');
    expect(tooltip.textContent).toContain('30');
    expect(tooltip.textContent).toContain('rear');
  });

  it('mirrors U numbers onto both rails with no every-5 emphasis (round 4)', () => {
    const { container } = render(
      <RackViewModal rackName="R1" side="source" rows={[makeRow({ source_position: 'front' })]} onClose={() => {}} />,
    );
    // Only FRONT renders here (no rear-mounted asset) -> one elevation.
    const labels = Array.from(container.querySelectorAll('.rack-u-label'));
    expect(labels).toHaveLength(54 * 2); // every RU, both rails
    const xs = new Set(labels.map((l) => l.getAttribute('x')));
    expect(xs.size).toBe(2); // exactly one left-rail x and one right-rail x
    // No number is styled differently from any other (dropped entirely,
    // not just unused elsewhere) — same class, same size/weight/color.
    expect(container.querySelectorAll('.rack-u-label-major')).toHaveLength(0);
    const u54 = labels.find((l) => l.textContent === '54')!;
    const u50 = labels.find((l) => l.textContent === '50')!; // used to be "major"
    expect(u54.getAttribute('class')).toBe(u50.getAttribute('class'));
  });

  it('moves the Verified/Planned legend from the modal header to the footer', () => {
    const { container } = render(
      <RackViewModal rackName="R1" side="source" rows={[makeRow()]} onClose={() => {}} />,
    );
    const head = container.querySelector('.modal-head')!;
    const foot = container.querySelector('.modal-foot')!;
    expect(foot).toBeTruthy();
    expect(head.querySelector('.rack-legend')).toBeNull();
    expect(foot.querySelector('.rack-legend')).toBeTruthy();
    expect(foot.textContent).toContain('Verified');
    expect(foot.textContent).toContain('Planned');
  });
});
