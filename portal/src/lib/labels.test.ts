import { expect, it } from 'vitest';

import type { LabelPlaceholder, LabelTemplate, LabelTemplateChild, LabelTemplateTreeNode, LabelVocab } from './api';
import {
  childStateChips, dpiDots, isContainerLabelType, isTreeParent, keptChildName, metaSummary, missingDpis, placeholdersFor,
  replaceCandidates, siteNames, sitesCellText, sizeMeta, templateDpiText, templateSearchText, vocabLabel,
  vocabOfKind,
} from './labels';

const V = (over: Partial<LabelVocab>): LabelVocab => ({
  kind: 'size', key: 'k', label: 'L', description: '', meta: {},
  sort_order: 0, is_active: true, usage_count: 0, ...over,
});

const VOCAB: LabelVocab[] = [
  V({ kind: 'size', key: '4x2', label: '4" x 2"', sort_order: 1,
      meta: { width_in: 4, height_in: 2, has_tab: false } }),
  V({ kind: 'size', key: 'old', label: 'Old', sort_order: 2, is_active: false }),
  V({ kind: 'dpi', key: '300', label: '300 DPI', meta: { dots: 300 } }),
  V({ kind: 'type', key: 'top', label: 'Top Label' }),
];

it('vocabOfKind filters, sorts, and honors activeOnly', () => {
  expect(vocabOfKind(VOCAB, 'size').map((v) => v.key)).toEqual(['4x2']);
  expect(vocabOfKind(VOCAB, 'size', { activeOnly: false }).map((v) => v.key))
    .toEqual(['4x2', 'old']);
});

it('vocabLabel falls back to the key', () => {
  expect(vocabLabel(VOCAB, 'type', 'top')).toBe('Top Label');
  expect(vocabLabel(VOCAB, 'type', 'gone')).toBe('gone');
});

it('sizeMeta and dpiDots survive malformed meta', () => {
  expect(sizeMeta(VOCAB[0])).toEqual({ width_in: 4, height_in: 2, has_tab: false });
  expect(sizeMeta(V({ meta: {} }))).toEqual({ width_in: 4, height_in: 2, has_tab: false });
  expect(dpiDots(VOCAB, '300')).toBe(300);
  expect(dpiDots(VOCAB, 'gone')).toBe(203);
});

it('metaSummary renders per kind', () => {
  expect(metaSummary(VOCAB[0])).toBe('4 x 2 in');
  expect(metaSummary(V({ kind: 'size', key: 't',
    meta: { width_in: 4, height_in: 3, has_tab: true } }))).toBe('4 x 3 in + tab');
  expect(metaSummary(VOCAB[2])).toBe('300 dots/in');
  expect(metaSummary(V({ kind: 'language', key: 'zpl',
    meta: { family: 'zebra' } }))).toBe('zebra');
  expect(metaSummary(VOCAB[3])).toBe('');
});

it('placeholdersFor filters on label type and active', () => {
  const P = (over: Partial<LabelPlaceholder>): LabelPlaceholder => ({
    key: 'k', label: 'L', description: '', sample_value: '', applies_to: [],
    sort_order: 0, is_active: true, usage_count: 0, ...over,
  });
  const rows = [
    P({ key: 'asset_id', applies_to: ['top', 'front'], sort_order: 1 }),
    P({ key: 'container_name', applies_to: ['container'], sort_order: 2 }),
    P({ key: 'dead', applies_to: ['top'], is_active: false }),
  ];
  expect(placeholdersFor(rows, 'top').map((p) => p.key)).toEqual(['asset_id']);
  expect(placeholdersFor(rows, 'container').map((p) => p.key))
    .toEqual(['container_name']);
});

const SITES = [{ id: 's1', name: 'NAP7' }, { id: 's2', name: 'NAP11' }];

it('siteNames maps ids and keeps unknown ids raw', () => {
  expect(siteNames(['s2', 'ghost'], SITES)).toEqual(['NAP11', 'ghost']);
});

it('sitesCellText renders global, single, and overflow states', () => {
  expect(sitesCellText([], SITES)).toBe('All sites');
  expect(sitesCellText(['s1'], SITES)).toBe('NAP7');
  expect(sitesCellText(['s1', 's2'], SITES)).toBe('NAP7 +1');
});

it('templateSearchText covers the visible columns', () => {
  const t = { id: '1', name: 'Front tag', description: 'main', label_type: 'front',
    size_key: '4x2', dpi_key: '203', language_key: 'zpl', kind: 'design',
    design: null, code: null, version: 3, is_active: true, site_ids: [] as string[],
    created_at: '', updated_at: '' } as const;
  const hay = templateSearchText(t);
  for (const frag of ['front tag', 'main', 'front', '4x2', 'zpl', 'design']) {
    expect(hay).toContain(frag);
  }
});

it('isContainerLabelType knows the container-shaped types and treats everything else as an asset type', () => {
  expect(isContainerLabelType('container')).toBe(true);
  expect(isContainerLabelType('container_info')).toBe(true);
  expect(isContainerLabelType('top')).toBe(false);
  expect(isContainerLabelType('front')).toBe(false);
  expect(isContainerLabelType('custom')).toBe(false);
  expect(isContainerLabelType('')).toBe(false);
});

