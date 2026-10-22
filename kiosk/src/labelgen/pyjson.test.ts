/** The number-preserving JSON reader: numbers keep their literal text and
 *  whether Python reads them as int or float, objects keep key order (a
 *  Map, so "2" stays before "1"), and the last duplicate key wins. */
import { describe, expect, it } from 'vitest';

import { isPyDict, isPyNumber, parsePyJson, type PyValue } from './pyjson';

describe('parsePyJson', () => {
  it('keeps every number as Python reads it', () => {
    expect(parsePyJson('7')).toEqual({ kind: 'int', text: '7' });
    expect(parsePyJson('-12')).toEqual({ kind: 'int', text: '-12' });
    expect(parsePyJson('12.0')).toEqual({ kind: 'float', text: '12.0' });
    expect(parsePyJson('1e5')).toEqual({ kind: 'float', text: '1e5' });
    expect(parsePyJson('123456789012345678901234567890'))
      .toEqual({ kind: 'int', text: '123456789012345678901234567890' });
  });

  it('reads the constants, strings and containers', () => {
    expect(parsePyJson(' null ')).toBeNull();
    expect(parsePyJson('true')).toBe(true);
    expect(parsePyJson('false')).toBe(false);
    expect(parsePyJson('"a\\u00e9\\n\\ud83d\\ude00"')).toBe('aé\n😀');
    const list = parsePyJson('[1, "x", []]') as PyValue[];
    expect(list).toHaveLength(3);
    expect(list[1]).toBe('x');
    expect(list[2]).toEqual([]);
  });

  it('reads objects into a Map in key order, last duplicate wins', () => {
    const dict = parsePyJson('{"b": 1, "2": 2, "1": 3, "b": 4}');
    expect(isPyDict(dict)).toBe(true);
    if (!isPyDict(dict)) return;
    expect([...dict.keys()]).toEqual(['b', '2', '1']);
    expect(dict.get('b')).toEqual({ kind: 'int', text: '4' });
    expect(isPyNumber(dict.get('2'))).toBe(true);
  });

  it('accepts the non-standard constants Python json accepts', () => {
    expect(parsePyJson('NaN')).toEqual({ kind: 'float', text: 'NaN' });
    expect(parsePyJson('-Infinity')).toEqual({ kind: 'float', text: '-Infinity' });
  });

  it('accepts whatever JSON.parse accepts', () => {
    const samples = [
      '{"a":[1,2,{"b":null}],"c":"d\\"e","f":-0.5e-3}', '[]', '{}', '""', '"\\/"',
      ' \t\n\r[ 1 , 2 ]\n', '"\\ud800"', '0', '-0', '1E+2', '[[[[]]]]',
    ];
    for (const s of samples) expect(() => parsePyJson(s)).not.toThrow();
  });

  it.each([
    '', '01', '1.', '.5', '+1', '[1,]', '{"a":1,}', "'a'", '"a\tb"', '{a:1}', 'tru', '1 2',
    '"\\x41"', '[', '{"a" 1}', '\ufeff1', 'nan', 'infinity',
  ])('refuses %j like Python json and JSON.parse', (s) => {
    expect(() => parsePyJson(s)).toThrow();
  });
});
