import { describe, expect, it } from 'vitest';

import { createHistory } from './history';

describe('createHistory', () => {
  it('undoes and redoes pushes', () => {
    const h = createHistory('a');
    expect(h.canUndo()).toBe(false);
    h.push('b');
    h.push('c');
    expect(h.present).toBe('c');
    expect(h.undo()).toBe('b');
    expect(h.undo()).toBe('a');
    expect(h.canUndo()).toBe(false);
    expect(h.undo()).toBe('a');            // nothing left: stays put
    expect(h.redo()).toBe('b');
    expect(h.canRedo()).toBe(true);
    expect(h.redo()).toBe('c');
    expect(h.canRedo()).toBe(false);
    expect(h.redo()).toBe('c');
  });

  it('drops the redo stack on a new push and ignores a push of the same state', () => {
    const h = createHistory('a');
    h.push('b');
    h.undo();
    h.push('x');
    expect(h.canRedo()).toBe(false);
    h.push('x');
    expect(h.undo()).toBe('a');
    expect(h.canUndo()).toBe(false);
  });

  it('records a drag as one entry', () => {
    const h = createHistory('start');
    h.push('before');
    h.beginGesture();
    h.push('move 1');
    h.push('move 2');
    h.push('move 3');
    expect(h.present).toBe('move 3');
    h.endGesture();
    expect(h.undo()).toBe('before');
    expect(h.redo()).toBe('move 3');
  });

  it('records nothing for a gesture that changed nothing', () => {
    const h = createHistory('a');
    h.beginGesture();
    h.endGesture();
    expect(h.canUndo()).toBe(false);
    h.beginGesture();
    h.push('b');
    h.push('a');                           // dragged back to where it started
    h.endGesture();
    expect(h.canUndo()).toBe(false);
  });

  it('ends an open gesture before undoing', () => {
    const h = createHistory('a');
    h.beginGesture();
    h.push('b');
    expect(h.undo()).toBe('a');
    expect(h.redo()).toBe('b');
    h.push('c');                           // a plain push again, after the implicit end
    expect(h.undo()).toBe('b');
  });

  it('drops a redo stack when a gesture changes something', () => {
    const h = createHistory('a');
    h.push('b');
    h.undo();
    h.beginGesture();
    h.push('drag');
    h.endGesture();
    expect(h.canRedo()).toBe(false);
  });

  it('keeps at most `cap` undo steps (100 by default)', () => {
    const h = createHistory(0);
    for (let i = 1; i <= 150; i++) h.push(i);
    let steps = 0;
    while (h.canUndo()) { h.undo(); steps++; }
    expect(steps).toBe(100);
    expect(h.present).toBe(50);
    const small = createHistory(0, 3);
    for (let i = 1; i <= 5; i++) small.push(i);
    small.undo(); small.undo(); small.undo();
    expect(small.canUndo()).toBe(false);
    expect(small.present).toBe(2);
  });

  it('starts over on reset', () => {
    const h = createHistory('a');
    h.push('b');
    h.reset('z');
    expect(h.present).toBe('z');
    expect(h.canUndo()).toBe(false);
    expect(h.canRedo()).toBe(false);
  });
});
