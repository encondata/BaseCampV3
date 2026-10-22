/** The design model, the ZPL compiler and render: ports of labels/model.py,
 *  zpl.py and render.py. The expected strings are the Python tests' own
 *  (api/tests/test_labels_zpl.py, test_labels_zpl_v2.py), and the Vegas
 *  golden is the API's shared fixture, so the port prints what the laptop
 *  prints. */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DesignError } from './errors';
import { MOCK_VALUES } from './fixtures/mockValues';
import { elementHidden, elementValue, parseDesign, type FieldEl } from './model';
import { parsePyJson } from './pyjson';
import { QrTooLong } from './qr';
import { UnsupportedLanguage, renderTemplate } from './render';
import { compileZpl } from './zpl';

const FIXTURES = new URL('../../../api/src/serversherpa/labels/fixtures/', import.meta.url);
const fixtureText = (name: string): string => readFileSync(new URL(name, FIXTURES), 'utf8');

type Json = Record<string, unknown>;

const RACK = { destination_rack: '14.01.07C.02.03' };
const SPLITS = { destination_rack: { pieces: ['NAP', 'Sector', 'POD', 'Row', 'Rack'] } };
const SWISS = { family: 'swiss721-cond-bold', weight: 'regular' };
const SWISS_BOLD = { family: 'swiss721-cond-bold', weight: 'bold' };
const HEAD = ['^XA', '^PW1200', '^LL600', '^CI28'];
const PAD_20_10 = { x: 0.0667, y: 0.0333 }; // 20 / 10 dots at 300

/** The Vegas POD cell: x 400, top 28, 150 wide, baseline 100 (300 dpi). */
function field(kw: Json = {}): Json {
  return {
    id: 'f1', type: 'field', field: 'destination_rack', piece: 2,
    x: 1.3333, y: 0.0933, w: 0.5, h: 0.24, rotation: 0,
    display: 'text', font: SWISS, sizePt: 24, baselineIn: 0.24, align: 'left', ...kw,
  };
}

function v2(elements: Json[], { values = RACK as Record<string, string>, dpi = 300, splits = SPLITS as Json } = {}) {
  const design = parseDesign({ schema: 2, size: { w: 4, h: 2 }, splits, elements });
  return compileZpl(design, dpi, values);
}

function body(out: string): string[] {
  const lines = out.split('\n');
  expect(lines.slice(0, 4)).toEqual(['^XA', `^PW${lines[1].slice(3)}`, `^LL${lines[2].slice(3)}`, '^CI28']);
  expect(lines[lines.length - 1]).toBe('^XZ');
  return lines.slice(4, -1);
}

const data = (out: string): string[] => [...out.matchAll(/\^FD(.*?)\^FS/g)].map((m) => m[1]);

function v1(elements: Json[], size = { w: 4, h: 2 }) {
  return parseDesign({ size, elements });
}

describe('the Vegas golden', () => {
  it('compiles byte for byte to vegas_v2_300.zpl', () => {
    const design = parseDesign(JSON.parse(fixtureText('vegas_v2.json')));
    const golden = fixtureText('vegas_v2_300.zpl');
    expect(golden.endsWith('\n')).toBe(true);
    expect(compileZpl(design, 300, MOCK_VALUES)).toBe(golden.slice(0, -1));
  });

  it('compiles the same from the number-preserving reader', () => {
    const design = parseDesign(parsePyJson(fixtureText('vegas_v2.json')));
    expect(compileZpl(design, 300, MOCK_VALUES)).toBe(fixtureText('vegas_v2_300.zpl').slice(0, -1));
  });
});

