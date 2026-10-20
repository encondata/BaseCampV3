// @vitest-environment jsdom
/**
 * The properties panel: every property of the selected element (or of the
 * last one picked, the change going to every selected element), with a
 * text field kept as wide as it reserves, and Split building its pieces
 * from the field's sample.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { textBoxFor } from '../../../labels/builder/metrics';
import { MAX_COUNT, MAX_LINES, validate, type DesignV2, type FieldElement } from '../../../labels/builder/model';
import { FAKE_METRICS, FIELDS, SAMPLES, VEGAS, elementOf, fakeMetricsFor } from './builderTestKit';
import PlacedFieldsTable from './PlacedFieldsTable';
import PropertiesPanel, { type PropertiesPanelProps } from './PropertiesPanel';

afterEach(cleanup);

const DPI = 300;

function setup({ design, selection, samples = SAMPLES, props = {} }: {
  design?: DesignV2; selection: string[]; samples?: Record<string, string>; props?: Partial<PropertiesPanelProps>;
}) {
  const change = vi.fn<(d: DesignV2) => void>();
  const select = vi.fn<(ids: string[]) => void>();
  function Harness() {
    const [d, setD] = useState<DesignV2>(design ?? VEGAS());
    const [sel, setSel] = useState<string[]>(selection);
    const onSelect = (ids: string[]) => { select(ids); setSel(ids); };
    const onChange = (next: DesignV2) => { change(next); setD(next); };
    return (
      <>
        <PropertiesPanel design={d} selection={sel} samples={samples} fields={FIELDS} dpi={DPI}
          metricsFor={fakeMetricsFor} onChange={onChange} onSelect={onSelect} {...props} />
        <PlacedFieldsTable design={d} selection={sel} samples={samples} fields={FIELDS}
          metricsFor={fakeMetricsFor} onChange={onChange} onSelect={onSelect} />
      </>
    );
  }
  const utils = render(<Harness />);
  const last = () => change.mock.calls.at(-1)![0];
  return { ...utils, change, select, last };
}

const panel = () => screen.getByRole('complementary', { name: 'Properties' });

function commit(name: string, value: string) {
  const box = within(panel()).getByRole('textbox', { name });
  fireEvent.change(box, { target: { value } });
  fireEvent.keyDown(box, { key: 'Enter' });
}

const press = (name: string) => fireEvent.click(within(panel()).getByRole('button', { name }));

/** A design holding one whole Destination rack placement. */
function oneRack(): DesignV2 {
  return {
    schema: 2, size: { w: 4, h: 2 }, splits: {},
    elements: [{
      id: 'rack', type: 'field', field: 'destination_rack', display: 'text', x: 0.1, y: 0.1, w: 1.5, h: 0.25,
      rotation: 0, font: { family: 'swiss721-cond-bold', weight: 'regular' }, sizePt: 18, baselineIn: 0.1875,
      align: 'left', inverted: true,
    }],
  };
}

