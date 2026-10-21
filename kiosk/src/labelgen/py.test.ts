/** Python-compatible primitives the label generator is built on: round()
 *  half to even, floor division, code-point strings, str() of JSON values,
 *  Decimal text and ISO dates. Expected values were read off CPython 3.13. */
import { describe, expect, it } from 'vitest';

import {
  cpLength, cpSlice, dateFromIsoformat, decimalNormalize, floorDiv, formatRu, moveDates,
  pyRound, pyStr, pyStrip, pyText, rjust, utf8Encode, utf8Length,
} from './py';
import { parsePyJson } from './pyjson';

describe('pyRound', () => {
  it('rounds halves to even, like Python round()', () => {
    expect(pyRound(2.5)).toBe(2);
    expect(pyRound(3.5)).toBe(4);
    expect(pyRound(-2.5)).toBe(-2);
    expect(pyRound(0.5)).toBe(0);
    expect(pyRound(1.5)).toBe(2);
    expect(pyRound(-0.5)).toBe(0);
  });

  it('rounds everything else to the nearest integer', () => {
    expect(pyRound(2.4999)).toBe(2);
    expect(pyRound(2.5001)).toBe(3);
    expect(pyRound(-2.6)).toBe(-3);
    expect(pyRound(40.6)).toBe(41);
    expect(pyRound(0.2 * 300)).toBe(60);
    expect(pyRound(7)).toBe(7);
  });

  it('refuses a value Python cannot round to an int', () => {
    expect(() => pyRound(Number.NaN)).toThrow();
    expect(() => pyRound(Infinity)).toThrow();
  });
});

describe('floorDiv', () => {
  it('floors toward negative infinity', () => {
    expect(floorDiv(-3, 2)).toBe(-2);
    expect(floorDiv(3, 2)).toBe(1);
    expect(floorDiv(-4, 2)).toBe(-2);
    expect(floorDiv(7, -2)).toBe(-4);
  });
});

describe('code-point strings', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(cpLength('a😀')).toBe(2);
    expect(cpLength('')).toBe(0);
  });

  it('slices like Python, negative indices included', () => {
    expect(cpSlice('a😀bc', 0, 2)).toBe('a😀');
    expect(cpSlice('a😀bc', -2)).toBe('bc');
    expect(cpSlice('a😀bc', 1)).toBe('😀bc');
    expect(cpSlice('abc', 0, -1)).toBe('ab');
    expect(cpSlice('abc', 5)).toBe('');
    expect(cpSlice('abc', -10, 2)).toBe('ab');
  });

  it('right-justifies to a width in code points', () => {
    expect(rjust('7', 3, '0')).toBe('007');
    expect(rjust('😀', 3, '0')).toBe('00😀');
    expect(rjust('1234', 3, '0')).toBe('1234');
  });

  it('strips Python whitespace, which is not JavaScript trim()', () => {
    expect(pyStrip(' \x1c\x85a b\t\n')).toBe('a b');
    expect(pyStrip('\ufeffa')).toBe('\ufeffa');
  });
});

describe('utf8', () => {
  it('encodes code points as UTF-8 bytes', () => {
    expect(utf8Encode('aé😀')).toEqual([0x61, 0xc3, 0xa9, 0xf0, 0x9f, 0x98, 0x80]);
    expect(utf8Length('é'.repeat(7))).toBe(14);
  });

  it('refuses a lone surrogate, like str.encode("utf-8")', () => {
    expect(() => utf8Encode('a\ud800')).toThrow();
  });
});

