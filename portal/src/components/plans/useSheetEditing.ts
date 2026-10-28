/**
 * The task sheet's cell editor: which cell is being edited, what it holds,
 * and committing it (lib/plans/editOps builds the ops; PlanController.apply
 * sends them).
 *
 * - Opening an editor takes an editing hold (`beginEditing`), so a poll
 *   that finds someone else's change waits instead of replacing the plan
 *   under the editor.
 * - A commit calls `apply` first and lets go of the hold only once it
 *   answers: let go first, and the refresh that waited is queued ahead of
 *   the apply, which is then dropped as "changed by someone else".
 * - Review Focus 1: nothing is shown before the API answers. The cell keeps
 *   the plan's value (usePlan merges only what the API accepted); a refusal
 *   keeps the editor open, with what was typed and the message under the
 *   cell, still holding editing. Esc then gives up and the cell shows what
 *   it always showed.
 * - While a commit is in flight the editor is read-only; keys typed then
 *   are kept and start the next cell's editor once the move lands.
 * - Notices (a constraint the edit added or cleared) toast with Undo; a
 *   completion the rules stopped goes to the completion check (useCompletion).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';

import { useToast } from '../../lib/notificationsContext';
import type { Plan, PlanTask } from '../../lib/plans/api';
import type { PlanColumn } from '../../lib/plans/columns';
import { canEditCell, editLabel, editText, opsForCell, type EditContext } from '../../lib/plans/editOps';
import { planUnits } from '../../lib/plans/merge';
import { moveActive, selectCell, type MoveDir, type Selection } from '../../lib/plans/selection';
import { sayNotices, useCompletionPrompt } from './useCompletion';
import type { PlanController } from './usePlan';

/** How a column is edited (CellEditor draws one of these). */
export type EditorKind = 'text' | 'date' | 'datetime' | 'select' | 'resources' | 'color';

export function editorKind(column: PlanColumn, showTimes: boolean): EditorKind | null {
  switch (column.editor) {
    case 'none': return null;
    case 'date': return showTimes ? 'datetime' : 'date';
    case 'datetime': return 'datetime';
    case 'select': return 'select';
    case 'resources': return 'resources';
    case 'color': return 'color';
    default: return 'text';
  }
}

export interface SheetEditor {
  id: string | 'blank';
  col: string;
  kind: EditorKind;
  text: string;
  error: string | null;
  /** Bumped by every refusal, so the field takes focus back even when the
   *  same message comes again (a click away refused like the Enter before). */
  refusals: number;
  /** A commit is in flight. */
  pending: boolean;
  /** One per opening: keys the editor element and tells a stale answer apart. */
  seq: number;
}

interface Options {
  ctl: PlanController;
  columns: readonly PlanColumn[];       // shown, in order
  rows: readonly string[];              // the task rows shown, in order
  blankRow: boolean;
  selection: Selection;
  onSelect(sel: Selection): void;
  /** Focus back on the grid (only when focus was in the editor). */
  focusGrid(): void;
}

export interface SheetEditing {
  editor: SheetEditor | null;
  /** Opens the cell's editor (`seed` null: its value); false when it can't. */
  open(id: string | 'blank', col: string, seed: string | null): boolean;
  change(text: string): void;
  commit(text: string, dir: MoveDir | null, refocus: boolean): void;
  cancel(refocus: boolean): void;
  /** A refusal the field itself knows of (a half-typed date): shown like
   *  any other, nothing sent. */
  fail(message: string): void;
  /** A key typed while a commit is in flight. */
  typeAhead(key: string): void;
}

const HOLD_OWNER = 'sheet-cell';

/** Editors that start from the key typed (the others start from the value). */
const SEEDED: ReadonlySet<EditorKind> = new Set(['text']);

