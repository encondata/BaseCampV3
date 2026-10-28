/**
 * The editor over the active cell of the task sheet (useSheetEditing holds
 * its state). PlanSheet places it over the cell; it draws the column's
 * editor:
 *
 *  - text (Task Name, Duration, Predecessors, % Complete, Notes): an
 *    `.org-select` input;
 *  - a date: `<input type="date">`, or `datetime-local` while the plan
 *    shows times;
 *  - Mode and Constraint Type: the house ComboBox, its menu portaled so it
 *    shows above full screen and outside the sheet's scroll box;
 *  - Resource Names: the ResourcePicker popover.
 *
 * Enter and Tab commit and move (a select's Enter picks, then moves down,
 * Shift+Enter up; a mouse pick stays), Esc cancels, a click elsewhere
 * commits where it is.
 * Keys that belong to an IME composition (the Enter that confirms one)
 * do nothing here. Every key typed here stays here: the grid and the
 * plan's shortcuts never see it (Review Focus 3). A refusal shows in
 * `.pf-error` under the cell, and focus comes back to the field. A native
 * date field holding part of a date is refused ("Enter a full date.")
 * rather than read as empty.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent,
  type KeyboardEvent } from 'react';

import ComboBox, { type ComboOption } from '../ComboBox';
import type { PlanColumn } from '../../lib/plans/columns';
import { PARTIAL_DATE } from '../../lib/plans/editOps';
import type { MoveDir } from '../../lib/plans/selection';
import { editorKey, keyLike, type KeyLike } from '../../lib/plans/sheetKeys';
import ResourcePicker from './ResourcePicker';
import type { SheetEditor } from './useSheetEditing';

import '../../styles/profile.css';   // .pf-error, .btn-solid

interface Props {
  editor: SheetEditor;
  column: PlanColumn;
  /** Placement over the cell (PlanSheet's grid coordinates). */
  style: CSSProperties;
  /** Resource Names: the picker's options. */
  options: ComboOption[];
  onChange(text: string): void;
  onCommit(text: string, dir: MoveDir | null, refocus: boolean): void;
  onCancel(refocus: boolean): void;
  /** A refusal the field knows of itself (a half-typed date). */
  onFail(message: string): void;
  onTypeAhead(key: string): void;
}

const printable = (k: KeyLike) => [...k.key].length === 1 && !k.ctrlKey && !k.metaKey && !k.altKey;

/** The right edge of what shows of `el`'s surroundings: `right`, or the
 *  sheet pane's edge (the splitter) when that comes first. */
function visibleRight(el: Element, right: number): number {
  const pane = el.closest('.pln-pane')?.getBoundingClientRect().right;
  return pane === undefined ? right : Math.min(right, pane);
}

