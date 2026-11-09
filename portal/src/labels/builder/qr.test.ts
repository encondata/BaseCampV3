import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  CAPACITY_M, QR_MAX_MAGNIFICATION, QR_PRINT_DROP_DOTS, maskPenalty, qrLayout, qrMatrix, qrModules,
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

  it('sizes a mixed value by its shortest segments, as Labelary renders it', () => {
    expect(qrModules('abc12345678901234567890')).toBe(21);   // one byte segment would need v2
    expect(qrModules('CN0123456789012345678')).toBe(21);     // 21 alphanumerics would need v2
    expect(qrModules('SN0000001')).toBe(21);
    expect(qrModules('Dell PowerEdge R740')).toBe(25);
    expect(qrModules('https://portal.serversherpa.com/assets/100417')).toBe(33);
    expect(qrModules('ABC1234567890123456789012345678')).toBe(25);
    expect(qrModules('RACK 14.01.07C.02.03 / RU 12 / NAP11-HALL-B')).toBe(29);
  });

  it('mirrors the capacity table in labels/qr.py', () => {
    const src = readFileSync(QR_PY, 'utf8');
    const block = src.slice(src.indexOf('CAPACITY_M:'), src.indexOf('NUMERIC ='));
    const rows = [...block.matchAll(/\((\d+), (\d+), (\d+)\)/g)].map((m) => [+m[1], +m[2], +m[3]]);
    expect(rows).toHaveLength(10);
    expect(CAPACITY_M.map((r) => [...r])).toEqual(rows);
  });
});

describe('qrLayout', () => {
  it('places the Vegas QR where it prints: 10 dots below ^FO1000,148^BQN,2,7 at 300', () => {
    expect(QR_PRINT_DROP_DOTS).toBe(10);
    expect(qrLayout({ x: 3.3333, y: 0.4933, w: 0.49, h: 0.49 }, '100000', 300)).toEqual({
      modules: 21, magnification: 7, side: 147, x: 1000, y: 158, capped: false,
    });
  });

  it('caps the magnification at 10 and centers the symbol on the box', () => {
    // 0.49 in at 600 = 294 dots / 21 modules = 14 → capped at 10: 210 dots, 42 dots in
    const out = qrLayout({ x: 1, y: 0.5, w: 0.49, h: 0.49 }, '100000', 600);
    expect(out.magnification).toBe(QR_MAX_MAGNIFICATION);
    expect(out.side).toBe(210);
    expect(out.capped).toBe(true);
    expect(out.x).toBe(600 + 42);
    expect(out.y).toBe(300 + 42 + 10);
  });

  it('never magnifies below 1 and floors a negative offset like Python //', () => {
    const out = qrLayout({ x: 0, y: 0, w: 0.01, h: 0.01 }, '100000', 300);
    expect(out.magnification).toBe(1);
    expect(out.side).toBe(21);
    expect(out.x).toBe(0);   // max(0, 0 + (3 - 21) // 2)
    expect(qrLayout({ x: 1, y: 1, w: 0.01, h: 0.01 }, '100000', 300).x).toBe(300 - 9);
  });
});

