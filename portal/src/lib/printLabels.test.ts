/** Pure Print Labels helpers. The ZPL transform cases are lifted from V2's
 *  sendZplToPrinter so the port stays exact; V2 source:
 *  BaseCampV2-reference/portal-v2/src/pages/PrintLabels.jsx. */
import { describe, expect, it } from 'vitest';

import type { GeneratedLabelBundle, InitiativeAssetRow } from './api';
import {
  DEFAULT_PRINT_SETTINGS, alignmentTestZpl, applyPrintSettings, batchBounds, batchCount,
  blankLabelsZpl, bundleByEntity, clampSetting, labelStatusFor, missingLabelIds, printOrder,
  readPrintSettings, sanitizePrintSettings, settingsModified, staleLabelCount, writePrintSettings,
} from './printLabels';

const S = (over: Partial<typeof DEFAULT_PRINT_SETTINGS> = {}) => ({ ...DEFAULT_PRINT_SETTINGS, ...over });
const ZPL = '^XA\n^PW812\n^LL406\n^FO10,10^FDhi^FS\n^XZ';

describe('applyPrintSettings (V2 sendZplToPrinter transform)', () => {
  it('returns the label untouched at defaults', () => {
    expect(applyPrintSettings(ZPL, S())).toBe(ZPL);
  });
  it('negates a positive horizontal offset into ^LS and widens ^PW', () => {
    const out = applyPrintSettings(ZPL, S({ horizontalOffset: 20 }));
    expect(out).toContain('^XA\n^LS-20');
    expect(out).toContain('^PW832');
  });
  it('a negative horizontal offset becomes a positive ^LS and leaves ^PW alone', () => {
    const out = applyPrintSettings(ZPL, S({ horizontalOffset: -15 }));
    expect(out).toContain('^XA\n^LS15');
    expect(out).toContain('^PW812');
  });
  it('replaces an existing ^LS instead of inserting a second one', () => {
    const out = applyPrintSettings('^XA^LS5^FDx^FS^XZ', S({ horizontalOffset: 7 }));
    expect(out).toBe('^XA^LS-7^FDx^FS^XZ');
  });
  it('inserts ^LT for a vertical offset (+ moves down)', () => {
    expect(applyPrintSettings(ZPL, S({ verticalOffset: 30 }))).toContain('^XA\n^LT30');
    expect(applyPrintSettings(ZPL, S({ verticalOffset: -4 }))).toContain('^XA\n^LT-4');
  });
  it('adds ^PQ before ^XZ for copies > 1, unless singleCopy', () => {
    expect(applyPrintSettings(ZPL, S({ copies: 3 }))).toMatch(/\^PQ3\^XZ$/);
    expect(applyPrintSettings(ZPL, S({ copies: 3 }), { singleCopy: true })).toBe(ZPL);
    expect(applyPrintSettings(ZPL, S({ copies: 1 }))).toBe(ZPL);
  });
  it('combines every setting in V2 order (LT after LS, both after ^XA)', () => {
    const out = applyPrintSettings(ZPL, S({ horizontalOffset: 10, verticalOffset: 5, copies: 2 }));
    expect(out.startsWith('^XA\n^LT5\n^LS-10')).toBe(true);
    expect(out.endsWith('^PQ2^XZ')).toBe(true);
    expect(out).toContain('^PW822');
  });
});

describe('blank + alignment ZPL', () => {
  it('feeds N blanks with ^PQ inside the format', () => {
    expect(blankLabelsZpl(2)).toBe('^XA^FO10,10^A0N,10,10^FD ^FS^PQ2^XZ');
  });
  it('draws V2 concentric boxes 25 dots apart with the size text', () => {
    const zpl = alignmentTestZpl(600, 300, '2x1', 300);
    const lines = zpl.split('\n');
    expect(lines[0]).toBe('^XA');
    expect(lines[1]).toBe('^PW600');
    expect(lines[2]).toBe('^LL300');
    expect(lines[3]).toBe('^LH0,0');
    expect(lines[4]).toBe('^FO5,5^GB590,290,4^FS');
    expect(lines[5]).toBe('^FO30,30^GB540,240,2^FS');
    expect(lines[6]).toBe('^FO55,55^GB490,190,2^FS');
    expect(lines[7]).toBe('^FO80,80^GB440,140,2^FS');
    expect(lines[8]).toBe('^FO105,105^GB390,90,2^FS');
    expect(lines).toContain('^FO0,138^A0N,24,24^FB600,1,0,C,0^FDALIGN 2x1 300DPI^FS');
    expect(lines[lines.length - 1]).toBe('^XZ');
    // boxes stop once a side would drop below 50 dots
    expect(lines.filter((l) => l.includes('^GB')).length).toBe(5);
    expect(zpl).not.toContain('^FO130,130');
  });
});

