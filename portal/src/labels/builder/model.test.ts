import { describe, expect, it } from 'vitest';

import vegas from '../../../../api/src/serversherpa/labels/fixtures/vegas_v2.json';
import {
  DesignError, addElement, addSplit, duplicate, elementHidden, elementValue, newDesign, nextId,
  parseDesign, placementsOf, removeElements, renamePiece, reorder, replaceElements,
  serializeDesign, updateElement, validate, type DesignV2, type ElementV2, type FieldElement,
} from './model';

const RACK = { destination_rack: '14.01.07C.02.03', destination_ru: '3.5', asset_id: '100000' };

function box(id: string, x = 0, y = 0): ElementV2 {
  return { id, type: 'box', x, y, w: 0.5, h: 0.25, rotation: 0, strokeIn: 0.01 };
}

function ids(d: DesignV2): string[] {
  return d.elements.map((e) => e.id);
}

function el(d: DesignV2, id: string): ElementV2 {
  const found = d.elements.find((e) => e.id === id);
  if (!found) throw new Error(`no element ${id}`);
  return found;
}

describe('parse and serialize', () => {
  it('round-trips the Vegas fixture unchanged', () => {
    const design = parseDesign(vegas);
    expect(serializeDesign(design)).toEqual(vegas);
    expect(validate(design)).toEqual([]);
  });

  it('copies: changing the parsed design never touches the input', () => {
    const raw = JSON.parse(JSON.stringify(vegas));
    const design = parseDesign(raw);
    (design.elements[0] as FieldElement).sizePt = 99;
    design.splits!.destination_rack.pieces[0] = 'X';
    expect(raw).toEqual(vegas);
  });

  it('drops undefined keys when serializing', () => {
    const d = updateElement(addElement(newDesign({ w: 2, h: 1 }), box('b1')), 'b1', { locked: undefined });
    expect(Object.keys(serializeDesign(d).elements[0])).not.toContain('locked');
  });

  it('refuses what the builder cannot hold', () => {
    expect(() => parseDesign(null)).toThrow(DesignError);
    expect(() => parseDesign({ ...vegas, schema: 1 })).toThrow(/schema must be 2/);
    expect(() => parseDesign({ ...vegas, size: { w: 0, h: 2 } })).toThrow(/size must hold positive numbers w and h/);
    expect(() => parseDesign({ ...vegas, elements: {} })).toThrow(/elements must be a list/);
    expect(() => parseDesign({ ...vegas, elements: [{ id: 'z', type: 'image' }] })).toThrow(/unknown type 'image'/);
    expect(() => parseDesign({ ...vegas, elements: [7] })).toThrow(/element 0: must be an object/);
  });

  it('gives an element with a missing or repeated id a fresh one', () => {
    const d = parseDesign({ schema: 2, size: { w: 2, h: 1 }, elements: [box('a'), box('a'), { ...box(''), id: 5 }] });
    expect(ids(d)).toEqual(['a', 'box-1', 'box-2']);
  });
});

