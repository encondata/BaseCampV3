import { describe, expect, it } from 'vitest';

import vegas from '../../../../api/src/serversherpa/labels/fixtures/vegas_v2.json';
import { addElement, newDesign, parseDesign, type DesignV2, type ElementV2 } from './model';
import { fontIdsFor, previewRequest, type LibraryFont } from './zplPreview';

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
    const req = previewRequest(d, 600, samples, ['rc-r'], '4x2');
    expect(req.compile).toEqual({
      kind: 'design', design: vegas, size_key: '4x2', dpi_key: '600', language_key: 'zpl',
      mode: 'sample', samples,
    });
    expect(req.preview('^XA^XZ')).toEqual({
      zpl: '^XA^XZ', size_key: '4x2', dpi_key: '600', font_ids: ['rc-r'],
    });
  });

  it('sends copies, so a later edit never changes a body already built', () => {
    const samples = { asset_id: '1' };
    const fontIds = ['a'];
    const req = previewRequest(newDesign({ w: 2, h: 1 }), 300, samples, fontIds, '2x1');
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
