import { describe, expect, it } from 'vitest';

import type { LabelTemplate, LabelTemplateChild, LabelTemplateTreeNode } from '../lib/api';
import { mockTemplateOptions, noVersionText, versionAt } from './testLabelTemplates';

const base = (id: string, over: Partial<LabelTemplate> = {}): LabelTemplate => ({
  id, name: id, description: '', label_type: 'top', size_key: '4x2', dpi_key: '203', language_key: 'zpl',
  kind: 'code', design: null, code: '^XA^XZ', version: 1, is_active: true, site_ids: [],
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', ...over,
});

/** An older single row at the top of the tree. */
const single = (id: string, family: string, over: Partial<LabelTemplate> = {}): LabelTemplateTreeNode =>
  ({ ...base(id, over), family, children: [] });

/** A builder parent (schema 2, no parent_id) owning DPI children. */
const parent = (id: string, family: string, children: LabelTemplateChild[], over: Partial<LabelTemplate> = {}): LabelTemplateTreeNode =>
  ({ ...base(id, { kind: 'design', schema_version: 2, dpi_key: '300', ...over }), family, children });

const child = (id: string, parentId: string, over: Partial<LabelTemplate> = {}): LabelTemplateChild =>
  ({ ...base(id, { kind: 'design', schema_version: 2, parent_id: parentId, ...over }), out_of_date: false });

const typeLabels = { top: 'Top', front: 'Front', id_badge: 'ID Badge' };

describe('mockTemplateOptions', () => {
  it('groups by family and label type', () => {
    const options = mockTemplateOptions([
      single('t1', 'Generic Rack and RU', { label_type: 'top' }),
      single('f1', 'Generic Rack and RU', { label_type: 'front' }),
      single('t2', 'Generic Rack and RU', { label_type: 'top', dpi_key: '300' }),
    ], typeLabels);
    expect(options.map((o) => o.label)).toEqual(['Generic Rack and RU · Front', 'Generic Rack and RU · Top']);
    const top = options.find((o) => o.labelType === 'top')!;
    expect(top.key).toBe('Generic Rack and RU|top');
    expect(top.family).toBe('Generic Rack and RU');
    expect(Object.keys(top.versions).sort()).toEqual(['203', '300']);
    expect(top.versions['203'].id).toBe('t1');
    expect(top.versions['300'].id).toBe('t2');
  });

  it('names a label type that has no vocab row by its key', () => {
    const [option] = mockTemplateOptions([single('c1', 'Pallet Tag', { label_type: 'custom_thing' })], typeLabels);
    expect(option.label).toBe('Pallet Tag · custom_thing');
  });

  it('lists only active, current, ZPL printable rows', () => {
    const options = mockTemplateOptions([
      single('keep', 'Keep', { label_type: 'top' }),
      single('off', 'Inactive', { is_active: false }),
      single('old', 'Old', { is_old: true }),
      single('brother', 'Brother', { language_key: 'ptouch' }),
      single('escp', 'Brother 2', { language_key: 'escp' }),
      parent('p-empty', 'Childless Parent', []),
      parent('p-off', 'Off Children', [child('c-off', 'p-off', { is_active: false }), child('c-old', 'p-off', { is_old: true })]),
    ], typeLabels);
    expect(options.map((o) => o.family)).toEqual(['Keep']);
  });

  it('a builder parent offers its DPI children, never itself', () => {
    const options = mockTemplateOptions([
      parent('p1', 'Front Tag', [
        child('p1-203', 'p1', { dpi_key: '203', label_type: 'front' }),
        child('p1-300', 'p1', { dpi_key: '300', label_type: 'front' }),
        child('p1-600', 'p1', { dpi_key: '600', label_type: 'front', is_old: true, is_active: false }),
      ], { label_type: 'front' }),
    ], typeLabels);
    expect(options).toHaveLength(1);
    expect(options[0].label).toBe('Front Tag · Front');
    expect(Object.keys(options[0].versions).sort()).toEqual(['203', '300']);
    expect(Object.values(options[0].versions).map((v) => v.id).sort()).toEqual(['p1-203', 'p1-300']);
  });

  it('puts one option per family and type across a parent and an older row', () => {
    const options = mockTemplateOptions([
      parent('p1', 'Front Tag', [child('p1-300', 'p1', { dpi_key: '300', label_type: 'front' })], { label_type: 'front' }),
      single('s1', 'Front Tag', { label_type: 'front', dpi_key: '203' }),
    ], typeLabels);
    expect(options).toHaveLength(1);
    expect(Object.keys(options[0].versions).sort()).toEqual(['203', '300']);
  });

  it('sorts by label naturally', () => {
    const options = mockTemplateOptions([
      single('a', 'Rack 10'), single('b', 'Rack 2'), single('c', 'rack 1'),
    ], typeLabels);
    expect(options.map((o) => o.family)).toEqual(['rack 1', 'Rack 2', 'Rack 10']);
  });

  it('is empty for an empty tree', () => {
    expect(mockTemplateOptions([], typeLabels)).toEqual([]);
  });
});

describe('versionAt', () => {
  const [option] = mockTemplateOptions([
    single('a', 'Front Tag', { dpi_key: '203' }), single('b', 'Front Tag', { dpi_key: '300' }),
  ], typeLabels);
  it('picks the row at the DPI or null', () => {
    expect(versionAt(option, '203')?.id).toBe('a');
    expect(versionAt(option, '300')?.id).toBe('b');
    expect(versionAt(option, '600')).toBeNull();
  });
});

describe('noVersionText', () => {
  it('names the DPIs the template has', () => {
    const [option] = mockTemplateOptions([single('a', 'Front Tag', { dpi_key: '203' })], typeLabels);
    expect(noVersionText(option, '300')).toBe(
      '"Front Tag" is only available at 203 DPI, so it can\'t print at 300 DPI.');
  });
  it('joins several DPIs with "or", in natural order', () => {
    const [option] = mockTemplateOptions([
      single('a', 'Front Tag', { dpi_key: '600' }), single('b', 'Front Tag', { dpi_key: '203' }),
      single('c', 'Front Tag', { dpi_key: '300' }),
    ], typeLabels);
    expect(noVersionText(option, '100')).toBe(
      '"Front Tag" is only available at 203 or 300 or 600 DPI, so it can\'t print at 100 DPI.');
  });
});
