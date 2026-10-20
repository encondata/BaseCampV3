// @vitest-environment jsdom
/**
 * The field panel: the catalog's groups with each field's sample, unused
 * fields first and placed ones last in grey with how many times they're on
 * the label, Split pieces nested under their field, the search `/` focuses,
 * samples edited in place, and the + that opens the picker.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { createRef, useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DesignV2 } from '../../../labels/builder/model';
import type { LabelFields } from '../../../lib/api';
import { FIELDS, SAMPLES, VEGAS, fakeMetricsFor } from './builderTestKit';
import FieldPanel, { type FieldPanelHandle, type FieldPanelProps } from './FieldPanel';

afterEach(cleanup);

function setup(props: Partial<FieldPanelProps> = {}) {
  const change = vi.fn<(d: DesignV2) => void>();
  const select = vi.fn<(ids: string[]) => void>();
  const onSamples = vi.fn<(s: Record<string, string>) => void>();
  const ref = createRef<FieldPanelHandle>();
  function Harness() {
    const [design, setDesign] = useState<DesignV2>(props.design ?? VEGAS());
    const [samples, setSamples] = useState<Record<string, string>>({ ...SAMPLES });
    return (
      <FieldPanel ref={ref} fields={FIELDS} design={design} samples={samples} metricsFor={fakeMetricsFor}
        labelType="top"
        onChange={(d) => { change(d); setDesign(d); }}
        onSelect={select}
        onSamples={(s) => { onSamples(s); setSamples(s); }}
        {...props} />
    );
  }
  const utils = render(<Harness />);
  return { ...utils, change, select, onSamples, ref };
}

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
  it('lists unused fields first, then placed ones greyed with ×n, in catalog order', () => {
    setup();
    expect(names('Asset')).toEqual(['RFID tag', 'Asset ID', 'Asset name', 'Serial number']);
    expect(fieldItem('RFID tag').className).not.toContain('is-used');
    const id = fieldItem('Asset ID');
    expect(id.className).toContain('is-used');
    // the barcode and the QR code both print the Asset ID
    expect(within(id).getByRole('button', { name: /2 placements/ }).textContent).toBe('×2');
    expect(within(fieldItem('Asset name')).getByRole('button', { name: /1 placement/ }).textContent).toBe('×1');
    expect(names('On this move')).toEqual(['Source rack', 'Destination rack', 'Destination RU']);
    expect(within(fieldItem('Destination rack')).getByRole('button', { name: /10 placements/ })).toBeTruthy();
  });

  it('shows each sample, and From-To columns after the catalog', () => {
    setup();
    expect(within(fieldItem('Destination rack')).getByRole('button', { name: /Edit the sample/ }).textContent)
      .toBe('14.01.07C.02.03');
    const groups = screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Asset', 'Make & model', 'On this move', 'Move', 'Sites', 'From-To columns']);
    expect(names('From-To columns')).toEqual(['Data 2', 'Data 10', 'Notes']);
  });

  it('nests Split pieces under their field with their own counts and sample pieces', () => {
    setup();
    const pieces = Array.from(fieldItem('Destination rack').parentElement!.querySelectorAll('.lbp-field.is-piece'));
    expect(pieces.map((p) => p.querySelector('.lbp-field-name')?.textContent)).toEqual(['NAP', 'Sector', 'POD', 'Row', 'Rack']);
    expect(pieces.map((p) => p.querySelector('.lbp-sample')?.textContent)).toEqual(['14', '01', '07C', '02', '03']);
    expect(pieces.map((p) => p.querySelector('.lbp-count')?.textContent)).toEqual(['×2', '×2', '×2', '×2', '×2']);
  });

  it('a click on a name adds a placement; on ×n selects the placements', () => {
    const { change, select } = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Add RFID tag to the label' }));
    const added = change.mock.calls[0][0].elements.at(-1)!;
    expect(added).toMatchObject({ type: 'field', field: 'rfid_tag', display: 'text' });
    expect(select).toHaveBeenLastCalledWith([added.id]);

    fireEvent.click(within(fieldItem('Asset ID')).getByRole('button', { name: /2 placements/ }));
    expect(select).toHaveBeenLastCalledWith(['barcode', 'qr']);
    fireEvent.click(screen.getByRole('button', { name: 'Add POD to the label' }));
    expect(change.mock.calls.at(-1)![0].elements.at(-1)).toMatchObject({ field: 'destination_rack', piece: 2 });
  });

  it('edits a sample in place: Enter keeps it, Escape drops the edit', () => {
    const { onSamples } = setup();
    fireEvent.click(within(fieldItem('RFID tag')).getByRole('button', { name: /Edit the sample/ }));
    const box = screen.getByRole('textbox', { name: 'RFID tag sample' });
    fireEvent.change(box, { target: { value: '000000000000000000700022' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSamples).toHaveBeenLastCalledWith({ ...SAMPLES, rfid_tag: '000000000000000000700022' });

    fireEvent.click(within(fieldItem('Asset name')).getByRole('button', { name: /Edit the sample/ }));
    const name = screen.getByRole('textbox', { name: 'Asset name sample' });
    fireEvent.change(name, { target: { value: 'nope' } });
    fireEvent.keyDown(name, { key: 'Escape' });
    expect(onSamples).toHaveBeenCalledTimes(1);
    expect(within(fieldItem('Asset name')).getByRole('button', { name: /Edit the sample/ }).textContent)
      .toBe('lvn-hm1w2-vc1-c1n7');
  });

  it('focusSearch() focuses the search, which filters every group', () => {
    const { ref } = setup();
    ref.current!.focusSearch();
    const search = screen.getByRole('searchbox', { name: 'Search fields' });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: 'rack' } });
    expect(screen.getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['On this move']);
    expect(names('On this move')).toEqual(['Source rack', 'Destination rack']);
  });

  it('+ opens the picker; Load from asset… is offered on asset labels only', () => {
    const load = vi.fn();
    const { rerender } = render(
      <FieldPanel fields={FIELDS} design={VEGAS()} samples={SAMPLES} metricsFor={fakeMetricsFor} labelType="top"
        onChange={vi.fn()} onSelect={vi.fn()} onSamples={vi.fn()} onLoadFromAsset={load} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Add to the label' }));
    expect(screen.getByRole('dialog', { name: 'Add to the label' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Load from asset…' }));
    expect(load).toHaveBeenCalledTimes(1);
    const containerFields: LabelFields = { groups: FIELDS.groups.slice(3), ft_headers: [] };
    rerender(
      <FieldPanel fields={containerFields} design={VEGAS()} samples={SAMPLES} metricsFor={fakeMetricsFor}
        labelType="container" onChange={vi.fn()} onSelect={vi.fn()} onSamples={vi.fn()} onLoadFromAsset={load} />,
    );
    expect(screen.queryByRole('button', { name: 'Load from asset…' })).toBeNull();
  });

  it('closing the picker puts focus back on the +; Tab then moves on from it', () => {
    const { change } = setup();
    const plus = screen.getByRole('button', { name: 'Add to the label' });
    fireEvent.click(plus);
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Filter fields' }), { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Add to the label' })).toBeNull();
    expect(document.activeElement).toBe(plus);
    fireEvent.click(plus);
    expect(fireEvent.keyDown(screen.getByRole('combobox', { name: 'Filter fields' }), { key: 'Tab' })).toBe(true);
    expect(document.activeElement).toBe(plus);
    fireEvent.click(plus);
    fireEvent.change(screen.getByRole('combobox', { name: 'Filter fields' }), { target: { value: 'line' } });
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Filter fields' }), { key: 'Enter' });
    expect(change.mock.calls.at(-1)![0].elements.at(-1)).toMatchObject({ type: 'line' });
    expect(document.activeElement).toBe(plus);
  });

  it('read-only: no adding and no editing', () => {
    setup({ readOnly: true });
    expect((screen.getByRole('button', { name: 'Add to the label' }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Add RFID tag to the label' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(fieldItem('RFID tag')).getByRole('button', { name: /Edit the sample/ }) as HTMLButtonElement).disabled)
      .toBe(true);
  });
});
