import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_FAMILY, FONT_FAMILIES, FONT_SAMPLE, STAND_IN, faceFile, familyInfo, fauxBold,
  glyphWidthScale, metricsFile,
} from './fonts';

const FONTS_PY = join(__dirname, '../../../../api/src/serversherpa/labels/fonts.py');

describe('font families', () => {
  it('mirrors FAMILIES in labels/fonts.py, in order', () => {
    const src = readFileSync(FONTS_PY, 'utf8');
    const rows = [...src.matchAll(/"([a-z0-9-]+)": _family\("([^"]+)", "[^"]+", (None|"[^"]+")([^)]*)\)/g)]
      .map((m) => ({
        slug: m[1],
        label: m[2],
        bold: m[3] !== 'None',
        resident: /resident=True/.test(m[4]),
        mono: /mono=True/.test(m[4]),
      }));
    expect(rows).toHaveLength(8);
    expect(FONT_FAMILIES.map(({ slug, label, bold, resident, mono }) => ({ slug, label, bold, resident, mono })))
      .toEqual(rows);
  });

  it('defaults to the resident Swiss cut and samples with 0O 1Il 7', () => {
    expect(DEFAULT_FAMILY).toBe('swiss721-cond-bold');
    expect(familyInfo(DEFAULT_FAMILY)?.resident).toBe(true);
    expect(FONT_SAMPLE).toBe('0O 1Il 7');
    expect(familyInfo('nope')).toBeUndefined();
  });
});

describe('which file draws and which file measures', () => {
  const swiss = { family: 'swiss721-cond-bold', weight: 'regular' } as const;
  const swissBold = { family: 'swiss721-cond-bold', weight: 'bold' } as const;
  const robotoBold = { family: 'roboto', weight: 'bold' } as const;

  it('draws the resident family with Roboto Condensed Bold over its own metrics', () => {
    expect(STAND_IN).toEqual({ family: 'roboto-condensed', weight: 'bold' });
    expect(faceFile(swiss)).toEqual(STAND_IN);
    expect(faceFile(swissBold)).toEqual(STAND_IN);
    expect(metricsFile(swiss)).toEqual(swiss);
  });

  it('measures Bold on a family with no Bold file with its Regular file (faux bold)', () => {
    expect(metricsFile(swissBold)).toEqual(swiss);
    expect(fauxBold(swissBold)).toBe(true);
    expect(fauxBold(swiss)).toBe(false);
    expect(fauxBold(robotoBold)).toBe(false);
    expect(metricsFile(robotoBold)).toEqual(robotoBold);
    expect(faceFile(robotoBold)).toEqual(robotoBold);
  });

  it('widens glyphs 15% only for faux bold on an inverted element', () => {
    expect(glyphWidthScale(swissBold, true)).toBe(1.15);
    expect(glyphWidthScale(swissBold, false)).toBe(1);
    expect(glyphWidthScale(robotoBold, true)).toBe(1);
    expect(glyphWidthScale(swiss, true)).toBe(1);
  });
});
