/** Pure Print Labels helpers. The ZPL transform cases are lifted from V2's
 *  sendZplToPrinter so the port stays exact; V2 source:
 *  BaseCampV2-reference/portal-v2/src/pages/PrintLabels.jsx. */
import { describe, expect, it } from 'vitest';

import type { ContainerItem, GeneratedLabelBundle, InitiativeAssetRow, LabelVocab } from './api';
import {
  DEFAULT_PRINT_SETTINGS, alignmentTestZpl, applyPrintSettings, batchBounds, batchCount,
  blankLabelsZpl, bundleAtDpi, bundleByEntity, clampSetting, containerPrintOrder, defaultCopiesFor,
  dpisByEntity, labelDots, labelStatusFor, missingLabelIds, printOrder, rackSeparatorZpl, readPrintSettings,
  sanitizePrintSettings, settingsModified, showsRackName, staleLabelCount, writePrintSettings,
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


describe('rack separator (Front labels)', () => {
  const vocab: LabelVocab[] = [
    { kind: 'size', key: '2x1', label: '2" x 1"', description: '', meta: { width_in: 2, height_in: 1 }, sort_order: 1, is_active: true, usage_count: null },
    { kind: 'dpi', key: '300', label: '300 DPI', description: '', meta: { dots: 300 }, sort_order: 2, is_active: true, usage_count: null },
  ];
  const FRONT_203 = { width: 406, height: 203 };
  const heights = (zpl: string) => [...zpl.matchAll(/\^A0N,(\d+),\1/g)].map((m) => Number(m[1]));
  const fields = (zpl: string) => [...zpl.matchAll(/\^FH_\^FD([^^]*)\^FS/g)].map((m) => m[1]);

  it('only the Front label carries the rack name', () => {
    expect(showsRackName('front')).toBe(true);
    for (const t of ['top', 'rail', 'custom', 'container', '']) expect(showsRackName(t)).toBe(false);
  });

  it('sizes from the label code, which works offline, else its size row × DPI', () => {
    expect(labelDots({ code: '^XA^PW600^LL300^XZ', size_key: 'x', dpi_key: '300' }, [])).toEqual({ width: 600, height: 300 });
    expect(labelDots({ code: '^XA^FDa^FS^XZ', size_key: '2x1', dpi_key: '300' }, vocab)).toEqual({ width: 600, height: 300 });
    expect(labelDots({ code: '^XA^PW406^FDa^FS^XZ', size_key: '2x1', dpi_key: '300' }, vocab)).toEqual({ width: 406, height: 300 });
    expect(labelDots({ code: '^XA^FDa^FS^XZ', size_key: 'nope', dpi_key: '300' }, vocab)).toBeNull();
    expect(labelDots(undefined, vocab)).toBeNull();
  });

  it('prints the rack name on the label stock, N copies, through ^FH escaping', () => {
    const zpl = rackSeparatorZpl('AN17', 2, FRONT_203);
    const lines = zpl.split('\n');
    expect(lines.slice(0, 5)).toEqual(['^XA', '^CI28', '^PW406', '^LL203', '^LH0,0']);
    expect(lines.slice(-2)).toEqual(['^PQ2', '^XZ']);
    expect(fields(zpl)).toEqual(['AN17']);
    expect(zpl).toMatch(/\^FB\d+,1,0,C,0/);
  });

  it('escapes ^ ~ _ \\ and non-ASCII the way the label compiler does', () => {
    expect(fields(rackSeparatorZpl('R^1~a_b\\é', 1, FRONT_203))).toEqual(['R_5e1_7ea_5fb_5c_c3_a9']);
  });

  it('falls back to a plain blank without a rack name or a known label size', () => {
    expect(rackSeparatorZpl('', 2, FRONT_203)).toBe(blankLabelsZpl(2));
    expect(rackSeparatorZpl('   ', 1, FRONT_203)).toBe(blankLabelsZpl(1));
    expect(rackSeparatorZpl('AN17', 3, null)).toBe(blankLabelsZpl(3));
  });

  it('a short name fills the label height and stays inside it', () => {
    const [h] = heights(rackSeparatorZpl('AN17', 1, FRONT_203));
    expect(h).toBeGreaterThan(203 * 0.6);
    expect(h).toBeLessThanOrEqual(203);
  });

  it('scales with DPI and label size, and shrinks as the name grows', () => {
    const at203 = heights(rackSeparatorZpl('AN17', 1, FRONT_203))[0];
    const at300 = heights(rackSeparatorZpl('AN17', 1, { width: 600, height: 300 }))[0];
    const big = heights(rackSeparatorZpl('AN17', 1, { width: 812, height: 406 }))[0];
    expect(at300).toBeGreaterThan(at203);
    expect(big).toBeGreaterThan(at203);
    const short = heights(rackSeparatorZpl('A1', 1, FRONT_203))[0];
    const long = heights(rackSeparatorZpl('AISLE12RACK04', 1, FRONT_203))[0];
    expect(long).toBeLessThan(short);
  });

  it('never wraps: every name prints on one line, a longer one smaller', () => {
    const names = ['A01', 'BG04', 'ATL1-A01', 'Row 12 Rack 04', '09.01.05D.02.10',
      'DC1-HALL-B-ROW-12-RACK-04', 'AN17 (Room=N (Singapore,SGD,3))'];
    const sizes = names.map((name) => {
      const zpl = rackSeparatorZpl(name, 1, FRONT_203);
      expect(fields(zpl)).toEqual([name]);
      expect(heights(zpl)).toHaveLength(1);
      return heights(zpl)[0];
    });
    expect(sizes).toEqual([...sizes].sort((a, b) => b - a));
    expect(sizes[sizes.length - 1]).toBeLessThan(sizes[0] / 3);
  });

  it('centers the line vertically inside the margin', () => {
    const zpl = rackSeparatorZpl('09.01.05D.02.10', 1, FRONT_203);
    const [, , y, h] = /\^FO(\d+),(\d+)\^A0N,(\d+)/.exec(zpl)!.map(Number);
    expect(Math.abs(y - (203 - h - y))).toBeLessThanOrEqual(1);
  });

  it('never goes below the smallest font ZPL draws', () => {
    expect(heights(rackSeparatorZpl('X'.repeat(200), 1, FRONT_203))[0]).toBe(10);
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

const container = (id: string): ContainerItem => ({ id, name: `box-${id}` } as unknown as ContainerItem);

describe('containerPrintOrder', () => {
  it('is the selection intersected with the displayed rows, in display order', () => {
    const displayed = [container('a'), container('b'), container('c')];
    expect(containerPrintOrder(['c', 'a', 'zzz'], displayed, DEFAULT_PRINT_SETTINGS))
      .toEqual(['a', 'c']);
  });

  it('ignores printByRack, which has no container meaning', () => {
    const displayed = [container('a'), container('b')];
    expect(containerPrintOrder(['a', 'b'], displayed, S({ printByRack: true }))).toEqual(['a', 'b']);
  });
});

const typeVocabRow = (key: string, meta: Record<string, unknown> = {}): LabelVocab => ({
  kind: 'type', key, label: key, description: '', meta, sort_order: 1, is_active: true, usage_count: null,
});

describe('defaultCopiesFor', () => {
  const vocab: LabelVocab[] = [
    typeVocabRow('container', { default_copies: 5 }),
    typeVocabRow('container_info', { default_copies: 1 }),
    typeVocabRow('top'),
  ];
  it('reads default_copies from the type vocab meta', () => {
    expect(defaultCopiesFor(vocab, 'container')).toBe(5);
    expect(defaultCopiesFor(vocab, 'container_info')).toBe(1);
  });
  it('is null for a type that carries no default', () => {
    expect(defaultCopiesFor(vocab, 'top')).toBeNull();
  });
  it('is null for a type key with no matching vocab row', () => {
    expect(defaultCopiesFor(vocab, 'missing')).toBeNull();
  });
  it('ignores a non-numeric or out-of-range meta value', () => {
    expect(defaultCopiesFor([typeVocabRow('container', { default_copies: 'five' })], 'container')).toBeNull();
    expect(defaultCopiesFor([typeVocabRow('container', { default_copies: 0 })], 'container')).toBeNull();
    expect(defaultCopiesFor([typeVocabRow('container', { default_copies: 100 })], 'container')).toBeNull();
    expect(defaultCopiesFor([typeVocabRow('container', { default_copies: 2.5 })], 'container')).toBeNull();
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

describe('labels per DPI', () => {
  const at = (entity: string, dpi: string) => ({
    id: `${entity}-${dpi}`, entity_type: 'asset' as const, entity_id: entity, template_id: 't',
    template_name: 'T', template_version: 1, language_key: 'zpl', size_key: '4x2', dpi_key: dpi,
    stale: false, generated_at: 'now', code: `^XA${entity}${dpi}^XZ`,
  });
  const bundle: GeneratedLabelBundle = {
    initiative_id: 'i', label_type: 'top', fetched_at: 'now',
    labels: [at('a', '600'), at('a', '203'), at('b', '300'), at('a', '300')],
  };
  it('keeps only the printer DPI, or everything without one', () => {
    expect(bundleAtDpi(bundle, '300')?.labels.map((l) => l.id)).toEqual(['b-300', 'a-300']);
    expect(bundleAtDpi(bundle, null)).toBe(bundle);
    expect(bundleAtDpi(null, '300')).toBeNull();
    expect(bundleByEntity(bundleAtDpi(bundle, '203')).get('a')?.code).toBe('^XAa203^XZ');
  });
  it("treats a label at another DPI than the printer's as missing", () => {
    const by = bundleByEntity(bundle);              // no DPI filter: last wins, a-300
    expect(labelStatusFor('a', by, '300')).toBe('ready');
    expect(labelStatusFor('a', by, '203')).toBe('missing');
    expect(missingLabelIds(['a', 'b'], by, '203')).toEqual(['a', 'b']);
    expect(staleLabelCount(['a', 'b'], by, '300')).toBe(0);
  });
  it("lists each entity's DPIs lowest first", () => {
    const dpis = dpisByEntity(bundle);
    expect(dpis.get('a')).toEqual(['203', '300', '600']);
    expect(dpis.get('b')).toEqual(['300']);
    expect(dpisByEntity(null).size).toBe(0);
  });
});
