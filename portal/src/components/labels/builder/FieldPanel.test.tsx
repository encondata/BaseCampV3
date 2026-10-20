// @vitest-environment jsdom
/**
 * The field panel: only the fields on the label, grouped in catalog order
 * with how many times each is placed and its sample, Split pieces nested
 * under their field, a remove × on each row, samples edited in place, and
 * the search box and + that open the picker (the whole catalog).
 */

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesignV2 } from '../../../labels/builder/model';
import type { LabelFields } from '../../../lib/api';
import { FIELDS, SAMPLES, VEGAS, fakeMetricsFor, vegasWith } from './builderTestKit';
import FieldPanel, { type FieldPanelHandle, type FieldPanelProps } from './FieldPanel';

afterEach(cleanup);

function setup(props: Partial<FieldPanelProps> = {}) {
  // the design and selection start from props and then follow the panel's changes
  const { design: _design, selection: _selection, ...rest } = props;
  const change = vi.fn<(d: DesignV2) => void>();
  const select = vi.fn<(ids: string[]) => void>();
  const onSamples = vi.fn<(s: Record<string, string>) => void>();
  const removed = vi.fn<(count: number, name: string) => void>();
  const ref = createRef<FieldPanelHandle>();
  function Harness() {
    const [design, setDesign] = useState<DesignV2>(props.design ?? VEGAS());
    const [samples, setSamples] = useState<Record<string, string>>({ ...SAMPLES });
    const [selection, setSelection] = useState<readonly string[]>(props.selection ?? []);
    return (
      <FieldPanel ref={ref} fields={FIELDS} design={design} samples={samples} metricsFor={fakeMetricsFor}
        labelType="top" selection={selection}
        onChange={(d) => { change(d); setDesign(d); }}
        onSelect={(ids) => { select(ids); setSelection(ids); }}
        onSamples={(s) => { onSamples(s); setSamples(s); }}
        onRemoved={removed}
        {...rest} />
    );
  }
  const utils = render(<Harness />);
  return { ...utils, change, select, onSamples, removed, ref };
}

const picker = () => screen.queryByRole('dialog', { name: 'Add to the label' });
const pickNames = () => screen.getAllByRole('option').map((o) => o.querySelector('.lbp-pick-name')?.textContent);
const search = () => screen.getByRole('combobox', { name: 'Search fields' }) as HTMLInputElement;

/** The names in a group, top to bottom (Split pieces left out). */
function names(group: string): string[] {
  const section = screen.getByRole('group', { name: group });
  return Array.from(section.querySelectorAll('.lbp-field:not(.is-piece) .lbp-field-name')).map((n) => n.textContent ?? '');
}

function fieldItem(name: string): HTMLElement {
  const btn = screen.getAllByRole('button', { name: `Add ${name} to the label` })[0];
  return btn.closest('.lbp-field') as HTMLElement;
}