describe('editing', () => {
  it('starts an empty v2 design', () => {
    const d = newDesign({ w: 4, h: 2 });
    expect(d).toEqual({ schema: 2, size: { w: 4, h: 2 }, splits: {}, elements: [] });
    expect(validate(d)).toEqual([]);
  });

  it('adds on top of the stack, naming an element with no id, never mutating', () => {
    const d0 = newDesign({ w: 4, h: 2 });
    const d1 = addElement(d0, box('a'));
    const d2 = addElement(d1, { ...box(''), id: '' });
    expect(ids(d2)).toEqual(['a', 'box-1']);
    expect(d0.elements).toEqual([]);
    expect(() => addElement(d2, box('a'))).toThrow(/already/);
    expect(nextId(d2, 'box')).toBe('box-2');
  });

  it('patches one element and keeps its id and type', () => {
    const d = parseDesign(vegas);
    const out = updateElement(d, 'banner-pod', { sizePt: 30, inverted: true });
    const pod = el(out, 'banner-pod') as FieldElement;
    expect(pod.sizePt).toBe(30);
    expect(pod.inverted).toBe(true);
    expect((el(d, 'banner-pod') as FieldElement).sizePt).toBe(24);
    expect(updateElement(d, 'nope', { x: 1 })).toBe(d);
  });

  it('replaces elements by id in place', () => {
    const d = addElement(addElement(newDesign({ w: 4, h: 2 }), box('a')), box('b'));
    const out = replaceElements(d, [{ ...box('b'), x: 1 }]);
    expect(ids(out)).toEqual(['a', 'b']);
    expect(el(out, 'b').x).toBe(1);
  });

  it('removes elements and keeps the Split for the next placement', () => {
    const d = parseDesign(vegas);
    const out = removeElements(d, placementsOf(d, 'destination_rack').map((e) => e.id));
    expect(placementsOf(out, 'destination_rack')).toEqual([]);
    expect(out.splits?.destination_rack.pieces).toHaveLength(5);
    expect(out.elements).toHaveLength(d.elements.length - 10);
  });

  it('duplicates with an offset and new ids, on top, in stacking order', () => {
    const d = addElement(addElement(addElement(newDesign({ w: 4, h: 2 }), box('a', 1, 1)), box('b', 2, 1)), box('c'));
    const { design, ids: copies } = duplicate(d, ['b', 'a']);
    expect(copies).toEqual(['box-1', 'box-2']);
    expect(ids(design)).toEqual(['a', 'b', 'c', 'box-1', 'box-2']);
    expect(el(design, 'box-1')).toMatchObject({ x: 1.05, y: 1.05 });
    expect(el(design, 'box-2')).toMatchObject({ x: 2.05, y: 1.05 });
    expect(el(duplicate(d, ['a'], 0.25).design, 'box-1')).toMatchObject({ x: 1.25, y: 1.25 });
  });

  it('reorders one or several elements', () => {
    const d = ['a', 'b', 'c', 'd'].reduce((acc, id) => addElement(acc, box(id)), newDesign({ w: 4, h: 2 }));
    expect(ids(reorder(d, 'b', 'forward'))).toEqual(['a', 'c', 'b', 'd']);
    expect(ids(reorder(d, 'b', 'back'))).toEqual(['b', 'a', 'c', 'd']);
    expect(ids(reorder(d, 'b', 'toFront'))).toEqual(['a', 'c', 'd', 'b']);
    expect(ids(reorder(d, 'c', 'toBack'))).toEqual(['c', 'a', 'b', 'd']);
    expect(ids(reorder(d, 'd', 'forward'))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(reorder(d, 'a', 'back'))).toEqual(['a', 'b', 'c', 'd']);
    expect(ids(reorder(d, ['a', 'c'], 'forward'))).toEqual(['b', 'a', 'd', 'c']);
    expect(ids(reorder(d, ['b', 'd'], 'back'))).toEqual(['b', 'a', 'd', 'c']);
    expect(ids(reorder(d, ['c', 'a'], 'toFront'))).toEqual(['b', 'd', 'a', 'c']);
    expect(ids(reorder(d, ['d', 'b'], 'toBack'))).toEqual(['b', 'd', 'a', 'c']);
  });
});

describe('Split', () => {
  it('names one piece per piece of the sample, Piece 1..n', () => {
    const d = addSplit(newDesign({ w: 4, h: 2 }), 'destination_rack', '14.01.07C.02.03');
    expect(d.splits).toEqual({
      destination_rack: { pieces: ['Piece 1', 'Piece 2', 'Piece 3', 'Piece 4', 'Piece 5'] },
    });
  });

  it('keeps one Split per field: placing it again reuses the pieces', () => {
    const d = parseDesign(vegas);
    expect(addSplit(d, 'destination_rack', '1.2')).toBe(d);
  });

  it('renames a piece', () => {
    const d = renamePiece(addSplit(newDesign({ w: 4, h: 2 }), 'source_rack', '09.01.05D'), 'source_rack', 2, 'POD');
    expect(d.splits?.source_rack.pieces).toEqual(['Piece 1', 'Piece 2', 'POD']);
    expect(() => renamePiece(d, 'source_rack', 3, 'X')).toThrow(RangeError);
    expect(() => renamePiece(d, 'nope', 0, 'X')).toThrow(RangeError);
  });

  it('counts placements of a field, pieces and barcodes included', () => {
    const d = parseDesign(vegas);
    expect(placementsOf(d, 'destination_rack')).toHaveLength(10);
    expect(placementsOf(d, 'asset_id').map((e) => e.id)).toEqual(['barcode', 'qr']);
    expect(placementsOf(d, 'nope')).toEqual([]);
  });
});

