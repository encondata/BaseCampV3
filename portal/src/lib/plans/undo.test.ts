/**
 * lib/plans/undo.ts: the plan tab's undo/redo stack. 20 steps (MS Project's
 * default undo levels); each step holds the inverse batches of one edit in
 * the order they were applied (a paste's add batch, then its links batch).
 */
import { describe, expect, it } from 'vitest';

import type { Op, RestoreOp } from './api';
import { makeRestore } from './planFixtures';
import { UNDO_LEVELS, UndoStack, type UndoEntry } from './undo';

const batch = (tag: string): Op[] => [makeRestore(tag)];

/** The tags of an entry's batches, in order. */
const tags = (entry: UndoEntry | null): string[] =>
  (entry?.batches ?? []).map((ops) => String((ops[0] as RestoreOp).tasks[0].id));

describe('UndoStack', () => {
  it('starts empty', () => {
    const stack = new UndoStack();
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
    expect(stack.undo()).toBeNull();
    expect(stack.redo()).toBeNull();
    expect(stack.undoLabel).toBeNull();
    expect(stack.redoLabel).toBeNull();
  });

  it('keeps 20 steps by default and drops the oldest past the limit', () => {
    expect(UNDO_LEVELS).toBe(20);
    const stack = new UndoStack();
    for (let i = 1; i <= 21; i += 1) stack.push(batch(`b${i}`), `Edit ${i}`);
    const popped: string[] = [];
    for (let entry = stack.undo(); entry; entry = stack.undo()) popped.push(entry.label);
    expect(popped).toHaveLength(20);
    expect(popped[0]).toBe('Edit 21');
    expect(popped[19]).toBe('Edit 2');          // Edit 1 fell off
  });

  it('honors a smaller limit, on the redo side too', () => {
    const stack = new UndoStack(2);
    for (const tag of ['a', 'b', 'c']) stack.push(batch(tag), tag);
    expect(tags(stack.undo())).toEqual(['c']);
    expect(tags(stack.undo())).toEqual(['b']);
    expect(stack.undo()).toBeNull();
    for (const tag of ['x', 'y', 'z']) stack.pushRedo({ label: tag, batches: [batch(tag)] });
    expect(tags(stack.redo())).toEqual(['z']);
    expect(tags(stack.redo())).toEqual(['y']);
    expect(stack.redo()).toBeNull();
  });

  it('round-trips undo then redo: what the undo posts answered becomes the redo step', () => {
    const stack = new UndoStack();
    stack.push(batch('inv1'), 'Indent');
    expect(stack.canUndo).toBe(true);
    expect(stack.undoLabel).toBe('Indent');

    const undone = stack.undo();
    expect(undone?.label).toBe('Indent');
    expect(tags(undone)).toEqual(['inv1']);
    expect(stack.canUndo).toBe(false);

    // posting inv1 answered redo1: it goes on the redo side
    stack.pushRedo({ label: 'Indent', batches: [batch('redo1')] });
    expect(stack.canRedo).toBe(true);
    expect(stack.redoLabel).toBe('Indent');

    const redone = stack.redo();
    expect(tags(redone)).toEqual(['redo1']);
    // posting redo1 answered inv2: back on the undo side, the redo side kept
    stack.pushRedo({ label: 'Other', batches: [batch('r-other')] });
    stack.pushUndo({ label: 'Indent', batches: [batch('inv2')] });
    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(true);
    expect(tags(stack.undo())).toEqual(['inv2']);
  });

  it('clears the redo side on a fresh edit', () => {
    const stack = new UndoStack();
    stack.push(batch('a'), 'A');
    stack.undo();
    stack.pushRedo({ label: 'A', batches: [batch('ra')] });
    expect(stack.canRedo).toBe(true);
    stack.push(batch('b'), 'B');
    expect(stack.canRedo).toBe(false);
    expect(stack.redo()).toBeNull();
  });

  it('joins a batch into the step on top, in the order applied', () => {
    const stack = new UndoStack();
    stack.push(batch('before'), 'Rename');
    stack.push(batch('add'), 'Paste');
    stack.join(batch('links'), 'Paste');
    expect(stack.undoLabel).toBe('Paste');
    const entry = stack.undo();
    expect(entry?.label).toBe('Paste');
    expect(tags(entry)).toEqual(['add', 'links']);
    expect(tags(stack.undo())).toEqual(['before']);
    expect(stack.undo()).toBeNull();
  });

  it('keeps the top step’s label when joining, and clears the redo side', () => {
    const stack = new UndoStack();
    stack.push(batch('a'), 'Paste');
    stack.pushRedo({ label: 'Old', batches: [batch('r')] });
    stack.join(batch('b'), 'Paste links');
    expect(stack.canRedo).toBe(false);
    expect(stack.undoLabel).toBe('Paste');
  });

  it('starts a step when there is none to join', () => {
    const stack = new UndoStack();
    stack.join(batch('a'), 'Paste');
    expect(stack.undoLabel).toBe('Paste');
    expect(tags(stack.undo())).toEqual(['a']);
  });

  it('ignores an empty inverse', () => {
    const stack = new UndoStack();
    stack.push([], 'Nothing');
    expect(stack.canUndo).toBe(false);
    stack.push(batch('a'), 'A');
    stack.join([], 'A');
    expect(tags(stack.undo())).toEqual(['a']);
    stack.pushUndo({ label: 'Empty', batches: [] });
    stack.pushRedo({ label: 'Empty', batches: [[]] });
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
  });

  it('hands back the inverse ops untouched (signed restores go back value for value)', () => {
    const stack = new UndoStack();
    const inverse = batch('a');
    stack.push(inverse, 'A');
    const entry = stack.undo();
    expect(entry?.batches[0]).toBe(inverse);
    expect(entry?.batches[0][0]).toBe(inverse[0]);
  });

  it('clears both sides', () => {
    const stack = new UndoStack();
    stack.push(batch('a'), 'A');
    stack.pushRedo({ label: 'B', batches: [batch('b')] });
    stack.clear();
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(false);
  });
});
