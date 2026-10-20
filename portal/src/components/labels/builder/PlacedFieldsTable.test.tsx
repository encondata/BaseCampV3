// @vitest-environment jsdom
/**
 * The placed-fields table under the canvas: one row per placement with
 * Split pieces nested under one parent row, selection shared with the
 * canvas, Tab / ⇧Tab stepping, and the per-placement controls (display,
 * bold, inverted, expected length, max characters with trim, strip) that
 * keep a text field's width its reserved width.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { reservedWidthIn } from '../../../labels/builder/metrics';
import type { DesignV2, FieldElement } from '../../../labels/builder/model';
import { FAKE_METRICS, FIELDS, SAMPLES, VEGAS, elementOf, fakeMetricsFor } from './builderTestKit';
import PlacedFieldsTable, { type PlacedFieldsTableProps } from './PlacedFieldsTable';

afterEach(cleanup);

function setup(props: Partial<PlacedFieldsTableProps> = {}) {
  const change = vi.fn<(d: DesignV2) => void>();
  const select = vi.fn<(ids: string[]) => void>();
  function Harness() {
    const [design, setDesign] = useState<DesignV2>(props.design ?? VEGAS());
    const [selection, setSelection] = useState<string[]>([...(props.selection ?? [])]);
    return (
      <PlacedFieldsTable fields={FIELDS} samples={SAMPLES} metricsFor={fakeMetricsFor} {...props}
        design={design} selection={selection}
        onChange={(d) => { change(d); setDesign(d); }}
        onSelect={(ids) => { select(ids); setSelection(ids); }} />
    );
  }
  const utils = render(<Harness />);
  const last = () => change.mock.calls.at(-1)![0];
  return { ...utils, change, select, last };
}

const bodyRows = () => Array.from(document.querySelectorAll('tbody tr')) as HTMLTableRowElement[];
const label = (tr: HTMLTableRowElement) => tr.cells[0].textContent?.replace('└', '').trim();
const rowFor = (text: string, nth = 0) => bodyRows().filter((tr) => label(tr) === text)[nth];

describe('PlacedFieldsTable', () => {
  it('has one row per placement, the Split pieces nested under one parent row', () => {
    setup();
    const heads = Array.from(document.querySelectorAll('thead th')).map((th) => th.textContent);
    expect(heads).toEqual(['Field', 'Display', 'Font', 'B', 'Inv', 'Expected', 'Max', 'Trim', 'Strip']);
    expect(bodyRows().map(label)).toEqual([
      'Destination rack', 'NAP', 'Sector', 'POD', 'Row', 'Rack', 'NAP', 'Sector', 'POD', 'Row', 'Rack',
      'Destination RU', 'Asset name', 'Serial number', 'Make + model', 'Destination RU',
      'Asset ID', 'Asset ID', 'Origin site code', 'Move date',
    ]);
    const parent = rowFor('Destination rack');
    expect(parent.className).toContain('is-split');
    expect(parent.cells[1].textContent).toBe('Split');
    expect(rowFor('POD').className).toContain('is-piece');
    // static text and the rule are not fields
    expect(rowFor('Name:')).toBeUndefined();
    expect(rowFor('Asset ID').cells[1].textContent).toBe('Barcode');
    expect(rowFor('Asset ID', 1).cells[1].textContent).toBe('QR code');
    expect(rowFor('Asset name').cells[2].textContent).toBe('Swiss 721 Cond. Bold');
  });

  it('selects with the canvas: a click picks a row, ⇧ adds, the parent picks every piece', () => {
    const { select } = setup({ selection: ['grid-pod'] });
    expect(rowFor('POD', 1).getAttribute('aria-selected')).toBe('true');
    expect(rowFor('POD', 0).getAttribute('aria-selected')).toBe('false');
    fireEvent.click(rowFor('Asset name').cells[0]);
    expect(select).toHaveBeenLastCalledWith(['value-name']);
    expect(rowFor('Asset name').getAttribute('aria-selected')).toBe('true');
    fireEvent.click(rowFor('Serial number').cells[0], { shiftKey: true });
    expect(select).toHaveBeenLastCalledWith(['value-name', 'value-serial']);
    fireEvent.click(rowFor('Asset name').cells[0], { metaKey: true });
    expect(select).toHaveBeenLastCalledWith(['value-serial']);
    fireEvent.click(rowFor('Destination rack').cells[0]);
    expect(select).toHaveBeenLastCalledWith([
      'banner-nap', 'banner-sector', 'banner-pod', 'banner-row', 'banner-rack',
      'grid-nap', 'grid-sector', 'grid-pod', 'grid-row', 'grid-rack']);
    expect(rowFor('Destination rack').getAttribute('aria-selected')).toBe('true');
  });

  it('Tab and ⇧Tab step through the placements while the table has focus; Tab past the last leaves', () => {
    const { select } = setup({ selection: ['value-name'] });
    const table = screen.getByRole('region', { name: 'Fields on this label' });
    table.focus();
    fireEvent.keyDown(table, { key: 'Tab' });
    expect(select).toHaveBeenLastCalledWith(['value-serial']);
    fireEvent.keyDown(table, { key: 'Tab', shiftKey: true });
    fireEvent.keyDown(table, { key: 'Tab', shiftKey: true });
    expect(select).toHaveBeenLastCalledWith(['banner-ru']);
    fireEvent.keyDown(table, { key: 'ArrowDown' });
    expect(select).toHaveBeenLastCalledWith(['value-name']);
    fireEvent.click(rowFor('Move date').cells[0]);
    const calls = select.mock.calls.length;
    expect(fireEvent.keyDown(table, { key: 'Tab' })).toBe(true);   // not prevented: focus moves on
    expect(select).toHaveBeenCalledTimes(calls);
  });

  it('B and Inv keep a field as wide as it reserves', () => {
    const { last } = setup();
    fireEvent.click(within(rowFor('NAP')).getByRole('button', { name: 'Bold' }));
    let nap = elementOf(last(), 'banner-nap') as FieldElement;
    expect(nap.font).toEqual({ family: 'swiss721-cond-bold', weight: 'bold' });
    expect(nap.w).toBeCloseTo(reservedWidthIn(FAKE_METRICS, 24, 2, 'text')!);
    expect(nap.w).toBeCloseTo(0.3);
    fireEvent.click(within(rowFor('NAP')).getByRole('button', { name: 'Inverted' }));
    nap = elementOf(last(), 'banner-nap') as FieldElement;
    // faux Bold on an inverted single-cut family widens the glyphs 15%
    expect(nap.inverted).toBe(true);
    expect(nap.w).toBeCloseTo(0.3 * 1.15);
    expect(within(rowFor('NAP')).getByRole('button', { name: 'Inverted' }).getAttribute('aria-pressed')).toBe('true');
  });

  it('edits expected length, display, max with trim, and strip', () => {
    const { last } = setup();
    const name = () => elementOf(last(), 'value-name') as FieldElement;
    const expected = within(rowFor('Asset name')).getByRole('textbox', { name: 'Expected length' });
    fireEvent.change(expected, { target: { value: '10' } });
    fireEvent.keyDown(expected, { key: 'Enter' });
    expect(name().expectedLength).toBe(10);
    expect(name().w).toBeCloseTo(10 * 450 * (8.4 / 72 / 1000));

    fireEvent.click(within(rowFor('Asset name')).getByRole('combobox', { name: 'Display' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Number' }));
    expect(name().display).toBe('number');
    // a number reserves the widest digit
    expect(name().w).toBeCloseTo(10 * 400 * (8.4 / 72 / 1000));

    expect(within(rowFor('Asset name')).queryByRole('combobox', { name: 'Trim' })).toBeNull();
    const max = within(rowFor('Asset name')).getByRole('textbox', { name: 'Max characters' });
    fireEvent.change(max, { target: { value: '5' } });
    fireEvent.blur(max);
    expect(name()).toMatchObject({ maxChars: 5, trim: 'rear' });
    fireEvent.click(within(rowFor('Asset name')).getByRole('combobox', { name: 'Trim' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Front' }));
    expect(name().trim).toBe('front');

    const strip = within(rowFor('Destination RU', 1)).getByRole('textbox', { name: 'Strip' });
    fireEvent.change(strip, { target: { value: '0' } });
    fireEvent.blur(strip);
    expect(elementOf(last(), 'grid-ru')).toMatchObject({ strip: '0', stripWhere: 'front' });
    fireEvent.click(within(rowFor('Destination RU', 1)).getByRole('combobox', { name: 'Strip from' }));
    fireEvent.mouseDown(screen.getByRole('button', { name: 'Anywhere' }));
    expect(elementOf(last(), 'grid-ru')).toMatchObject({ strip: '0', stripWhere: 'anywhere' });
  });

  it('read-only: rows still select, nothing edits', () => {
    const { select } = setup({ readOnly: true });
    expect((within(rowFor('NAP')).getByRole('button', { name: 'Bold' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(rowFor('Asset name')).getByRole('textbox', { name: 'Expected length' }) as HTMLInputElement).disabled)
      .toBe(true);
    fireEvent.click(rowFor('Asset name').cells[0]);
    expect(select).toHaveBeenLastCalledWith(['value-name']);
  });
});