describe('validate (mirrors labels/model.py parse_design v2)', () => {
  const field = (extra: Record<string, unknown> = {}) => ({
    id: 'f1', type: 'field', field: 'destination_rack', piece: 2, x: 1, y: 0.1, w: 0.5, h: 0.24,
    rotation: 0, display: 'text', font: { family: 'swiss721-cond-bold', weight: 'regular' },
    sizePt: 24, baselineIn: 0.24, align: 'left', ...extra,
  });
  const design = (...elements: unknown[]) => parseDesign({
    schema: 2, size: { w: 4, h: 2 }, splits: { destination_rack: { pieces: ['A', 'B', 'C'] } }, elements,
  });
  const messages = (d: DesignV2) => validate(d).map((p) => `${p.elementId}: ${p.message}`);

  it('accepts a good field', () => {
    expect(validate(design(field()))).toEqual([]);
  });

  it('flags pieces beyond the Split and pieces with no Split', () => {
    expect(messages(design(field({ piece: 3 })))).toEqual(["f1: piece 3 is beyond 'destination_rack''s Split (3 pieces)"]);
    expect(messages(design(field({ field: 'source_rack', piece: 0 })))).toEqual(["f1: piece 0 needs a Split defined for 'source_rack'"]);
  });

  it('flags bad rules, fonts and typesetting', () => {
    expect(messages(design(field({ maxChars: 0, expectedLength: 1.5, trim: 'middle', stripWhere: 'both' })))).toEqual([
      'f1: expectedLength must be a whole number of 1 or more',
      'f1: maxChars must be a whole number of 1 or more',
      'f1: trim must be one of front/rear',
      'f1: stripWhere must be one of front/rear/anywhere',
    ]);
    expect(messages(design(field({ font: { family: 'comic-sans', weight: 'regular' } }))))
      .toEqual(['f1: font must name a known family and a weight of regular or bold']);
    expect(messages(design(field({ sizePt: 0, baselineIn: -1 })))).toEqual([
      'f1: sizePt must be a positive number', 'f1: baselineIn must be a non-negative number',
    ]);
    expect(messages(design(field({ display: 'qr', sizePt: undefined, baselineIn: undefined })))).toEqual([]);
    expect(messages(design(field({ display: 'barcode', symbology: 'ean13', moduleIn: 0 })))).toEqual([
      'f1: symbology must be code128 or code39', 'f1: moduleIn must be a positive number',
    ]);
    expect(messages(design(field({ invertPad: { x: -1, y: 0 }, align: 'justify' })))).toEqual([
      'f1: align must be left/center/right', 'f1: invertPad must hold non-negative numbers x and y',
    ]);
  });

  it('flags geometry, sources, strokes and repeated ids', () => {
    const qr = { id: 'q1', type: 'qr', field: 'asset_id', data: '1', x: -1, y: 0, w: 0.5, h: 0.5, rotation: 45 };
    const line = { id: 'l1', type: 'line', x: 0, y: 0, w: 1, h: 0, rotation: 0, strokeIn: 0 };
    const text = { id: 't1', type: 'text', content: 5, x: 0, y: 0, w: 1, h: 0.1, rotation: 0, sizePt: 8, baselineIn: 0.1, lines: 0 };
    expect(messages(design(qr, line, text))).toEqual([
      'q1: x must be a non-negative number',
      'q1: rotation must be one of 0/90/180/270',
      'q1: needs exactly one of field or data',
      'l1: strokeIn must be a positive number',
      't1: content must be a string',
      't1: lines must be an integer of 1 or more',
    ]);
    const d = design(box('b1'), box('b2'));
    const twin = { ...d, elements: [d.elements[0], { ...d.elements[1], id: 'b1' }] };
    expect(messages(twin)).toEqual(['b1: id is used by another element']);
  });

  it('flags a bad Split and size', () => {
    const d = { ...design(), splits: { destination_rack: { pieces: [] } }, size: { w: 4, h: 0 } };
    expect(validate(d).map((p) => p.message)).toEqual([
      'size must hold positive numbers w and h',
      "splits: 'destination_rack' must hold a non-empty list of piece names",
    ]);
  });
});