export function useSheetEditing(o: Options): SheetEditing {
  const toast = useToast();
  const prompt = useCompletionPrompt();
  const [editor, setEditorState] = useState<SheetEditor | null>(null);
  const [queued, setQueued] = useState<{ id: string; col: string; seed: string } | null>(null);

  // the latest props and state for callbacks that keep one identity (the
  // rows take them) and for code that runs after an await
  const latest = useRef({ ...o, toast, prompt });
  useLayoutEffect(() => {
    latest.current = { ...o, toast, prompt };
  });
  const editorRef = useRef<SheetEditor | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const aheadRef = useRef('');
  const seqRef = useRef(0);
  const refusalRef = useRef(0);
  const tempRef = useRef(0);

  const setEditor = useCallback((next: SheetEditor | null) => {
    editorRef.current = next;
    setEditorState(next);
  }, []);

  /** Closes the editor and lets go of editing. */
  const close = useCallback((refocus: boolean) => {
    setEditor(null);
    const release = releaseRef.current;
    releaseRef.current = null;
    release?.();
    if (refocus) latest.current.focusGrid();
  }, [setEditor]);

  // the plan went away under an open editor (another initiative, deleted)
  useEffect(() => () => {
    releaseRef.current?.();
    releaseRef.current = null;
  }, []);

  const taskOf = (plan: Plan, id: string): PlanTask | null => plan.tasks.find((t) => t.id === id) ?? null;
  const columnOf = (key: string) => latest.current.columns.find((c) => c.key === key) ?? null;

  const open = useCallback((id: string | 'blank', col: string, seed: string | null): boolean => {
    const plan = latest.current.ctl.plan;
    const column = columnOf(col);
    if (!plan || !column || editorRef.current) return false;
    const task = id === 'blank' ? null : taskOf(plan, id);
    if (id !== 'blank' && !task) return false;
    if (!canEditCell(plan, task, column)) return false;
    const showTimes = plan.settings.show_times;
    const kind = editorKind(column, showTimes);
    if (!kind) return false;
    const text = seed !== null && SEEDED.has(kind) ? seed : editText(task, column, showTimes);
    releaseRef.current?.();
    releaseRef.current = latest.current.ctl.beginEditing(HOLD_OWNER);
    seqRef.current += 1;
    aheadRef.current = '';
    setEditor({ id, col, kind, text, error: null, refusals: 0, pending: false, seq: seqRef.current });
    return true;
  }, [setEditor]);

  const change = useCallback((text: string) => {
    const ed = editorRef.current;
    if (ed && !ed.pending) setEditor({ ...ed, text });
  }, [setEditor]);

  const cancel = useCallback((refocus: boolean) => {
    const ed = editorRef.current;
    if (!ed || ed.pending) return;    // a commit in flight can't be called back
    close(refocus);
  }, [close]);

  const typeAhead = useCallback((key: string) => {
    if (editorRef.current?.pending) aheadRef.current += key;
  }, []);

  /** The edit is refused: the editor stays open with what was typed and
   *  the message, and the active cell comes back to it (a click elsewhere
   *  may have committed it). */
  const refuse = useCallback((ed: SheetEditor, text: string, message: string) => {
    aheadRef.current = '';
    refusalRef.current += 1;
    setEditor({ ...ed, text, error: message, refusals: refusalRef.current, pending: false });
    const { selection, onSelect } = latest.current;
    if (selection.active?.id !== ed.id || selection.active.col !== ed.col) onSelect(selectCell(ed.id, ed.col));
  }, [setEditor]);

  const fail = useCallback((message: string) => {
    const ed = editorRef.current;
    if (ed && !ed.pending) refuse(ed, ed.text, message);
  }, [refuse]);

  /** After a commit: the next cell, if the person is still on this one. */
  const moveAfter = useCallback((ed: SheetEditor, dir: MoveDir | null, addedId: string | null) => {
    const { selection, onSelect, rows, blankRow, columns } = latest.current;
    if (!dir || selection.active?.id !== ed.id || selection.active.col !== ed.col) return null;
    const cols = columns.map((c) => c.key);
    let next: Selection;
    if (ed.id === 'blank' && addedId) {
      // the new task sits right above the blank row now
      if (dir === 'down') next = selectCell('blank', ed.col);
      else if (dir === 'up') next = selectCell(addedId, ed.col);
      else next = moveActive(selectCell(addedId, ed.col), dir, [addedId], cols);
    } else {
      next = moveActive(selection, dir, blankRow ? [...rows, 'blank'] : rows, cols);
    }
    onSelect(next);
    return next.active;
  }, []);

  const commit = useCallback((text: string, dir: MoveDir | null, refocus: boolean) => {
    const ed = editorRef.current;
    if (!ed || ed.pending) return;
    const { ctl, rows } = latest.current;
    const plan = ctl.plan;
    const column = columnOf(ed.col);
    const task = plan && ed.id !== 'blank' ? taskOf(plan, ed.id) : null;
    if (!plan || !column || (ed.id !== 'blank' && !task)) {
      close(refocus);
      return;
    }
    const byId = new Map(plan.tasks.map((t) => [t.id, t]));
    const ctx: EditContext = {
      units: planUnits(plan),
      validIds: new Set(plan.tasks.map((t) => t.display_id)),
      displayIdOf: (id) => byId.get(id)?.display_id ?? null,
      tempId: () => {
        tempRef.current += 1;
        return `sheet-${tempRef.current}`;
      },
      appendParentId: byId.get(rows[rows.length - 1])?.parent_id ?? null,
    };
    const edit = opsForCell(task, column, text, ctx);
    if ('error' in edit) {
      refuse(ed, text, edit.error);
      return;
    }
    if (!edit.ops.length) {
      close(refocus);
      moveAfter(ed, dir, null);
      return;
    }
    const label = editLabel(task, column);
    setEditor({ ...ed, text, error: null, pending: true });
    // apply first; the hold goes only once it answers (see the header)
    void ctl.apply(edit.ops, label).then((result) => {
      if (editorRef.current?.seq !== ed.seq) return;      // closed meanwhile (the plan went away)
      const { toast: say, prompt: ask, ctl: now } = latest.current;
      if (result.ok) {
        const ahead = aheadRef.current;
        aheadRef.current = '';
        close(refocus);
        sayNotices(say, result.notices, () => void latest.current.ctl.undo());
        const addedId = task ? null : (Object.values(result.tempIds)[0] ?? null);
        const next = moveAfter(ed, dir, addedId);
        if (ahead && next) setQueued({ id: next.id, col: next.col, seed: ahead });
        return;
      }
      if (result.kind !== 'error') {
        close(refocus);
        ask(result, () => latest.current.ctl.apply(edit.ops, label, { confirm: true }));
        return;
      }
      if (result.code === 'plan_changed' || result.code === 'gone' || !now.plan) {
        close(refocus);      // reloaded (or gone): the toast already said why
        return;
      }
      refuse(ed, text, result.message);
    });
  }, [close, moveAfter, refuse, setEditor]);

  // keys typed while a commit was in flight start the next cell's editor
  // once the plan on screen has the row (a new task arrives a render later)
  useEffect(() => {
    if (!queued) return;
    const plan = o.ctl.plan;
    if (queued.id !== 'blank' && !plan?.tasks.some((t) => t.id === queued.id)) return;
    setQueued(null);
    open(queued.id, queued.col, queued.seed);
  }, [queued, o.ctl.plan, open]);

  return useMemo(() => ({ editor, open, change, commit, cancel, fail, typeAhead }),
    [editor, open, change, commit, cancel, fail, typeAhead]);
}