export default function CellEditor({
  editor, column, style, options, onChange, onCommit, onCancel, onFail, onTypeAhead,
}: Props) {
  const { kind, text, error, refusals, pending } = editor;
  const isDate = kind === 'date' || kind === 'datetime';
  /** The select's pick under way came from Enter (down) or Shift+Enter (up). */
  const enterPick = useRef<MoveDir | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const errorId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);
  // the message stays inside the sheet's scroll box: it lines up with the
  // cell's right edge near the box's right side, and opens upward near its bottom
  const [errorFit, setErrorFit] = useState('');

  // an editor wider than its column (dates, selects) that would run past
  // the sheet's right edge opens leftward instead
  const [shift, setShift] = useState(0);

  useLayoutEffect(() => {
    const el = wrapRef.current;
    setAnchor(el);
    const sheet = el?.closest('.pln-sheet');
    if (!el || !sheet) return;
    const over = el.getBoundingClientRect().right - visibleRight(el, sheet.getBoundingClientRect().right);
    if (over > 0) setShift(Math.ceil(over));
  }, []);

  useLayoutEffect(() => {
    const box = wrapRef.current?.closest('.pln-panes')?.getBoundingClientRect();
    const msg = errorRef.current?.getBoundingClientRect();
    if (!error || !box || !msg) {
      setErrorFit('');
      return;
    }
    const cell = wrapRef.current!.getBoundingClientRect();
    setErrorFit(`${msg.right > visibleRight(wrapRef.current!, box.right) ? ' pln-editor-error-end' : ''}`
      + `${cell.bottom + msg.height + 8 > box.bottom && cell.top - msg.height - 8 > box.top ? ' pln-editor-error-up' : ''}`);
  }, [error]);

  // the field takes focus when the editor opens and when a refusal comes
  // back, the same message again included (`refusals`); typing starts at
  // the end, as in a spreadsheet
  useEffect(() => {
    if (kind === 'resources' || pending) return;
    const input = wrapRef.current?.querySelector<HTMLInputElement>('input');
    if (!input) return;
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    if (kind === 'text') input.setSelectionRange(input.value.length, input.value.length);
  }, [kind, error, refusals, pending]);

  /** Commits what the field holds, unless a date field holds part of a date
   *  (its value then reads as empty, which would clear the field). */
  const commitAs = (value: string, dir: MoveDir | null, refocus: boolean) => {
    if (isDate && wrapRef.current?.querySelector('input')?.validity?.badInput) {
      onFail(PARTIAL_DATE);
      return;
    }
    onCommit(value, dir, refocus);
  };

  // a select's keys before the ComboBox sees them: Escape cancels the edit
  // at once (not only the list); Enter on an open list picks and moves down
  // (Shift+Enter up), on a closed one commits as it is and moves the same way
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (kind !== 'select' || pending) return;
    const k = keyLike(e);
    if (k.isComposing) return;
    if (k.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel(true);
    } else if (k.key === 'Enter' && !k.ctrlKey && !k.metaKey && !k.altKey) {
      const dir: MoveDir = k.shiftKey ? 'up' : 'down';
      if ((e.target as HTMLElement).getAttribute('aria-expanded') === 'true') {
        enterPick.current = dir;
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      onCommit(text, dir, true);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    enterPick.current = null;           // a pick it led to has happened by now
    const k = keyLike(e);
    if (k.isComposing) return;          // the IME's keys (its Enter confirms the text)
    if (pending) {
      // the commit is on its way: keep what is typed for the next cell
      if (kind === 'text' && printable(k)) onTypeAhead(k.key);
      if (printable(k) || k.key === 'Enter' || k.key === 'Tab') e.preventDefault();
      return;
    }
    // the picker owns its keys; an Enter the ComboBox used was a pick
    if (kind === 'resources' || e.defaultPrevented) return;
    const action = editorKey(k);
    if (action.kind === 'commit') {
      e.preventDefault();
      commitAs(text, action.dir, true);
    } else if (action.kind === 'cancel') {
      e.preventDefault();
      onCancel(true);
    }
  };

  // leaving the field (a click on another cell, the toolbar) commits where
  // it is; the window losing focus does not
  const onBlur = (e: FocusEvent<HTMLDivElement>) => {
    if (pending || kind === 'resources') return;
    const next = e.relatedTarget as Node | null;
    if (next && wrapRef.current?.contains(next)) return;
    if (!document.hasFocus()) return;
    commitAs(text, null, false);
  };

  const field = { 'aria-label': column.label, 'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined };
  let control;
  if (kind === 'select') {
    control = (
      <ComboBox portal options={column.options ?? []} value={text} ariaLabel={column.label}
                placeholder={column.options?.find((o) => o.value === text)?.label}
                onChange={(v) => {
                  const dir = enterPick.current;
                  enterPick.current = null;
                  onCommit(v, dir, true);
                }} />
    );
  } else if (kind === 'resources') {
    const keys = text ? text.split(',') : [];
    const labels = new Map(options.map((o) => [o.value, o.label]));
    control = (
      <>
        <div className="org-select pln-editor-names" aria-hidden="true">
          {keys.map((k) => labels.get(k) ?? k).join(', ')}
        </div>
        {anchor && (
          <ResourcePicker options={options} selected={keys} anchor={anchor} pending={pending} error={error}
                          onChange={(next) => onChange(next.join(','))}
                          onSave={(refocus) => onCommit(keys.join(','), null, refocus)}
                          onCancel={() => onCancel(true)} />
        )}
      </>
    );
  } else {
    control = (
      <input className="org-select" type={kind === 'date' ? 'date' : kind === 'datetime' ? 'datetime-local' : 'text'}
             value={text} readOnly={pending} spellCheck={false} autoComplete="off" {...field}
             onChange={(e) => onChange(e.target.value)} />
    );
  }

  return (
    <div ref={wrapRef} className={`pln-editor${error ? ' pln-editor-bad' : ''}`} data-col={column.key}
         style={shift ? { ...style, marginLeft: -shift } : style}
         data-kind={kind}
         aria-busy={pending || undefined} onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown} onBlur={onBlur}>
      {control}
      {error && kind !== 'resources' && (
        <p ref={errorRef} id={errorId} className={`pf-error pln-editor-error${errorFit}`} role="alert">{error}</p>
      )}
    </div>
  );
}