describe('what an element prints (mirrors model.py element_value / element_hidden)', () => {
  const d = parseDesign(vegas);

  it('runs a field through its piece and rules', () => {
    expect(elementValue(el(d, 'banner-pod'), RACK)).toBe('07C');
    expect(elementValue(el(d, 'banner-ru'), RACK)).toBe('03.5');
    expect(elementValue(el(d, 'caption-name'), RACK)).toBe('Name:');
    expect(elementValue(el(d, 'qr'), RACK)).toBe('100000');
    expect(elementValue(el(d, 'value-name'), RACK)).toBe('');
    expect(elementValue(el(d, 'rule'), RACK)).toBe('');
  });

  it('hides blanks that are hide-when-empty or inverted', () => {
    expect(elementHidden(el(d, 'banner-sector'), {})).toBe(true);        // inverted, blank
    expect(elementHidden(el(d, 'banner-pod'), {})).toBe(false);          // blank but neither
    expect(elementHidden(el(d, 'banner-sector'), RACK)).toBe(false);
    const hide = updateElement(d, 'qr', { hideWhenEmpty: true });
    expect(elementHidden(el(hide, 'qr'), {})).toBe(true);
    expect(elementHidden(el(d, 'rule'), {})).toBe(false);
  });
});

describe('field keys that name Object.prototype members', () => {
  it('define, rename and find a Split like any other key', () => {
    const ctor = addSplit(newDesign({ w: 4, h: 2 }), 'constructor', 'a.b');
    expect(ctor.splits?.constructor).toEqual({ pieces: ['Piece 1', 'Piece 2'] });
    expect(() => renamePiece(newDesign({ w: 4, h: 2 }), 'constructor', 0, 'X')).toThrow(RangeError);
    const proto = addSplit(newDesign({ w: 4, h: 2 }), '__proto__', '1.2.3');
    expect(Object.hasOwn(proto.splits!, '__proto__')).toBe(true);
    expect(Object.getPrototypeOf(proto.splits)).toBe(Object.prototype);
    expect(serializeDesign(proto).splits).toEqual(JSON.parse('{"__proto__":{"pieces":["Piece 1","Piece 2","Piece 3"]}}'));
    expect(renamePiece(proto, '__proto__', 1, 'Row').splits!.__proto__).toEqual({ pieces: ['Piece 1', 'Row', 'Piece 3'] });
  });

  it('read a missing value as blank', () => {
    const field = (key: string, extra: Partial<FieldElement> = {}): FieldElement => ({
      id: 'f', type: 'field', field: key, display: 'text', x: 0, y: 0, w: 1, h: 0.1, rotation: 0,
      sizePt: 8, baselineIn: 0.1, ...extra,
    });
    expect(elementValue(field('constructor'), {})).toBe('');
    expect(elementValue(field('__proto__'), {})).toBe('');
    expect(elementValue(field('toString', { piece: 0 }), {})).toBe('');
    expect(elementHidden(field('toString', { hideWhenEmpty: true }), {})).toBe(true);
    const qr: ElementV2 = { id: 'q', type: 'qr', field: '__proto__', x: 0, y: 0, w: 0.5, h: 0.5, rotation: 0 };
    expect(elementValue(qr, {})).toBe('');
    expect(elementValue(field('constructor'), JSON.parse('{"constructor":"A1"}'))).toBe('A1');
  });

  it('validate pieces against own Splits only', () => {
    const piece = (key: string, n: number) => ({
      id: 'f1', type: 'field', field: key, piece: n, x: 0, y: 0, w: 1, h: 0.1, rotation: 0,
      display: 'text', sizePt: 8, baselineIn: 0.1,
    });
    const msgs = (raw: unknown) => validate(parseDesign(raw)).map((p) => p.message);
    expect(msgs({ schema: 2, size: { w: 4, h: 2 }, elements: [piece('constructor', 0)] }))
      .toEqual(["piece 0 needs a Split defined for 'constructor'"]);
    const own = JSON.parse('{"schema":2,"size":{"w":4,"h":2},"splits":{"__proto__":{"pieces":["A"]}},"elements":[]}');
    expect(msgs({ ...own, elements: [piece('__proto__', 0)] })).toEqual([]);
    expect(msgs({ ...own, elements: [piece('__proto__', 1)] }))
      .toEqual(["piece 1 is beyond '__proto__''s Split (1 pieces)"]);
  });
});
