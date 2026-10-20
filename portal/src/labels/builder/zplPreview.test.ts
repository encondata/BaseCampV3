import { describe, expect, it } from 'vitest';

import vegas from '../../../../api/src/serversherpa/labels/fixtures/vegas_v2.json';
import { addElement, newDesign, parseDesign, type DesignV2, type ElementV2 } from './model';
import {
  PREVIEW_MAX_CHARS, designFonts, fontIdsFor, previewRequest, previewTooLarge, type LibraryFont,
} from './zplPreview';

const LIBRARY: LibraryFont[] = [
  { id: 'swiss', family: 'swiss721-cond-bold', weight: 'regular', resident: true },
  { id: 'rc-r', family: 'roboto-condensed', weight: 'regular', resident: false },
  { id: 'rc-b', family: 'roboto-condensed', weight: 'bold', resident: false },
  { id: 'rob-r', family: 'roboto', weight: 'regular', resident: false },
  { id: 'mono-r', family: 'roboto-mono', weight: 'regular', resident: false },
  { id: 'other', family: null, weight: null, resident: false },
];

function text(id: string, family: string, weight: 'regular' | 'bold'): ElementV2 {
  return { id, type: 'text', content: 'X', x: 0, y: 0, w: 1, h: 0.1, rotation: 0,
    font: { family, weight }, sizePt: 8, baselineIn: 0.08 };
}

function design(...els: ElementV2[]): DesignV2 {
  return els.reduce(addElement, newDesign({ w: 4, h: 2 }));
}

describe('previewRequest', () => {
  it('builds the compile body (v2 design with its samples) and the preview body (with font ids)', () => {
    const d = parseDesign(vegas);
    const samples = { asset_id: '100000', destination_rack: '14.01.07C.02.03' };
    const req = previewRequest(d, 600, samples, ['rc-r'], '4x2', 'top');
    expect(req.compile).toEqual({
      kind: 'design', design: vegas, size_key: '4x2', dpi_key: '600', language_key: 'zpl',
      mode: 'sample', samples, label_type: 'top', image_mode: 'placeholder',
    });
    expect(req.preview('^XA^XZ')).toEqual({
      zpl: '^XA^XZ', size_key: '4x2', dpi_key: '600', font_ids: ['rc-r'],
    });
  });

  it('sends a badge’s sample person (person:id) with its samples, and the design as schema 3', () => {
    const photo: ElementV2 = { id: 'image-1', type: 'image', source: 'photo', x: 0.1, y: 0.1, w: 0.8, h: 1, rotation: 0 };
    const samples = { person_name: 'Ada Lovelace', 'person:id': '0b7f3c52-6a2e-4c41-9d1e-3f2a9b8c7d10' };
    const req = previewRequest(design(photo), 300, samples, [], 'id-badge', 'id_badge');
    expect(req.compile.samples).toEqual(samples);
    expect(req.compile.design.schema).toBe(3);
    // pictures never go to Labelary: the compile draws placeholders for them
    expect(req.compile.image_mode).toBe('placeholder');
  });

  it('knows a ZPL too large to preview', () => {
    expect(PREVIEW_MAX_CHARS).toBe(250_000);
    expect(previewTooLarge('x'.repeat(250_000))).toBe(false);
    expect(previewTooLarge('x'.repeat(250_001))).toBe(true);
  });

  it('sends copies, so a later edit never changes a body already built', () => {
    const samples = { asset_id: '1' };
    const fontIds = ['a'];
    const req = previewRequest(newDesign({ w: 2, h: 1 }), 300, samples, fontIds, '2x1', 'container');
    samples.asset_id = '2';
    fontIds.push('b');
    expect(req.compile.samples).toEqual({ asset_id: '1' });
    expect(req.preview('^XA^XZ').font_ids).toEqual(['a']);
  });
});

describe('fontIdsFor', () => {
  it('lists nothing for a design in the resident font only', () => {
    expect(fontIdsFor(parseDesign(vegas), LIBRARY)).toEqual([]);
  });

  it('lists each open library file the text uses once, in order of first use', () => {
    const d = design(
      text('t1', 'roboto-condensed', 'bold'),
      text('t2', 'swiss721-cond-bold', 'bold'),      // resident, faux bold: nothing to send
      text('t3', 'roboto', 'regular'),
      text('t4', 'roboto-condensed', 'bold'),
      text('t5', 'roboto', 'bold'),                  // no Bold file in the library: prints Regular
    );
    expect(fontIdsFor(d, LIBRARY)).toEqual(['rc-b', 'rob-r']);
  });

  it('skips fields shown as a barcode or QR code, and fonts missing from the library', () => {
    const base = parseDesign(vegas).elements.find((e) => e.id === 'banner-pod')!;
    const asQr = { ...base, id: 'f1', display: 'qr', font: { family: 'roboto-mono', weight: 'regular' } } as ElementV2;
    const asText = { ...base, id: 'f2', font: { family: 'roboto-mono', weight: 'regular' } } as ElementV2;
    expect(fontIdsFor(design(asQr), LIBRARY)).toEqual([]);
    expect(fontIdsFor(design(asText), LIBRARY)).toEqual(['mono-r']);
    expect(fontIdsFor(design(text('t', 'oswald', 'regular')), LIBRARY)).toEqual([]);
  });
});

describe('designFonts', () => {
  it('names the resident object for a design in the resident font only', () => {
    expect(designFonts(parseDesign(vegas))).toEqual([
      { family: 'swiss721-cond-bold', weight: 'regular', object: 'TT0003M_.TTF' },
    ]);
  });

  it('lists each printer object the text prints with once, in order of first use (design_fonts)', () => {
    const d = design(
      text('t1', 'roboto-condensed', 'bold'),
      text('t2', 'swiss721-cond-bold', 'bold'),      // faux bold: the Regular file is all it needs
      text('t3', 'roboto', 'regular'),
      text('t4', 'roboto-condensed', 'bold'),
      text('t5', 'roboto', 'bold'),                  // a Bold file: the printer needs it, library or not
      text('t6', 'swiss721-cond-bold', 'regular'),
    );
    expect(designFonts(d)).toEqual([
      { family: 'roboto-condensed', weight: 'bold', object: 'ROBOCO_B.TTF' },
      { family: 'swiss721-cond-bold', weight: 'regular', object: 'TT0003M_.TTF' },
      { family: 'roboto', weight: 'regular', object: 'ROBOTO_R.TTF' },
      { family: 'roboto', weight: 'bold', object: 'ROBOTO_B.TTF' },
    ]);
  });

  it('skips fields shown as a barcode or QR code, and unknown families', () => {
    const base = parseDesign(vegas).elements.find((e) => e.id === 'banner-pod')!;
    const asQr = { ...base, id: 'f1', display: 'qr', font: { family: 'roboto-mono', weight: 'regular' } } as ElementV2;
    const asText = { ...base, id: 'f2', font: { family: 'roboto-mono', weight: 'regular' } } as ElementV2;
    expect(designFonts(design(asQr))).toEqual([]);
    expect(designFonts(design(asText))).toEqual([{ family: 'roboto-mono', weight: 'regular', object: 'ROBOMO_R.TTF' }]);
    expect(designFonts(design(text('t', 'nope', 'regular')))).toEqual([]);
  });
});
