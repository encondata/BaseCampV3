/**
 * lib/listTools.tsx: csvCell — the CSV field encoder used by exportCsv.
 * Covers the existing quoting rules and the OWASP formula-injection
 * guard (values starting with = + - @ are prefixed with a single quote,
 * except purely numeric values like "-5" which are real data).
 */

import { describe, expect, it } from 'vitest';

import { csvCell } from './listTools';

describe('csvCell quoting (existing behavior)', () => {
  it('passes plain values through untouched', () => {
    expect(csvCell('hello')).toBe('hello');
    expect(csvCell('')).toBe('');
  });

  it('quotes values containing commas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
  });

  it('quotes and doubles embedded quotes', () => {
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
  });

  it('quotes values containing newlines', () => {
    expect(csvCell('line1\nline2')).toBe('"line1\nline2"');
  });
});

describe('csvCell formula-injection guard', () => {
  it('neutralizes = formulas', () => {
    expect(csvCell('=HYPERLINK("http://evil")')).toBe(
      '"\'=HYPERLINK(""http://evil"")"',
    );
    expect(csvCell('=1+1')).toBe("'=1+1");
  });

  it('neutralizes + prefixed values', () => {
    expect(csvCell('+cmd|calc')).toBe("'+cmd|calc");
  });

  it('neutralizes - prefixed values', () => {
    expect(csvCell('-cmd|calc')).toBe("'-cmd|calc");
  });

  it('neutralizes @ prefixed values', () => {
    expect(csvCell('@SUM(1,2)')).toBe('"\'@SUM(1,2)"');
  });

  it('leaves purely numeric values alone (negative numbers are data)', () => {
    // Decision: only escape when the value is NOT purely numeric —
    // lists legitimately export negative/signed numbers like "-5".
    expect(csvCell('-5')).toBe('-5');
    expect(csvCell('-5.25')).toBe('-5.25');
    expect(csvCell('+12')).toBe('+12');
  });
});