describe('PropertiesPanel', () => {
  it('shows nothing to edit without a selection', () => {
    setup({ selection: [] });
    expect(within(panel()).getByText(/Select something on the label/)).toBeTruthy();
  });

  it('edits patch the selected element; size refits the box, position is in dots', () => {
    const { last } = setup({ selection: ['value-name'] });
    expect(within(panel()).getByRole('heading').textContent).toBe('Asset name');
    expect((within(panel()).getByRole('textbox', { name: 'X' }) as HTMLInputElement).value).toBe('185');
    commit('Size (pt)', '12');
    const el = elementOf(last(), 'value-name') as FieldElement;
    const box = textBoxFor(FAKE_METRICS, 12);
    expect(el).toMatchObject({ sizePt: 12, h: box.h, baselineIn: box.baselineIn });
    // no expected length: the width scales with the size
    expect(el.w).toBeCloseTo(2.6667 * (12 / 8.4));
    press('Center');
    expect(elementOf(last(), 'value-name')).toMatchObject({ align: 'center' });
    commit('X', '+15');
    expect(elementOf(last(), 'value-name').x).toBeCloseTo(200 / DPI);
    commit('Expected length', '6');
    expect(elementOf(last(), 'value-name').w).toBeCloseTo(6 * 450 * (12 / 72 / 1000));
  });

  it('W and H resize as a handle drag does: a text height sets its font size', () => {
    const { last } = setup({ selection: ['value-name'] });
    commit('H', '50');
    const el = elementOf(last(), 'value-name') as FieldElement;
    expect(el.sizePt).toBeCloseTo(12);
    expect(el.h).toBeCloseTo(50 / DPI);
    commit('W', '600');
    expect(elementOf(last(), 'value-name').w).toBeCloseTo(2);
  });

  it('display type Split builds the pieces from the sample: 14.01.07C.02.03 → 5 rows', () => {
    const { last, select } = setup({ design: oneRack(), selection: ['rack'] });
    press('Split');
    const d = last();
    expect(d.splits).toEqual({ destination_rack: { pieces: ['Piece 1', 'Piece 2', 'Piece 3', 'Piece 4', 'Piece 5'] } });
    expect(d.elements.map((e) => (e as FieldElement).piece)).toEqual([0, 1, 2, 3, 4]);
    expect(d.elements.every((e) => e.type === 'field' && e.field === 'destination_rack' && e.display === 'text'
      && e.sizePt === 18 && e.inverted === true)).toBe(true);
    // left to right from where the field was
    const xs = d.elements.map((e) => e.x);
    expect(xs[0]).toBeCloseTo(0.1);
    expect([...xs].every((x, i) => i === 0 || x > xs[i - 1])).toBe(true);
    expect(select).toHaveBeenLastCalledWith(d.elements.map((e) => e.id));
    const rows = Array.from(document.querySelectorAll('tbody tr')).map((tr) => (tr as HTMLTableRowElement).cells[0]
      .textContent?.replace('└', '').trim());
    expect(rows).toEqual(['Destination rack', 'Piece 1', 'Piece 2', 'Piece 3', 'Piece 4', 'Piece 5']);
  });

  it('Split needs a sample with dots, and is not offered on a piece', () => {
    setup({ selection: ['value-name'] });
    expect((within(panel()).getByRole('button', { name: 'Split' }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    setup({ selection: ['grid-pod'] });
    expect(within(panel()).queryByRole('button', { name: 'Split' })).toBeNull();
  });

  it('renames a piece for every placement of it', () => {
    const { last } = setup({ selection: ['grid-pod'] });
    expect(within(panel()).getByText('Destination rack › piece 3')).toBeTruthy();
    commit('Name of this piece', 'Pod');
    expect(last().splits!.destination_rack.pieces).toEqual(['NAP', 'Sector', 'Pod', 'Row', 'Rack']);
  });

  it('with several selected, a change goes to all of them', () => {
    const { last } = setup({ selection: ['banner-nap', 'grid-pod'] });
    expect(within(panel()).getByText('2 selected')).toBeTruthy();
    press('Bold');
    const d = last();
    for (const id of ['banner-nap', 'grid-pod']) {
      expect((elementOf(d, id) as FieldElement).font).toEqual({ family: 'swiss721-cond-bold', weight: 'bold' });
    }
    // each keeps its own reserved width
    expect(elementOf(d, 'banner-nap').w).toBeCloseTo(2 * 450 * (24 / 72 / 1000));
    expect(elementOf(d, 'grid-pod').w).toBeCloseTo(3 * 450 * (8.4 / 72 / 1000));
  });

  it('typed arithmetic and steps act on each selected element; differing values show Mixed', () => {
    const { last } = setup({ selection: ['banner-nap', 'grid-pod'] });
    const x = within(panel()).getByRole('textbox', { name: 'X' }) as HTMLInputElement;
    expect(x.value).toBe('');
    expect(x.placeholder).toBe('Mixed');
    commit('X', '+15');
    // banner-nap sat at 10 dots, grid-pod at 185
    expect(elementOf(last(), 'banner-nap').x).toBeCloseTo(25 / DPI);
    expect(elementOf(last(), 'grid-pod').x).toBeCloseTo(200 / DPI);
    commit('Size (pt)', '*2');
    expect((elementOf(last(), 'banner-nap') as FieldElement).sizePt).toBeCloseTo(48);
    expect((elementOf(last(), 'grid-pod') as FieldElement).sizePt).toBeCloseTo(16.8);
    fireEvent.keyDown(within(panel()).getByRole('textbox', { name: 'Expected length' }), { key: 'ArrowUp' });
    expect((elementOf(last(), 'banner-nap') as FieldElement).expectedLength).toBe(3);
    expect((elementOf(last(), 'grid-pod') as FieldElement).expectedLength).toBe(4);
    // a plain number sets them all, and the box shows it again
    commit('Expected length', '2');
    expect((elementOf(last(), 'grid-pod') as FieldElement).expectedLength).toBe(2);
    expect((within(panel()).getByRole('textbox', { name: 'Expected length' }) as HTMLInputElement).value).toBe('2');
  });

  it('barcode settings reach only barcodes in a mixed selection; a placement shown as one takes them', () => {
    const mixedSel = setup({ selection: ['value-name', 'barcode'] });
    press('Code 39');
    expect(elementOf(mixedSel.last(), 'barcode')).toMatchObject({ symbology: 'code39' });
    expect('symbology' in elementOf(mixedSel.last(), 'value-name')).toBe(false);
    cleanup();
    const shown = setup({ selection: ['value-name'] });
    press('Barcode');
    expect(elementOf(shown.last(), 'value-name')).toMatchObject({ display: 'barcode', symbology: 'code128', showText: true });
  });

  it('Split pieces keep the lock of the placement they replace', () => {
    const design = oneRack();
    design.elements[0] = { ...design.elements[0], locked: true };
    const { last } = setup({ design, selection: ['rack'] });
    press('Split');
    expect(last().elements).toHaveLength(5);
    expect(last().elements.every((e) => e.locked === true)).toBe(true);
  });

  it('picks a font from the font list', () => {
    const { last } = setup({ selection: ['value-name'] });
    fireEvent.click(within(panel()).getByRole('button', { name: /^Font/ }));
    fireEvent.click(screen.getByRole('option', { name: /Roboto Mono/ }));
    expect((elementOf(last(), 'value-name') as FieldElement).font).toEqual({ family: 'roboto-mono', weight: 'regular' });
  });

  it('edits static text, a barcode and a box', () => {
    const { last } = setup({ selection: ['caption-name'] });
    const content = within(panel()).getByRole('textbox', { name: 'Content' });
    fireEvent.change(content, { target: { value: 'Host:' } });
    fireEvent.blur(content);
    expect(elementOf(last(), 'caption-name')).toMatchObject({ content: 'Host:' });
    cleanup();

    const barcode = setup({ selection: ['barcode'] });
    expect((within(panel()).getByRole('textbox', { name: 'Module width (dots)' }) as HTMLInputElement).value).toBe('4');
    press('Code 39');
    expect(elementOf(barcode.last(), 'barcode')).toMatchObject({ symbology: 'code39' });
    commit('Module width (dots)', '3');
    expect((elementOf(barcode.last(), 'barcode') as { moduleIn: number }).moduleIn).toBeCloseTo(3 / DPI);
    cleanup();

    const box = setup({
      design: { schema: 2, size: { w: 4, h: 2 }, elements: [
        { id: 'b', type: 'box', x: 0.1, y: 0.1, w: 1, h: 0.5, rotation: 0, strokeIn: 0.01 }] },
      selection: ['b'],
    });
    commit('Stroke (dots)', '6');
    expect(box.last().elements[0]).toMatchObject({ strokeIn: 6 / DPI });
    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Fill' }));
    expect(box.last().elements[0]).toMatchObject({ fill: true });
  });

  it('expected length and max characters stop at 64, lines at 50 (the API caps)', () => {
    const { last } = setup({ selection: ['value-name'] });
    commit('Expected length', '500');
    expect((elementOf(last(), 'value-name') as FieldElement).expectedLength).toBe(MAX_COUNT);
    commit('Max characters', '10*100');
    expect((elementOf(last(), 'value-name') as FieldElement).maxChars).toBe(MAX_COUNT);
    cleanup();

    const text = setup({ selection: ['caption-name'] });
    commit('Lines', '99');
    expect(elementOf(text.last(), 'caption-name')).toMatchObject({ lines: MAX_LINES });
    commit('Lines', '50');
    expect(validate(text.last())).toEqual([]);
  });

  it('read-only: everything shows, nothing edits', () => {
    setup({ selection: ['value-name'], props: { readOnly: true } });
    expect((within(panel()).getByRole('textbox', { name: 'Size (pt)' }) as HTMLInputElement).disabled).toBe(true);
    expect((within(panel()).getByRole('button', { name: 'Center' }) as HTMLButtonElement).disabled).toBe(true);
  });
});
