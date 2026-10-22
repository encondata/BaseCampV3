/**
 * Template pick, label values, the plan and its renders: the logic of the
 * laptop edge's labels/generate.py on the sync bodies, store-free. Sample
 * assets and templates follow kiosk_laptop/edge/tests/test_label_generate.py.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { assetLabelValues } from './labelValues';
import { designFieldKeys, fieldValues, mockFieldValues, MOCK_VALUES } from './fields';
import { pickTemplate, type TemplateChoice } from './pick';
import {
  availableDpis, buildPlan, fingerprint, planWithValues, renderLabels, type PlanInput,
} from './plan';
import { parsePyJson, type PyDict } from './pyjson';
import { fontsUsed, templateFonts, templateSchema } from './templateFonts';

const FIXTURES = new URL('../../../api/src/serversherpa/labels/fixtures/', import.meta.url);
const fixtureText = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');
const VEGAS = JSON.parse(fixtureText('vegas_v2.json'));
const VEGAS_ZPL = fixtureText('vegas_v2_300.zpl').slice(0, -1);

const CATALOG = ['asset_id', 'asset_name', 'serial_number', 'make_model', 'source_ru',
  'source_raw', 'destination_site', 'move_date', 'move_date_long'];

const DESIGN = {
  elements: [
    { type: 'text', x: 0.1, y: 0.1, w: 2.0, h: 0.3, content: '{asset_name} / {source_ru}', fontSizePt: 12 },
    { type: 'barcode', x: 0.1, y: 0.5, w: 2.0, h: 0.5, data: '{serial_number}', symbology: 'code128' },
  ],
};

type Json = Record<string, unknown>;

function asset(n: number, over: Json = {}): Json {
  return {
    id: `a-${n}`, asset_id: String(100 + n), legacy_id: 100 + n,
    name: `web${String(n).padStart(2, '0')}`, rfid: null, serial_number: `SN${n}`,
    make: 'Dell', model: 'R640', make_model: 'Dell R640', container_id: null,
    source_rack: 'R1', source_ru: '14.5', source_ru_raw: '14.50',
    source_position: 'R1.14', source_pod: null,
    destination_rack: 'D9', destination_ru: '3', destination_ru_raw: '3',
    destination_position: null, destination_pod: null,
    priority_wave: '1', disposition: null, label: {},
    ...over,
  };
}

function template(id: string, o: {
  family?: string; dpi?: string; scope?: string | null; kind?: string; version?: number;
  labelType?: string; design?: unknown; code?: string; rules?: Json; updatedAt?: string;
} = {}): Json {
  const dpi = o.dpi ?? '203';
  const family = o.family ?? 'Rack';
  const kind = o.kind ?? 'design';
  return {
    id, name: `${family} - ${dpi}DPI`, family, label_type: o.labelType ?? 'top',
    size_key: '4x2', dpi_key: dpi, language_key: 'zpl', version: o.version ?? 1,
    updated_at: o.updatedAt ?? '2026-10-01T12:00:00+00:00', move_site_names: [], reasons: [],
    code: o.code ?? '', generation_rules: o.rules ?? {}, width_in: 4.0, height_in: 2.0,
    dots: /^\d+$/.test(dpi) ? Number(dpi) : 203, error: null, kind,
    design: kind === 'design' ? (o.design ?? DESIGN) : null, scope: o.scope ?? 'destination',
  };
}

const CONTEXT = {
  move_name: 'Move 1', move_day: '2026-11-03', source_site: 'Old DC',
  destination_site: 'New DC', catalog_keys: CATALOG,
};

function input(o: {
  assets?: Json[]; templates?: Json[]; dpi?: number; kind?: 'top' | 'front';
  context?: Json | null; templatesText?: string;
} = {}): PlanInput {
  const body: Json = {
    initiative_id: 'm-1', assets: o.assets ?? [asset(1), asset(2)],
  };
  if (o.context !== null) body.label_context = o.context ?? CONTEXT;
  return {
    assetsJson: JSON.stringify(body),
    templatesJson: o.templatesText
      ?? JSON.stringify({ initiative_id: 'm-1', templates: o.templates ?? [template('t-203')] }),
    kind: o.kind ?? 'top',
    dpi: o.dpi ?? 203,
  };
}

function choice(id: string, o: Partial<TemplateChoice> = {}): TemplateChoice {
  return {
    id, family: o.family ?? id, label_type: o.label_type ?? 'top', dpi_key: o.dpi_key ?? '203',
    version: o.version ?? 1, updated_at: o.updated_at ?? '2026-10-01', scope: o.scope ?? 'global',
  };
}

describe('pickTemplate', () => {
  const top = [
    choice('generic', { family: 'Generic Rack and RU', scope: 'global' }),
    choice('global', { scope: 'global' }),
    choice('source', { scope: 'source' }),
    choice('dest', { scope: 'destination' }),
  ];

  it('picks Top: destination, then source, then global, then generic', () => {
    const ids: string[] = [];
    let left = [...top];
    while (left.length) {
      const [picked, notes] = pickTemplate(left, 'top', '203');
      expect(notes).toEqual([]);
      ids.push(picked!.id);
      left = left.filter((t) => t.id !== picked!.id);
    }
    expect(ids).toEqual(['dest', 'source', 'global', 'generic']);
    // "both" counts as the destination
    expect(pickTemplate([...top, choice('both', { scope: 'both', version: 2 })], 'top', '203')[0]!.id)
      .toBe('both');
    // the generic family is never a global pick, whatever its scope says
    expect(pickTemplate([choice('g', { family: 'GENERIC rack AND ru', scope: 'global' })], 'top', '203')[0]!.id)
      .toBe('g');
  });

  it('picks Front: destination, then global, never source or generic', () => {
    const front = top.map((t) => ({ ...t, label_type: 'front' }));
    expect(pickTemplate(front, 'front', '203')[0]!.id).toBe('dest');
    const noDest = front.filter((t) => t.id !== 'dest');
    expect(pickTemplate(noDest, 'front', '203')[0]!.id).toBe('global');
    expect(pickTemplate(noDest.filter((t) => t.id !== 'global'), 'front', '203')).toEqual([null, []]);
    // a Top template is never a Front pick
    expect(pickTemplate(top, 'front', '203')).toEqual([null, []]);
  });

  it('falls through a step with no version at the DPI and says so', () => {
    const templates = [
      choice('d-203', { family: 'Dest', scope: 'destination', dpi_key: '203' }),
      choice('s-203', { family: 'Src', scope: 'source', dpi_key: '203' }),
      choice('g-300', { family: 'Glob', scope: 'global', dpi_key: '300' }),
    ];
    const [picked, notes] = pickTemplate(templates, 'top', '300');
    expect(picked!.id).toBe('g-300');
    expect(notes).toEqual([
      'The destination site\'s Top template "Dest" isn\'t available at 300 DPI.',
      'The source site\'s Top template "Src" isn\'t available at 300 DPI.',
    ]);
    const front = [
      choice('fd', { family: 'Front Dest', label_type: 'front', scope: 'both', dpi_key: '300' }),
      choice('fg', { family: 'Front Glob', label_type: 'front', scope: 'global', dpi_key: '300' }),
      choice('gen', { family: 'Generic Rack and RU', label_type: 'top', dpi_key: '300' }),
    ];
    expect(pickTemplate(front, 'front', '203')).toEqual([null, [
      'The destination site\'s Front template "Front Dest" isn\'t available at 203 DPI.',
      'The global Front template "Front Glob" isn\'t available at 203 DPI.',
    ]]);
    expect(pickTemplate([front[2]], 'top', '203')[1]).toEqual([
      'The fallback Top template "Generic Rack and RU" isn\'t available at 203 DPI.',
    ]);
  });

  it('breaks ties by version, then newest updated_at, then the first listed', () => {
    const tied = [
      choice('a', { version: 2, updated_at: '2026-10-01' }),
      choice('b', { version: 3, updated_at: '2026-01-01' }),
      choice('c', { version: 3, updated_at: '2026-02-01' }),
      choice('d', { version: 3, updated_at: '2026-02-01' }),
    ];
    expect(pickTemplate(tied, 'top', '203')[0]!.id).toBe('c');
    // the note names the best of the step too
    expect(pickTemplate(tied, 'top', '300')[1]).toEqual([
      'The global Top template "c" isn\'t available at 300 DPI.',
    ]);
    // updated_at compares by code point, as Python does (not UTF-16 units)
    const astral = [choice('bmp', { updated_at: '￿' }), choice('astral', { updated_at: '\u{10000}' })];
    expect(pickTemplate(astral, 'top', '203')[0]!.id).toBe('astral');
  });
});

describe('templateSchema and templateFonts', () => {
  const py = (v: unknown): PyDict => parsePyJson(JSON.stringify(v)) as PyDict;

  it('reads the schema like the server, schema_version included', () => {
    expect(templateSchema(py(template('c', { kind: 'code', code: '^XA^XZ' })))).toBe(1);
    expect(templateSchema(py(template('d')))).toBe(1);
    expect(templateSchema(py({ ...template('v', { design: VEGAS }), schema_version: 2 }))).toBe(2);
    for (const odd of [true, '3', null, [3]]) {
      expect(templateSchema(py(template('d', { design: { ...DESIGN, schema: odd } })))).toBe(1);
    }
    expect(templateSchema(parsePyJson('{"kind": "design", "design": {"schema": 3.0}}') as PyDict)).toBe(1);
    expect(templateSchema(py(template('d', { design: { ...DESIGN, schema: 3 } })))).toBe(3);
    expect(templateSchema(py({ ...template('x', { kind: 'hologram' }), schema_version: 4 }))).toBe(4);
    expect(templateSchema(py({ ...template('d'), schema_version: true }))).toBe(1);
  });

  it('lists a design\'s fonts from its text, a code template\'s from its code', () => {
    expect(templateFonts(py({ ...template('v', { design: VEGAS }), schema_version: 2 })))
      .toEqual(['TT0003M_.TTF']);
    const code = '^XA^CWZ,e:arialbd.ttf^A@N,30,30E:ROBOTO.TTF^FDx^FS^A@N,1,1,R:NOPE.TTF^XZ';
    expect(templateFonts(py(template('c', { kind: 'code', code })))).toEqual(['ARIALBD.TTF', 'ROBOTO.TTF']);
    expect(templateFonts(null)).toEqual([]);
    // Python's IGNORECASE [A-Z] also takes these four letters; \s is str.isspace
    expect([...fontsUsed('^CWA,\x1cE:ſxı.TTF')]).toEqual(['SXI.TTF']);
  });
});

describe('label values', () => {
  it('builds the catalog from the asset and move, then the template rules', () => {
    const move = { name: 'Move 1', day: '2026-11-03', sourceSite: 'Old DC', destinationSite: 'New DC' };
    const a = {
      legacyId: parsePyJson('101'), name: 'web01-long', serialNumber: 'SN-1', make: 'Dell',
      model: 'R640', sourceRack: 'R1', sourceRu: '14.50', sourcePosition: 'R1.14',
      destinationRack: 'D9', destinationRu: '3.00', destinationPosition: null,
    };
    const rules = parsePyJson(JSON.stringify({
      source: { 1: 'src_rack', 2: 'src_slot', 3: 'src_none', x: 'bad' },
      length_limits: { asset_name: 6, serial_number: '2', make_model: 0 },
    })) as PyDict;
    expect({ ...assetLabelValues(a, move, [...CATALOG, 'destination_ru', 'unknown'], rules) }).toEqual({
      asset_id: '101', asset_name: 'web01-', serial_number: 'SN', make_model: 'Dell R640',
      source_ru: 'U14.5', source_raw: 'R1.14', destination_site: 'New DC',
      move_date: '11/03/2026', move_date_long: '03-NOV-2026', destination_ru: 'U3', unknown: '',
      src_rack: 'R1', src_slot: '14',
    });
  });

  it('gives a builder design the field values, From-To columns included', () => {
    const item = parsePyJson('{"id": "a-1", "asset_id": "7", "name": "web", "has_rails": true, '
      + '"vendor_involved": false, "asset_status": "racked", "asset_status_label": "", '
      + '"source_ru_raw": "", "source_ru": "12.00", "cable_info": {"data_2": "SW/2"}, '
      + '"raw_ft": {"Rack": 12.0, "Small": 1e-05, "Flag": true, "None": null}}');
    const values = fieldValues(item, parsePyJson('{"move_day": "2026-09-01T05:00:00Z", "move_code": 5}'));
    expect(values.asset_status).toBe('racked');
    expect(values.has_rails).toBe('Yes');
    expect(values.vendor_involved).toBe('No');
    expect(values.source_ru).toBe('12');
    expect(values.cable_data_2).toBe('SW/2');
    expect(values.move_date_long).toBe('01-SEP-2026');
    expect(values.move_code).toBe('5');
    expect(values['ft:Rack']).toBe('12.0');
    expect(values['ft:Small']).toBe('1e-05');
    expect(values['ft:Flag']).toBe('Yes');
    expect(values['ft:None']).toBe('');
  });

  it('reads the keys a design places and the mock values a sample prints', () => {
    const design = { schema: 2, elements: [
      { type: 'field', field: 'asset_name' }, { type: 'qr', field: 'ft:Rack' },
      { type: 'image', field: 'photo' }, { type: 'field', field: '' }, { type: 'text' },
    ] };
    expect([...designFieldKeys(parsePyJson(JSON.stringify(design)))].sort()).toEqual(['asset_name', 'ft:Rack']);
    expect(designFieldKeys(parsePyJson('{"schema": 2.0, "elements": [{"field": "x"}]}')).size).toBe(0);
    const mock = mockFieldValues('top', new Set(['ft:Rack', 'asset_name']));
    expect(mock['ft:Rack']).toBe('Rack');
    expect(mock.destination_ru).toBe('12');
    expect(mock.container_name).toBeUndefined();
    expect(mockFieldValues('container', new Set(['ft:Rack']))['ft:Rack']).toBeUndefined();
    expect(MOCK_VALUES.badge_short).toBe('3f2a9c1e');
  });
});

describe('buildPlan', () => {
  it('fingerprints every job no_template when nothing is at the DPI', () => {
    const plan = buildPlan(input({ dpi: 300, templates: [template('t-203')] }));
    expect(plan.templateId).toBeNull();
    expect(plan.templateFamily).toBeNull();
    expect(plan.notes).toEqual(['The destination site\'s Top template "Rack" isn\'t available at 300 DPI.']);
    expect(plan.availableDpis).toEqual([203]);
    expect(plan.fonts).toEqual([]);
    expect(plan.hasAssetData).toBe(true);
    expect(plan.jobs).toEqual([
      { assetId: 'a-1', fingerprint: fingerprint(['no_template', 300, 'top']) },
      { assetId: 'a-2', fingerprint: fingerprint(['no_template', 300, 'top']) },
    ]);
    expect(renderLabels(input({ dpi: 300 }), ['a-1']).map((r) => r.outcome)).toEqual(['no_template_at_dpi']);
  });

  it('lists the DPIs a printer would need, in natural order', () => {
    const plan = buildPlan(input({ dpi: 600, templates: [
      template('a', { dpi: '1200' }), template('b', { dpi: '300' }), template('c', { dpi: '203' }),
      template('f', { dpi: '152', labelType: 'front' }),
    ] }));
    expect(plan.availableDpis).toEqual([203, 300, 1200]);
    expect(availableDpis([choice('x', { label_type: 'front', dpi_key: '152' })], 'front')).toEqual([152]);
    expect(buildPlan(input()).availableDpis).toEqual([]);
  });

  it('makes schema 3 and newer template_unsupported, never compiled', () => {
    const image = { id: 'photo', type: 'image', source: 'photo', x: 0.1, y: 0.1, w: 0.8, h: 1.0 };
    const badge = { ...VEGAS, schema: 3, elements: [...VEGAS.elements, image] };
    const t = { ...template('v-203', { design: badge }), schema_version: 3 };
    const plan = buildPlan(input({ templates: [t] }));
    expect(plan.templateId).toBe('v-203');
    expect(plan.jobs[0].fingerprint)
      .toBe(fingerprint(['unsupported', 'v-203', 1, 3, 2, 203, 'top']));
    expect(renderLabels(input({ templates: [t] }), ['a-1', 'a-2'])).toEqual([
      { assetId: 'a-1', zpl: null, outcome: 'template_unsupported', fingerprint: plan.jobs[0].fingerprint },
      { assetId: 'a-2', zpl: null, outcome: 'template_unsupported', fingerprint: plan.jobs[1].fingerprint },
    ]);
    // schema_version alone says it too (a kind this generator doesn't know)
    const newer = { ...template('n'), schema_version: 4 };
    expect(renderLabels(input({ templates: [newer] }), ['a-1'])[0].outcome).toBe('template_unsupported');
  });

  it('gives a schema 2 design only the fields it places, From-To columns included', () => {
    const design = { ...VEGAS, elements: [...VEGAS.elements,
      { id: 'ft', type: 'field', field: 'ft:Rack Notes', x: 0.1, y: 1.8, w: 1, h: 0.1 }] };
    const item = {
      ...asset(1), asset_status: 'racked', asset_status_label: 'Racked', owner: 'Ops',
      raw_ft: { 'Rack Notes': 12, Other: 'x' },
    };
    const t = { ...template('v-203', { design }), schema_version: 2 };
    const plan = planWithValues(input({ assets: [item], templates: [t] }));
    const placed = [...designFieldKeys(parsePyJson(JSON.stringify(design)))].sort();
    expect(Object.keys(plan.jobs[0].values).sort()).toEqual(placed);
    expect(plan.jobs[0].values['ft:Rack Notes']).toBe('12');
    // a field the design doesn't print changes nothing
    const moved = planWithValues(input({ assets: [{ ...item, owner: 'Other', asset_status_label: 'Lost' }],
      templates: [t] }));
    expect(moved.jobs[0].fingerprint).toBe(plan.jobs[0].fingerprint);
    const renamed = planWithValues(input({ assets: [{ ...item, name: 'web99' }], templates: [t] }));
    expect(renamed.jobs[0].fingerprint).not.toBe(plan.jobs[0].fingerprint);
  });

  it('prints the Vegas golden from a sync item and label_context', () => {
    const item = {
      id: 'a-1', asset_id: '100000', legacy_id: 100000, name: 'SAMPLE-SERVER-01',
      rfid: '000000000000000000100000', serial_number: 'SN0000001', make: 'Dell',
      model: 'PowerEdge R740', make_model: 'Dell PowerEdge R740', source_rack: '09.01.05D.02.10',
      source_ru: '12', source_ru_raw: '12.00', destination_rack: '14.01.07C.02.03',
      destination_ru: '12', destination_ru_raw: '12.00', raw_ft: null,
    };
    const context = {
      move_name: 'Sample Move', move_code: 'SMPL', move_day: '2026-09-01',
      source_site: 'Sample Site A', source_site_code: 'SITE-A',
      destination_site: 'Sample Site B', destination_site_code: 'SITE-B', catalog_keys: CATALOG,
    };
    const t = { ...template('v-300', { family: 'Vegas', dpi: '300', design: VEGAS }), schema_version: 2 };
    const results = renderLabels(input({ assets: [item], templates: [t], context, dpi: 300 }), ['a-1']);
    expect(results[0].outcome).toBe('ok');
    expect(results[0].zpl).toBe(VEGAS_ZPL);
  });

  it('gives a code template or schema 1 design the catalog values with generation rules', () => {
    const rules = { source: { 1: 'src_rack', 2: 'src_slot' }, length_limits: { asset_name: 3 } };
    const plan = planWithValues(input({ templates: [template('t-203', { rules })] }));
    expect({ ...plan.jobs[0].values }).toEqual({
      asset_id: '101', asset_name: 'web', serial_number: 'SN1', make_model: 'Dell R640',
      source_ru: 'U14.5', source_raw: 'R1.14', destination_site: 'New DC',
      move_date: '11/03/2026', move_date_long: '03-NOV-2026', src_rack: 'R1', src_slot: '14',
    });
    const code = template('c-203', { kind: 'code', code: '^XA^FD{asset_name}^FS^FD{nope}^FS^XZ' });
    expect(renderLabels(input({ templates: [code] }), ['a-1'])[0])
      .toMatchObject({ zpl: '^XA^FDweb01^FS^FD^FS^XZ', outcome: 'ok' });
    const v1 = renderLabels(input(), ['a-1'])[0];
    expect(v1.outcome).toBe('ok');
    expect(v1.zpl).toContain('web01 / U14.5');
  });

  it('changes every fingerprint with the kind, the DPI or the template', () => {
    const both = [template('t-203'), template('t-300', { dpi: '300' }),
      template('f-203', { labelType: 'front' })];
    const fp = (o: Parameters<typeof input>[0]) => buildPlan(input({ templates: both, ...o })).jobs[0].fingerprint;
    const base = fp({});
    expect(fp({ dpi: 300 })).not.toBe(base);
    expect(fp({ kind: 'front' })).not.toBe(base);
    expect(fp({ templates: [{ ...both[0], version: 2 }] })).not.toBe(base);
    expect(fp({ templates: [{ ...both[0], width_in: 4.5 }] })).not.toBe(base);
    expect(fp({ templates: [{ ...both[0], language_key: 'zpl2' }] })).not.toBe(base);
    expect(fp({})).toBe(base);
    expect(base).toMatch(/^[0-9a-f]{14}$/);
  });

  it('has no jobs and says so without label_context', () => {
    const plan = buildPlan(input({ context: null }));
    expect(plan.hasAssetData).toBe(false);
    expect(plan.jobs).toEqual([]);
    expect(plan.templateId).toBe('t-203');
    expect(buildPlan({ ...input(), assetsJson: 'not json' }).hasAssetData).toBe(false);
  });

  it('skips asset rows with no id and names the rest as text', () => {
    const plan = buildPlan(input({ assets: [asset(1, { id: '' }), asset(2, { id: 7 }), 'x' as unknown as Json] }));
    expect(plan.jobs.map((j) => j.assetId)).toEqual(['7']);
  });
});

describe('renderLabels outcomes', () => {
  it('fails a design without a size or DPI, but not a code template', () => {
    for (const missing of ['width_in', 'height_in', 'dots']) {
      for (const bad of [null, 0]) {
        const t = { ...template('t-203'), [missing]: bad };
        expect(renderLabels(input({ templates: [t] }), ['a-1'])[0].outcome).toBe('template_failed');
      }
    }
    const code = { ...template('c', { kind: 'code', code: '^XA^XZ' }), width_in: null, height_in: null, dots: null };
    expect(renderLabels(input({ templates: [code] }), ['a-1'])[0]).toMatchObject({ zpl: '^XA^XZ', outcome: 'ok' });
  });

  it('fails a design the compiler refuses', () => {
    const broken = { elements: [{ type: 'text', x: -1, y: 0, w: 1, h: 1, content: '{asset_name}' }] };
    expect(renderLabels(input({ templates: [template('t', { design: broken })] }), ['a-1'])[0])
      .toMatchObject({ zpl: null, outcome: 'template_failed' });
  });

  it('reads the template set as Python does: 2.0 is a float', () => {
    const text = JSON.stringify({ templates: [template('t', { design: VEGAS })] })
      .replace('"schema":2', '"schema":2.0');
    // design.schema 2.0 is not an int: schema 1 to the edge, which parse_design refuses
    expect(renderLabels(input({ templatesText: text }), ['a-1'])[0].outcome).toBe('template_failed');
    const lines = JSON.stringify({ templates: [template('t', { design: {
      elements: [{ type: 'text', x: 0.1, y: 0.1, w: 2, h: 0.3, content: 'x', lines: 2 }] } })] })
      .replace('"lines":2', '"lines":2.0');
    expect(renderLabels(input({ templatesText: lines }), ['a-1'])[0].outcome).toBe('template_failed');
  });

  it('makes a non-ZPL template template_unsupported (Ruling 7)', () => {
    for (const language of ['escp', 'ptouch']) {
      for (const kind of ['code', 'design']) {
        const t = { ...template('t', { kind, code: '^XA^XZ' }), language_key: language };
        expect(renderLabels(input({ templates: [t] }), ['a-1'])[0].outcome).toBe('template_unsupported');
      }
    }
  });

  it('fails a label that prints a value Python would not take as text', () => {
    const code = (c: string) => [template('c', { kind: 'code', code: c })];
    const odd = [asset(1, { name: 123 })];
    expect(renderLabels(input({ assets: odd, templates: code('^FD{asset_name}^FS') }), ['a-1'])[0].outcome)
      .toBe('template_failed');
    expect(renderLabels(input({ assets: odd, templates: code('^FD{asset_id}^FS') }), ['a-1'])[0])
      .toMatchObject({ zpl: '^FD101^FS', outcome: 'ok' });
    // a design prints a list the way zpl.py's _esc iterates it; a code template can't
    const listed = [asset(1, { source_position: ['R', '^', '', '~_'] })];
    const v1 = { elements: [{ type: 'text', x: 0.1, y: 0.1, w: 2, h: 0.3, content: '[{source_raw}]', fontSizePt: 10 }] };
    const keys = { ...CONTEXT, catalog_keys: ['source_raw'] };
    expect(renderLabels(input({ assets: listed, context: keys, templates: [template('d', { design: v1 })] }),
      ['a-1'])[0].zpl).toContain('^FD[R_5e_7e_5f]^FS');
    expect(renderLabels(input({ assets: listed, context: keys, templates: code('^FD{source_raw}^FS') }),
      ['a-1'])[0].outcome).toBe('template_failed');
    const bad = [asset(1, { source_position: ['ab'] })];
    expect(renderLabels(input({ assets: bad, context: keys, templates: [template('d', { design: v1 })] }),
      ['a-1'])[0].outcome).toBe('template_failed');
  });

  it('renders only the requested assets, in the order asked', () => {
    const results = renderLabels(input({ assets: [asset(1), asset(2), asset(3)] }), ['a-3', 'nope', 'a-1']);
    expect(results.map((r) => r.assetId)).toEqual(['a-3', 'a-1']);
    const plan = buildPlan(input({ assets: [asset(1), asset(2), asset(3)] }));
    expect(results[0].fingerprint).toBe(plan.jobs[2].fingerprint);
  });
});

describe('the bundle surface', () => {
  it('installs globalThis.labelgen, JSON in and out, errors as {error}', async () => {
    const { surface, VERSION } = await import('./index');
    expect(globalThis.labelgen).toBe(surface);
    expect(surface.version).toBe(VERSION);
    const args = { ...input({ dpi: 300 }), assetIds: ['a-2'] };
    expect(JSON.parse(surface.buildPlan(JSON.stringify(args)))).toEqual(buildPlan(input({ dpi: 300 })));
    expect(JSON.parse(surface.renderLabels(JSON.stringify(args))))
      .toEqual({ results: renderLabels(input({ dpi: 300 }), ['a-2']) });
    expect(JSON.parse(surface.sampleLabel(JSON.stringify({ templatesJson: args.templatesJson, kind: 'top', dpi: 300 }))))
      .toEqual({ zpl: null, reason: 'The destination site\'s Top template "Rack" isn\'t available at 300 DPI.' });
    expect(JSON.parse(surface.applyPrintSettings('{"zpl": "^XA^XZ", "verticalOffset": 4, "horizontalOffset": 0}')))
      .toEqual({ zpl: '^XA\n^LT4^XZ' });
    expect(JSON.parse(surface.withPrintMode('{"zpl": "^XA^XZ", "peel": true}'))).toEqual({ zpl: '^XA^MMP^XZ' });
    expect(JSON.parse(surface.alignmentTestZpl('{"widthDots": 100, "heightDots": 60, "sizeLabel": "x", "dpi": 203}')).zpl)
      .toMatch(/^\^XA\n\^PW100\n/);
    for (const bad of ['nope', '[]', '{"kind": "top"}', '{"assetsJson": "{}", "templatesJson": "{}", "kind": "side", "dpi": 203}',
      '{"assetsJson": "{}", "templatesJson": "{}", "kind": "top", "dpi": 20.5}']) {
      expect(Object.keys(JSON.parse(surface.buildPlan(bad)))).toEqual(['error']);
    }
    expect(JSON.parse(surface.renderLabels(JSON.stringify({ ...args, assetIds: 'a-1' }))).error)
      .toBe('assetIds must be a list of strings');
  });
});
