import { expect, it } from 'vitest';

import type { LabelPlaceholder, LabelVocab } from './api';
import {
  dpiDots, metaSummary, placeholdersFor, sizeMeta, templateSearchText,
  vocabLabel, vocabOfKind,
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

it('templateSearchText covers the visible columns', () => {
  const t = { id: '1', name: 'Front tag', description: 'main', label_type: 'front',
    size_key: '4x2', dpi_key: '203', language_key: 'zpl', kind: 'design',
    design: null, code: null, version: 3, is_active: true,
    created_at: '', updated_at: '' } as const;
  const hay = templateSearchText(t);
  for (const frag of ['front tag', 'main', 'front', '4x2', 'zpl', 'design']) {
    expect(hay).toContain(frag);
  }
});
