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
 * Enter and Tab commit and move, Esc cancels, a click elsewhere commits
 * where it is. Every key typed here stays here: the grid and the plan's
 * shortcuts never see it (Review Focus 3). A refusal shows in `.pf-error`
 * under the cell, and focus comes back to the field.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type FocusEvent,
  type KeyboardEvent } from 'react';

import ComboBox, { type ComboOption } from '../ComboBox';
import type { PlanColumn } from '../../lib/plans/columns';
import type { MoveDir } from '../../lib/plans/selection';
import { editorKey } from '../../lib/plans/sheetKeys';
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
  onTypeAhead(key: string): void;
}

const printable = (e: KeyboardEvent) => [...e.key].length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey;

export default function CellEditor({ editor, column, style, options, onChange, onCommit, onCancel, onTypeAhead }: Props) {
  const { kind, text, error, pending } = editor;
  const wrapRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const errorId = useId();
  const errorRef = useRef<HTMLParagraphElement>(null);
  // the message stays inside the sheet's scroll box: it lines up with the
  // cell's right edge near the box's right side, and opens upward near its bottom
  const [errorFit, setErrorFit] = useState('');

  useLayoutEffect(() => setAnchor(wrapRef.current), []);

  useLayoutEffect(() => {
    const box = wrapRef.current?.closest('.pln-panes')?.getBoundingClientRect();
    const msg = errorRef.current?.getBoundingClientRect();
    if (!error || !box || !msg) {
      setErrorFit('');
      return;
    }
    const cell = wrapRef.current!.getBoundingClientRect();
    setErrorFit(`${msg.right > box.right ? ' pln-editor-error-end' : ''}`
      + `${cell.bottom + msg.height + 8 > box.bottom && cell.top - msg.height - 8 > box.top ? ' pln-editor-error-up' : ''}`);
  }, [error]);

  // the field takes focus when the editor opens and when a refusal comes
  // back; typing starts at the end, as in a spreadsheet
  useEffect(() => {
    if (kind === 'resources' || pending) return;
    const input = wrapRef.current?.querySelector<HTMLInputElement>('input');
    if (!input) return;
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    if (kind === 'text') input.setSelectionRange(input.value.length, input.value.length);
  }, [kind, error, pending]);

  // a select's Escape cancels the edit at once (before the ComboBox would
  // close only its list)
  const onKeyDownCapture = (e: KeyboardEvent<HTMLDivElement>) => {
    if (kind !== 'select' || e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    onCancel(true);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    e.stopPropagation();
    if (pending) {
      // the commit is on its way: keep what is typed for the next cell
      if (kind === 'text' && printable(e)) onTypeAhead(e.key);
      if (printable(e) || e.key === 'Enter' || e.key === 'Tab') e.preventDefault();
      return;
    }
    // the picker owns its keys; an Enter the ComboBox used was a pick
    if (kind === 'resources' || e.defaultPrevented) return;
    const action = editorKey(e);
    if (action.kind === 'commit') {
      e.preventDefault();
      onCommit(text, action.dir, true);
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
    onCommit(text, null, false);
  };

  const field = { 'aria-label': column.label, 'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? errorId : undefined };
  let control;
  if (kind === 'select') {
    control = (
      <ComboBox portal options={column.options ?? []} value={text} ariaLabel={column.label}
                placeholder={column.options?.find((o) => o.value === text)?.label}
                onChange={(v) => onCommit(v, null, true)} />
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
    <div ref={wrapRef} className={`pln-editor${error ? ' pln-editor-bad' : ''}`} style={style} data-col={column.key}
         data-kind={kind}
         aria-busy={pending || undefined} onKeyDownCapture={onKeyDownCapture} onKeyDown={onKeyDown} onBlur={onBlur}>
      {control}
      {error && kind !== 'resources' && (
        <p ref={errorRef} id={errorId} className={`pf-error pln-editor-error${errorFit}`} role="alert">{error}</p>
      )}
    </div>
  );
}
