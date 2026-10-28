/**
 * lib/plans/sheetKeys.ts: what a key does in the task sheet (the grid with
 * no editor open, or inside a cell editor), and how far to scroll so the
 * active cell is in view under the sticky header.
 */
import { describe, expect, it } from 'vitest';

import { editorKey, gridKey, scrollToShow, type KeyLike } from './sheetKeys';

const key = (k: string, mods: Partial<KeyLike> = {}): KeyLike => ({
  key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, ...mods,
});

describe('gridKey (no editor open)', () => {
  it('arrows move the active cell', () => {
    expect(gridKey(key('ArrowDown'))).toEqual({ kind: 'move', dir: 'down' });
    expect(gridKey(key('ArrowUp'))).toEqual({ kind: 'move', dir: 'up' });
    expect(gridKey(key('ArrowLeft'))).toEqual({ kind: 'move', dir: 'left' });
    expect(gridKey(key('ArrowRight'))).toEqual({ kind: 'move', dir: 'right' });
  });

  it('Enter moves down (Shift: up), Tab moves right (Shift: left)', () => {
    expect(gridKey(key('Enter'))).toEqual({ kind: 'move', dir: 'down' });
    expect(gridKey(key('Enter', { shiftKey: true }))).toEqual({ kind: 'move', dir: 'up' });
    expect(gridKey(key('Tab'))).toEqual({ kind: 'move', dir: 'right' });
    expect(gridKey(key('Tab', { shiftKey: true }))).toEqual({ kind: 'move', dir: 'left' });
  });

  it('F2 edits the current value; Backspace starts from nothing', () => {
    expect(gridKey(key('F2'))).toEqual({ kind: 'edit', seed: null });
    expect(gridKey(key('Backspace'))).toEqual({ kind: 'edit', seed: '' });
  });

  it('a printable key starts editing with that key', () => {
    expect(gridKey(key('5'))).toEqual({ kind: 'edit', seed: '5' });
    expect(gridKey(key('S', { shiftKey: true }))).toEqual({ kind: 'edit', seed: 'S' });
    expect(gridKey(key('é'))).toEqual({ kind: 'edit', seed: 'é' });
  });

  it('leaves shortcuts, modified arrows and composition to others', () => {
    for (const k of [
      key('c', { ctrlKey: true }), key('z', { metaKey: true }), key('ArrowRight', { altKey: true, shiftKey: true }),
      key('ArrowDown', { ctrlKey: true }), key('a', { isComposing: true }), key('Escape'), key('Delete'),
      key('Insert'), key('F5'), key('Shift'),
    ]) {
      expect(gridKey(k)).toEqual({ kind: 'none' });
    }
  });
});

describe('editorKey (inside a cell editor)', () => {
  it('Enter commits and moves down (Shift: up)', () => {
    expect(editorKey(key('Enter'))).toEqual({ kind: 'commit', dir: 'down' });
    expect(editorKey(key('Enter', { shiftKey: true }))).toEqual({ kind: 'commit', dir: 'up' });
  });

  it('Tab commits and moves right (Shift: left)', () => {
    expect(editorKey(key('Tab'))).toEqual({ kind: 'commit', dir: 'right' });
    expect(editorKey(key('Tab', { shiftKey: true }))).toEqual({ kind: 'commit', dir: 'left' });
  });

  it('Escape cancels', () => {
    expect(editorKey(key('Escape'))).toEqual({ kind: 'cancel' });
  });

  it('everything else types (arrows move the caret)', () => {
    for (const k of [key('ArrowLeft'), key('a'), key('Delete'), key('Enter', { isComposing: true })]) {
      expect(editorKey(k)).toEqual({ kind: 'none' });
    }
  });
});

describe('scrollToShow', () => {
  // a 600px box whose top 44px is the sticky header; 30px rows
  it('leaves a cell already in view alone', () => {
    expect(scrollToShow(44 + 5 * 30, 30, 0, 600, 44)).toBeNull();
  });

  it('scrolls up so a row hidden under the header shows just below it', () => {
    expect(scrollToShow(44 + 10 * 30, 30, 400, 600, 44)).toBe(300);
  });

  it('scrolls down so a row below the box shows at its bottom', () => {
    expect(scrollToShow(44 + 30 * 30, 30, 0, 600, 44)).toBe(44 + 31 * 30 - 600);
  });

  it('works across with no inset', () => {
    expect(scrollToShow(900, 100, 0, 800, 0)).toBe(200);
    expect(scrollToShow(100, 100, 300, 800, 0)).toBe(100);
  });
});
