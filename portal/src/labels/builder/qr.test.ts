import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CAPACITY_M, QR_FO_OFFSET_IN, QR_MAX_MAGNIFICATION, qrFoOffsetDots, qrLayout, qrModules, qrTooHigh,
} from './qr';

const QR_PY = join(__dirname, '../../../../api/src/serversherpa/labels/qr.py');

describe('qrModules', () => {
  // the same cases pin the API's labels/qr.py (tests/test_labels_zpl_v2.py)
  it('picks the smallest version at level M', () => {
    expect(qrModules('10482')).toBe(21);                 // numeric, v1 holds 34
    expect(qrModules('0'.repeat(34))).toBe(21);
    expect(qrModules('0'.repeat(35))).toBe(25);          // v2 holds 63
    expect(qrModules('RACK-14 $%*+./:')).toBe(21);       // alphanumeric, v1 holds 20
    expect(qrModules('A'.repeat(21))).toBe(25);
    expect(qrModules('sample-server-1')).toBe(25);       // 15 lowercase: byte, v1 holds 14
    expect(qrModules('s'.repeat(14))).toBe(21);
    expect(qrModules('é'.repeat(7))).toBe(21);           // 14 bytes
    expect(qrModules('é'.repeat(14))).toBe(29);          // 28 bytes: v3 holds 42
    expect(qrModules('')).toBe(21);
    expect(qrModules('0'.repeat(513))).toBe(57);         // v10 (17 + 4 x 10)
    expect(qrModules('٣'.repeat(20))).toBe(29);          // non-ASCII digits are bytes (40), not numeric
    expect(qrModules('😀'.repeat(4))).toBe(25);          // astral: 4 UTF-8 bytes each (16), not 8 UTF-16 units
    expect(() => qrModules('x'.repeat(214))).toThrow(RangeError);   // beyond v10's 213 bytes
  });

  it('mirrors the capacity table in labels/qr.py', () => {
    const src = readFileSync(QR_PY, 'utf8');
    const block = src.slice(src.indexOf('CAPACITY_M:'), src.indexOf('NUMERIC ='));
    const rows = [...block.matchAll(/\((\d+), (\d+), (\d+)\)/g)].map((m) => [+m[1], +m[2], +m[3]]);
    expect(rows).toHaveLength(10);
    expect(CAPACITY_M.map((r) => [...r])).toEqual(rows);
  });
});

describe('the printer\'s ^FO offset', () => {
  it('mirrors QR_FO_OFFSET_IN in labels/qr.py', () => {
    const src = readFileSync(QR_PY, 'utf8');
    const m = src.match(/^QR_FO_OFFSET_IN = ([0-9.]+)$/m);
    expect(m).not.toBeNull();
    expect(QR_FO_OFFSET_IN).toBe(Number(m![1]));
  });

  it('is 60 dots at 300 and scales with the DPI, as qr_fo_offset_dots does', () => {
    expect([203, 300, 600].map(qrFoOffsetDots)).toEqual([41, 60, 120]);
  });

  it('flags a symbol whose top is nearer the label\'s top edge than the offset', () => {
    const box = { x: 1, w: 0.49, h: 0.49 };
    expect(qrTooHigh({ ...box, y: 0.1 }, '100000', 300)).toBe(true);
    expect(qrTooHigh({ ...box, y: 0.19 }, '100000', 300)).toBe(true);    // top at 57
    expect(qrTooHigh({ ...box, y: 0.2 }, '100000', 300)).toBe(false);    // top at 60: ^FO y 0
    expect(qrTooHigh({ ...box, y: 0.4933 }, '100000', 300)).toBe(false);
    // a box taller than the symbol centers it lower: top at 30 + (300 - 147) // 2 = 106
    expect(qrTooHigh({ x: 1, y: 0.1, w: 0.49, h: 1 }, '100000', 300)).toBe(false);
    // a value no symbol holds prints nothing to warn about
    expect(qrTooHigh({ ...box, y: 0 }, 'x'.repeat(214), 300)).toBe(false);
  });
});

describe('qrLayout', () => {
  it('places the Vegas QR where it prints: top at 148 (^FO1000,88^BQN,2,7 at 300)', () => {
    expect(qrLayout({ x: 3.3333, y: 0.4933, w: 0.49, h: 0.49 }, '100000', 300)).toEqual({
      modules: 21, magnification: 7, side: 147, x: 1000, y: 148, capped: false,
    });
  });

  it('caps the magnification at 10 and centers the symbol on the box', () => {
    // 0.49 in at 600 = 294 dots / 21 modules = 14 → capped at 10: 210 dots, 42 dots in
    const out = qrLayout({ x: 1, y: 0.5, w: 0.49, h: 0.49 }, '100000', 600);
    expect(out.magnification).toBe(QR_MAX_MAGNIFICATION);
    expect(out.side).toBe(210);
    expect(out.capped).toBe(true);
    expect(out.x).toBe(600 + 42);
    expect(out.y).toBe(300 + 42);
  });

  it('never magnifies below 1 and floors a negative offset like Python //', () => {
    const out = qrLayout({ x: 0, y: 0, w: 0.01, h: 0.01 }, '100000', 300);
    expect(out.magnification).toBe(1);
    expect(out.side).toBe(21);
    expect(out.x).toBe(0);   // max(0, 0 + (3 - 21) // 2)
    expect(qrLayout({ x: 1, y: 1, w: 0.01, h: 0.01 }, '100000', 300).x).toBe(300 - 9);
  });
});