describe('schema 1', () => {
  const SIMPLE = [{ id: 't1', type: 'text', x: 0.25, y: 0.5, w: 2, h: 0.3, rotation: 0,
    content: 'Hello', fontSizePt: 12, bold: false, align: 'left' }];

  it('compiles a simple text at 203 and 300', () => {
    expect(compileZpl(v1(SIMPLE), 203)).toBe(
      '^XA\n^PW812\n^LL406\n^CI28\n^FO51,102^A0N,34,34^FH_^FDHello^FS\n^XZ');
    const out = compileZpl(v1(SIMPLE), 300);
    expect(out).toContain('^PW1200');
    expect(out).toContain('^LL600');
    expect(out).toContain('^FO75,150^A0N,50,50');
  });

  it('keeps tokens without substitutions and fills them with', () => {
    const d = v1([{ id: 't1', type: 'text', x: 0, y: 0, w: 2, h: 0.3, rotation: 0,
      content: 'SN: {serial_number} {unknown_key}', fontSizePt: 10, bold: false, align: 'left' }]);
    expect(compileZpl(d, 203)).toContain('^FDSN: {serial_number} {unknown_key}^FS');
    expect(compileZpl(d, 203, null)).toContain('^FDSN: {serial_number} {unknown_key}^FS');
    expect(compileZpl(d, 203, { serial_number: 'C7X-0042' })).toContain('^FDSN: C7X-0042 ^FS');
    // a substituted value is escaped; the literal around it too
    const nasty = v1([{ id: 't1', type: 'text', x: 0, y: 0, w: 2, h: 0.3, rotation: 0,
      content: 'a^b~c_d {k}', fontSizePt: 10, bold: false, align: 'left' }]);
    expect(data(compileZpl(nasty, 203, { k: 'é_^' }))).toEqual(['a_5eb_7ec_5fd _c3_a9_5f_5e']);
    // a lookup reads the values' own keys only
    expect(data(compileZpl(nasty, 203, {}))).toEqual(['a_5eb_7ec_5fd ']);
  });

  it('compiles the kitchen sink at 203', () => {
    const out = compileZpl(v1([
      { id: 'b1', type: 'barcode', x: 0.1, y: 0.6, w: 3, h: 0.8, rotation: 0,
        symbology: 'code128', data: '{asset_id}', showText: true },
      { id: 'b2', type: 'barcode', x: 0.1, y: 1.5, w: 3, h: 0.3, rotation: 0,
        symbology: 'code39', data: 'A1', showText: false },
      { id: 'q1', type: 'qr', x: 3.2, y: 0.2, w: 0.7, h: 0.7, rotation: 0, data: '{asset_id}' },
      { id: 'l1', type: 'line', x: 0, y: 0.5, w: 4, h: 0, rotation: 0, strokeIn: 0.01 },
      { id: 'x1', type: 'box', x: 0.05, y: 0.05, w: 3.9, h: 1.9, rotation: 0, strokeIn: 0.02 },
      { id: 't1', type: 'text', x: 0.1, y: 0.1, w: 3.8, h: 0.3, rotation: 0, content: 'MID',
        fontSizePt: 10, bold: true, align: 'center' },
    ]), 203);
    expect(body(out)).toEqual([
      '^FO20,122^BY2^BCN,162,Y,N,N^FH_^FD{asset_id}^FS',
      '^FO20,304^BY2^B3N,N,61,N,N^FH_^FDA1^FS',
      '^FO650,41^BQN,2,6^FH_^FDQA,{asset_id}^FS',
      '^FO0,102^GB812,2,2^FS',
      '^FO10,10^GB792,386,4^FS',
      '^FO20,20^FB771,1,0,C,0^A0N,28,34^FH_^FDMID^FS',
    ]);
    // a literal `>` in schema 1 Code 128 data is `>0`, with no start code
    const gt = v1([{ id: 'b1', type: 'barcode', x: 0, y: 0, w: 1, h: 0.2, rotation: 0,
      symbology: 'code128', data: 'A>B' }]);
    expect(data(compileZpl(gt, 203))).toEqual(['A>0B']);
  });

  it('turns, reverses, wraps and sizes the barcode module', () => {
    const rot = v1([{ id: 't1', type: 'text', x: 0, y: 0, w: 1, h: 0.3, rotation: 90,
      content: 'R', fontSizePt: 10, bold: false, align: 'left' }], { w: 2, h: 2 });
    expect(compileZpl(rot, 203)).toContain('^A0R,28,28');
    const qr = v1([{ id: 'q1', type: 'qr', x: 0, y: 0, w: 0.7, h: 0.7, rotation: 90,
      data: '{asset_id}' }], { w: 2, h: 2 });
    expect(compileZpl(qr, 203)).toContain('^BQR,2,');
    const rev = v1([{ id: 't1', type: 'text', x: 0.2, y: 0.5, w: 3.6, h: 0.36, rotation: 0,
      content: 'PRIORITY', fontSizePt: 26, bold: true, align: 'center', reverse: true }], { w: 4, h: 6 });
    expect(compileZpl(rev, 203)).toContain('^FR^FH_^FDPRIORITY^FS');
    const wrap = v1([{ id: 't1', type: 'text', x: 0.2, y: 0.5, w: 3.6, h: 1.0, rotation: 0,
      content: '{container_name}', fontSizePt: 28, bold: true, align: 'left', lines: 2 }], { w: 4, h: 6 });
    expect(compileZpl(wrap, 203)).toContain('^FB731,2,0,L,0');
    const mod = v1([{ id: 'b1', type: 'barcode', x: 0.8, y: 1.6, w: 2.4, h: 1.2, rotation: 0,
      symbology: 'code128', data: 'crate-17', showText: false, moduleIn: 0.01 }], { w: 4, h: 6 });
    expect(compileZpl(mod, 203)).toContain('^BY2^BCN,244,N,N,N');
    expect(compileZpl(mod, 300)).toContain('^BY3^BCN,360,N,N,N');
  });
});