// ── the templates list tree ──

const ROW: LabelTemplate = {
  id: 'p1', name: 'Vegas Destination', description: '', label_type: 'top', size_key: '4x2', dpi_key: '300',
  language_key: 'zpl', kind: 'design', design: { schema: 2 }, code: null, version: 7, is_active: true,
  site_ids: [], created_at: '', updated_at: '', parent_id: null, schema_version: 2, dpis: ['203', '300', '600'],
};

const kid = (dpi: string, over: Partial<LabelTemplateChild> = {}): LabelTemplateChild => ({
  ...ROW, id: `c${dpi}`, name: `Vegas Destination · ${dpi}`, dpi_key: dpi, parent_id: 'p1',
  generated_from_version: 7, child_edits: 0, customized: false, is_old: false, out_of_date: false, ...over,
});

const node = (over: Partial<LabelTemplateTreeNode> = {}): LabelTemplateTreeNode => ({
  ...ROW, family: ROW.name, children: [kid('203'), kid('300'), kid('600')], ...over,
});

const legacy = (id: string, name: string, over: Partial<LabelTemplateTreeNode> = {}): LabelTemplateTreeNode => ({
  ...ROW, id, name, kind: 'code', design: null, code: '^XA^XZ', schema_version: 1, dpi_key: '203', dpis: [],
  family: name.replace(/ - \d+DPI$/, ''), children: [], ...over,
});

it('isTreeParent: a top-level schema 2 design only', () => {
  expect(isTreeParent(ROW)).toBe(true);
  expect(isTreeParent(kid('203'))).toBe(false);
  expect(isTreeParent({ ...ROW, schema_version: 1 })).toBe(false);
  expect(isTreeParent(legacy('l1', 'Old tag'))).toBe(false);
});

it('templateDpiText: All with all three current children, else the ones present; a legacy row its own', () => {
  expect(templateDpiText(node())).toBe('All');
  expect(templateDpiText(node({ children: [kid('300'), kid('203')] }))).toBe('203 · 300');
  // an Old child is history, not a DPI the template prints at
  expect(templateDpiText(node({ children: [kid('203'), kid('300'), kid('600', { is_old: true })] })))
    .toBe('203 · 300');
  expect(templateDpiText(node({ children: [] }))).toBe('—');
  expect(templateDpiText(legacy('l1', 'Vegas Destination - 203DPI'))).toBe('203');
});

it('missingDpis lists the DPIs a parent has no current child for', () => {
  expect(missingDpis(node())).toEqual([]);
  expect(missingDpis(node({ children: [kid('300'), kid('600', { is_old: true })] }))).toEqual(['203', '600']);
  expect(missingDpis(legacy('l1', 'Old tag'))).toEqual([]);
});

it('childStateChips: From parent, Customized, Out of date (parent vN), Kept · inactive', () => {
  const text = (c: LabelTemplateChild) => childStateChips(c, ROW).map((chip) => chip.text);
  expect(text(kid('203'))).toEqual(['From parent']);
  expect(text(kid('300', { customized: true, child_edits: 2 }))).toEqual(['Customized']);
  expect(text(kid('300', { customized: true, child_edits: 2, generated_from_version: 6, out_of_date: true })))
    .toEqual(['Customized', 'Out of date (parent v7)']);
  expect(text(kid('300', { name: 'Vegas Destination · 300 Old', customized: true, is_old: true, is_active: false })))
    .toEqual(['Kept · inactive']);
});

it('replaceCandidates: the other active top-level rows of the same family and type', () => {
  const ams = node({ id: 'p2', name: 'Amsterdam Destination', family: 'Amsterdam Destination', is_active: false });
  const rows = [
    ams,
    legacy('l1', 'Amsterdam Destination - 203DPI'),
    legacy('l2', 'Amsterdam Destination - 300DPI'),
    legacy('l3', 'amsterdam destination - 600DPI', { family: 'amsterdam destination' }),   // casefold
    legacy('l4', 'Amsterdam Destination - 600DPI', { is_active: false }),                  // already off
    legacy('l5', 'Amsterdam Destination - 203DPI', { id: 'l5', label_type: 'front' }),     // another type
    legacy('l6', 'Vegas Destination - 203DPI'),                                              // another family
  ];
  expect(replaceCandidates(ams, rows).map((r) => r.id)).toEqual(['l1', 'l2', 'l3']);
});

it('keptChildName: the next free "… Old" name', () => {
  expect(keptChildName('Vegas Destination', '300', new Set())).toBe('Vegas Destination · 300 Old');
  expect(keptChildName('Vegas Destination', '300', new Set(['Vegas Destination · 300 Old'])))
    .toBe('Vegas Destination · 300 Old 2');
  expect(keptChildName('Vegas Destination', '300',
    new Set(['Vegas Destination · 300 Old', 'Vegas Destination · 300 Old 2']))).toBe('Vegas Destination · 300 Old 3');
});
