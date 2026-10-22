/**
 * The send-time print helpers equal the portal's and the kiosk's originals
 * (they are ported, not imported: the bundle can't reach either), and the
 * mock-data sample label renders the picked template.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  alignmentTestZpl as portalAlignment, applyPrintSettings as portalApply,
  DEFAULT_PRINT_SETTINGS,
} from '@portal/lib/printLabels';
import { withPrintMode as kioskWithPrintMode } from '../lib/stationPrinter';

import { alignmentTestZpl, applyPrintSettings, sampleLabel, withPrintMode } from './printing';

const FIXTURES = new URL('../../../api/src/serversherpa/labels/fixtures/', import.meta.url);
const fixtureText = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');
const VEGAS = JSON.parse(fixtureText('vegas_v2.json'));

const SAMPLES: [string, number, number][] = [
  ['^XA^PW812^FO10,10^FDx^FS^XZ', 0, 0],
  ['^XA^PW812^FO10,10^FDx^FS^XZ', 12, -7],
  ['^xa^LS5^pw600^MMT^FDy^FS^xz', -4, 3],
  ['^XA^LS-20^PW406\n^FDz^FS^XZ\n^XA^PW406^XZ', 30, 0],
  ['no zpl here', 5, 5],
];

describe('print helpers', () => {
  it('applyPrintSettings matches the portal, one copy', () => {
    for (const [zpl, verticalOffset, horizontalOffset] of SAMPLES) {
      const s = { ...DEFAULT_PRINT_SETTINGS, verticalOffset, horizontalOffset, copies: 3 };
      expect(applyPrintSettings(zpl, s, { singleCopy: true })).toBe(portalApply(zpl, s, { singleCopy: true }));
      expect(applyPrintSettings(zpl, s)).toBe(portalApply(zpl, s));
    }
  });

  it('withPrintMode matches the kiosk', () => {
    const labels = ['^XA^FDx^FS^XZ', '^xa^MMP,N^FDx^XZ^XA^mmt^XZ', '^XA^MMC^MMA,y^XZ', '', 'plain'];
    for (const zpl of labels) {
      for (const peel of [true, false]) expect(withPrintMode(zpl, peel)).toBe(kioskWithPrintMode(zpl, peel));
    }
  });

  it('alignmentTestZpl matches the portal', () => {
    const sizes: [number, number, string, number][] = [
      [812, 406, '4x2', 203], [1200, 600, '4x2', 300], [100, 100, '0.5x0.5', 203],
      [203, 1015, '1x5', 203], [49, 49, 'tiny', 600],
    ];
    for (const args of sizes) expect(alignmentTestZpl(...args)).toBe(portalAlignment(...args));
  });
});

const template = (over: Record<string, unknown>) => ({
  id: 't', family: 'Rack', label_type: 'top', dpi_key: '203', version: 1,
  updated_at: '2026-10-01', scope: 'destination', language_key: 'zpl', kind: 'code',
  code: '', design: null, generation_rules: {}, width_in: 4.0, height_in: 2.0, dots: 203,
  ...over,
});
const templatesJson = (...templates: unknown[]) => JSON.stringify({ templates });

describe('sampleLabel', () => {
  it('renders a builder design with the builder mock values', () => {
    const t = template({ kind: 'design', design: VEGAS, dpi_key: '300', dots: 300, schema_version: 2 });
    expect(sampleLabel(templatesJson(t), 'top', 300))
      .toEqual({ zpl: fixtureText('vegas_v2_300.zpl').slice(0, -1), reason: null });
  });

  it('fills a code template with the placeholder mocks and its rules', () => {
    const t = template({
      code: '^XA^FD{asset_name}|{source_ru}|{src_room}|{asset_id}|{nope}^FS^XZ',
      generation_rules: { source: { 1: 'src_room' }, length_limits: { asset_name: 6 } },
    });
    expect(sampleLabel(templatesJson(t), 'top', 203))
      .toEqual({ zpl: '^XA^FDSAMPLE|U12|A1|100000|^FS^XZ', reason: null });
  });

  it('says why when nothing can print', () => {
    expect(sampleLabel(templatesJson(template({ code: '^XA^XZ' })), 'top', 300)).toEqual({
      zpl: null, reason: 'The destination site\'s Top template "Rack" isn\'t available at 300 DPI.',
    });
    expect(sampleLabel(templatesJson(), 'front', 203)).toEqual({ zpl: null, reason: 'no_template_at_dpi' });
    expect(sampleLabel(templatesJson(template({ language_key: 'escp' })), 'top', 203))
      .toEqual({ zpl: null, reason: 'template_unsupported' });
    expect(sampleLabel(templatesJson(template({ kind: 'design', design: { elements: 1 } })), 'top', 203))
      .toEqual({ zpl: null, reason: 'template_failed' });
  });
});