describe('settings', () => {
  it('clamps per field', () => {
    expect(clampSetting('copies', 0)).toBe(1);
    expect(clampSetting('copies', 500)).toBe(99);
    expect(clampSetting('copies', 'x')).toBe(1);
    expect(clampSetting('batchSize', 9999)).toBe(500);
    expect(clampSetting('batchSize', '')).toBe(1);
    expect(clampSetting('blanksBetweenRacks', -3)).toBe(0);
    expect(clampSetting('blanksBetweenRacks', 99)).toBe(20);
    expect(clampSetting('verticalOffset', 12.7)).toBe(13);
    expect(clampSetting('horizontalOffset', 'junk')).toBe(0);
  });
  it('detects modification against defaults', () => {
    expect(settingsModified(S())).toBe(false);
    expect(settingsModified(S({ printByRack: true }))).toBe(true);
    expect(settingsModified(S({ blanksBetweenRacks: 2 }))).toBe(true);
  });
  it('sanitizes junk from storage and drops unknown keys', () => {
    expect(sanitizePrintSettings(null)).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(sanitizePrintSettings({ copies: '4', printByRack: 'yes', foo: 1 }))
      .toEqual(S({ copies: 4, printByRack: true }));
  });
  it('round-trips through a storage-like object', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } };
    writePrintSettings(S({ batchSize: 25 }), storage);
    expect(readPrintSettings(storage)).toEqual(S({ batchSize: 25 }));
    store.set('labels.print.settings', '{not json');
    expect(readPrintSettings(storage)).toEqual(DEFAULT_PRINT_SETTINGS);
    expect(readPrintSettings({ getItem: () => { throw new Error('private mode'); } })).toEqual(DEFAULT_PRINT_SETTINGS);
  });
});

const row = (assetId: string, rack: string | null, ru: number | null): InitiativeAssetRow => ({
  id: `j-${assetId}`, asset_id: assetId, source_rack: rack, source_ru: ru,
} as unknown as InitiativeAssetRow);

describe('printOrder', () => {
  const rows = [row('a', 'R10', 5), row('b', 'R2', 40), row('c', 'R2', 42), row('d', null, null)];
  it('keeps display order of the selected rows by default', () => {
    expect(printOrder(['c', 'a', 'zzz'], rows, S())).toEqual(['a', 'c']);
  });
  it('sorts by rack (numeric-aware) then RU descending in rack mode', () => {
    expect(printOrder(['a', 'b', 'c', 'd'], rows, S({ printByRack: true }))).toEqual(['d', 'b', 'c', 'a'].sort((x, y) => {
      const rx = rows.find((r) => r.asset_id === x)!, ry = rows.find((r) => r.asset_id === y)!;
      const cmp = String(rx.source_rack ?? '').localeCompare(String(ry.source_rack ?? ''), undefined, { numeric: true });
      return cmp !== 0 ? cmp : (ry.source_ru ?? 0) - (rx.source_ru ?? 0);
    }));
    expect(printOrder(['b', 'c'], rows, S({ printByRack: true }))).toEqual(['c', 'b']);
  });
});

describe('batches', () => {
  it('computes bounds and counts', () => {
    expect(batchCount(120, 50)).toBe(3);
    expect(batchCount(50, 50)).toBe(1);
    expect(batchBounds(1, 50, 120)).toEqual({ start: 0, end: 50 });
    expect(batchBounds(3, 50, 120)).toEqual({ start: 100, end: 120 });
  });
});

describe('label status', () => {
  const bundle: GeneratedLabelBundle = {
    initiative_id: 'i', label_type: 'top', fetched_at: 'now',
    labels: [
      { id: '1', entity_type: 'asset', entity_id: 'a', template_id: 't', template_name: 'T', template_version: 1, language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: false, generated_at: 'now', code: '^XA^XZ' },
      { id: '2', entity_type: 'asset', entity_id: 'b', template_id: 't', template_name: 'T', template_version: 1, language_key: 'zpl', size_key: '4x2', dpi_key: '203', stale: true, generated_at: 'now', code: '^XA^XZ' },
      { id: '3', entity_type: 'asset', entity_id: 'c', template_id: 't', template_name: 'T', template_version: 1, language_key: 'escp', size_key: '4x2', dpi_key: '203', stale: false, generated_at: 'now', code: 'ESC' },
    ],
  };
  const by = bundleByEntity(bundle);
  it('classifies ready / stale / unsupported / missing', () => {
    expect(labelStatusFor('a', by)).toBe('ready');
    expect(labelStatusFor('b', by)).toBe('stale');
    expect(labelStatusFor('c', by)).toBe('unsupported');
    expect(labelStatusFor('zzz', by)).toBe('missing');
    expect(bundleByEntity(null).size).toBe(0);
  });
  it('lists the selected ids that cannot print and counts stale ones', () => {
    expect(missingLabelIds(['a', 'b', 'c', 'x'], by)).toEqual(['c', 'x']);
    expect(staleLabelCount(['a', 'b', 'c'], by)).toBe(1);
  });
});
