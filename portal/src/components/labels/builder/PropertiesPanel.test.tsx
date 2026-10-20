// @vitest-environment jsdom
/**
 * The properties panel: every property of the selected element (or of the
 * last one picked, the change going to every selected element), with a
 * text field kept as wide as it reserves, and Split building its pieces
 * from the field's sample.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { textBoxFor } from '../../../labels/builder/metrics';
import {
  MAX_COUNT, MAX_LINES, updateElement, validate, type DesignV2, type ElementV2, type FieldElement, type ImageElement,
  type TextElement,
} from '../../../labels/builder/model';
import type { LabelImage } from '../../../lib/api';
import { FAKE_METRICS, FIELDS, SAMPLES, VEGAS, elementOf, fakeMetricsFor } from './builderTestKit';
import PlacedFieldsTable from './PlacedFieldsTable';
import PropertiesPanel, { type PropertiesPanelProps } from './PropertiesPanel';

const api = vi.hoisted(() => ({ listLabelImages: vi.fn(), uploadLabelImage: vi.fn(), deleteLabelImage: vi.fn() }));
vi.mock('../../../lib/api', async (importActual) => ({
  ...(await importActual<typeof import('../../../lib/api')>()), ...api,
}));
const raster = vi.hoisted(() => ({ forgetStaticRaster: vi.fn() }));
vi.mock('./imageRaster', async (importActual) => ({
  ...(await importActual<typeof import('./imageRaster')>()), ...raster,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

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

  it('W and H resize as a handle drag does: a text height scales its font size', () => {
    const { last } = setup({ selection: ['value-name'] });
    // the Vegas box stops at the baseline (0.084 in at 8.4 pt): it scales
    // from its own height, 25.2 → 50 dots
    commit('H', '50');
    const el = elementOf(last(), 'value-name') as FieldElement;
    expect(el.sizePt).toBeCloseTo(8.4 * (50 / 25.2));
    expect(el.h).toBeCloseTo(50 / DPI);
    expect(el.baselineIn).toBeCloseTo(50 / DPI);
    commit('W', '600');
    expect(elementOf(last(), 'value-name').w).toBeCloseTo(2);
    // refit to one line of the font (a size change), the height sets the
    // size the font's line needs: 1 em at 12 pt is 50 dots
    commit('Size (pt)', '10');
    commit('H', '50');
    expect((elementOf(last(), 'value-name') as FieldElement).sizePt).toBeCloseTo(12);
  });

  it('W and H shrink a QR code as the side handles do (21 modules at 7 → 3, then 2)', () => {
    const { last } = setup({ selection: ['qr'] });
    expect((within(panel()).getByRole('textbox', { name: 'W' }) as HTMLInputElement).value).toBe('147');
    commit('W', '60');
    expect(elementOf(last(), 'qr')).toMatchObject({ w: 63 / DPI, h: 63 / DPI });
    commit('H', '42');
    expect(elementOf(last(), 'qr')).toMatchObject({ w: 42 / DPI, h: 42 / DPI });
    commit('W', '+105');
    expect(elementOf(last(), 'qr')).toMatchObject({ w: 147 / DPI, h: 147 / DPI });
  });

  it('warns when a QR code sits nearer the top edge than the printer can print it', () => {
    const warning = "Too close to the top edge: the printer can't print a QR code higher than 0.2 in from the top";
    setup({ selection: ['qr'] });
    expect(within(panel()).queryByText(warning)).toBeNull();
    commit('Y', '30');
    expect(within(panel()).getByText(warning)).toBeTruthy();
    commit('Y', '60');
    expect(within(panel()).queryByText(warning)).toBeNull();
  });

  it('warns for a field shown as a QR code too', () => {
    const d = VEGAS();
    const qrField = { ...elementOf(d, 'value-name'), display: 'qr', y: 0.05, w: 0.49, h: 0.49 } as FieldElement;
    setup({ design: { ...d, elements: d.elements.map((e) => (e.id === 'value-name' ? qrField : e)) },
      selection: ['value-name'] });
    expect(within(panel()).getByText(/Too close to the top edge/)).toBeTruthy();
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

  it('a barcode\'s width follows its data: W is read-only, Module sets it, H is the bar height', () => {
    // '10482' is five characters in subset B: 90 modules of 4 dots
    const { last } = setup({ selection: ['barcode'] });
    const box = (name: string) => within(panel()).getByRole('textbox', { name }) as HTMLInputElement;
    expect(box('W').value).toBe('360');
    expect(box('W').disabled).toBe(true);
    expect(within(panel()).getByText('Width follows the data: 5 characters → 360 dots at this DPI.')).toBeTruthy();
    commit('Module width (dots)', '3');
    const bc = elementOf(last(), 'barcode') as { moduleIn: number; w: number; h: number };
    expect(bc.moduleIn).toBeCloseTo(3 / DPI);
    expect(bc.w).toBeCloseTo(270 / DPI, 12);
    expect(box('W').value).toBe('270');
    expect(within(panel()).getByText('Width follows the data: 5 characters → 270 dots at this DPI.')).toBeTruthy();
    commit('H', '80');
    expect(elementOf(last(), 'barcode')).toMatchObject({ h: 80 / DPI, moduleIn: bc.moduleIn });
    // Code 39 counts its own modules: 16 × 7 − 1 = 111 of 3
    press('Code 39');
    expect(elementOf(last(), 'barcode').w).toBeCloseTo(333 / DPI, 12);
    cleanup();

    // turned, the length runs down the label: H is the read-only one
    const turned = updateElement(VEGAS(), 'barcode', { rotation: 90 });
    setup({ design: turned, selection: ['barcode'] });
    expect(box('H').value).toBe('360');
    expect(box('H').disabled).toBe(true);
    expect(box('W').disabled).toBe(false);
    cleanup();

    // no sample value: nothing prints yet
    setup({ selection: ['barcode'], samples: { ...SAMPLES, asset_id: '' } });
    expect(within(panel()).getByText('Width follows the data: no sample value, so nothing prints.')).toBeTruthy();
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

describe('PropertiesPanel: an image (ID badges)', () => {
  const LIBRARY: LabelImage[] = [
    { id: 'img-10', name: 'Logo 10', width: 400, height: 200, mime: 'image/png', created_at: '' },
    { id: 'img-2', name: 'Logo 2', width: 300, height: 100, mime: 'image/png', created_at: '' },
  ];

  beforeEach(() => {
    api.listLabelImages.mockResolvedValue(LIBRARY);
  });

  const photo = (over: Partial<ImageElement> = {}): ImageElement => ({
    id: 'image-1', type: 'image', source: 'photo', fit: 'cover', mode: 'dither', brightness: 0, contrast: 100,
    threshold: 128, invert: false, hideWhenEmpty: true, x: 0.1, y: 0.1, w: 0.8, h: 1, rotation: 0, ...over,
  });
  const caption: TextElement = {
    id: 'text-1', type: 'text', content: 'Crew', x: 1.2, y: 0.1, w: 0.5, h: 0.2, rotation: 0, sizePt: 12,
    baselineIn: 0.15, font: { family: 'swiss721-cond-bold', weight: 'regular' },
  };
  const badge = (...elements: ElementV2[]): DesignV2 => ({ schema: 3, size: { w: 3.375, h: 2.125 }, splits: {}, elements });
  const imageOf = (d: DesignV2) => elementOf(d, 'image-1') as ImageElement;
  const pressIn = (group: string, name: string) =>
    fireEvent.click(within(within(panel()).getByRole('group', { name: group })).getByRole('button', { name }));

  it('shows the image section on an ID badge: Source, Fit, Look, Brightness, Contrast, Invert', () => {
    setup({ design: badge(photo()), selection: ['image-1'], props: { imagesAllowed: true } });
    expect(within(panel()).getByRole('heading').textContent).toBe('Photo');
    const pressed = (group: string) => within(within(panel()).getByRole('group', { name: group }))
      .getAllByRole('button').filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.textContent);
    expect(pressed('Source')).toEqual(['Photo']);
    expect(pressed('Fit')).toEqual(['Fill']);
    expect(pressed('Look')).toEqual(['Photo']);
    expect((within(panel()).getByRole('textbox', { name: 'Brightness' }) as HTMLInputElement).value).toBe('0');
    expect((within(panel()).getByRole('textbox', { name: 'Contrast (%)' }) as HTMLInputElement).value).toBe('100');
    // a dithered photo has no threshold
    expect(within(panel()).queryByRole('textbox', { name: 'Threshold' })).toBeNull();
    expect(within(panel()).getByRole('checkbox', { name: 'Invert' })).toBeTruthy();
    expect((within(panel()).getByRole('checkbox', { name: 'Hide when empty' }) as HTMLInputElement).checked).toBe(true);
  });

  it('edits change only the images in a mixed selection', () => {
    const { last } = setup({ design: badge(caption, photo()), selection: ['text-1', 'image-1'],
      props: { imagesAllowed: true } });
    commit('Brightness', '0-25');
    commit('Contrast (%)', '140');
    fireEvent.click(within(panel()).getByRole('checkbox', { name: 'Invert' }));
    pressIn('Look', 'Logo');
    commit('Threshold', '90');
    expect(imageOf(last())).toMatchObject({ brightness: -25, contrast: 140, invert: true, mode: 'threshold', threshold: 90 });
    expect(elementOf(last(), 'text-1')).toEqual(caption);
    // a shared property still goes to both
    press('90°');
    expect(imageOf(last()).rotation).toBe(90);
    expect(elementOf(last(), 'text-1').rotation).toBe(90);
  });

  it('a minus in Brightness is a darker picture, not a subtraction', () => {
    const { last } = setup({ design: badge(photo({ brightness: 10 })), selection: ['image-1'], props: { imagesAllowed: true } });
    commit('Brightness', '-20');
    expect(imageOf(last()).brightness).toBe(-20);
    commit('Brightness', '500');
    expect(imageOf(last()).brightness).toBe(100);
  });

  it('switching the source takes its fit and look, and a logo’s box while the photo’s is untouched', () => {
    const { last } = setup({ design: badge(photo()), selection: ['image-1'], props: { imagesAllowed: true } });
    pressIn('Source', 'Logo');
    expect(imageOf(last())).toMatchObject({ source: 'logo', fit: 'contain', mode: 'threshold', w: 1, h: 0.5 });
    pressIn('Source', 'Static image');
    expect(imageOf(last())).toMatchObject({ source: 'static', fit: 'contain', mode: 'threshold', w: 1, h: 0.5 });
    pressIn('Source', 'Photo');
    expect(imageOf(last())).toMatchObject({ source: 'photo', fit: 'cover', mode: 'dither', w: 0.8, h: 1 });
    cleanup();
    // sized by hand: the box stays
    const resized = setup({ design: badge(photo({ w: 0.6, h: 0.6 })), selection: ['image-1'], props: { imagesAllowed: true } });
    pressIn('Source', 'Logo');
    expect(imageOf(resized.last())).toMatchObject({ source: 'logo', w: 0.6, h: 0.6 });
  });

  it('a static image picks from the label image library, natural order', async () => {
    const { last } = setup({ design: badge(photo({ source: 'static', fit: 'contain', mode: 'threshold' })),
      selection: ['image-1'], props: { imagesAllowed: true } });
    expect(within(panel()).getByRole('heading').textContent).toBe('Image');
    await waitFor(() => expect(api.listLabelImages).toHaveBeenCalledTimes(1));
    const pick = within(panel()).getByRole('combobox', { name: 'Static image' });
    fireEvent.focus(pick);
    fireEvent.click(pick);
    await waitFor(() => expect(document.querySelectorAll('.combo-menu .kbar-item')).toHaveLength(2));
    const options = [...document.querySelectorAll('.combo-menu .kbar-item')];
    expect(options.map((o) => o.textContent)).toEqual(['Logo 2300 × 100', 'Logo 10400 × 200']);
    fireEvent.mouseDown(options[1]);
    expect(imageOf(last()).imageId).toBe('img-10');
  });

  it('Upload… posts the file and picks it', async () => {
    const made: LabelImage = { id: 'img-new', name: 'Cumulus', width: 600, height: 200, mime: 'image/png', created_at: '' };
    api.uploadLabelImage.mockResolvedValue(made);
    const { last } = setup({ design: badge(photo({ source: 'static', fit: 'contain', mode: 'threshold' })),
      selection: ['image-1'], props: { imagesAllowed: true } });
    await waitFor(() => expect(api.listLabelImages).toHaveBeenCalled());
    const file = new File(['png'], 'Cumulus.png', { type: 'image/png' });
    fireEvent.change(within(panel()).getByLabelText('Image file'), { target: { files: [file] } });
    await waitFor(() => expect(api.uploadLabelImage).toHaveBeenCalledWith(file));
    await waitFor(() => expect(imageOf(last()).imageId).toBe('img-new'));
    expect((within(panel()).getByRole('combobox', { name: 'Static image' }) as HTMLInputElement).value).toBe('Cumulus');
  });

  it('an upload the server refuses says why and changes nothing', async () => {
    const { ApiError } = await import('../../../lib/api');
    api.uploadLabelImage.mockRejectedValue(new ApiError(413, 'file_too_large'));
    const { change } = setup({ design: badge(photo({ source: 'static', fit: 'contain', mode: 'threshold' })),
      selection: ['image-1'], props: { imagesAllowed: true } });
    fireEvent.change(within(panel()).getByLabelText('Image file'),
      { target: { files: [new File(['x'], 'big.png', { type: 'image/png' })] } });
    expect(await within(panel()).findByText('That file is over 5 MB.')).toBeTruthy();
    expect(change).not.toHaveBeenCalled();
  });

  describe('an upload that finishes after the user kept working', () => {
    const MADE: LabelImage = { id: 'img-new', name: 'Cumulus', width: 600, height: 200, mime: 'image/png', created_at: '' };
    const staticImage = (id: string) => photo({ id, source: 'static', fit: 'contain', mode: 'threshold' });

    /** The panel over a design the test can also change from outside (as
     *  the canvas does), with the upload held until `finish()`. */
    async function startUpload(design: DesignV2, selection: string[], props: Partial<PropertiesPanelProps> = {}) {
      let finish!: (made: LabelImage) => void;
      api.uploadLabelImage.mockReturnValue(new Promise<LabelImage>((resolve) => { finish = resolve; }));
      const change = vi.fn<(d: DesignV2) => void>();
      const outside: {
        design?: (edit: (d: DesignV2) => DesignV2) => void;
        select?: (ids: string[]) => void;
        readOnly?: (on: boolean) => void;
      } = {};
      function Harness() {
        const [d, setD] = useState<DesignV2>(design);
        const [sel, setSel] = useState<string[]>(selection);
        const [ro, setRo] = useState(false);
        outside.design = (edit) => setD(edit);
        outside.select = setSel;
        outside.readOnly = setRo;
        return (
          <PropertiesPanel design={d} selection={sel} samples={SAMPLES} fields={FIELDS} dpi={DPI}
            metricsFor={fakeMetricsFor} onChange={(next) => { change(next); setD(next); }} onSelect={setSel}
            imagesAllowed readOnly={ro} {...props} />
        );
      }
      render(<Harness />);
      await waitFor(() => expect(api.listLabelImages).toHaveBeenCalled());
      fireEvent.change(within(panel()).getByLabelText('Image file'),
        { target: { files: [new File(['png'], 'Cumulus.png', { type: 'image/png' })] } });
      await waitFor(() => expect(api.uploadLabelImage).toHaveBeenCalled());
      const done = async () => {
        await act(async () => { finish(MADE); });
      };
      return { change, outside, done, last: () => change.mock.calls.at(-1)![0] };
    }

    it('keeps an element moved meanwhile, and the picture goes to its element', async () => {
      const { outside, done, last } = await startUpload(badge(caption, staticImage('image-1')), ['image-1']);
      // the caption moves on the canvas while the picture uploads
      act(() => outside.design!((d) => updateElement(d, 'text-1', { x: 2 })));
      await done();
      expect(elementOf(last(), 'text-1').x).toBe(2);
      expect(imageOf(last()).imageId).toBe('img-new');
    });

    it('goes to the element it was uploaded for, even with another one selected since', async () => {
      const { outside, done, last } = await startUpload(
        badge(staticImage('image-1'), staticImage('image-2')), ['image-1']);
      act(() => outside.select!(['image-2']));
      await done();
      expect(imageOf(last()).imageId).toBe('img-new');
      expect((elementOf(last(), 'image-2') as ImageElement).imageId).toBeUndefined();
    });

    it('changes nothing once the panel is read-only (an old version opened)', async () => {
      const { change, outside, done } = await startUpload(badge(staticImage('image-1')), ['image-1']);
      act(() => outside.readOnly!(true));
      await done();
      expect(change).not.toHaveBeenCalled();
    });

    it('changes nothing once the picker is gone (something else selected)', async () => {
      const { change, outside, done } = await startUpload(badge(caption, staticImage('image-1')), ['image-1']);
      act(() => outside.select!(['text-1']));
      await done();
      expect(change).not.toHaveBeenCalled();
    });

    it('goes through onUpdate, worked out from the design the page has then', async () => {
      const onUpdate = vi.fn<(edit: (present: DesignV2) => DesignV2) => void>();
      const { change, done } = await startUpload(badge(caption, staticImage('image-1')), ['image-1'], { onUpdate });
      await done();
      expect(change).not.toHaveBeenCalled();
      expect(onUpdate).toHaveBeenCalledTimes(1);
      // the page's design by then: the caption moved
      const present = updateElement(badge(caption, staticImage('image-1')), 'text-1', { x: 2 });
      const next = onUpdate.mock.calls[0][0](present);
      expect(elementOf(next, 'text-1').x).toBe(2);
      expect(imageOf(next).imageId).toBe('img-new');
    });
  });

  describe('Delete… (the picked library picture)', () => {
    const DELETED_NOTE = 'This picture was deleted from the library, so it prints nothing. Pick another.';
    const staticOne = (imageId?: string) => badge(photo({ source: 'static', fit: 'contain', mode: 'threshold', imageId }));
    const confirmDialog = () => screen.getByRole('dialog', { name: 'Delete library image' });

    async function openDelete(onDialog = vi.fn()) {
      const utils = setup({ design: staticOne('img-10'), selection: ['image-1'], props: { imagesAllowed: true, onDialog } });
      await waitFor(() => expect(api.listLabelImages).toHaveBeenCalledTimes(1));
      fireEvent.click(await within(panel()).findByRole('button', { name: 'Delete…' }));
      return { ...utils, onDialog };
    }

    it('asks first, with the report-generate header', async () => {
      await openDelete();
      expect(within(confirmDialog()).getByText('Logo 10 · Delete')).toBeTruthy();
      expect(within(confirmDialog()).getByRole('heading', { name: 'Delete “Logo 10”?' })).toBeTruthy();
      expect(within(confirmDialog()).getByText(
        'Templates that use it will print nothing in its place until another image is picked.')).toBeTruthy();
      expect(api.deleteLabelImage).not.toHaveBeenCalled();
    });

    it('deletes it, refreshes the library, and the element keeps it (it prints nothing now)', async () => {
      api.deleteLabelImage.mockResolvedValue(undefined);
      const { change, onDialog } = await openDelete();
      expect(onDialog).toHaveBeenLastCalledWith(true);
      api.listLabelImages.mockResolvedValue([LIBRARY[1]]);
      fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Delete image' }));
      await waitFor(() => expect(api.deleteLabelImage).toHaveBeenCalledWith('img-10'));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete library image' })).toBeNull());
      expect(onDialog).toHaveBeenLastCalledWith(false);
      expect(api.listLabelImages).toHaveBeenCalledTimes(2);
      expect(raster.forgetStaticRaster).toHaveBeenCalledWith('img-10');
      expect(await within(panel()).findByText(DELETED_NOTE)).toBeTruthy();
      // the design is untouched: the element still names the picture
      expect(change).not.toHaveBeenCalled();
      // nothing left to delete
      expect(within(panel()).queryByRole('button', { name: 'Delete…' })).toBeNull();
    });

    it('Cancel deletes nothing', async () => {
      const { onDialog } = await openDelete();
      fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Cancel' }));
      expect(screen.queryByRole('dialog', { name: 'Delete library image' })).toBeNull();
      expect(onDialog).toHaveBeenLastCalledWith(false);
      expect(api.deleteLabelImage).not.toHaveBeenCalled();
    });

    it('a delete the server refuses says why and keeps the dialog open', async () => {
      const { ApiError } = await import('../../../lib/api');
      api.deleteLabelImage.mockRejectedValue(new ApiError(403, 'forbidden'));
      await openDelete();
      fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Delete image' }));
      expect(await within(confirmDialog()).findByText('You don’t have access to the label image library.'))
        .toBeTruthy();
      expect(raster.forgetStaticRaster).not.toHaveBeenCalled();
    });

    it('one already gone counts as deleted', async () => {
      const { ApiError } = await import('../../../lib/api');
      api.deleteLabelImage.mockRejectedValue(new ApiError(404, 'image_not_found'));
      api.listLabelImages.mockResolvedValueOnce(LIBRARY).mockResolvedValue([LIBRARY[1]]);
      await openDelete();
      fireEvent.click(within(confirmDialog()).getByRole('button', { name: 'Delete image' }));
      await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete library image' })).toBeNull());
      expect(await within(panel()).findByText(DELETED_NOTE)).toBeTruthy();
    });

    it('nothing picked, or read-only: no Delete…', async () => {
      setup({ design: staticOne(), selection: ['image-1'], props: { imagesAllowed: true } });
      await waitFor(() => expect(api.listLabelImages).toHaveBeenCalled());
      expect(within(panel()).queryByRole('button', { name: 'Delete…' })).toBeNull();
      cleanup();
      setup({ design: staticOne('img-10'), selection: ['image-1'], props: { imagesAllowed: true, readOnly: true } });
      await waitFor(() => expect(api.listLabelImages).toHaveBeenCalled());
      expect((within(panel()).getByRole('button', { name: 'Delete…' }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  it('off an ID badge in ZPL, says images don’t print there', () => {
    setup({ design: badge(photo()), selection: ['image-1'], props: { imagesAllowed: false } });
    expect(within(panel()).getByText('Images print on ID Badge templates in ZPL only. Remove this one.')).toBeTruthy();
    expect(within(panel()).queryByRole('group', { name: 'Source' })).toBeNull();
  });

  it('the placed-fields table lists images as Photo, Logo and Image', () => {
    setup({ design: badge(photo(), photo({ id: 'image-2', source: 'logo' }), photo({ id: 'image-3', source: 'static' })),
      selection: [], props: { imagesAllowed: true } });
    const table = screen.getByRole('region', { name: 'Fields on this label' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0].textContent)).toEqual(['Photo', 'Logo', 'Image']);
    expect(rows.map((r) => within(r).getAllByRole('cell')[1].textContent)).toEqual(['Image', 'Image', 'Image']);
  });
});