describe('schema 2 text', () => {
  it('sits on its ^FT baseline in a named font', () => {
    expect(v2([field()]).split('\n')).toEqual(
      [...HEAD, '^FT400,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD07C^FS', '^XZ']);
  });

  it('aligns center and right with a ^FB', () => {
    expect(body(v2([field({ align: 'center' })]))).toEqual([
      '^FT400,100^FB150,1,0,C,0^A@N,100,100,E:TT0003M_.TTF^FH_^FD07C^FS']);
    expect(v2([field({ align: 'right' })])).toContain('^FB150,1,0,R,0^A@');
    expect(v2([field({ align: 'left' })])).not.toContain('^FB');
  });

  it('inverts as a filled ^GB under ^FR text', () => {
    expect(body(v2([field({ inverted: true, invertPad: PAD_20_10 })]))).toEqual([
      '^FO380,18^GB190,92,92^FS',
      '^FT400,100^A@N,100,100,E:TT0003M_.TTF^FR^FH_^FD07C^FS']);
    // nothing to reverse prints nothing at all
    const blanks: Record<string, string>[] = [{}, { destination_rack: 'ORD1-F01' },
      { destination_rack: '14.01..02' }];
    for (const values of blanks) {
      expect(body(v2([field({ inverted: true })], { values }))).toEqual([]);
    }
    const caption = { id: 't1', type: 'text', content: '', font: SWISS, sizePt: 24,
      baselineIn: 0.24, inverted: true, x: 0, y: 0, w: 1, h: 0.24, rotation: 0 };
    expect(body(v2([caption]))).toEqual([]);
  });

  it('stops an inverted box at the label edge', () => {
    const edge = field({ x: 0, y: 0, inverted: true, invertPad: PAD_20_10 });
    expect(body(v2([edge]))[0]).toBe('^FO0,0^GB170,82,82^FS');
  });

  it('overprints faux bold one dot along the reading direction', () => {
    expect(body(v2([field({ font: SWISS_BOLD })]))).toEqual([
      '^FT400,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD07C^FS',
      '^FT401,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD07C^FS']);
    // a family with a Bold file uses it: one pass, the bold object
    expect(body(v2([field({ font: { family: 'roboto-condensed', weight: 'bold' } })]))).toEqual([
      '^FT400,100^A@N,100,100,E:ROBOCO_B.TTF^FH_^FD07C^FS']);
    expect(v2([field({ font: { family: 'roboto-condensed', weight: 'regular' } })]))
      .toContain('E:ROBOCO_R.TTF');
    // each rotation steps along its own reading direction
    const steps: [number, string, string][] = [
      [90, '^FT330,150^', '^FT330,151^'],
      [180, '^FT600,180^', '^FT599,180^'],
      [270, '^FT360,450^', '^FT360,449^'],
    ];
    for (const [rotation, first, second] of steps) {
      const out = body(v2([field({ font: SWISS_BOLD, rotation, x: 1, y: 0.5, w: 1, h: 0.3,
        baselineIn: 0.2 })]));
      expect(out.map((line) => line.slice(0, first.length))).toEqual([first, second]);
    }
    // the overprint never steps past the label's edge
    const atZero = body(v2([field({ font: SWISS_BOLD, rotation: 180, x: 0, y: 0, w: 0,
      h: 0.3, baselineIn: 0.2 })]));
    expect(atZero.map((line) => line.slice(0, 8))).toEqual(['^FT0,30^', '^FT0,30^']);
  });

  it('widens faux bold 15% on an inverted element instead', () => {
    expect(body(v2([field({ font: SWISS_BOLD, inverted: true, invertPad: PAD_20_10 })]))).toEqual([
      '^FO380,18^GB190,92,92^FS',
      '^FT400,100^A@N,100,115,E:TT0003M_.TTF^FR^FH_^FD07C^FS']);
  });

  it('anchors rotated text on its baseline', () => {
    const side = field({ field: 'move_date', piece: null, rotation: 270, x: 3.7587, y: 1.1,
      w: 0.8333, h: 0.108, sizePt: 10.8, baselineIn: 0.108 });
    const values = { move_date: '09/01/2026' };
    expect(body(v2([side], { values }))).toEqual([
      '^FT1160,580^A@B,45,45,E:TT0003M_.TTF^FH_^FD09/01/2026^FS']);
    const inv = { ...side, inverted: true, invertPad: PAD_20_10 };
    expect(body(v2([inv], { values }))[0]).toBe('^FO1118,310^GB52,290,52^FS');
    expect(v2([field({ rotation: 90, x: 1, y: 0.5, w: 1, h: 0.3, baselineIn: 0.2 })]))
      .toContain('^FT330,150^A@R,100,100,');
    expect(v2([field({ rotation: 180, x: 1, y: 0.5, w: 1, h: 0.3, baselineIn: 0.2 })]))
      .toContain('^FT600,180^A@I,100,100,');
  });

  it('applies Split pieces, number padding and the rules', () => {
    const pieces = [0, 1, 2, 3, 4].map((i) => field({ id: `p${i}`, piece: i }));
    const ru = field({ id: 'ru', field: 'destination_ru', piece: null, display: 'number',
      expectedLength: 2 });
    expect(data(v2([...pieces, ru], { values: { ...RACK, destination_ru: '3.5' } })))
      .toEqual(['14', '01', '07C', '02', '03', '03.5']);
    const rules = field({ id: 'r', field: 'asset_id', piece: null, strip: '0', stripWhere: null,
      maxChars: 3, trim: 'front' });
    expect(data(v2([rules], { values: { asset_id: '000123456' } }))).toEqual(['456']);
    expect(data(v2(pieces, { values: { destination_rack: 'A.B.C.D.E.F' } })))
      .toEqual(['A', 'B', 'C', 'D', 'E']);
    expect(data(v2(pieces, { values: { destination_rack: 'ORD1-F01' } })))
      .toEqual(['ORD1-F01', '', '', '', '']);
    // Max characters counts code points
    const emoji = field({ id: 'e', field: 'asset_name', piece: null, maxChars: 2 });
    expect(data(v2([emoji], { values: { asset_name: '😀é1' } }))).toEqual(['_f0_9f_98_80_c3_a9']);
  });

  it('hides when empty', () => {
    const hidden = field({ hideWhenEmpty: true });
    expect(body(v2([hidden], { values: { destination_rack: 'ORD1-F01' } }))).toEqual([]);
    expect(data(v2([hidden]))).toEqual(['07C']);
    const stripped = field({ field: 'asset_id', piece: null, strip: '0', hideWhenEmpty: true });
    expect(body(v2([stripped], { values: { asset_id: '000' } }))).toEqual([]);
    expect(data(v2([field()], { values: {} }))).toEqual(['']);
    const code = { id: 'b1', type: 'barcode', field: 'asset_id', symbology: 'code128',
      hideWhenEmpty: true, x: 0, y: 0, w: 1, h: 0.2, rotation: 0 };
    const qr = { id: 'q1', type: 'qr', field: 'asset_id', hideWhenEmpty: true,
      x: 0, y: 0, w: 0.5, h: 0.5, rotation: 0 };
    expect(body(v2([code, qr], { values: { asset_id: '' } }))).toEqual([]);
    expect(body(v2([code, qr], { values: { asset_id: '1' } }))).toHaveLength(2);
  });

  it('wraps static text and places lines and boxes', () => {
    const caption = { id: 't1', type: 'text', content: 'Name:', font: SWISS, sizePt: 10.08,
      baselineIn: 0.1008, x: 0.1267, y: 0.4759, w: 0.4667, h: 0.1008, rotation: 0 };
    const wrapped = { ...caption, id: 't2', lines: 2, content: 'Two lines' };
    const line = { id: 'l1', type: 'line', strokeIn: 0.017, x: 0.1, y: 1, w: 3.7, h: 0, rotation: 0 };
    const upright = { ...line, id: 'l2', w: 1, rotation: 90 };
    const box = { id: 'x1', type: 'box', strokeIn: 0.01, x: 0.1, y: 1.2, w: 1, h: 0.2, rotation: 0 };
    const filled = { ...box, id: 'x2', fill: true };
    expect(body(v2([caption, wrapped, line, upright, box, filled], { values: {} }))).toEqual([
      '^FT38,173^A@N,42,42,E:TT0003M_.TTF^FH_^FDName:^FS',
      '^FT38,215^FB140,2,0,L,0^A@N,42,42,E:TT0003M_.TTF^FH_^FDTwo lines^FS',
      '^FO30,300^GB1110,5,5^FS',
      '^FO30,300^GB5,300,5^FS',
      '^FO30,360^GB300,60,3^FS',
      '^FO30,360^GB300,60,60^FS']);
    const broken = { ...wrapped, content: 'Two\nlines' };
    expect(data(v2([broken], { values: {} }))).toEqual(['Two\\&lines']);
    expect(data(v2([{ ...broken, lines: 1 }], { values: {} }))).toEqual(['Twolines']);
    expect(data(v2([{ ...broken, content: 'a\r\nb\\c\rd' }], { values: {} })))
      .toEqual(['a\\&b_5cc\\&d']);
  });
});