describe('pyStr of parsed JSON', () => {
  const s = (json: string) => pyStr(parsePyJson(json));

  it('prints numbers the way Python prints them', () => {
    expect(s('12.0')).toBe('12.0');
    expect(s('7')).toBe('7');
    expect(s('1e-5')).toBe('1e-05');
    expect(s('1e16')).toBe('1e+16');
    expect(s('1e15')).toBe('1000000000000000.0');
    expect(s('0.1')).toBe('0.1');
    expect(s('0.0001')).toBe('0.0001');
    expect(s('0.00001')).toBe('1e-05');
    expect(s('-0.0')).toBe('-0.0');
    expect(s('-0')).toBe('0');
    expect(s('1E2')).toBe('100.0');
    expect(s('1e400')).toBe('inf');
    expect(s('-1e400')).toBe('-inf');
    expect(s('5e-324')).toBe('5e-324');
    expect(s('1.5e300')).toBe('1.5e+300');
    expect(s('123456789012345678901234567890')).toBe('123456789012345678901234567890');
    expect(s('123456789012345680000.0')).toBe('1.2345678901234568e+20');
    expect(s('1.7976931348623157e308')).toBe('1.7976931348623157e+308');
    expect(s('-1.5e-7')).toBe('-1.5e-07');
  });

  it('prints constants and containers as Python repr', () => {
    expect(s('true')).toBe('True');
    expect(s('false')).toBe('False');
    expect(s('null')).toBe('None');
    expect(s('{"a":1}')).toBe("{'a': 1}");
    expect(s('[]')).toBe('[]');
    expect(s('{}')).toBe('{}');
    expect(s('[1,"a",null,true,{"x":"it\'s"}]')).toBe(`[1, 'a', None, True, {'x': "it's"}]`);
    expect(s('{"k": {"n": [true, false, null]}, "s": "x"}'))
      .toBe("{'k': {'n': [True, False, None]}, 's': 'x'}");
    expect(s('[1.0e+2, 1e22, 2.5e-5, 0.0]')).toBe('[100.0, 1e+22, 2.5e-05, 0.0]');
  });

  it('keeps key order, the last duplicate wins in the first position', () => {
    expect(s('{"b":1,"a":2,"b":3}')).toBe("{'b': 3, 'a': 2}");
    expect(s('{"2":1,"1":2}')).toBe("{'2': 1, '1': 2}");
  });

  it('quotes and escapes strings inside containers like repr', () => {
    expect(s(String.raw`["say \"hi\" it's", "it's", "say \"hi\""]`))
      .toBe(`['say "hi" it\\'s', "it's", 'say "hi"']`);
    expect(s(String.raw`["\u0085\u00a0\u00ad\u2028\u007f\u0378\ue000\t\r\u0000\u001fÿĀ"]`))
      .toBe(String.raw`['\x85\xa0\xad\u2028\x7f\u0378\ue000\t\r\x00\x1f` + 'ÿĀ\']');
    expect(s(String.raw`["a\\b\n", "😀", "\udfff\ud83d"]`))
      .toBe(String.raw`['a\\b\n', '` + '😀' + String.raw`', '\udfff\ud83d']`);
  });

  it('prints a top-level string as itself', () => {
    expect(s('"it\'s \\"x\\""')).toBe('it\'s "x"');
  });
});

describe('pyText (fields._text)', () => {
  it('blanks None, says Yes/No for booleans, str() for the rest', () => {
    expect(pyText(parsePyJson('null'))).toBe('');
    expect(pyText(parsePyJson('true'))).toBe('Yes');
    expect(pyText(parsePyJson('false'))).toBe('No');
    expect(pyText(parsePyJson('"x"'))).toBe('x');
    expect(pyText(parsePyJson('12.0'))).toBe('12.0');
    expect(pyText(parsePyJson('[1]'))).toBe('[1]');
    expect(pyText(undefined)).toBe('');
  });
});

describe('decimalNormalize (format(Decimal(t).normalize(), "f"))', () => {
  it.each([
    ['14.50', '14.5'], ['3.0', '3'], ['-0', '-0'], ['-0.0', '-0'], ['0.00', '0'],
    ['1E+2', '100'], ['1e-7', '0.0000001'], ['  14 ', '14'], ['1_000', '1000'],
    ['1__0', '10'], ['_1', '1'], ['1_', '1'], ['+5', '5'], ['.5', '0.5'], ['5.', '5'],
    ['1._5', '1.5'], ['1e_5', '100000'], ['0e5', '0'], ['-0e-3', '-0'],
    ['1.0E+30', '1000000000000000000000000000000'], ['1.5E-3', '0.0015'],
    ['\u00a014\u2003', '14'],
    // 28 significant digits, half to even
    ['1.23456789012345678901234567890123', '1.234567890123456789012345679'],
    ['99999999999999999999999999999', '100000000000000000000000000000'],
    ['12345678901234567890123456785', '12345678901234567890123456780'],
    ['0.000123456789012345678901234567850', '0.0001234567890123456789012345678'],
  ])('%j -> %j', (text, expected) => {
    expect(decimalNormalize(text)).toBe(expected);
  });

  it.each(['x', '', '1,0', '1 0', '_', '.', 'e5', '1e', '+-1', 'NaN', 'Inf', '-infinity', 'sNaN'])(
    '%j is not a finite decimal', (text) => {
      expect(decimalNormalize(text)).toBeNull();
    });
});

