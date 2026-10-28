/**
 * The plan tab's undo and redo: 20 steps (MS Project's default undo
 * levels), for this session only. A step is the inverse of one edit as the
 * API answered it: a list of batches in the order they were applied (one
 * for most edits; a paste adds its rows, then sets their links in a second
 * batch keyed by the new ids, and `join` keeps both in one step).
 *
 * Running a step posts its batches last first, one POST each, and the
 * inverses those POSTs answer, in the order posted, are the step for the
 * other side (`pushRedo` after an undo, `pushUndo` after a redo). Running
 * that step posts them last first again, so every round trip lines up.
 *
 * The ops are kept as received: the inverses are signed restores the API
 * checks value for value, so nothing here copies or rewrites them.
 */
import type { Op } from './api';

export const UNDO_LEVELS = 20;

export interface UndoEntry {
  readonly label: string;
  /** The inverse batches, in the order their edits were applied. */
  readonly batches: readonly (readonly Op[])[];
}

/** The batches that hold something to send. */
const nonEmpty = (batches: readonly (readonly Op[])[]): (readonly Op[])[] =>
  batches.filter((ops) => ops.length > 0);

export class UndoStack {
  private undoSteps: UndoEntry[] = [];

  private redoSteps: UndoEntry[] = [];

  constructor(private readonly limit = UNDO_LEVELS) {}

  /** A fresh edit's inverse as a new step; the redo side is gone. */
  push(inverse: readonly Op[], label: string): void {
    if (!inverse.length) return;
    this.redoSteps = [];
    this.add(this.undoSteps, { label, batches: [inverse] });
  }

  /** Another batch of the edit on top (applied after its others, so undone
   *  before them); a new step when there is none. The step keeps its label. */
  join(inverse: readonly Op[], label: string): void {
    if (!inverse.length) return;
    const top = this.undoSteps.pop();
    this.redoSteps = [];
    this.add(this.undoSteps, top
      ? { label: top.label, batches: [...top.batches, inverse] }
      : { label, batches: [inverse] });
  }

  /** Takes the newest undo step off, for the caller to post. */
  undo(): UndoEntry | null {
    return this.undoSteps.pop() ?? null;
  }

  /** Takes the newest redo step off, for the caller to post. */
  redo(): UndoEntry | null {
    return this.redoSteps.pop() ?? null;
  }

  /** A step onto the undo side (what a redo's posts answered, or an undo
   *  that did not go through), leaving the redo side as it is. */
  pushUndo(entry: UndoEntry): void {
    this.add(this.undoSteps, entry);
  }

  /** A step onto the redo side (what an undo's posts answered, or a redo
   *  that did not go through). */
  pushRedo(entry: UndoEntry): void {
    this.add(this.redoSteps, entry);
  }

  clear(): void {
    this.undoSteps = [];
    this.redoSteps = [];
  }

  get canUndo(): boolean {
    return this.undoSteps.length > 0;
  }

  get canRedo(): boolean {
    return this.redoSteps.length > 0;
  }

  /** The label of the step Undo would take back. */
  get undoLabel(): string | null {
    return this.undoSteps[this.undoSteps.length - 1]?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoSteps[this.redoSteps.length - 1]?.label ?? null;
  }

  /** Onto `side`, dropping the oldest past the limit; a step with nothing
   *  to send is not kept. */
  private add(side: UndoEntry[], entry: UndoEntry): void {
    const batches = nonEmpty(entry.batches);
    if (!batches.length) return;
    side.push(batches.length === entry.batches.length ? entry : { label: entry.label, batches });
    if (side.length > this.limit) side.splice(0, side.length - this.limit);
  }
}