describe('escaping (Porting rule 2)', () => {
  it('hex-escapes ^ ~ _ \\ and every non-ASCII UTF-8 byte, lowercase', () => {
    const name = field({ field: 'asset_name', piece: null });
    expect(data(v2([name], { values: { asset_name: 'a^b~c_d\\e é 😀\t\x7f' } }))).toEqual([
      'a_5eb_7ec_5fd_5ce _c3_a9 _f0_9f_98_80_09_7f']);
    expect(data(v2([name], { values: { asset_name: 'Café ☃ 1' } }))).toEqual(['Caf_c3_a9 _e2_98_83 1']);
    // v2 values are never token-expanded
    expect(data(v2([name], { values: { asset_name: '{asset_id}', asset_id: '1' } })))
      .toEqual(['{asset_5fid}']);
    // a lone surrogate can't be encoded, as in Python
    expect(() => v2([name], { values: { asset_name: 'a\ud800' } })).toThrow(RangeError);
  });

  it('escapes every kind of element the same way', () => {
    const nasty = 'X^XZ~JR';
    const out = v2([
      field({ field: 'asset_name', piece: null }),
      { id: 'q1', type: 'qr', field: 'asset_name', x: 1, y: 0.5, w: 0.49, h: 0.49, rotation: 0 },
      { id: 'b1', type: 'barcode', field: 'asset_name', symbology: 'code128', x: 0, y: 1, w: 2,
        h: 0.2, rotation: 0 },
      { id: 't1', type: 'text', content: 'a_b\\c', font: SWISS, sizePt: 10, baselineIn: 0.1,
        x: 0, y: 1.5, w: 1, h: 0.1, rotation: 0 },
    ], { values: { asset_name: nasty } });
    expect(data(out)).toEqual(['X_5eXZ_7eJR', 'MA,X_5eXZ_7eJR', '>:X_5eXZ_7eJR', 'a_5fb_5cc']);
    expect(out.split('^XZ')).toHaveLength(2);
    const gt = v2([
      field({ field: 'asset_name', piece: null }),
      { id: 'q1', type: 'qr', field: 'asset_name', x: 1, y: 0.5, w: 0.49, h: 0.49, rotation: 0 },
      { id: 'b1', type: 'barcode', field: 'asset_name', symbology: 'code128', x: 0, y: 1, w: 2,
        h: 0.2, rotation: 0 },
      field({ id: 'f2', field: 'asset_name', piece: null, display: 'barcode',
        symbology: 'code128', h: 0.2 }),
      { id: 'b2', type: 'barcode', field: 'asset_name', symbology: 'code39', x: 0, y: 1.3, w: 2,
        h: 0.2, rotation: 0 },
    ], { values: { asset_name: 'A>;B>' } });
    expect(data(gt)).toEqual(['A>;B>', 'MA,A>;B>', '>:A>0;B>0', '>:A>0;B>0', 'A>;B>']);
  });
});