describe('formatRu (label_values._format_ru)', () => {
  it.each([
    ['14.00', 'U14'], ['14.50', 'U14.5'], ['14', 'U14'], ['-0.0', 'U0'], ['1E+2', 'U100'],
    ['1e-7', 'U0.0000001'], ['.5', 'U0.5'],
    ['1.23456789012345678901234567890123', 'U1.23456789012345678901234567890123'],
    ['99999999999999999999999999999', 'U99999999999999999999999999999'],
    ['NaN', 'UNaN'], ['nan123', 'UNaN123'], ['-NaN', 'U-NaN'],
  ])('%j -> %j', (text, expected) => {
    expect(formatRu(text)).toBe(expected);
  });

  it('is blank for no value or text Decimal refuses (the edge passes None)', () => {
    expect(formatRu(null)).toBe('');
    expect(formatRu('')).toBe('');
    expect(formatRu('x')).toBe('');
  });

  it('fails where Python fails (int(Infinity), comparing sNaN)', () => {
    expect(() => formatRu('Infinity')).toThrow();
    expect(() => formatRu('sNaN')).toThrow();
  });
});

describe('dates', () => {
  it('formats a move day both ways', () => {
    expect(moveDates('2026-10-05')).toEqual(['10/05/2026', '05-OCT-2026']);
    expect(moveDates('2026-01-31')).toEqual(['01/31/2026', '31-JAN-2026']);
  });

  it('is blank for no day or one date.fromisoformat refuses', () => {
    expect(moveDates(null)).toEqual(['', '']);
    expect(moveDates('')).toEqual(['', '']);
    expect(moveDates('2026-02-30')).toEqual(['', '']);
    expect(moveDates('2026-10-05T00:00:00')).toEqual(['', '']);
  });

  it('reads every form date.fromisoformat reads', () => {
    expect(dateFromIsoformat('20261005')).toEqual({ year: 2026, month: 10, day: 5 });
    expect(dateFromIsoformat('2026-W41')).toEqual({ year: 2026, month: 10, day: 5 });
    expect(dateFromIsoformat('2026W41')).toEqual({ year: 2026, month: 10, day: 5 });
    expect(dateFromIsoformat('2026-W41-3')).toEqual({ year: 2026, month: 10, day: 7 });
    expect(dateFromIsoformat('2026W413')).toEqual({ year: 2026, month: 10, day: 7 });
    expect(dateFromIsoformat('2020-W53-7')).toEqual({ year: 2021, month: 1, day: 3 });
    expect(dateFromIsoformat('2026-W53')).toEqual({ year: 2026, month: 12, day: 28 });
    expect(dateFromIsoformat('2025-W53')).toBeNull();
    expect(dateFromIsoformat('0001-W01-1')).toEqual({ year: 1, month: 1, day: 1 });
    expect(dateFromIsoformat('9999-W52-6')).toBeNull();
    // CPython's C parser stops after the date and never looks at the rest
    expect(dateFromIsoformat('2026100512')).toEqual({ year: 2026, month: 10, day: 5 });
    expect(dateFromIsoformat('2026W413xx')).toEqual({ year: 2026, month: 10, day: 7 });
    expect(dateFromIsoformat('2026-W4')).toBeNull();
    expect(dateFromIsoformat('+026-10-05')).toBeNull();
    expect(dateFromIsoformat('2026-W00')).toBeNull();
    expect(dateFromIsoformat('2026-W41-8')).toBeNull();
    expect(dateFromIsoformat('2026-10')).toBeNull();
    expect(dateFromIsoformat('2026-1005')).toBeNull();
    expect(dateFromIsoformat('0000-01-01')).toBeNull();
    expect(dateFromIsoformat('2024-02-29')).toEqual({ year: 2024, month: 2, day: 29 });
    expect(dateFromIsoformat('2026-10-0é')).toBeNull();
  });
});
