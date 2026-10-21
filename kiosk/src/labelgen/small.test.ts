/** The small label modules, each a port of its labels/<name>.py: tokens,
 *  container tags, font families, barcode widths, QR sizing and the field
 *  rules pipeline. The barcode and field rules cases are the API's own
 *  shared fixtures, so the port prints what the compiler prints. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { barcodeModules, code128Data, code128Subset } from './barcode';
import { DesignError } from './errors';
import { applyRules, isBlank, piece, splitValue, type FieldRules } from './fieldRules';
import {
  DEFAULT_FAMILY, FAMILIES, RESIDENT_FONT, WEIGHTS, fontObject, objectFamily, residentObject,
} from './fonts';
import { QR_FO_OFFSET_IN, QrTooLong, qrFoOffsetDots, qrModules } from './qr';
import {
  LABEL_TAG_ASSIGNMENT_ORDER, LABEL_TAG_KEYS, LABEL_TAG_LABELS, resolveLabelTag,
} from './tags';
import { TOKEN_RE, applyPlaceholders, resolveTokens } from './tokens';

const FIXTURES = new URL('../../../api/src/serversherpa/labels/fixtures/', import.meta.url);
const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(name, FIXTURES), 'utf8')) as T;

describe('tokens', () => {
  it('substitutes every token, unknown ones blank', () => {
    expect(applyPlaceholders('{a}-{zz}', { a: '1' })).toBe('1-');
    expect(applyPlaceholders('{A} {a-b} {}', { a: '1' })).toBe('{A} {a-b} {}');
    expect(applyPlaceholders('{a}{a}', { a: 'x' })).toBe('xx');
  });

  it('never reads a value off the object prototype', () => {
    expect(applyPlaceholders('{constructor}{__proto__}', {})).toBe('');
  });

  it('leaves tokens intact without substitutions', () => {
    expect(resolveTokens('{a}', null)).toBe('{a}');
    expect(resolveTokens('{a}{b}', { b: '2' })).toBe('2');
  });

  it('matches the Python pattern', () => {
    expect(TOKEN_RE.source).toBe('\\{([a-z0-9_]+)\\}');
  });
});

describe('tags', () => {
  it('lists the keys in display and assignment order', () => {
    expect(LABEL_TAG_KEYS).toEqual(['priority', 'vendor', 'accessories', 'ewaste', 'warehouse']);
    expect(LABEL_TAG_ASSIGNMENT_ORDER)
      .toEqual(['priority', 'vendor', 'accessories', 'warehouse', 'ewaste']);
    expect(LABEL_TAG_LABELS.ewaste).toBe('E-Waste');
  });

  it('resolves a key or a label, ignoring case and whitespace', () => {
    expect(resolveLabelTag(' ewaste ')).toBe('ewaste');
    expect(resolveLabelTag('E-Waste')).toBe('ewaste');
    expect(resolveLabelTag('VENDOR')).toBe('vendor');
    expect(resolveLabelTag('constructor')).toBeNull();
    expect(resolveLabelTag('nope')).toBeNull();
  });
});

describe('fonts', () => {
  it('maps a weight to its printer object, faux bold where there is no Bold file', () => {
    expect(fontObject('roboto', 'regular')).toEqual(['ROBOTO_R.TTF', false]);
    expect(fontObject('roboto', 'bold')).toEqual(['ROBOTO_B.TTF', false]);
    expect(fontObject(DEFAULT_FAMILY, 'regular')).toEqual([RESIDENT_FONT, false]);
    expect(fontObject(DEFAULT_FAMILY, 'bold')).toEqual([RESIDENT_FONT, true]);
  });

  it('refuses an unknown weight or family', () => {
    expect(() => fontObject('roboto', 'light')).toThrow();
    expect(() => fontObject('comic-sans', 'regular')).toThrow();
  });

  it('knows the eight families and only the Swiss 721 cut is resident', () => {
    expect(Object.keys(FAMILIES)).toEqual([
      'swiss721-cond-bold', 'roboto-condensed', 'roboto', 'oswald', 'roboto-mono',
      'ibm-plex-mono', 'atkinson-hyperlegible', 'source-sans-3',
    ]);
    expect(WEIGHTS).toEqual(['regular', 'bold']);
    expect(RESIDENT_FONT).toBe('TT0003M_.TTF');
    expect(residentObject('tt0003m_.ttf')).toBe(true);
    expect(residentObject('ROBOTO_R.TTF')).toBe(false);
    expect(objectFamily('roboco_b.ttf')).toEqual(['roboto-condensed', 'bold']);
    expect(objectFamily('ARIAL.TTF')).toBeNull();
  });

  it('names every object as an 8.3 .TTF file', () => {
    for (const fam of Object.values(FAMILIES)) {
      for (const obj of [fam.objects.regular, fam.objects.bold]) {
        if (obj !== null) expect(obj).toMatch(/^[A-Z0-9_]{1,8}\.TTF$/);
      }
    }
  });
});

interface BarcodeCase {
  name: string; symbology: 'code128' | 'code39'; value: string;
  subset: 'B' | 'C' | null; modules: number; data?: string;
}

describe('barcode fixture (labels/fixtures/barcode_modules.json)', () => {
  const { cases } = fixture<{ cases: BarcodeCase[] }>('barcode_modules.json');

  it.each(cases)('$name', (c) => {
    expect(barcodeModules(c.symbology, c.value)).toBe(c.modules);
    if (c.symbology === 'code128') expect(code128Subset(c.value)).toBe(c.subset);
    if (c.data !== undefined) expect(code128Data(c.value)).toBe(c.data);
  });
});

describe('qr', () => {
  it('sizes a value like qr.py (test_labels_zpl_v2.py cases)', () => {
    expect(qrModules('10482')).toBe(21);
    expect(qrModules('0'.repeat(34))).toBe(21);
    expect(qrModules('0'.repeat(35))).toBe(25);
    expect(qrModules('RACK-14 $%*+./:')).toBe(21);
    expect(qrModules('A'.repeat(21))).toBe(25);
    expect(qrModules('sample-server-1')).toBe(25);
    expect(qrModules('s'.repeat(14))).toBe(21);
    expect(qrModules('é'.repeat(7))).toBe(21);
    expect(qrModules('é'.repeat(14))).toBe(29);
    expect(qrModules('')).toBe(21);
    expect(qrModules('0'.repeat(513))).toBe(57);
    expect(qrModules('٣'.repeat(20))).toBe(29);
  });

  it('raises QrTooLong, a DesignError, past version 10', () => {
    let caught: unknown;
    try {
      qrModules('x'.repeat(214));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(QrTooLong);
    expect(caught).toBeInstanceOf(DesignError);
    expect((caught as QrTooLong).problems)
      .toEqual(['QR data too long for version 10 at error correction M (214 bytes)']);
    expect((caught as QrTooLong).message)
      .toBe('QR data too long for version 10 at error correction M (214 bytes)');
  });

  it('puts ^FO 0.2 in above the symbol', () => {
    expect(QR_FO_OFFSET_IN).toBe(0.2);
    expect(qrFoOffsetDots(203)).toBe(41);
    expect(qrFoOffsetDots(300)).toBe(60);
    expect(qrFoOffsetDots(600)).toBe(120);
  });
});

interface RulesCase { name: string; value: string; rules: FieldRules; expected: string; blank: boolean }

describe('field rules fixture (labels/fixtures/field_rules.json)', () => {
  const { cases } = fixture<{ cases: RulesCase[] }>('field_rules.json');

  it.each(cases)('$name', ({ value, rules, expected, blank }) => {
    expect(applyRules(value, rules)).toBe(expected);
    expect(isBlank(value, rules)).toBe(blank);
  });
});

describe('field rules', () => {
  it('splits on dots only and picks pieces, blank when missing', () => {
    expect(splitValue('')).toEqual(['']);
    expect(splitValue('a.b-c.d')).toEqual(['a', 'b-c', 'd']);
    expect(piece('a.b', 1)).toBe('b');
    expect(piece('a.b', 2)).toBe('');
    expect(piece('a.b', -1)).toBe('');
  });

  it('trims and pads in code points', () => {
    expect(applyRules('😀😀😀', { max_chars: 2, trim: 'front' })).toBe('😀😀');
    expect(applyRules('.5', { display: 'number', expected_length: 2 })).toBe('00.5');
    expect(applyRules('xxaxx', { strip: 'x', strip_where: 'rear' })).toBe('xxa');
    expect(applyRules('', { display: 'number', expected_length: 3 })).toBe('');
  });
});