describe('schema 2 codes', () => {
  const qr = { id: 'q1', type: 'qr', field: 'asset_id', x: 1, y: 0.5, w: 0.49, h: 0.49, rotation: 0 };

  it('sizes, centers and offsets a QR code', () => {
    const values = { asset_id: '100000' };
    expect(body(v2([qr], { values }))).toEqual(['^FO300,90^BQN,2,7^FH_^FDMA,100000^FS']);
    expect(body(v2([qr], { values, dpi: 600 }))).toEqual(['^FO642,222^BQN,2,10^FH_^FDMA,100000^FS']);
    const long = 'X'.repeat(26);
    expect(body(v2([qr], { values: { asset_id: long } }))).toEqual([
      `^FO298,88^BQN,2,6^FH_^FDMA,${long}^FS`]);
    expect(body(v2([qr], { values: { asset_id: 'é'.repeat(14) } }))).toEqual([
      `^FO301,91^BQN,2,5^FH_^FDMA,${'_c3_a9'.repeat(14)}^FS`]);
    const { field: _f, ...rest } = qr;
    expect(body(v2([{ ...rest, data: 'HELLO' }], { values: {} }))).toEqual([
      '^FO300,90^BQN,2,7^FH_^FDMA,HELLO^FS']);
    for (const [w, mag] of [[0.35, 5], [0.7, 10]]) {
      const q = { id: 'q1', type: 'qr', data: '100000', x: 1, y: 1, w, h: w, rotation: 0 };
      expect(body(v2([q], { values: {} }))).toEqual([`^FO300,240^BQN,2,${mag}^FH_^FDMA,100000^FS`]);
    }
    const top = { id: 'q1', type: 'qr', data: '100000', x: 1, y: 0.1, w: 0.49, h: 0.49, rotation: 0 };
    expect(body(v2([top], { values: {} }))).toEqual(['^FO300,0^BQN,2,7^FH_^FDMA,100000^FS']);
    expect(body(v2([{ ...top, y: 0.21 }], { values: {} }))).toEqual(['^FO300,3^BQN,2,7^FH_^FDMA,100000^FS']);
    // a symbol wider than its box centers with floor division: (10 - 21) // 2 is -6
    const small = { id: 'q1', type: 'qr', data: '100000', x: 1, y: 1, w: 0.0333, h: 0.0333, rotation: 0 };
    expect(body(v2([small], { values: {} }))).toEqual(['^FO294,234^BQN,2,1^FH_^FDMA,100000^FS']);
  });

  it('prints a QR code upright whatever its rotation', () => {
    for (const rotation of [90, 180, 270]) {
      expect(body(v2([{ ...qr, rotation }], { values: { asset_id: '100000' } }))).toEqual([
        '^FO300,90^BQN,2,7^FH_^FDMA,100000^FS']);
      expect(v2([field({ display: 'qr', w: 0.49, h: 0.49, rotation })])).toContain('^BQN,2,7^');
    }
  });

  it('names the element when its QR value is too long', () => {
    expect(() => v2([qr], { values: { asset_id: 'x'.repeat(214) } })).toThrow(QrTooLong);
    try {
      v2([qr], { values: { asset_id: 'x'.repeat(214) } });
    } catch (e) {
      expect(e).toBeInstanceOf(DesignError);
      expect((e as DesignError).problems[0]).toMatch(/^q1: QR data too long/);
    }
  });

  it('puts a field displayed as a barcode or QR code through its rules', () => {
    const code = field({ display: 'barcode', symbology: 'code128', moduleIn: 0.0133,
      showText: false, h: 0.1667 });
    const q = field({ id: 'f2', display: 'qr', w: 0.49, h: 0.49 });
    expect(body(v2([code, q]))).toEqual([
      '^FO400,28^BY4^BCN,50,N,N,N^FH_^FD>:07C^FS',
      '^FO400,0^BQN,2,7^FH_^FDMA,07C^FS']);
    // an even run of digits starts in subset C; Code 39 has no start code
    const digits = { id: 'b1', type: 'barcode', data: '1234', symbology: 'code128', x: 0, y: 0,
      w: 1, h: 0.2, rotation: 90 };
    const c39 = { ...digits, id: 'b2', symbology: 'code39', showText: false };
    expect(body(v2([digits, c39], { values: {} }))).toEqual([
      '^FO0,0^BY2^BCR,60,Y,N,N^FH_^FD>;1234^FS',
      '^FO0,0^BY2^B3R,N,60,N,N^FH_^FD1234^FS']);
  });

  it('needs values', () => {
    const design = parseDesign({ schema: 2, size: { w: 4, h: 2 }, splits: SPLITS, elements: [field()] });
    expect(() => compileZpl(design, 300)).toThrow('v2 designs render with values');
  });
});

