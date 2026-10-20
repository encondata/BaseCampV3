/**
 * What the builder panels' tests share (only tests import this file): the
 * Canvas tests' tiny fake font, a field catalog in the shape
 * GET /labels/fields returns, the Vegas fixture and its sample values.
 *
 * The fake font: every digit is 400 units wide, every capital 450 (the
 * widest), lower case 400, anything else 300, on a 1000-unit em with ascent
 * 750 and descent 250, for every family and weight.
 */

import vegas from '../../../../../api/src/serversherpa/labels/fixtures/vegas_v2.json';
import { faceFile, type FontWeight } from '../../../labels/builder/fonts';
import { cssFamilyOf, type FontMetrics, type LoadedFont } from '../../../labels/builder/metrics';
import { parseDesign, type DesignV2, type ElementV2 } from '../../../labels/builder/model';
import type { LabelFields } from '../../../lib/api';

function fakeAdvances(): Record<string, number> {
  const out: Record<string, number> = {};
  for (let c = 32; c < 127; c++) {
    const ch = String.fromCharCode(c);
    out[ch] = /[0-9]/.test(ch) ? 400 : /[A-Z]/.test(ch) ? 450 : /[a-z]/.test(ch) ? 400 : 300;
  }
  return out;
}

export const FAKE_METRICS: FontMetrics = { unitsPerEm: 1000, ascent: 750, descent: 250, advances: fakeAdvances() };

export function fakeMetricsFor(family: string, weight: FontWeight): LoadedFont {
  return { face: null, metrics: FAKE_METRICS, cssFamily: cssFamilyOf(faceFile({ family, weight })) };
}

export const FIELDS: LabelFields = {
  groups: [
    {
      key: 'asset', label: 'Asset', label_types: ['top', 'front', 'rail'], fields: [
        { key: 'asset_id', label: 'Asset ID', kind: 'number', mock: '100000' },
        { key: 'asset_name', label: 'Asset name', kind: 'text', mock: 'SAMPLE-SERVER-01' },
        { key: 'serial_number', label: 'Serial number', kind: 'text', mock: 'SN0000001' },
        { key: 'rfid_tag', label: 'RFID tag', kind: 'text', mock: '000000000000000000100000' },
      ],
    },
    {
      key: 'model', label: 'Make & model', label_types: ['top', 'front', 'rail'], fields: [
        { key: 'make_model', label: 'Make + model', kind: 'text', mock: 'Dell PowerEdge R740' },
      ],
    },
    {
      key: 'move_row', label: 'On this move', label_types: ['top', 'front', 'rail'], fields: [
        { key: 'source_rack', label: 'Source rack', kind: 'text', mock: '09.01.05D.02.10' },
        { key: 'destination_rack', label: 'Destination rack', kind: 'text', mock: '14.01.07C.02.03' },
        { key: 'destination_ru', label: 'Destination RU', kind: 'number', mock: '12' },
      ],
    },
    {
      key: 'move', label: 'Move', label_types: ['top', 'front', 'rail', 'container', 'container_info'], fields: [
        { key: 'move_date', label: 'Move date', kind: 'date', mock: '09/01/2026' },
      ],
    },
    {
      key: 'sites', label: 'Sites', label_types: ['top', 'front', 'rail', 'container', 'container_info'], fields: [
        { key: 'origin_site_code', label: 'Origin site code', kind: 'text', mock: 'SITE-A' },
      ],
    },
  ],
  ft_headers: ['Data 2', 'Data 10', 'Notes'],
};

/** GET /labels/fields?label_type=id_badge: the Person group only, no
 *  From-To columns (labels/fields.py, keys in its order). */
export const PERSON_FIELDS: LabelFields = {
  groups: [{
    key: 'person', label: 'Person', label_types: ['id_badge'], fields: ([
      ['person_name', 'Name'], ['first_name', 'First name'], ['last_name', 'Last name'],
      ['preferred_name', 'Preferred name'], ['person_type', 'Person type'], ['company', 'Company'],
      ['parent_company', 'Parent company'], ['job_title', 'Job title'], ['roles', 'Roles'], ['trade', 'Trade'],
      ['level', 'Level'], ['worker_status', 'Worker status'], ['employee_id', 'Employee ID'], ['email', 'Email'],
      ['phone', 'Phone'], ['person_rfid_tag', 'RFID tag'], ['badge_id', 'Badge ID'], ['badge_short', 'Badge ID (short)'],
    ] as const).map(([key, label]) => ({ key, label, kind: 'text' as const, mock: '' })),
  }],
  ft_headers: [],
};

export const SAMPLES: Record<string, string> = {
  destination_rack: '14.01.07C.02.03',
  destination_ru: '23',
  asset_name: 'lvn-hm1w2-vc1-c1n7',
  serial_number: '36B7144',
  make_model: 'Dell R660',
  asset_id: '10482',
  origin_site_code: 'LVN14',
  move_date: '10/07/2026',
};

export const VEGAS = (): DesignV2 => parseDesign(vegas);

export function elementOf(d: DesignV2, id: string): ElementV2 {
  const found = d.elements.find((e) => e.id === id);
  if (!found) throw new Error(`no ${id}`);
  return found;
}

/** The Vegas fixture cut down to the elements with these ids. */
export function vegasWith(...ids: string[]): DesignV2 {
  const d = VEGAS();
  return { ...d, elements: d.elements.filter((e) => ids.includes(e.id)) };
}
