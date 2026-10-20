// @vitest-environment jsdom
/**
 * The + picker: static text, line and box, then the fields (unused first,
 * placed ones last with "on label ×n", Split pieces under their field), a
 * filter that drives the keyboard, and a free-text From-To column.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { textBoxFor, textWidthIn } from '../../../labels/builder/metrics';
import type { DesignV2, FieldElement } from '../../../labels/builder/model';
import { FAKE_METRICS, FIELDS, SAMPLES, fakeMetricsFor, vegasWith } from './builderTestKit';
import FieldPicker, { type FieldPickerProps } from './FieldPicker';

afterEach(cleanup);

function setup(props: Partial<FieldPickerProps> = {}) {
  const change = vi.fn<(d: DesignV2) => void>();
  const select = vi.fn<(ids: string[]) => void>();
  const close = vi.fn();
  const design = props.design ?? vegasWith('value-name', 'grid-pod', 'barcode', 'caption-name');
  render(
    <FieldPicker fields={FIELDS} design={design} samples={SAMPLES} metricsFor={fakeMetricsFor} labelType="top"
      onChange={change} onSelect={select} onClose={close} {...props} />,
  );
  const added = () => change.mock.calls.at(-1)![0].elements.at(-1)!;
  return { change, select, close, added, design };
}

const options = () => screen.getAllByRole('option').map((o) => o.querySelector('.lbp-pick-name')?.textContent);

describe('FieldPicker', () => {
  it('lists static text, line and box, then fields; placed ones last with on label ×n', () => {
    setup();
    const all = options();
    expect(all.slice(0, 3)).toEqual(['Static text', 'Line', 'Box']);
    // unused fields in catalog order, then the placed ones
    expect(all.slice(3, 6)).toEqual(['Serial number', 'RFID tag', 'Make + model']);
    expect(all.slice(-8)).toEqual(['Asset ID', 'Asset name', 'Destination rack', 'NAP', 'Sector', 'POD', 'Row', 'Rack']);
    const assetId = screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Asset ID'))!;
    expect(assetId.className).toContain('is-used');
    expect(assetId.textContent).toContain('on label ×1');
    expect(screen.queryByText('Image')).toBeNull();
  });

  it('picking a placed field adds a second copy, sized to its sample, and selects it', () => {
    const { change, select, close, added, design } = setup();
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Asset name'))!);
    expect(change).toHaveBeenCalledTimes(1);
    const next = change.mock.calls[0][0];
    expect(next.elements.filter((e) => 'field' in e && e.field === 'asset_name')).toHaveLength(2);
    expect(next.elements).toHaveLength(design.elements.length + 1);
    const el = added() as FieldElement;
    const box = textBoxFor(FAKE_METRICS, 12);
    expect(el).toMatchObject({ type: 'field', field: 'asset_name', display: 'text', sizePt: 12, h: box.h, baselineIn: box.baselineIn });
    expect(el.w).toBeCloseTo(textWidthIn(FAKE_METRICS, 12, SAMPLES.asset_name));
    expect(el.id).not.toBe('value-name');
    expect(select).toHaveBeenCalledWith([el.id]);
    expect(close).toHaveBeenCalled();
  });

  it('adds a number field as Number, a piece as that piece, and static text / line / box', () => {
    const { added } = setup();
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Destination RU'))!);
    expect(added()).toMatchObject({ field: 'destination_ru', display: 'number' });
    cleanup();
    const second = setup();
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Rack'))!);
    expect(second.added()).toMatchObject({ field: 'destination_rack', piece: 4, display: 'text' });
    cleanup();
    const third = setup();
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Static text'))!);
    expect(third.added()).toMatchObject({ type: 'text', content: 'Text' });
    cleanup();
    const fourth = setup();
    fireEvent.click(screen.getAllByRole('option').find((o) => o.textContent?.startsWith('Box'))!);
    expect(fourth.added()).toMatchObject({ type: 'box' });
  });

  it('nests the Split pieces under their field', () => {
    setup();
    const all = options();
    const at = all.indexOf('Destination rack');
    expect(all.slice(at, at + 6)).toEqual(['Destination rack', 'NAP', 'Sector', 'POD', 'Row', 'Rack']);
    const pod = screen.getAllByRole('option')[at + 3];
    expect(pod.className).toContain('is-piece');
    expect(pod.textContent).toContain('on label ×1');
  });

  it('filters as you type; arrows and Enter pick, Escape closes', () => {
    const { added, close } = setup();
    const filter = screen.getByRole('combobox', { name: 'Filter fields' });
    expect(document.activeElement).toBe(filter);
    fireEvent.change(filter, { target: { value: 'serial' } });
    // a typed header the list hasn't seen can always be added, last
    expect(options()).toEqual(['Serial number', 'From-To column “serial”']);
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(added()).toMatchObject({ field: 'serial_number' });

    // a field that matches brings its pieces; a piece that matches, its field
    fireEvent.change(filter, { target: { value: 'rack' } });
    expect(options()).toEqual(['Source rack', 'Destination rack', 'NAP', 'Sector', 'POD', 'Row', 'Rack',
      'From-To column “rack”']);
    fireEvent.change(filter, { target: { value: 'pod' } });
    expect(options()).toEqual(['Destination rack', 'POD', 'From-To column “pod”']);
    fireEvent.change(filter, { target: { value: 'Notes' } });
    // a header already listed is not offered twice
    expect(options()).toEqual(['Notes']);
    fireEvent.change(filter, { target: { value: 'rack' } });
    fireEvent.keyDown(filter, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1].getAttribute('aria-selected')).toBe('true');
    fireEvent.keyDown(filter, { key: 'Enter' });
    expect(added()).toMatchObject({ field: 'destination_rack' });
    expect((added() as FieldElement).piece ?? null).toBeNull();
    const closed = close.mock.calls.length;
    fireEvent.keyDown(filter, { key: 'Escape' });
    expect(close).toHaveBeenCalledTimes(closed + 1);
  });

  it('adds a From-To column the picker has not seen', () => {
    const { added } = setup();
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter fields' }), { target: { value: 'Asset Tag' } });
    const free = screen.getAllByRole('option').find((o) => o.textContent?.includes('From-To column “Asset Tag”'))!;
    fireEvent.click(free);
    expect(added()).toMatchObject({ type: 'field', field: 'ft:Asset Tag', display: 'text' });
  });

  it('offers no From-To columns on a container label', () => {
    setup({ labelType: 'container', fields: { groups: FIELDS.groups.slice(3), ft_headers: [] } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter fields' }), { target: { value: 'Asset Tag' } });
    expect(screen.queryByText(/From-To column/)).toBeNull();
  });
});