describe('schema 3 images', () => {
  const image = (kw: Json = {}) => ({ id: 'i1', type: 'image', source: 'photo', x: 0.1, y: 0.2,
    w: 1, h: 0.5, rotation: 90, ...kw });

  it('parses, and prints an image with no picture as nothing or an outline', () => {
    const design = parseDesign({ schema: 3, size: { w: 4, h: 2 }, elements: [
      image(), image({ id: 'i2', hideWhenEmpty: false }), field({ piece: null, field: 'asset_id' })] });
    expect(body(compileZpl(design, 300, { asset_id: '7' }))).toEqual([
      '^FO30,60^GB150,300,2^FS',
      '^FT400,100^A@N,100,100,E:TT0003M_.TTF^FH_^FD7^FS']);
  });

  it('keeps model.py rules for images', () => {
    expect(() => parseDesign({ schema: 3, size: { w: 4, h: 2 }, elements: [field()] }))
      .toThrow('a schema 3 design needs an image element');
    expect(() => parseDesign({ schema: 2, size: { w: 4, h: 2 }, elements: [image()] }))
      .toThrow('i1: an image element needs schema 3');
    expect(() => parseDesign({ schema: 3, size: { w: 4, h: 2 }, elements: [image(), image()] }))
      .toThrow('i1: id is used by another element');
  });
});