describe('qrMatrix', () => {
  /** The 7 × 7 finder at (r, c): a dark ring, a light ring, a dark 3 × 3 core. */
  const isFinder = (m: boolean[][], r: number, c: number) => {
    for (let i = 0; i < 7; i++) {
      for (let j = 0; j < 7; j++) {
        const ring = Math.max(Math.abs(i - 3), Math.abs(j - 3));
        if (m[r + i][c + j] !== (ring !== 2)) return false;
      }
    }
    return true;
  };

  it('encodes the value at the size qrModules picks, finders in three corners', () => {
    for (const value of ['100000', '12345678', 'X'.repeat(26), 'sample-server-1', 'é'.repeat(14)]) {
      const modules = qrModules(value);
      const m = qrMatrix(value, modules)!;
      expect(m).toHaveLength(modules);
      expect(m.every((row) => row.length === modules)).toBe(true);
      expect(isFinder(m, 0, 0) && isFinder(m, 0, modules - 7) && isFinder(m, modules - 7, 0)).toBe(true);
      expect(isFinder(m, modules - 7, modules - 7)).toBe(false);
    }
  });

  // Labelary's renders of ^BQN,2,7^FDMA,<value>, read module by module
  // (2026-11-09): the canvas has to draw exactly these
  const LABELARY: Record<string, string[]> = {
    '100000': [
      '#######.##..#.#######', '#.....#.#.#...#.....#', '#.###.#..##.#.#.###.#', '#.###.#.####..#.###.#',
      '#.###.#.#.#.#.#.###.#', '#.....#.#..#..#.....#', '#######.#.#.#.#######', '.........##.#........',
      '...#..#..#.....###.##', '#..##..#..#.#....#.#.', '##..#######.......#.#', '..##...#..#.###....#.',
      '#..##.##...#.##.#.###', '........####...###...', '#######..#.#.###.##.#', '#.....#....#.#####...',
      '#.###.#..#.#.#.##.###', '#.###.#.######...####', '#.###.#..#...##.#...#', '#.....#..##..##.#.##.',
      '#######.....###.###..'],
    '14.01.07C.02.03': [
      '#######.#.#.#.#######', '#.....#.#..##.#.....#', '#.###.#.#.##..#.###.#', '#.###.#.#.###.#.###.#',
      '#.###.#.#..##.#.###.#', '#.....#..##.#.#.....#', '#######.#.#.#.#######', '........###..........',
      '.##.#.##.#.#..#.#####', '##..##.###.#.#.#..#..', '.##...##..#...#.#...#', '..#.##.#..##...##.#.#',
      '..#...#..###.####.#.#', '........##.##.##...#.', '#######.###.#####.#..', '#.....#....#.#####..#',
      '#.###.#.#...#.#..####', '#.###.#..###.##.#..#.', '#.###.#.###.#.#.###.#', '#.....#.#.##.#.#..###',
      '#######..##.##..#.#.#'],
    'sample-server-1': [
      '#######.##...###..#######', '#.....#..#...####.#.....#', '#.###.#..#..##.#..#.###.#', '#.###.#...###.##..#.###.#',
      '#.###.#.#..#...##.#.###.#', '#.....#.#.###.....#.....#', '#######.#.#.#.#.#.#######', '..............#.#........',
      '.#######.##.#......##...#', '..##.#.#..#.####.#.#..#..', '....#.#.####.####.##...##', '#...##.##.#.##.#...#...##',
      '#####.##...##.#####.#.#.#', '###.##...#..##...#.#.#...', '#..#.##.###.#.########.##', '#.#.##..##...####......#.',
      '#..#####..#.##..#######.#', '........#.#.#..##...#.##.', '#######.#...#...#.#.##.##', '#.....#.##..#.###...#..#.',
      '#.###.#.################.', '#.###.#.#.....#######...#', '#.###.#.#....#.#...#....#', '#.....#.#.#####.####.#..#',
      '#######....#.#...########'],
  };

  it('draws exactly the code Labelary renders for the value', () => {
    for (const [value, rows] of Object.entries(LABELARY)) {
      const m = qrMatrix(value, qrModules(value))!;
      expect(m.map((row) => row.map((b) => (b ? '#' : '.')).join(''))).toEqual(rows);
    }
  });

  it('scores masks as ZXing does: a blank grid is all runs, blocks and imbalance', () => {
    const blank = Array.from({ length: 21 }, () => Array.from({ length: 21 }, () => false));
    // runs: 42 lines of 21 = 42 × 19; blocks: 400 × 3; dark share 0 % = 10 steps of 5 % = 100
    expect(maskPenalty(blank)).toBe(42 * 19 + 400 * 3 + 100);
  });

  it('draws different values differently', () => {
    const a = qrMatrix('100000', 21)!;
    const b = qrMatrix('100001', 21)!;
    expect(a.flat().join()).not.toBe(b.flat().join());
  });

  it('is null when the value can\'t be encoded (an empty value)', () => {
    expect(qrMatrix('', 21)).toBeNull();
  });
});