describe('FieldPanel', () => {
  it('lists only the fields on the label, in catalog order, with ×n', () => {
    setup();
    // no RFID tag, Source rack or From-To column: none is placed
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label')))
      .toEqual(['Asset', 'Make & model', 'On this move', 'Move', 'Sites']);
    expect(names('Asset')).toEqual(['Asset ID', 'Asset name', 'Serial number']);
    expect(names('On this move')).toEqual(['Destination rack', 'Destination RU']);
    expect(screen.queryByRole('button', { name: 'Add RFID tag to the label' })).toBeNull();
    // the barcode and the QR code both print the Asset ID
    expect(within(fieldItem('Asset ID')).getByRole('button', { name: /2 placements/ }).textContent).toBe('×2');
    expect(within(fieldItem('Asset name')).getByRole('button', { name: /1 placement/ }).textContent).toBe('×1');
    expect(within(fieldItem('Destination rack')).getByRole('button', { name: /10 placements/ })).toBeTruthy();
    expect(within(fieldItem('Destination rack')).getByRole('button', { name: /Edit the sample/ }).textContent)
      .toBe('14.01.07C.02.03');
  });

  it('nests only the placed Split pieces under their field, with counts and sample pieces', () => {
    setup({ design: vegasWith('banner-nap', 'banner-pod', 'grid-pod') });
    const pieces = Array.from(fieldItem('Destination rack').parentElement!.querySelectorAll('.lbp-field.is-piece'));
    expect(pieces.map((p) => p.querySelector('.lbp-field-name')?.textContent)).toEqual(['NAP', 'POD']);
    expect(pieces.map((p) => p.querySelector('.lbp-sample')?.textContent)).toEqual(['14', '07C']);
    expect(pieces.map((p) => p.querySelector('.lbp-count')?.textContent)).toEqual(['×1', '×2']);
    expect(within(fieldItem('Destination rack')).getByRole('button', { name: /3 placements/ })).toBeTruthy();
  });

  it('a placed From-To column is listed under From-To columns', () => {
    const d = VEGAS();
    const ft = { ...d.elements.find((e) => e.id === 'value-name')!, id: 'ft-1', field: 'ft:Notes' } as DesignV2['elements'][number];
    setup({ design: { ...d, elements: [...d.elements, ft] } });
    expect(names('From-To columns')).toEqual(['Notes']);
  });

  it('a click on a name adds another placement; on ×n selects the placements', () => {
    const { change, select } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add Serial number to the label' }));
    const added = change.mock.calls[0][0].elements.at(-1)!;
    expect(added).toMatchObject({ type: 'field', field: 'serial_number', display: 'text' });
    expect(select).toHaveBeenLastCalledWith([added.id]);

    fireEvent.click(within(fieldItem('Asset ID')).getByRole('button', { name: /2 placements/ }));
    expect(select).toHaveBeenLastCalledWith(['barcode', 'qr']);
    fireEvent.click(screen.getByRole('button', { name: 'Add POD to the label' }));
    expect(change.mock.calls.at(-1)![0].elements.at(-1)).toMatchObject({ field: 'destination_rack', piece: 2 });
  });

  it('removes every placement of a field in one change and drops them from the selection', () => {
    const { change, select, removed } = setup({ selection: ['grid-pod', 'value-name', 'banner-nap'] });
    fireEvent.click(screen.getByRole('button', { name: 'Remove Destination rack from the label' }));
    expect(change).toHaveBeenCalledTimes(1);
    const next = change.mock.calls[0][0];
    expect(next.elements.some((e) => 'field' in e && e.field === 'destination_rack')).toBe(false);
    expect(next.elements).toHaveLength(VEGAS().elements.length - 10);
    // its Split stays for the next placement
    expect(next.splits).toEqual(VEGAS().splits);
    expect(select).toHaveBeenLastCalledWith(['value-name']);
    expect(removed).toHaveBeenCalledWith(10, 'Destination rack');
    expect(screen.queryByRole('group', { name: 'On this move' })).toBeTruthy();
    expect(names('On this move')).toEqual(['Destination RU']);
  });

  it('removes one Split piece\'s placements, and a field bound to a barcode and a QR code', () => {
    const { change, removed } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Remove POD from the label' }));
    const next = change.mock.calls[0][0];
    expect(next.elements.map((e) => e.id)).not.toContain('banner-pod');
    expect(next.elements.map((e) => e.id)).not.toContain('grid-pod');
    expect(next.elements.filter((e) => 'field' in e && e.field === 'destination_rack')).toHaveLength(8);
    expect(removed).toHaveBeenLastCalledWith(2, 'POD');
    fireEvent.click(screen.getByRole('button', { name: 'Remove Asset ID from the label' }));
    expect(change.mock.calls.at(-1)![0].elements.map((e) => e.id)).not.toContain('barcode');
    expect(change.mock.calls.at(-1)![0].elements.map((e) => e.id)).not.toContain('qr');
    expect(removed).toHaveBeenLastCalledWith(2, 'Asset ID');
  });

  it('after a ×, focus goes to the next row\'s ×, else the one before, else the search box', () => {
    const removes = () => Array.from(document.querySelectorAll<HTMLButtonElement>('button.lbp-remove'));
    const labels = () => removes().map((b) => b.getAttribute('aria-label'));
    const press = (label: string) => {
      const button = removes().find((b) => b.getAttribute('aria-label') === label)!;
      button.focus();
      fireEvent.click(button);
    };
    setup();
    const before = labels();
    const at = before.indexOf('Remove Asset name from the label');
    expect(at).toBeGreaterThanOrEqual(0);
    press('Remove Asset name from the label');
    expect(document.activeElement?.getAttribute('aria-label')).toBe(before[at + 1]);
    // the last row: the one before it
    const rest = labels();
    press(rest.at(-1)!);
    expect(document.activeElement?.getAttribute('aria-label')).toBe(rest.at(-2));
    cleanup();

    // the only row: the search box
    const only = VEGAS();
    setup({ design: { ...only, elements: only.elements.filter((e) => e.id === 'value-name') } });
    press('Remove Asset name from the label');
    expect(screen.getByText('No fields on this label yet. Press + or / to add one.')).toBeTruthy();
    expect(document.activeElement).toBe(search());
  });

  it('with nothing placed, says how to add a field', () => {
    setup({ design: { schema: 2, size: { w: 4, h: 2 }, splits: {}, elements: [] } });
    expect(screen.getByText('No fields on this label yet. Press + or / to add one.')).toBeTruthy();
    expect(screen.queryAllByRole('group')).toHaveLength(0);
  });

  it('edits a sample in place: Enter keeps it, Escape drops the edit', () => {
    const { onSamples } = setup();
    fireEvent.click(within(fieldItem('Serial number')).getByRole('button', { name: /Edit the sample/ }));
    const box = screen.getByRole('textbox', { name: 'Serial number sample' });
    fireEvent.change(box, { target: { value: 'SN-42' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSamples).toHaveBeenLastCalledWith({ ...SAMPLES, serial_number: 'SN-42' });

    fireEvent.click(within(fieldItem('Asset name')).getByRole('button', { name: /Edit the sample/ }));
    const name = screen.getByRole('textbox', { name: 'Asset name sample' });
    fireEvent.change(name, { target: { value: 'nope' } });
    fireEvent.keyDown(name, { key: 'Escape' });
    expect(onSamples).toHaveBeenCalledTimes(1);
    expect(within(fieldItem('Asset name')).getByRole('button', { name: /Edit the sample/ }).textContent)
      .toBe('lvn-hm1w2-vc1-c1n7');
  });

  it('/ (focusSearch) focuses the search and opens the picker, which the search filters', () => {
    const { ref } = setup();
    expect(picker()).toBeNull();
    act(() => ref.current!.focusSearch());
    expect(document.activeElement).toBe(search());
    expect(picker()).toBeTruthy();
    expect(search().getAttribute('aria-expanded')).toBe('true');
    // the whole catalog: unused fields too, placed ones last
    expect(pickNames()).toContain('RFID tag');
    fireEvent.change(search(), { target: { value: 'rack' } });
    expect(pickNames()).toEqual(['Source rack', 'Destination rack', 'NAP', 'Sector', 'POD', 'Row', 'Rack',
      'From-To column “rack”']);
    // the list itself is not filtered
    expect(names('Asset')).toEqual(['Asset ID', 'Asset name', 'Serial number']);
  });

  it('typing in the search opens the picker; arrows and Enter pick; Escape closes and clears', () => {
    const { change, select } = setup();
    search().focus();
    fireEvent.change(search(), { target: { value: 'rfid' } });
    expect(picker()).toBeTruthy();
    expect(pickNames()).toEqual(['RFID tag', 'From-To column “rfid”']);
    const active = () => document.getElementById(search().getAttribute('aria-activedescendant') ?? '');
    expect(active()?.textContent).toContain('RFID tag');
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(picker()).toBeNull();
    expect(search().value).toBe('');
    expect(document.activeElement).toBe(search());   // the search box keeps the cursor

    fireEvent.change(search(), { target: { value: 'line' } });
    fireEvent.keyDown(search(), { key: 'Enter' });
    expect(change.mock.calls.at(-1)![0].elements.at(-1)).toMatchObject({ type: 'line' });
    expect(select).toHaveBeenCalled();
    expect(picker()).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add to the label' }));
    expect(search().value).toBe('');

    // ↓ opens it again from the keyboard, then moves through the options
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(picker()).toBeTruthy();
    fireEvent.keyDown(search(), { key: 'ArrowDown' });
    expect(active()?.textContent).toContain('Line');
  });

  it('Escape puts the cursor back in the search box, wherever the picker had it', () => {
    setup();
    fireEvent.change(search(), { target: { value: 'rack' } });
    expect(picker()).toBeTruthy();
    expect(document.activeElement).not.toBe(search());
    fireEvent.keyDown(search(), { key: 'Escape' });
    expect(picker()).toBeNull();
    expect(document.activeElement).toBe(search());
  });

  it('Tab closes the picker and moves on as usual', () => {
    setup();
    search().focus();
    fireEvent.change(search(), { target: { value: 'rack' } });
    expect(picker()).toBeTruthy();
    // not prevented: the browser moves focus on from the search box
    expect(fireEvent.keyDown(search(), { key: 'Tab' })).toBe(true);
    expect(picker()).toBeNull();
    expect(search().value).toBe('');
  });

  it('+ opens the picker with the cursor in the search; + again closes it', () => {
    setup();
    const plus = screen.getByRole('button', { name: 'Add to the label' });
    fireEvent.click(plus);
    expect(picker()).toBeTruthy();
    expect(document.activeElement).toBe(search());
    fireEvent.click(plus);
    expect(picker()).toBeNull();
  });

  it('Load from asset… is offered on asset labels only', () => {
    const load = vi.fn();
    const { rerender } = render(
      <FieldPanel fields={FIELDS} design={VEGAS()} samples={SAMPLES} metricsFor={fakeMetricsFor} labelType="top"
        onChange={vi.fn()} onSelect={vi.fn()} onSamples={vi.fn()} onLoadFromAsset={load} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Load from asset…' }));
    expect(load).toHaveBeenCalledTimes(1);
    const containerFields: LabelFields = { groups: FIELDS.groups.slice(3), ft_headers: [] };
    rerender(
      <FieldPanel fields={containerFields} design={VEGAS()} samples={SAMPLES} metricsFor={fakeMetricsFor}
        labelType="container" onChange={vi.fn()} onSelect={vi.fn()} onSamples={vi.fn()} onLoadFromAsset={load} />,
    );
    expect(screen.queryByRole('button', { name: 'Load from asset…' })).toBeNull();
  });

  it('read-only: no adding, no removing and no editing', () => {
    setup({ readOnly: true });
    expect((screen.getByRole('button', { name: 'Add to the label' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add Serial number to the label' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /^Remove / })).toBeNull();
    expect((within(fieldItem('Serial number')).getByRole('button', { name: /Edit the sample/ }) as HTMLButtonElement).disabled)
      .toBe(true);
    fireEvent.change(search(), { target: { value: 'rack' } });
    expect(picker()).toBeNull();
  });
});

describe('a DPI child', () => {
  it('shows the parent template’s samples read-only', () => {
    const onLoadFromAsset = vi.fn();
    setup({ samplesFromParent: true, onLoadFromAsset });
    const sample = screen.getByRole('button', { name: 'Edit the sample of Serial number' }) as HTMLButtonElement;
    expect(sample.disabled).toBe(true);
    expect(sample.textContent).toBe('36B7144');
    expect((screen.getByRole('button', { name: 'Load from asset…' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('Samples belong to the parent template.')).toBeTruthy();
    // placing and removing a field still work
    expect((screen.getByRole('button', { name: 'Add to the label' }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole('button', { name: 'Add Serial number to the label' }) as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByRole('button', { name: 'Remove Serial number from the label' })).toBeTruthy();
  });
});