describe('parseDesign', () => {
  const problems = (raw: unknown): string[] => {
    try {
      parseDesign(raw);
    } catch (e) {
      expect(e).toBeInstanceOf(DesignError);
      return (e as DesignError).problems;
    }
    throw new Error('parsed');
  };

  it('refuses a bad design shell', () => {
    expect(problems([])).toEqual(['design must be an object']);
    expect(problems({ schema: 4, size: { w: 1, h: 1 }, elements: [] }))
      .toEqual(['schema must be 1, 2 or 3, not 4']);
    expect(problems({ schema: true, size: { w: 1, h: 1 }, elements: [] }))
      .toEqual(['schema must be 1, 2 or 3, not True']);
    expect(problems({ size: { w: 0, h: 1 }, elements: [] }))
      .toEqual(['size must hold positive numbers w and h']);
    expect(problems({ size: { w: 1, h: 1 } })).toEqual(['elements must be a list']);
    expect(problems({ size: { w: 1, h: 1 }, elements: new Array(501).fill({}) }))
      .toEqual(['a design holds at most 500 elements']);
  });

  it('collects every problem, prefixed with the element id', () => {
    expect(problems({ size: { w: 1, h: 1 }, elements: [
      { id: 't1', type: 'text', x: -1, y: 0, w: 1, h: 1, rotation: 45, content: 3,
        fontSizePt: 0, align: 'middle', lines: 0 },
      'nope',
      { type: 'star', x: 0, y: 0, w: 0, h: 0 },
    ] })).toEqual([
      't1: x must be a non-negative number',
      't1: rotation must be one of 0/90/180/270',
      't1: content must be a string',
      't1: fontSizePt must be a positive number',
      't1: align must be left/center/right',
      't1: lines must be an integer of 1 or more',
      'element 1: must be an object',
      "element 2: unknown type 'star'",
    ]);
    expect(problems({ schema: 2, size: { w: 1, h: 1 }, splits: { k: { pieces: [] } }, elements: [
      { id: 'f', type: 'field', field: 'k', piece: 1, x: 0, y: 0, w: 1, h: 1, sizePt: 1,
        baselineIn: 0, maxChars: 65, trim: 'middle', font: { family: 'comic' } },
      { id: 'b', type: 'barcode', field: 'k', data: 'x', x: 0, y: 0, w: 1, h: 1 },
    ] })).toEqual([
      "splits: 'k' must hold a non-empty list of piece names",
      "f: piece 1 needs a Split defined for 'k'",
      'f: font must name a known family and a weight of regular or bold',
      'f: maxChars must be at most 64',
      'f: trim must be one of front/rear',
      'b: needs exactly one of field or data',
      'b: symbology must be code128 or code39',
    ]);
  });

  it('reads JSON numbers as Python does', () => {
    // a float is never an int: lines 2.0 is refused, as json.loads + _int refuse it
    const raw = '{"size": {"w": 1, "h": 1}, "elements": [{"id": "t", "type": "text", "x": 0,'
      + ' "y": 0, "w": 1, "h": 1, "content": "", "fontSizePt": 9, "lines": 2.0, "rotation": 90.0}]}';
    expect(problems(parsePyJson(raw))).toEqual(['t: lines must be an integer of 1 or more']);
    // rotation 90.0 and False compare equal to 90 and 0
    const ok = parseDesign(parsePyJson(raw.replace('2.0', '2')));
    expect(ok.elements[0].rotation).toBe(90);
    const off = parseDesign({ size: { w: 1, h: 1 }, elements: [{ id: 't', type: 'line', x: 0, y: 0,
      w: 1, h: 0, strokeIn: 0.01, rotation: false }] });
    expect(off.elements[0].rotation).toBe(0);
    // Python truthiness: an empty list is False, a non-empty one True
    const flags = parseDesign({ size: { w: 1, h: 1 }, elements: [
      { id: 'b', type: 'barcode', x: 0, y: 0, w: 1, h: 1, symbology: 'code39', data: 'A',
        showText: [] },
      { id: 'c', type: 'barcode', x: 0, y: 0, w: 1, h: 1, symbology: 'code39', data: 'A',
        showText: [0] }] });
    expect(flags.elements.map((el) => (el.type === 'barcode' ? el.showText : null))).toEqual([false, true]);
    // null is not missing: align null is refused, where a missing align is left
    expect(problems({ size: { w: 1, h: 1 }, elements: [{ id: 't', type: 'text', x: 0, y: 0,
      w: 1, h: 1, content: '', fontSizePt: 9, align: null }] }))
      .toEqual(['t: align must be left/center/right']);
  });

  it('builds field rules and values like model.py', () => {
    const design = parseDesign({ schema: 2, size: { w: 4, h: 2 }, splits: SPLITS, elements: [
      field({ maxChars: 2, trim: 'front', strip: '', expectedLength: 3, display: 'number' })] });
    const el = design.elements[0] as FieldEl;
    expect(el.type).toBe('field');
    expect(el.rules).toEqual({ display: 'number', expected_length: 3, max_chars: 2, trim: 'front' });
    expect(el.invertPad).toEqual({ x: (0.25 * 24) / 72, y: (0.10 * 24) / 72 });
    expect(elementValue(el, RACK)).toBe('07C');
    expect(elementValue(el, { destination_rack: '1.2.345' })).toBe('045');
    expect(elementHidden(el, RACK)).toBe(false);
    expect([...design.splits]).toEqual([['destination_rack', ['NAP', 'Sector', 'POD', 'Row', 'Rack']]]);
  });
});

