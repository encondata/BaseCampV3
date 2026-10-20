/**
 * Undo and redo for the builder: a stack of whole states (designs are
 * immutable, so each state is kept as is). A gesture — a drag, a resize, a
 * nudge held down — pushes many states but records one undo step, from
 * where it started to where it ended.
 */

export interface History<T> {
  /** The current state. */
  readonly present: T;
  /** Moves to `next`, recording the current state as an undo step (inside a
   *  gesture, only the gesture's start is recorded, at its end). Pushing
   *  the current state again records nothing. */
  push(next: T): void;
  /** Steps back and returns the new current state (unchanged at the start). */
  undo(): T;
  /** Steps forward again and returns the new current state. */
  redo(): T;
  canUndo(): boolean;
  canRedo(): boolean;
  /** Starts a gesture: pushes until `endGesture` coalesce into one step. */
  beginGesture(): void;
  /** Ends the gesture; one undo step if it changed anything, else none. */
  endGesture(): void;
  /** Starts over at `state` with no undo or redo steps (a template opened). */
  reset(state: T): void;
}

export function createHistory<T>(initial: T, cap = 100): History<T> {
  let present = initial;
  let past: T[] = [];
  let future: T[] = [];
  let gestureStart: { state: T } | null = null;

  function record(state: T): void {
    past.push(state);
    if (past.length > cap) past = past.slice(past.length - cap);
    future = [];
  }

  function endGesture(): void {
    if (!gestureStart) return;
    const { state } = gestureStart;
    gestureStart = null;
    if (state !== present) record(state);
  }

  return {
    get present() {
      return present;
    },
    push(next) {
      if (next === present) return;
      if (!gestureStart) record(present);
      present = next;
    },
    undo() {
      endGesture();
      if (!past.length) return present;
      future.push(present);
      present = past.pop() as T;
      return present;
    },
    redo() {
      endGesture();
      if (!future.length) return present;
      past.push(present);
      present = future.pop() as T;
      return present;
    },
    canUndo: () => past.length > 0 || (gestureStart !== null && gestureStart.state !== present),
    canRedo: () => future.length > 0,
    beginGesture() {
      if (!gestureStart) gestureStart = { state: present };
    },
    endGesture,
    reset(state) {
      present = state;
      past = [];
      future = [];
      gestureStart = null;
    },
  };
}
