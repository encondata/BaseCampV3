import { describe, expect, it } from 'vitest';

// The same cases pin the API's labels/field_rules.py, so the canvas shows
// exactly what the compiler prints.
import fixture from '../../../api/src/serversherpa/labels/fixtures/field_rules.json';
import { applyRules, isBlank, piece, splitValue, type FieldRules } from './fieldRules';

/** The fixture is written in the API's snake_case; the portal's keys are camelCase. */
function toRules(raw: Record<string, unknown>): FieldRules {
  return Object.fromEntries(
    Object.entries(raw).map(([k, v]) => [k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()), v]),
  ) as FieldRules;
}

describe('field rules fixture', () => {
  it.each(fixture.cases)('$name', ({ value, rules, expected, blank }) => {
    expect(applyRules(value, toRules(rules))).toBe(expected);
    expect(isBlank(value, toRules(rules))).toBe(blank);
  });

  it('maps every snake_case rule key the fixture uses', () => {
    const keys = new Set(fixture.cases.flatMap((c) => Object.keys(toRules(c.rules))));
    for (const k of keys) {
      expect(['display', 'expectedLength', 'maxChars', 'trim', 'strip', 'stripWhere']).toContain(k);
    }
  });
});

describe('splitValue and piece', () => {
  it('splits on dots only and picks pieces, blank when missing', () => {
    expect(splitValue('14.01.07C.02.03')).toEqual(['14', '01', '07C', '02', '03']);
    expect(splitValue('')).toEqual(['']);
    expect(piece('14.01.07C.02.03', 2)).toBe('07C');
    // a value with fewer pieces than the sample prints the missing ones blank
    expect(piece('ORD1-F01', 0)).toBe('ORD1-F01');
    expect(piece('ORD1-F01', 1)).toBe('');
    expect(piece('', 0)).toBe('');
    expect(piece('14.01', -1)).toBe('');
  });
});