describe('renderTemplate', () => {
  const opts = { width_in: 4, height_in: 2, dots: 300 };

  it('fills a code template and reports unknown tokens', () => {
    const t = { kind: 'code' as const, code: '^XA^FD{asset_id} {nope} {nope}^FS^XZ', design: null,
      language_key: 'zpl' };
    expect(renderTemplate(t, { asset_id: '7' }, opts)).toEqual({
      zpl: '^XA^FD7  ^FS^XZ', unknown: ['nope'] });
    expect(renderTemplate({ ...t, code: null }, {}, opts)).toEqual({ zpl: '', unknown: [] });
  });

  it('compiles a v2 design at the template size and reports its unbound keys', () => {
    const design = { schema: 2, size: { w: 1, h: 1 }, splits: SPLITS, elements: [
      field(),
      { id: 'b1', type: 'barcode', field: 'asset_id', symbology: 'code128', x: 0, y: 1, w: 2,
        h: 0.2, rotation: 0 }] };
    const out = renderTemplate({ kind: 'design', code: null, design, language_key: 'zpl' }, RACK, opts);
    expect(out.zpl).toBe(compileZpl(parseDesign({ ...design, size: { w: 4, h: 2 } }), 300, RACK));
    expect(out.zpl).toContain('^FD07C^FS');
    expect(out.unknown).toEqual(['asset_id']);
  });

  it('compiles a v1 design with its tokens filled', () => {
    const design = { elements: [
      { id: 't1', type: 'text', x: 0, y: 0, w: 2, h: 0.3, rotation: 0, content: '{a} {b}',
        fontSizePt: 10 },
      { id: 'q1', type: 'qr', x: 0, y: 0, w: 0.7, h: 0.7, data: '{c}' }] };
    const out = renderTemplate({ kind: 'design', code: null, design, language_key: 'zpl' },
      { a: 'A' }, { width_in: 2, height_in: 1, dots: 203 });
    expect(body(out.zpl)).toEqual(['^FO0,0^A0N,28,28^FH_^FDA ^FS', '^FO0,0^BQN,2,6^FH_^FDQA,^FS']);
    expect(out.unknown).toEqual(['b', 'c']);
    // a missing design is an empty one: no elements list
    expect(() => renderTemplate({ kind: 'design', code: null, design: null, language_key: 'zpl' },
      {}, opts)).toThrow(DesignError);
  });

  it('refuses a language other than ZPL', () => {
    const design = { schema: 2, size: { w: 1, h: 1 }, splits: SPLITS, elements: [field()] };
    for (const language_key of ['escp', 'ptouch', 'tspl']) {
      expect(() => renderTemplate({ kind: 'design', code: null, design, language_key }, RACK, opts))
        .toThrow(UnsupportedLanguage);
    }
    try {
      renderTemplate({ kind: 'code', code: 'x', design: null, language_key: 'escp' }, {}, opts);
    } catch (e) {
      expect(e).toBeInstanceOf(UnsupportedLanguage);
      expect((e as UnsupportedLanguage).key).toBe('escp');
      expect((e as Error).message).toBe('unsupported language: escp');
      return;
    }
    throw new Error('rendered');
  });
});
